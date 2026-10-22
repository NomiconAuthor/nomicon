/** Tiny element builder shared by the engine, AI and steering widgets. */
export type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

/** A row of segmented buttons; returns the element and a setter. */
export function seg<T extends string>(label: string, options: Array<[T, string]>, value: T, onChange: (v: T) => void): { el: HTMLElement; set: (v: T) => void } {
  const btns = options.map(([v, text]) =>
    h('button', { type: 'button', class: 'll-seg-b', 'aria-pressed': String(v === value), onclick: () => pick(v) }, text),
  );
  const pick = (v: T) => {
    btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === v)));
    onChange(v);
  };
  return {
    el: h('div', { class: 'll-seg', role: 'group', 'aria-label': label }, h('span', { class: 'll-seg-l' }, label), ...btns),
    set: (v: T) => btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === v))),
  };
}

export const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
