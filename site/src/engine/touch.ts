/**
 * Touch screens: let a one-finger vertical swipe over an interactive canvas scroll the page,
 * while drags that start on something draggable, taps and sideways strokes still reach the
 * widget. Mouse and pen input pass through untouched.
 *
 * The canvas gets `touch-action: pan-y pinch-zoom` (or `pan-x pan-y pinch-zoom`), so the
 * browser owns vertical pans. Then, for each touch:
 * - `grab(e)` true (the finger is on a unit, an endpoint, or a paint tool is active): the
 *   touchstart is cancelled, so the page doesn't scroll and the drag goes to the widget.
 * - otherwise, with `defer` on, the widget doesn't see the pointerdown yet. A tap (lifted
 *   without moving) or a mostly sideways stroke replays it, so tapping and horizontal
 *   painting still work; a mostly vertical swipe is left to the browser, which scrolls and
 *   cancels the pointer, and the widget never hears of it.
 */
export interface TouchScrollOptions {
  /** Does this pointerdown start a drag the page must not steal? */
  grab?: (e: PointerEvent) => boolean;
  /** Hold back other touches until they turn out to be a tap or a sideways stroke. */
  defer?: boolean;
  /** Let the browser pan sideways too (for canvases inside a horizontal scroller). */
  panX?: boolean;
}

const SLOP = 8;

export function touchScroll(el: HTMLElement, o: TouchScrollOptions = {}): void {
  el.style.touchAction = o.panX ? 'pan-x pan-y pinch-zoom' : 'pan-y pinch-zoom';
  // A replayed pointerdown may arrive when the browser no longer counts the pointer as active.
  const capture = el.setPointerCapture.bind(el);
  el.setPointerCapture = (id: number) => {
    try {
      capture(id);
    } catch {
      /* the pointer is already up: nothing to capture */
    }
  };
  let block = false;
  let pend: { e: PointerEvent; gone: boolean } | null = null;
  let replaying = false;
  const replay = (d: PointerEvent) => {
    replaying = true;
    try {
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: d.pointerId,
          pointerType: d.pointerType,
          isPrimary: d.isPrimary,
          clientX: d.clientX,
          clientY: d.clientY,
          screenX: d.screenX,
          screenY: d.screenY,
          button: 0,
          buttons: 1,
          pressure: d.pressure,
          width: d.width,
          height: d.height,
        }),
      );
    } finally {
      replaying = false;
    }
  };
  const mine = (e: PointerEvent) => !!pend && e.pointerId === pend.e.pointerId;
  el.addEventListener(
    'pointerdown',
    (e) => {
      if (replaying || e.pointerType !== 'touch') return;
      block = !!o.grab?.(e);
      if (block || !o.defer) return;
      e.stopImmediatePropagation();
      pend = { e, gone: false };
    },
    { capture: true },
  );
  // Pointer events come before touch events, so `block` is already decided here.
  el.addEventListener('touchstart', (e) => block && e.cancelable && e.preventDefault(), { passive: false });
  el.addEventListener(
    'pointermove',
    (e) => {
      if (!mine(e)) return;
      const p = pend!;
      const dx = e.clientX - p.e.clientX;
      const dy = e.clientY - p.e.clientY;
      if (p.gone || Math.hypot(dx, dy) < SLOP) return e.stopImmediatePropagation();
      if (Math.abs(dy) > Math.abs(dx)) {
        // A vertical swipe: the page's.
        p.gone = true;
        return e.stopImmediatePropagation();
      }
      pend = null;
      replay(p.e);
    },
    { capture: true },
  );
  el.addEventListener(
    'pointerup',
    (e) => {
      block = false;
      if (!mine(e)) return;
      const p = pend!;
      pend = null;
      if (p.gone) return e.stopImmediatePropagation();
      replay(p.e);
    },
    { capture: true },
  );
  el.addEventListener(
    'pointercancel',
    (e) => {
      block = false;
      if (!mine(e)) return;
      pend = null;
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
}
