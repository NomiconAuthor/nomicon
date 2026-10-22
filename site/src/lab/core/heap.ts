/**
 * Binary min-heap of integer ids keyed by a float priority.
 * Uses "lazy deletion": pushing an id that is already queued adds a second
 * entry, and callers skip stale entries when they pop (check a closed set or
 * compare against the current best g). This is how most game A* implementations
 * avoid a decrease-key operation.
 *
 * Ties are broken by a secondary key (smaller wins), which the searches use to
 * prefer nodes with a larger g (closer to the goal) — see the field guide's
 * note on tie-breaking.
 */
export class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  private ties: Float64Array;
  private n = 0;

  constructor(capacity = 1024) {
    this.ids = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.ties = new Float64Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  push(id: number, key: number, tie = 0): void {
    if (this.n === this.ids.length) this.grow();
    let i = this.n++;
    // Sift up.
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(key, tie, this.keys[p], this.ties[p])) {
        this.ids[i] = this.ids[p];
        this.keys[i] = this.keys[p];
        this.ties[i] = this.ties[p];
        i = p;
      } else break;
    }
    this.ids[i] = id;
    this.keys[i] = key;
    this.ties[i] = tie;
  }

  /** Key of the top entry (Infinity when empty). */
  peekKey(): number {
    return this.n > 0 ? this.keys[0] : Infinity;
  }

  pop(): number {
    const top = this.ids[0];
    const last = --this.n;
    if (last > 0) {
      const id = this.ids[last];
      const key = this.keys[last];
      const tie = this.ties[last];
      let i = 0;
      // Sift down.
      for (;;) {
        const l = 2 * i + 1;
        if (l >= last) break;
        const r = l + 1;
        const c = r < last && this.less(this.keys[r], this.ties[r], this.keys[l], this.ties[l]) ? r : l;
        if (this.less(this.keys[c], this.ties[c], key, tie)) {
          this.ids[i] = this.ids[c];
          this.keys[i] = this.keys[c];
          this.ties[i] = this.ties[c];
          i = c;
        } else break;
      }
      this.ids[i] = id;
      this.keys[i] = key;
      this.ties[i] = tie;
    }
    return top;
  }

  private less(ka: number, ta: number, kb: number, tb: number): boolean {
    // Keys within a tiny epsilon count as equal so float noise doesn't defeat tie-breaking.
    const d = ka - kb;
    if (d < -1e-9) return true;
    if (d > 1e-9) return false;
    return ta < tb;
  }

  private grow(): void {
    const cap = this.ids.length * 2;
    const ids = new Int32Array(cap);
    ids.set(this.ids);
    const keys = new Float64Array(cap);
    keys.set(this.keys);
    const ties = new Float64Array(cap);
    ties.set(this.ties);
    this.ids = ids;
    this.keys = keys;
    this.ties = ties;
  }
}
