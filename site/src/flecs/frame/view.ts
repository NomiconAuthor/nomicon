import { FlecsWorld } from '../runtime';
import { h, type Child } from '../../engine/dom';
import type { StorageModel } from '../debugger/model';
import { defaultConfig, record, type FrameConfig, type Recording } from './record';
import { systemCpp, type FrameScenario, type Kind } from './scenarios';
import { builds, kindLabel, noMergeWhy, rowRange, splitRows, stageName, tableName, timeline, immediateTree, type Beat, type Block, type Reason, type Run, type Timeline, type TreeNode } from './model';

type Selection = { kind: 'sync'; run: number } | { kind: 'block'; run: number; system: number } | null;

const KIND_TEXT: Record<Kind, string> = { single: 'single', multi: 'multi_threaded', immediate: 'immediate' };

/**
 * "A frame in detail": one progress() (or run_pipeline) of a real flecs world,
 * drawn as runs of systems on the main thread and worker stages, with the sync
 * points between them and every merge's hooks, observers and nested flushes.
 */
export class FrameView {
  private w!: FlecsWorld;
  private rec!: Recording;
  private tl!: Timeline;
  private cfg: FrameConfig;
  private step = 0;
  private cursor = 0;
  private sel: Selection = null;
  private playing: number | null = null;
  private note = '';
  private types = new Map<number, string[]>();
  private root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private scrub!: HTMLInputElement;

  constructor(
    private host: HTMLElement,
    private sc: FrameScenario,
  ) {
    this.cfg = defaultConfig(sc, 0);
    this.root = h('div', { class: 'ffr', tabindex: '0' });
  }

  async init(): Promise<void> {
    try {
      this.w = await FlecsWorld.create();
    } catch (e) {
      this.host.textContent = `Couldn't load flecs: ${(e as Error).message}`;
      return;
    }
    this.host.replaceChildren(this.root);
    this.root.addEventListener('keydown', (e) => this.key(e));
    this.build();
    this.rerecord();
  }

  // ---------------------------------------------------------------- recording

  private rerecord(summary = false): void {
    const old = this.rec ? this.scheduleText() : '';
    this.stop();
    this.rec = record(this.w, this.sc, this.cfg);
    this.step = Math.min(this.step, this.rec.steps.length - 1);
    this.loadStep();
    if (summary) {
      const now = this.scheduleText();
      this.note = now === old ? 'Same runs as before.' : `Runs now: ${now}`;
    } else this.note = this.sc.variants?.[this.cfg.variant]?.note ?? '';
    this.render();
  }

  private loadStep(): void {
    const st = this.rec.steps[this.step];
    this.types = new Map(st.types);
    for (const [, t] of st.before.tables) if (!this.types.has(t.id)) this.types.set(t.id, t.type.map((c) => c.str));
    for (const [, t] of st.after.tables) if (!this.types.has(t.id)) this.types.set(t.id, t.type.map((c) => c.str));
    this.tl = timeline(this.rec, this.step, (e) => this.name(e), (t) => this.types.get(t));
    this.cursor = 0;
    this.sel = null;
  }

  /** Runs of the first step, as text ("[Input] ‖ [Move, Ignite] ‖ …"). */
  private scheduleText(): string {
    const t = timeline(this.rec, 0, (e) => this.name(e), () => undefined);
    return t.runs
      .filter((r) => !r.internal)
      .map((r) => `[${r.systems.map((s) => this.name(s)).join(', ')}]`)
      .join(' ‖ ');
  }

  private name(e: number): string {
    return this.rec.names.get(e) ?? this.rec.systems.get(e)?.name ?? this.w.name(e);
  }

  private tname(t: number): string {
    return tableName(this.types.get(t), t);
  }

  // ---------------------------------------------------------------- skeleton

