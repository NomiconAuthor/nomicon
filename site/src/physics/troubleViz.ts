/** "When physics goes wrong": four mistakes, each with its fix one tick away. */
import { h, seg } from '../engine/dom';
import { type Problem, type TroubleScene, troubleScene } from './trouble';
import { PhysicsView } from './view';

const NOTES: Record<Problem, { label: string; symptom: (x: number) => string; fix: string }> = {
  crush: {
    label: 'Heavy on light',
    symptom: (x) => `The light box has been pushed up to ${(x * 100).toFixed(1)} cm into the ground or the block.`,
    fix: 'Keep mass ratios under about 10 to 1 (the box is made 200 times denser)',
  },
  chain: {
    label: 'Heavy on a chain',
    symptom: (x) => (x < 0.005 ? 'The chain has kept its 4.4 m length.' : `The chain has stretched up to ${x.toFixed(2)} m past its 4.4 m length.`),
    fix: 'Add a rope: one distance limit from the anchor straight to the weight',
  },
  spawn: {
    label: 'Spawned inside',
    symptom: (x) => `Fastest box so far: ${x.toFixed(1)} m/s.`,
    fix: 'Check for room first, and spawn above anything in the way',
  },
  platform: {
    label: 'Moved by position',
    symptom: (x) => `The crate has slid up to ${x.toFixed(2)} m from the platform's centre${x > 1.8 ? ', off the edge' : ''}.`,
    fix: 'Move the platform by velocity, not by setting its position',
  },
};

export class TroubleViz {
  private view: PhysicsView;
  private problem: Problem = 'crush';
  private fix = false;
  private scene: TroubleScene;
  private out = h('div', { class: 'll-muted ph-result' });
  private fixBox: HTMLInputElement;
  private fixText = h('span', {});

  constructor(host: HTMLElement) {
    const root = h('div', { class: 'll ph ph-trouble' });
    host.replaceChildren(root);
    this.scene = troubleScene(this.problem, this.fix);
    this.view = new PhysicsView(this.scene.world, { view: this.scene.view, label: 'A physics mistake and its fix' });
    this.view.ground = this.scene.ground;
    this.view.beforeStep = (dt) => this.scene.before(this.view.world.time, dt);
    this.view.onStep = () => this.result();
    this.fixBox = h('input', {
      type: 'checkbox',
      onchange: (e: Event) => {
        this.fix = (e.target as HTMLInputElement).checked;
        this.reset();
      },
    }) as HTMLInputElement;
    const play = h('button', { type: 'button', class: 'll-btn primary', onclick: () => {
      this.view.playing = !this.view.playing;
      play.textContent = this.view.playing ? 'Pause' : 'Play';
    } }, 'Pause');
    root.append(
      seg<Problem>('Problem', (Object.keys(NOTES) as Problem[]).map((p) => [p, NOTES[p].label]), this.problem, (p) => {
        this.problem = p;
        this.reset();
      }).el,
      h('div', { class: 'll-row' }, h('label', { class: 'll-chk' }, this.fixBox, ' Fix: ', this.fixText)),
      h('div', { class: 'll-row' }, play, h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, 'Run again')),
      this.view.canvas,
      this.out,
    );
    this.result();
  }

  private reset(): void {
    this.scene = troubleScene(this.problem, this.fix);
    this.view.ground = this.scene.ground;
    this.view.setWorld(this.scene.world, this.scene.view);
    this.result();
  }

  private result(): void {
    const n = NOTES[this.problem];
    this.fixText.textContent = n.fix;
    this.fixBox.checked = this.fix;
    this.out.textContent = n.symptom(this.scene.worst());
  }
}
