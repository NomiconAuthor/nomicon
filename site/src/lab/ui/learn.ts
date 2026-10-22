import { CONCEPTS, GLOSSARY, type Term } from '../learn/concepts';
import { h } from './dom';

// ---------------------------------------------------------------------------
// Glossary links in running text
// ---------------------------------------------------------------------------

export type Linker = (text: string, seen?: Set<string>) => DocumentFragment;

/**
 * A function that turns the first mention of each glossary term in running text
 * into a hoverable link. Pass the same `seen` set to several calls to link each
 * term once per block.
 */
export function makeLinker(glossary: Record<string, Term>): Linker {
  const aliases: Array<[string, string]> = Object.entries(glossary)
    .flatMap(([id, t]) => t.aliases.map((a): [string, string] => [a.toLowerCase(), id]))
    .sort((a, b) => b[0].length - a[0].length);
  const aliasToId = new Map(aliases);
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole words only; "A*" style names keep their star.
  const re = new RegExp(`(?<![\\w-])(${aliases.map(([a]) => escape(a)).join('|')})(?![\\w-])`, 'gi');
  return (text, seen = new Set()) => {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      const id = aliasToId.get(m[0].toLowerCase());
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const at = m.index ?? 0;
      if (at > last) frag.append(text.slice(last, at));
      frag.append(h('button', { type: 'button', class: 'term', 'data-term': id, 'aria-describedby': 'term-pop' }, m[0]));
      last = at + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  };
}

/** The pathing lab's linker. */
export const linkTerms: Linker = makeLinker(GLOSSARY);

// ---------------------------------------------------------------------------
// Popover + Concepts drawer
// ---------------------------------------------------------------------------

/** What the panel needs from a concept card. */
export interface LearnConcept {
  id: string;
  group: string;
  title: string;
  body: string[];
  look?: string;
  tries: Array<{ label: string }>;
}

export interface LearnData<C extends LearnConcept> {
  concepts: C[];
  glossary: Record<string, Term>;
  intro: string;
}

const PATHING: LearnData<LearnConcept> = {
  concepts: CONCEPTS,
  glossary: GLOSSARY,
  intro: 'Short explanations of the ideas behind the lab. "Try it" sets the maps up to show the idea. Underlined words anywhere in the lab explain themselves on hover.',
};

/** The shared term popover and the Concepts panel. One per page. */
export class Learn<C extends LearnConcept = LearnConcept> {
  private pop: HTMLElement;
  private popFor: HTMLElement | null = null;
  private pinned = false;
  private hideTimer = 0;
  private drawer: HTMLElement;
  private cards = new Map<string, HTMLDetailsElement>();
  private toggleBtn: HTMLButtonElement;
  private returnFocus: HTMLElement | null = null;

  private data: LearnData<C>;
  readonly link: Linker;