  private build(): void {
    const sc = this.sc;
    const top = h('div', { class: 'ffr-top' });
    if (sc.variants?.length) {
      const sel = h('select', { class: 'ffr-select', 'aria-label': 'Setup' }) as HTMLSelectElement;
      sc.variants.forEach((v, i) => sel.append(h('option', { value: String(i) }, v.label)));
      sel.addEventListener('change', () => {
        this.cfg = defaultConfig(sc, Number(sel.value));
        this.step = 0;
        this.rerecord();
      });
      top.append(h('label', { class: 'ffr-field' }, h('span', {}, 'Setup'), sel));
    }
    if (sc.threads) {
      this.els.threads = h('div', { class: 'ffr-seg', role: 'group', 'aria-label': 'Threads' });
      top.append(h('div', { class: 'ffr-field' }, h('span', {}, 'set_threads'), this.els.threads));
    }
    this.els.steps = h('div', { class: 'ffr-seg ffr-steps', role: 'group', 'aria-label': 'Step' });
    top.append(this.els.steps);

    const btn = (label: string, title: string, fn: () => void) => h('button', { type: 'button', class: 'ffr-btn', title, 'aria-label': title, onclick: fn }, label);
    this.els.play = btn('▶ Play', 'Play', () => this.togglePlay());
    this.scrub = h('input', { type: 'range', min: '0', max: '0', value: '0', class: 'ffr-scrub', 'aria-label': 'Position in the frame' }) as HTMLInputElement;
    this.scrub.addEventListener('input', () => {
      this.stop();
      this.go(Number(this.scrub.value));
    });
    const ctrl = h(
      'div',
      { class: 'ffr-ctrl' },
      btn('⏮', 'Back to the start', () => this.go(0)),
      btn('◀', 'Previous step', () => this.go(this.cursor - 1)),
      this.els.play,
      btn('▶|', 'Next step', () => this.go(this.cursor + 1)),
      btn('⏭', 'Next run or sync', () => this.nextRun()),
      this.scrub,
    );
    this.els.caption = h('p', { class: 'ffr-caption', 'aria-live': 'polite' });
    this.els.note = h('p', { class: 'ffr-note' });
    this.els.tline = h('div', { class: 'ffr-tl' });
    this.els.detail = h('div', { class: 'ffr-detail' });
    this.els.tables = h('div', { class: 'ffr-tables' });
    this.els.queues = h('div', { class: 'ffr-queues' });
    this.els.code = h('pre', { class: 'ffr-pre' });
    this.root.append(
      top,
      ctrl,
      this.els.caption,
      this.els.note,
      h('div', { class: 'ffr-tlwrap' }, this.els.tline),
      this.els.detail,
      h('div', { class: 'ffr-panels' }, h('section', { class: 'ffr-panel' }, h('h4', {}, 'Tables at this point'), this.els.tables), h('section', { class: 'ffr-panel' }, h('h4', {}, 'Command queues'), this.els.queues)),
      h('details', { class: 'ffr-codebox' }, h('summary', {}, 'The code'), this.els.code),
    );
  }

  // ---------------------------------------------------------------- cursor

  private get beats(): Beat[] {
    return this.tl.beats;
  }

  /** Event index the cursor has reached (everything up to and including it has happened). */
  private get at(): number {
    return this.beats[this.cursor]?.ev ?? -1;
  }

  private go(i: number): void {
    this.cursor = Math.max(0, Math.min(this.beats.length - 1, i));
    this.sel = null;
    this.render();
  }

  private nextRun(): void {
    this.stop();
    const cur = this.beats[this.cursor];
    for (let i = this.cursor + 1; i < this.beats.length; i++) {
      const b = this.beats[i];
      if (b.run !== cur?.run || (b.merging && !cur.merging)) return this.go(i);
    }
    this.go(this.beats.length - 1);
  }

  private togglePlay(): void {
    if (this.playing !== null) return this.stop();
    if (this.cursor >= this.beats.length - 1) this.cursor = 0;
    this.playing = window.setInterval(() => {
      if (this.cursor >= this.beats.length - 1) return this.stop();
      this.go(this.cursor + 1);
    }, 550);
    this.els.play.textContent = '❚❚ Pause';
  }

  private stop(): void {
    if (this.playing !== null) window.clearInterval(this.playing);
    this.playing = null;
    if (this.els.play) this.els.play.textContent = '▶ Play';
  }

