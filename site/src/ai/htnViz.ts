/** The HTN lesson's widgets: a step-through decomposition, and the domain it uses. */
import { h } from './ui';
import { type FactState, FACTS, FACT_LABEL, GOALS, plan as goapPlan } from './brains';
import { DOMAIN, DOMAIN_ORDER, PRIMITIVES, ROOT, factText, htnPlan, type HtnEvent, type HtnResult } from './htn';

/** Which GOAP goal matches each root method, for the side-by-side line. */
const GOAP_GOAL: Record<string, string> = { 'Patch up': 'Get healthy', Fight: 'Kill the enemy', 'Restock potion': 'Carry a potion', 'Get ready': 'Recharge' };

export class HtnViz {
  private root: HTMLElement;
  private start: FactState = { enemyDead: false, inRange: false, inCover: false, staffCharged: false, hasCrystals: true, hasPotion: false, potionAvailable: true, healthy: true };
  private res!: HtnResult;
  private shown = 0;
  private timer = 0;
  private facts = h('div', { class: 'ai-facts' });
  private domain = h('div', { class: 'htn-domain' });
  private trace = h('ol', { class: 'htn-trace' });
  private out = h('div', { class: 'ai-goap-out' });
  private count = h('span', { class: 'll-muted' });
  private playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.togglePlay() }, 'Play') as HTMLButtonElement;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ai ai-htn' });
    host.replaceChildren(this.root);
    this.root.append(
      h('div', { class: 'll-h' }, 'Current world state (click to toggle)'),
      this.facts,
      h(
        'div',
        { class: 'll-row' },
        h('button', { type: 'button', class: 'll-btn', title: 'Back to the start', onclick: () => (this.pause(), this.show(0)) }, '⏮'),
        h('button', { type: 'button', class: 'll-btn', title: 'Back one step', onclick: () => (this.pause(), this.show(this.shown - 1)) }, '◀'),
        this.playBtn,
        h('button', { type: 'button', class: 'll-btn', title: 'One step', onclick: () => (this.pause(), this.show(this.shown + 1)) }, '▶|'),
        h('button', { type: 'button', class: 'll-btn', title: 'Jump to the result', onclick: () => (this.pause(), this.show(this.res.events.length)) }, '⏭'),
        this.count,
      ),
      h('div', { class: 'htn-cols' }, h('div', {}, h('div', { class: 'll-h' }, 'Decomposition'), this.trace), h('div', {}, h('div', { class: 'll-h' }, 'The domain (methods in priority order)'), this.domain)),
      this.out,
    );
    this.replan();
  }

  private togglePlay(): void {
    if (this.timer) return this.pause();
    if (this.shown >= this.res.events.length) this.show(0);
    this.playBtn.textContent = 'Pause';
    this.timer = window.setInterval(() => {
      this.show(this.shown + 1);
      if (this.shown >= this.res.events.length) this.pause();
    }, 650);
  }
  private pause(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.playBtn.textContent = 'Play';
  }

  private replan(): void {
    this.facts.replaceChildren(
      ...FACTS.map((k) =>
        h(
          'button',
          {
            type: 'button',
            class: 'ai-fact',
            'aria-pressed': String(this.start[k]),
            onclick: () => {
              this.start[k] = !this.start[k];
              this.replan();
            },
          },
          FACT_LABEL[k],
        ),
      ),
    );
    this.res = htnPlan(this.start, ROOT, DOMAIN, true);
    this.pause();
    this.show(this.res.events.length);
  }

  private show(n: number): void {
    const evs = this.res.events;
    this.shown = Math.max(0, Math.min(n, evs.length));
    const done = this.shown >= evs.length;
    const cur = this.shown > 0 ? evs[this.shown - 1] : null;
    const backs = evs.filter((e) => e.k === 'backtrack').length;
    this.count.textContent = done ? `${this.res.steps} decomposition steps, ${backs} backtrack${backs === 1 ? '' : 's'}` : `${this.shown} of ${evs.length} events`;
    this.trace.replaceChildren(...evs.slice(0, this.shown).map((e, i) => this.traceRow(e, i === this.shown - 1)));
    this.trace.scrollTop = this.trace.scrollHeight;
    this.renderDomain(cur, done);
    this.renderResult(done);
  }

  private traceRow(e: HtnEvent, latest: boolean): HTMLElement {
    const li = (cls: string, ...kids: Array<Node | string>) => h('li', { class: `${cls}${latest ? ' latest' : ''}`, style: `--d:${e.depth}` }, ...kids);
    switch (e.k) {
      case 'expand':
        return li('t-expand', h('span', { class: 'htn-c' }, e.task), h('span', { class: 'll-muted' }, ' is compound: try its methods in order'));
      case 'method':
        return li(
          e.ok ? 't-ok' : 't-bad',
          `${e.index + 1}. ${e.method} `,
          e.ok ? h('span', { class: 'ai-trace-s s-success' }, '✓ use it') : h('span', { class: 'ai-trace-s s-failure' }, `✗ ${e.why}`),
        );
      case 'prim':
        return e.ok
          ? li('t-ok', h('span', { class: 'htn-p' }, e.task), ' ', h('span', { class: 'ai-trace-s s-success' }, '✓'), ' ', ...(e.changed.length ? e.changed.map((k) => h('span', { class: `ai-f ${e.state[k] ? 'on' : 'off'}` }, FACT_LABEL[k])) : [h('span', { class: 'll-muted' }, 'no change')]))
          : li('t-bad', h('span', { class: 'htn-p' }, e.task), ' ', h('span', { class: 'ai-trace-s s-failure' }, `✗ needs ${e.why}`));
      case 'backtrack':
        return li('t-back', `↩ ${e.method} fell through: undo its steps, try the next method of ${e.task}`);
      case 'exhausted':
        return li('t-bad', h('span', { class: 'ai-trace-s s-failure' }, `✗ no method of ${e.task} works`));
    }
  }

  private renderDomain(cur: HtnEvent | null, done: boolean): void {
    const chosen = new Set(done ? this.res.mtrNames : []);
    const curTask = cur && cur.k !== 'prim' ? cur.task : '';
    const curMethod = cur && cur.k === 'method' ? cur.method : cur && cur.k === 'backtrack' ? cur.method : '';
    this.domain.replaceChildren(
      ...DOMAIN_ORDER.map((name) => {
        const c = DOMAIN[name];
        return h(
          'div',
          { class: `htn-task ${name === curTask ? 'cur' : ''}` },
          h('div', { class: 'htn-c' }, name),
          h(
            'ol',
            {},
            ...c.methods.map((m) => {
              const cls = [name === curTask && m.name === curMethod ? (cur?.k === 'backtrack' ? 'back' : cur && cur.k === 'method' && !cur.ok ? 'bad' : 'cur') : '', chosen.has(`${name}: ${m.name}`) ? 'chosen' : ''].join(' ');
              return h(
                'li',
                { class: cls },
                h('b', {}, m.name),
                Object.keys(m.pre).length ? h('span', { class: 'll-muted' }, ` if ${factText(m.pre)}`) : '',
                h('span', { class: 'htn-sub' }, ' → ', ...(m.subtasks.length ? m.subtasks.flatMap((s, i) => [i ? ', ' : '', h('span', { class: PRIMITIVES[s] ? 'htn-p' : 'htn-c' }, s)]) : [h('span', { class: 'll-muted' }, 'nothing')])),
              );
            }),
          ),
        );
      }),
      h('p', { class: 'll-muted htn-key' }, h('span', { class: 'htn-c' }, 'Compound'), ' tasks decompose further; ', h('span', { class: 'htn-p' }, 'primitive'), ' tasks are the GOAP actions, with the same needs and effects.'),
    );
  }

  private renderResult(done: boolean): void {
    if (!done) {
      this.out.replaceChildren();
      return;
    }
    const r = this.res;
    if (!r.plan) {
      this.out.replaceChildren(h('div', { class: 'det-bad' }, 'No plan: every method of the root failed.'));
      return;
    }
    const purpose = r.mtrNames[0]?.split(': ')[1] ?? '';
    const goalName = GOAP_GOAL[purpose];
    const goal = GOALS.find((g) => g.name === goalName);
    const g = goal ? goapPlan(this.start, goal.want) : null;
    const same = g?.plan && g.plan.map((a) => a.name).join() === r.plan.map((a) => a.name).join();
    this.out.replaceChildren(
      h(
        'div',
        { class: 'ai-plan' },
        h('span', { class: 'll-h' }, `Plan: ${r.plan.length} step${r.plan.length === 1 ? '' : 's'}, found in ${r.steps} decomposition steps`),
        h('div', { class: 'ai-plan-steps' }, ...(r.plan.length ? r.plan.map((a, i) => h('span', { class: 'ai-step' }, `${i + 1}. ${a.name}`)) : [h('span', { class: 'll-muted' }, 'Nothing to do: the agent patrols.')])),
        h('div', { class: 'll-muted' }, 'Method traversal record: ', h('span', { class: 'mono' }, r.mtrNames.map((n, i) => `${n} (${r.mtr[i] + 1})`).join(' › '))),
        g
          ? h(
              'div',
              { class: 'll-muted' },
              `GOAP with the goal "${goalName}": `,
              g.plan ? `${g.plan.map((a) => a.name).join(' → ') || 'nothing to do'}, ${g.expanded.length} states expanded` : `no plan (${g.expanded.length} states searched)`,
              g.plan ? (same ? '. Same plan.' : '. A different plan.') : '',
            )
          : '',
      ),
    );
  }
}
