type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** Tiny element builder: h('button', { class: 'primary', onclick: fn }, 'Run'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'html') {
      el.innerHTML = String(v);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function option(value: string, label: string, selected: boolean, disabled = false): HTMLOptionElement {
  const o = h('option', { value }, label);
  o.selected = selected;
  o.disabled = disabled;
  return o;
}

export function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${fmt(ms * 1000, 0)} µs`;
  if (ms < 100) return `${fmt(ms, 2)} ms`;
  return `${fmt(ms, 0)} ms`;
}