  private key(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('select, input, button')) return;
    if (e.key === 'ArrowRight') this.go(this.cursor + 1);
    else if (e.key === 'ArrowLeft') this.go(this.cursor - 1);
    else if (e.key === ' ') this.togglePlay();
    else return;
    e.preventDefault();
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    this.renderTop();
    const beat = this.beats[this.cursor];
    this.scrub.max = String(Math.max(0, this.beats.length - 1));
    this.scrub.value = String(this.cursor);
    this.els.caption.replaceChildren(
      h('span', { class: 'ffr-count' }, `${this.cursor + 1}/${this.beats.length}`),
      h('span', { class: `ffr-dot s${beat?.stage ?? 0}` }),
      beat?.text ?? '',
    );
    this.els.note.textContent = this.rec.error ? `Error: ${this.rec.error}` : this.note;
    this.els.note.classList.toggle('err', !!this.rec.error);
    this.renderTimeline();
    this.renderDetail();
    this.renderTables();
    this.renderQueues();
    this.renderCode();
  }

  private renderTop(): void {
    if (this.els.threads) {
      this.els.threads.replaceChildren(
        ...[1, 2, 3, 4].map((n) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(this.cfg.stages === n),
              onclick: () => {
                this.cfg = { ...this.cfg, stages: n };
                this.rerecord(true);
              },
            },
            String(n),
          ),
        ),
      );
    }
    this.els.steps.hidden = this.sc.steps.length < 2;
    this.els.steps.replaceChildren(
      ...this.sc.steps.map((s, i) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(this.step === i),
            title: s.label,
            onclick: () => {
              this.stop();
              this.step = i;
              this.loadStep();
              this.render();
            },
          },
          stepShort(s.label, i),
        ),
      ),
    );
  }

  private state(ev: number): 'done' | 'now' | 'todo' {
    const at = this.at;
    return ev < at ? 'done' : ev === at ? 'now' : 'todo';
  }

  private renderTimeline(): void {
    const tl = this.tl;
    const at = this.at;
    const labels = h('div', { class: 'ffr-labels' }, h('div', { class: 'ffr-hdr' }), ...Array.from({ length: tl.stages }, (_, s) => h('div', { class: `ffr-lab s${s}` }, stageName(s))));
    const items: HTMLElement[] = [labels];
    for (const run of tl.runs) {
      const curRun = this.beats[this.cursor]?.run === run.index;
      const weight = Math.max(2, ...run.lanes.map((l) => l.reduce((n, b) => n + Math.max(1, b.rows), 0))) + 1;
      const lanes = run.lanes.map((lane, s) => {
        const blocks = lane.map((b) => this.blockEl(run, b));
        if (!lane.length && s > 0) blocks.push(h('span', { class: 'ffr-idle' }, run.internal ? '' : 'idle'));
        if (run.threaded && run.evJoin >= 0) blocks.push(h('span', { class: `ffr-wait ${at >= run.evJoin ? 'done' : ''}`, title: 'Waits here until every stage has finished the run' }));
        return h('div', { class: `ffr-lane s${s}` }, ...blocks);
      });
      const runEl = h(
        'div',
        { class: `ffr-run k-${run.kind}${run.internal ? ' internal' : ''}${curRun ? ' cur' : ''}${run.ev > at ? ' todo' : ''}`, style: `flex-grow:${weight}` },
        h('div', { class: 'ffr-hdr' }, h('span', { class: 'ffr-phase' }, run.internal ? 'built-in' : run.phases.join(' · ') || ' '), h('span', { class: 'ffr-kind', title: kindLabel(run.kind, run.threaded) }, run.kind === 'multi' ? (run.threaded ? 'threaded' : 'multi, 1 stage') : run.kind)),
        h('div', { class: 'ffr-lanes' }, ...lanes),
      );
      items.push(runEl);
      const rb = tl.rebuilds.find((r) => run.merge && r.ev > run.merge.ev && r.ev <= run.merge.evEnd + 1);
      if (run.merge) items.push(this.syncEl(run, !!rb));
    }
    this.els.tline.replaceChildren(...items);
    this.els.tline.querySelector('.ffr-blk.now, .ffr-sync.now')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  private blockEl(run: Run, b: Block): HTMLElement {
    const at = this.at;
    const state = b.ev > at ? 'todo' : b.evEnd < at ? 'done' : 'now';
    const sel = this.sel?.kind === 'block' && this.sel.run === run.index && this.sel.system === b.system;
    // One table: its row range. Several: how many rows (the table panel shows which).
    const one = b.slices.length === 1 ? b.slices[0] : null;
    const rowsText = !b.rows ? '' : run.threaded && one ? `rows ${rowRange(one.offset, one.count)}` : `${b.rows} row${b.rows === 1 ? '' : 's'}${b.slices.length > 1 ? ` · ${b.slices.length} tables` : ''}`;
    const rows = rowsText ? h('span', { class: 'ffr-rows' }, rowsText) : null;
    return h(
      'button',
      {
        type: 'button',
        class: `ffr-blk ${state}${b.internal ? ' internal' : ''}${sel ? ' sel' : ''}`,
        style: `flex-grow:${Math.max(1, b.rows)}`,
        title: `${b.name} on ${stageName(b.stage)}: ${b.slices.map((x) => `${this.tname(x.table)} rows ${rowRange(x.offset, x.count)}`).join('; ') || 'no rows'}`,
        onclick: () => {
          this.stop();
          this.sel = { kind: 'block', run: run.index, system: b.system };
          this.render();
        },
      },
      h('span', { class: 'ffr-bname' }, b.name.replace(/^flecs\.script\./, '')),
      rows,
    );
  }

  private syncEl(run: Run, rebuilt: boolean): HTMLElement {
    const m = run.merge!;
    const at = this.at;
    const state = m.ev > at ? 'todo' : m.evEnd < at ? 'done' : 'now';
    const sel = this.sel?.kind === 'sync' && this.sel.run === run.index;
    const label = m.immediate ? 'flush' : 'sync';
    return h(
      'button',
      {
        type: 'button',
        class: `ffr-sync ${state}${m.commands ? ' busy' : ''}${sel ? ' sel' : ''}${m.immediate ? ' imm' : ''}`,
        title: `${m.immediate ? 'Flush' : 'Merge'}: ${m.commands} command${m.commands === 1 ? '' : 's'}. Click for why it's here and what it ran.`,
        onclick: () => {
          this.stop();
          this.sel = { kind: 'sync', run: run.index };
          this.render();
        },
      },
      h('span', { class: 'ffr-synct' }, label),
      h('span', { class: 'ffr-syncn' }, String(m.commands)),
      rebuilt ? h('span', { class: 'ffr-rebuilt', title: 'The schedule was rebuilt after this merge' }, '↻') : null,
    );
  }

  /** What the detail panel shows: the user's selection, or wherever the cursor is. */
  private focus(): Selection {
    if (this.sel) return this.sel;
    const b = this.beats[this.cursor];
    if (!b || b.run < 0) return null;
    const run = this.tl.runs[b.run];
    if (b.merging) return { kind: 'sync', run: b.run };
    const blk = [...run.lanes.flat()].filter((x) => x.ev <= b.ev).sort((a, c) => c.ev - a.ev)[0];
    if (blk) return { kind: 'block', run: b.run, system: blk.system };
    return b.run > 0 && this.tl.runs[b.run - 1].merge ? { kind: 'sync', run: b.run - 1 } : null;
  }

  private renderDetail(): void {
    const f = this.focus();
    if (!f) {
      this.els.detail.replaceChildren(h('p', { class: 'ffr-hint' }, 'Step through the frame, or click a system or a sync bar.'));
      return;
    }
    const run = this.tl.runs[f.run];
    const kids = f.kind === 'sync' ? this.syncDetail(run) : this.blockDetail(run, f.system);
    this.els.detail.replaceChildren(...kids.filter((k): k is Node | string => !!k));
  }

  private syncDetail(run: Run): Child[] {
    const m = run.merge!;
    const next = this.tl.runs[run.index + 1];
    const why: Child[] = [];
    if (m.immediate) why.push(h('li', {}, `${run.systems.map((s) => this.name(s)).join(', ')} is immediate: what it queued through the stage is flushed as soon as it returns, before the next run.`));
    if (!next) why.push(h('li', {}, this.isMain() ? 'End of the frame: every run ends with a merge. Commands nobody declared land here.' : 'End of this pipeline run: its last run ends with a merge too.'));
    else for (const r of next.reasons) why.push(h('li', {}, ...this.reasonText(r)));
    const rb = this.tl.rebuilds.find((r) => r.ev > m.ev && r.ev <= m.evEnd + 1);
    const stages = m.stages.length ? h('p', { class: 'ffr-sub' }, `Queues flushed in stage order: ${m.stages.map((s) => `${stageName(s.stage)}: ${s.count}`).join(' · ')}`) : null;
    return [
      h('h4', {}, `${m.immediate ? 'Flush after' : 'Sync point after'} run ${run.index + 1}: ${m.commands} command${m.commands === 1 ? '' : 's'}`),
      h('p', { class: 'ffr-sub' }, m.immediate ? 'Why it is here' : 'Why there is a sync here'),
      h('ul', { class: 'ffr-why' }, ...why),
      stages,
      rb ? h('p', { class: 'ffr-rb' }, `↻ After this merge the schedule was rebuilt${rb.activated.length ? `: ${rb.activated.join(', ')} now ${rb.activated.length > 1 ? 'match' : 'matches'} something and ${rb.activated.length > 1 ? 'run' : 'runs'} later in this frame` : ''}.`) : null,
      m.tree.length ? h('p', { class: 'ffr-sub' }, 'What it ran (indented = triggered by the line above)') : null,
      this.treeEl(m.tree),
    ];
  }

  private isMain(): boolean {
    return !this.sc.steps[this.step].pipeline;
  }

  private reasonText(r: Reason): Child[] {
    // A fresh element each time: a DOM node can only be in one place.
    const sys = () => h('code', {}, r.system);
    const out: Child[] = [];
    if (r.internal) out.push(h('span', { class: 'ffr-tag' }, 'built-in'), ' ');
    if (!r.active) {
      out.push(sys(), ' matches nothing yet, so it isn\'t scheduled, but something it matches may be queued. The merge stays so it can start matching.');
      return out;
    }
    if (r.bits & 1)
      for (const t of r.terms) {
        const w = t.writers.length ? t.writers.map((x) => x).join(', ') : 'an earlier system';
        if (t.how === 1) out.push(sys(), ' matches ', h('code', {}, t.id), ' on its own entities, and ', h('code', {}, w), ' declared that it may queue it. Merging first, so ', sys(), ' iterates the entities\' new tables.');
        else out.push(sys(), ' reads ', h('code', {}, t.id), ' from somewhere other than its own entities (a singleton or a declared read), and ', h('code', {}, w), ' may have queued it.');
      }
    if (r.bits & 2) out.push(out.length ? ' Also, ' : '', sys(), r.prevKind === 'multi' ? ' is not multi_threaded and ' : ' is multi_threaded and ', h('code', {}, r.prevName ?? 'the system before it'), r.prevKind === 'multi' ? ' is' : ' isn\'t', '. A run has one threading mode, so a new run starts.');
    if (r.bits & 8) out.push(out.length ? ' ' : '', sys(), ' is immediate: it always runs alone, on a writable world.');
    else if (r.bits & 4) out.push(out.length ? ' ' : '', h('code', {}, r.prevName ?? 'the system before it'), ' is immediate and ', sys(), ' isn\'t, so a new run starts.');
    return out;
  }

  private blockDetail(run: Run, system: number): Child[] {
    const info = this.rec.systems.get(system);
    const def = this.sc.systems.find((s) => s.name === info?.name);
    const name = info?.name ?? this.name(system);
    const out: Child[] = [h('h4', {}, name, ' ', h('span', { class: 'ffr-tag' }, run.internal ? 'built-in' : KIND_TEXT[info?.kind ?? 'single']))];
    if (run.internal) {
      out.push(h('p', {}, `flecs' own system: ${name} is immediate and in PreUpdate (the script add-on's task runner), so every frame of an app with that add-on has a run of its own here, with a sync point before and after it.`));
      return out;
    }
    // Rows per stage.
    const blocks = run.lanes.flat().filter((b) => b.system === system);
    const rows = blocks.map((b) => `${stageName(b.stage)}: ${b.slices.map((s) => `${this.tname(s.table)} rows ${rowRange(s.offset, s.count)}`).join(', ') || 'no rows'}`);
    out.push(h('ul', { class: 'ffr-rowsl' }, ...rows.map((r) => h('li', {}, r))));
    // Why it shares a run (or doesn't).
    const b = builds(this.rec).filter(([s]) => this.rec.steps[s].pipeline === this.rec.steps[this.step].pipeline && s <= this.step).pop()?.[1];
    const first = run.systems[0] === system;
    if (b && !first) {
      const nm = noMergeWhy(b, system);
      if (nm) {
        const queued = [...nm.queued.entries()].map(([id, ws]) => `${id} (by ${ws.join(', ')})`);
        out.push(
          h(
            'p',
            { class: 'ffr-sub' },
            `No sync before ${name}: it's the same kind as ${nm.prev ?? 'the system before it'}, and none of its terms match anything a system in this run declared it may queue${queued.length ? ` (declared so far: ${queued.join(', ')})` : ' (nothing declared so far)'}. Writing a field isn't a command, and [in] on its own terms doesn't move merges.`,
          ),
        );
      }
    } else if (first) out.push(h('p', { class: 'ffr-sub' }, 'First system of this run. Click the sync bar before it for why the run starts here.'));
    // An immediate system's own on-the-spot work.
    if (info?.kind === 'immediate') {
      const blk = blocks[0];
      const st = this.rec.steps[this.step];
      const tree = blk ? immediateTree(st.events, blk, (e) => this.name(e), (t) => this.tname(t)) : [];
      if (tree.length) out.push(h('p', { class: 'ffr-sub' }, 'Inside the system (the world is writable: world operations apply on the spot)'), this.treeEl(tree));
    }
    // Toggles.
    if (def && this.sc.toggles) {
      const kinds: Kind[] = ['single', 'multi', 'immediate'];
      const seg = h(
        'div',
        { class: 'ffr-seg', role: 'group', 'aria-label': `${name} kind` },
        ...kinds.map((k) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(this.cfg.kinds[def.name] === k),
              onclick: () => {
                this.cfg = { ...this.cfg, kinds: { ...this.cfg.kinds, [def.name]: k } };
                this.rerecord(true);
              },
            },
            KIND_TEXT[k],
          ),
        ),
      );
      const decls = (def.declares ?? []).map((d, i) => {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = !!this.cfg.declared[def.name]?.[i];
        cb.addEventListener('change', () => {
          const arr = [...(this.cfg.declared[def.name] ?? [])];
          arr[i] = cb.checked;
          this.cfg = { ...this.cfg, declared: { ...this.cfg.declared, [def.name]: arr } };
          this.rerecord(true);
        });
        return h('label', { class: 'ffr-check' }, cb, h('code', {}, d.cpp));
      });
      out.push(h('div', { class: 'ffr-toggles' }, h('span', { class: 'ffr-sub' }, 'Try:'), seg, ...decls));
      out.push(h('pre', { class: 'ffr-pre small' }, systemCpp(def, this.cfg.kinds[def.name], this.cfg.declared[def.name] ?? [])));
    }
    return out;
  }

  private treeEl(nodes: TreeNode[]): HTMLElement {
    const at = this.at;
    const mk = (n: TreeNode): HTMLElement | HTMLElement[] => {
      if (n.kind === 'flush' && n.depth === 0) return n.children.flatMap(mk);
      if (n.kind === 'flush' && n.text.startsWith('the system')) return [h('li', { class: `ffr-n k-flush ${this.state(n.ev)}` }, h('span', {}, n.text), h('ul', {}, ...n.children.flatMap(mk)))];
      const cls = `ffr-n k-${n.kind} ${n.ev < at ? 'done' : n.ev === at ? 'now' : 'todo'}${n.warn ? ' warn' : ''}${n.internal ? ' internal' : ''}`;
      const kids = n.children.flatMap(mk);
      return h('li', { class: cls }, h('span', { class: 'ffr-ntext' }, n.text), kids.length ? h('ul', {}, ...kids) : null);
    };
    return h('ul', { class: 'ffr-tree' }, ...nodes.flatMap(mk));
  }

  // ---------------------------------------------------------------- side panels

  private storageAt(): StorageModel {
    const st = this.rec.steps[this.step];
    const m = st.before.clone();
    const types = new Map(st.types);
    const at = this.at;
    for (let i = 0; i <= at && i < st.events.length; i++) m.apply(st.events[i], st.after, types);
    return m;
  }

  private renderTables(): void {
    const m = this.storageAt();
    const beat = this.beats[this.cursor];
    const run = beat && beat.run >= 0 ? this.tl.runs[beat.run] : null;
    // Which stage owns each row of each table in the current threaded run (its latest system so far).
    const owner = new Map<number, number[]>();
    if (run?.threaded && !beat?.merging) {
      for (const b of run.lanes.flat())
        for (const s of b.slices) {
          if (s.ev > this.at) continue;
          const arr = owner.get(s.table) ?? [];
          for (let r = s.offset; r < s.offset + s.count; r++) arr[r] = b.stage;
          owner.set(s.table, arr);
        }
    }
    const tables = m.sortedTables().filter((t) => t.rows.length || owner.has(t.id));
    this.els.tables.replaceChildren(
      ...tables.map((t) => {
        const own = owner.get(t.id);
        const split = own && this.tl.stages > 1 ? splitRows(t.rows.length, this.tl.stages) : null;
        return h(
          'div',
          { class: 'ffr-table' },
          h('div', { class: 'ffr-ttype' }, tableName(t.type.map((c) => c.str), t.id), split ? h('span', { class: 'ffr-ruler', title: 'How flecs splits a table over the stages: equal shares, the remainder to the first stages' }, ` ${t.rows.length} ÷ ${this.tl.stages} → ${split.join(' · ')}`) : null),
          h('div', { class: 'ffr-trows' }, ...t.rows.map((e, r) => h('span', { class: `ffr-row${own?.[r] !== undefined ? ` s${own[r]}` : ''}`, title: `row ${r}` }, this.name(e)))),
        );
      }),
    );
  }

  private renderQueues(): void {
    const beat = this.beats[this.cursor];
    const run = beat && beat.run >= 0 ? this.tl.runs[beat.run] : null;
    if (!run) {
      this.els.queues.replaceChildren(h('p', { class: 'ffr-hint' }, 'Empty.'));
      return;
    }
    const at = this.at;
    const m = run.merge;
    const cols = run.queued.map((items, s) => {
      const fl = m?.stages.find((x) => x.stage === s);
      const next = m?.stages.find((x) => x.stage === s + 1);
      const flushStart = fl ? fl.ev : m && m.immediate ? m.ev : Infinity;
      const flushEnd = next ? next.ev : m ? m.evEnd : Infinity;
      const status = at >= flushEnd ? 'gone' : at >= flushStart ? 'draining' : '';
      const shown = items.filter((x) => x.ev <= at);
      return h(
        'div',
        { class: `ffr-q s${s} ${status}` },
        h('div', { class: 'ffr-qh' }, stageName(s), status === 'draining' ? ' · merging' : status === 'gone' ? ' · merged' : ''),
        ...(shown.length ? shown.map((x) => h('div', { class: 'ffr-qi' }, x.text)) : [h('div', { class: 'ffr-qi empty' }, '—')]),
      );
    });
    this.els.queues.replaceChildren(...cols);
  }

  private renderCode(): void {
    const v = this.sc.variants?.[this.cfg.variant];
    const parts = [this.sc.setupCode.replace('set_threads(3)', `set_threads(${this.cfg.stages})`).replace('set_threads(2)', `set_threads(${this.cfg.stages})`)];
    const extra = v?.setupCodeExtra ?? this.sc.setupCodeExtra;
    if (extra) parts.push(extra);
    for (const s of this.sc.systems) parts.push(systemCpp(s, this.cfg.kinds[s.name], this.cfg.declared[s.name] ?? []));
    this.els.code.textContent = parts.join('\n\n');
  }
}

function stepShort(label: string, i: number): string {
  const m = /^(Frame \d+)/.exec(label);
  if (m) return m[1];
  return label.startsWith('world.run_pipeline') ? `physics ${i + 1}` : label.replace(/^world\./, '');
}