  constructor(
    private onTry: (concept: C, t: C['tries'][number]) => void,
    data?: LearnData<C>,
  ) {
    this.data = data ?? (PATHING as unknown as LearnData<C>);
    this.link = data ? makeLinker(data.glossary) : linkTerms;
    this.pop = h('div', {
      class: 'term-pop',
      id: 'term-pop',
      role: 'tooltip',
      hidden: true,
    });
    this.pop.addEventListener('pointerenter', () => window.clearTimeout(this.hideTimer));
    this.pop.addEventListener('pointerleave', () => this.scheduleHide());
    this.drawer = this.buildDrawer();
    this.toggleBtn = h(
      'button',
      {
        type: 'button',
        class: 'concepts-btn',
        'aria-expanded': 'false',
        'aria-controls': 'concepts',
        onclick: () => (this.isOpen() ? this.close() : this.open()),
      },
      'Concepts',
    );
    // The site navbar has a slot for page actions; the standalone lab has its own header.
    const slot = document.querySelector('[data-nav-slot]');
    if (slot) slot.append(this.toggleBtn);
    else document.querySelector('header.top')?.append(h('span', { class: 'spacer' }), this.toggleBtn);
    document.body.append(this.pop, this.drawer);

    // Delegated, so terms anywhere on the page (lane info, cards) just work.
    document.addEventListener('pointerover', (e) => {
      const t = (e.target as HTMLElement).closest?.('.term') as HTMLElement | null;
      if (t && e.pointerType !== 'touch' && !this.pinned) this.show(t);
    });
    document.addEventListener('pointerout', (e) => {
      const t = (e.target as HTMLElement).closest?.('.term');
      if (t && !this.pinned) this.scheduleHide();
    });
    document.addEventListener('focusin', (e) => {
      const t = (e.target as HTMLElement).closest?.('.term') as HTMLElement | null;
      if (t && !this.pinned) this.show(t);
    });
    document.addEventListener('focusout', (e) => {
      const t = (e.target as HTMLElement).closest?.('.term');
      const next = e.relatedTarget as Node | null;
      if (t && !this.pinned && !(next && this.pop.contains(next))) this.scheduleHide();
    });
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const t = target.closest?.('.term') as HTMLElement | null;
      if (t) {
        e.preventDefault();
        if (this.pinned && this.popFor === t) {
          this.hide();
        } else {
          this.show(t);
          this.pinned = true;
          this.pop.classList.add('pinned');
        }
        return;
      }
      if (this.pinned && !this.pop.contains(target)) this.hide();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.pop.hidden) {
        const back = this.popFor;
        this.hide();
        back?.focus();
      } else if (this.isOpen()) this.close();
    });
    window.addEventListener('resize', () => this.hide());
    // Links like /pathing-lab/#concept-astar (from search) open that card.
    const fromHash = () => {
      const m = location.hash.match(/^#concept-([\w-]+)$/);
      if (m && this.data.concepts.some((c) => c.id === m[1])) this.open(m[1]);
    };
    window.addEventListener('hashchange', fromHash);
    setTimeout(fromHash);
  }

  // ---------------- Popover ----------------

  private show(term: HTMLElement): void {
    window.clearTimeout(this.hideTimer);
    const id = term.dataset.term ?? '';
    const g = this.data.glossary[id];
    if (!g) return;
    this.popFor = term;
    this.pinned = false;
    this.pop.classList.remove('pinned');
    this.pop.innerHTML = '';
    const concept = g.concept ? this.data.concepts.find((c) => c.id === g.concept) : undefined;
    this.pop.append(
      h('div', { class: 'tp-term' }, g.term),
      h('p', {}, g.def),
      ...(concept
        ? [
            h(
              'button',
              {
                type: 'button',
                class: 'tp-more',
                onclick: () => {
                  this.hide();
                  this.open(concept.id);
                },
              },
              `${concept.title} →`,
            ),
          ]
        : []),
    );
    this.pop.hidden = false;
    this.place(term);
  }

  private place(term: HTMLElement): void {
    const r = term.getBoundingClientRect();
    const pw = this.pop.offsetWidth;
    const ph = this.pop.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let x = Math.min(Math.max(8, r.left), vw - pw - 8);
    let y = r.bottom + 6;
    if (y + ph > vh - 8 && r.top - ph - 6 > 8) y = r.top - ph - 6;
    x = Math.max(8, x);
    this.pop.style.left = `${x}px`;
    this.pop.style.top = `${y}px`;
  }

  private scheduleHide(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), 180);
  }

  private hide(): void {
    window.clearTimeout(this.hideTimer);
    this.pop.hidden = true;
    this.pinned = false;
    this.popFor = null;
  }

  // ---------------- Drawer ----------------

  private buildDrawer(): HTMLElement {
    const list = h('div', { class: 'cx-list' });
    const { concepts } = this.data;
    const groups = [...new Set(concepts.map((c) => c.group))];
    for (const g of groups) {
      list.append(h('h3', { class: 'cx-group' }, g));
      for (const c of concepts.filter((k) => k.group === g)) {
        const seen = new Set<string>();
        const card = h(
          'details',
          { class: 'cx-card', id: `concept-${c.id}` },
          h('summary', {}, c.title),
          ...c.body.map((p) => h('p', {}, this.link(p, seen))),
          c.look ? h('p', { class: 'cx-look' }, h('b', {}, 'Look for: '), c.look) : null,
          c.tries.length
            ? h(
                'div',
                { class: 'cx-tries' },
                ...c.tries.map((t) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'cx-try',
                      onclick: () => {
                        this.close(false);
                        this.onTry(c, t);
                      },
                    },
                    `Try it: ${t.label}`,
                  ),
                ),
              )
            : null,
        );
        this.cards.set(c.id, card);
        list.append(card);
      }
    }
    return h(
      'aside',
      {
        class: 'concepts',
        id: 'concepts',
        'aria-label': 'Concepts',
        hidden: true,
      },
      h(
        'div',
        { class: 'cx-head' },
        h('h2', {}, 'Concepts'),
        h(
          'button',
          {
            type: 'button',
            class: 'cx-close',
            'aria-label': 'Close concepts',
            onclick: () => this.close(),
          },
          '×',
        ),
      ),
      h(
        'p',
        { class: 'cx-intro' },
        this.data.intro,
      ),
      list,
    );
  }

  isOpen(): boolean {
    return !this.drawer.hidden;
  }

  /** Open the panel, optionally scrolled to (and expanding) one concept. */
  open(id?: string): void {
    if (!this.isOpen()) this.returnFocus = document.activeElement as HTMLElement | null;
    this.drawer.hidden = false;
    this.toggleBtn.setAttribute('aria-expanded', 'true');
    const card = id ? this.cards.get(id) : undefined;
    if (card) {
      card.open = true;
      card.scrollIntoView({ block: 'start' });
      card.querySelector('summary')?.focus();
    } else this.drawer.querySelector<HTMLElement>('.cx-close')?.focus();
  }

  close(restoreFocus = true): void {
    this.drawer.hidden = true;
    this.toggleBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) (this.returnFocus ?? this.toggleBtn).focus();
    this.returnFocus = null;
  }

  /** True when a keyboard event belongs to the panel or popover, not the lab's shortcuts. */
  owns(target: EventTarget | null): boolean {
    return target instanceof Node && (this.drawer.contains(target) || this.pop.contains(target));
  }
}
