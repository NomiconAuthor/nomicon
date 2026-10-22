/**
 * Step-through playback for the tactics lab's algorithms, like the pathing lab's.
 * An algorithm records what it did as a Trace; the Player moves through it.
 */
import { h } from '../lab/ui/dom';

export type Stat = [value: string, label: string, cls?: string];

export interface Caption {
  title: string;
  text: string;
}

/** A recorded run of an algorithm that can be redrawn at any step. */
export interface Trace {
  /** Number of steps (the last index is length - 1). */
  readonly length: number;
  /** Steps where something worth pausing on happens (phase changes, decisions). */
  readonly marks: number[];
  /** Bring the trace's own state to step k (replaying from the start if going back). */
  seek(k: number): void;
  /** Draw the state at the current step on top of the map. */
  draw(ctx: CanvasRenderingContext2D, cs: number): void;
  caption(): Caption;
  stats(): Stat[];
}

/**
 * Helper for traces that are a list of events applied in order to some state:
 * going forward applies the next events, going back resets and replays.
 */
export abstract class EventTrace<E> implements Trace {
  protected events: E[] = [];
  marks: number[] = [];
  protected at = -1;
  get length(): number {
    return this.events.length;
  }
  protected abstract reset(): void;
  protected abstract apply(e: E, index: number): void;
  seek(k: number): void {
    k = Math.max(-1, Math.min(this.events.length - 1, k));
    if (k < this.at) {
      this.reset();
      this.at = -1;
    }
    while (this.at < k) this.apply(this.events[++this.at], this.at);
  }
  abstract draw(ctx: CanvasRenderingContext2D, cs: number): void;
  abstract caption(): Caption;
  abstract stats(): Stat[];
}

/** Transport bar (⏮ ◀ ▶ ▶| ⏭, scrubber, speed) driving a trace. */
export class Player {
  readonly el: HTMLElement;
  readonly captionEl: HTMLElement;
  /** Turns glossary terms in captions into hoverable links (full lab only). */
  link: ((text: string) => DocumentFragment) | null = null;
  /** Keep the bar on screen, disabled, when there is no trace (instead of hiding it). */
  keep = false;
  private lastCaption = '';
  private trace: Trace | null = null;
  step = 0;
  private playing = false;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private speed = 55; // 0..100, log scale
  private pauseAtMarks = true;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private scrubLbl: HTMLElement;
  private speedLbl: HTMLElement;

  constructor(private onChange: () => void) {
    const btn = (label: string, title: string, fn: () => void) => h('button', { type: 'button', title, 'aria-label': title, onclick: fn }, label);
    this.playBtn = btn('▶', 'Play', () => this.toggle()) as HTMLButtonElement;
    this.playBtn.classList.add('primary');
    this.scrub = h('input', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Algorithm progress' }) as HTMLInputElement;
    this.scrub.addEventListener('input', () => {
      this.pause();
      this.seek(Number(this.scrub.value));
    });
    this.scrubLbl = h('div', { class: 'lbl' });
    this.speedLbl = h('span');
    const speed = h('input', { type: 'range', min: 0, max: 100, value: this.speed, 'aria-label': 'Playback speed' }) as HTMLInputElement;
    speed.addEventListener('input', () => {
      this.speed = Number(speed.value);
      this.speedLabel();
    });
    const pause = h('input', { type: 'checkbox', checked: this.pauseAtMarks }) as HTMLInputElement;
    pause.addEventListener('change', () => (this.pauseAtMarks = pause.checked));
    this.speedLabel();
    this.el = h(
      'div',
      { class: 'transport tl-transport' },
      h(
        'div',
        { class: 'btns' },
        btn('⏮', 'Back to start', () => (this.pause(), this.seek(0))),
        btn('◀', 'Step back', () => (this.pause(), this.seek(this.step - 1))),
        this.playBtn,
        btn('▶|', 'Step', () => (this.pause(), this.seek(this.step + 1))),
        btn('⏭', 'Jump to the end', () => (this.pause(), this.seek(Infinity))),
      ),
      h('div', { class: 'scrub' }, this.scrub, this.scrubLbl),
      h('div', { class: 'speed' }, speed, h('div', { class: 'lbl' }, this.speedLbl)),
      h('label', { class: 'check' }, pause, 'Pause at each stage'),
    );
    this.captionEl = h('div', { class: 'tl-caption' });
  }

  private sps(): number {
    return Math.max(1, Math.round(Math.pow(10, (this.speed / 100) * 3.6)));
  }
  private speedLabel(): void {
    this.speedLbl.textContent = `${this.sps()} steps/s`;
  }

  /** Show a new trace. `atEnd` starts at the finished result; otherwise it starts at step 0. */
  set(trace: Trace | null, atEnd: boolean): void {
    this.pause();
    this.trace = trace;
    const off = !trace && this.keep;
    this.el.hidden = !trace && !off;
    this.captionEl.hidden = !trace && !off;
    this.el.classList.toggle('tl-off', off);
    this.captionEl.classList.toggle('tl-off', off);
    for (const c of this.el.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) c.disabled = !trace;
    if (off) {
      this.lastCaption = '';
      this.scrub.max = '0';
      this.scrub.value = '0';
      this.scrubLbl.replaceChildren(h('span', {}, 'no steps'));
      this.captionEl.replaceChildren(h('b', {}, 'No playback.'), ' This analysis has no step-by-step run; the map shows its result.');
    }
    if (!trace) return;
    this.scrub.max = String(Math.max(0, trace.length - 1));
    this.seek(atEnd ? trace.length - 1 : 0, true);
  }
  get current(): Trace | null {
    return this.trace;
  }

  seek(k: number, quiet = false): void {
    const t = this.trace;
    if (!t) return;
    this.step = Math.max(0, Math.min(t.length - 1, k));
    t.seek(this.step);
    this.scrub.value = String(this.step);
    this.scrubLbl.replaceChildren(h('span', {}, `step ${this.step + 1} of ${t.length}`), h('span', {}, `${t.marks.filter((m) => m <= this.step).length} / ${t.marks.length} stages`));
    const c = t.caption();
    const key = c.title + c.text;
    if (key !== this.lastCaption) {
      this.lastCaption = key;
      this.captionEl.replaceChildren(h('b', {}, c.title), ' ', this.link ? this.link(c.text) : c.text);
    }
    void quiet;
    this.onChange();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }
  play(): void {
    const t = this.trace;
    if (!t) return;
    if (this.step >= t.length - 1) this.seek(0);
    this.playing = true;
    this.playBtn.textContent = '⏸';
    this.last = performance.now();
    this.acc = 0;
    const f = (now: number) => {
      if (!this.playing) return;
      this.acc += ((now - this.last) / 1000) * this.sps();
      this.last = now;
      const n = Math.floor(this.acc);
      if (n > 0) {
        this.acc -= n;
        let target = Math.min(t.length - 1, this.step + n);
        // Stop at the next stage boundary, so each stage's explanation can be read.
        if (this.pauseAtMarks) {
          const mark = t.marks.find((m) => m > this.step && m <= target);
          if (mark !== undefined) {
            target = mark;
            this.seek(target);
            this.pause();
            return;
          }
        }
        this.seek(target);
        if (target >= t.length - 1) {
          this.pause();
          return;
        }
      }
      this.raf = requestAnimationFrame(f);
    };
    this.raf = requestAnimationFrame(f);
  }
  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.playBtn.textContent = '▶';
  }
}
