// The rendering section's claims: one module per lesson (claims/render/<slug>.ts, default export),
// listed here once. `npm run check-lessons -- render` runs them all (it's in the fast set run by
// `npm test`); `npm run check-lessons -- render/<slug>` runs one lesson's.
import pipeline from './the-pipeline';
import rasterisation from './rasterisation';
import depth from './depth';

const LESSONS: Record<string, () => void | Promise<void>> = {
  'the-pipeline': pipeline,
  rasterisation,
  depth,
};

/** One claims group per lesson, named render/<slug>. */
export const RENDER_LESSONS: Record<string, () => void | Promise<void>> = Object.fromEntries(Object.entries(LESSONS).map(([slug, f]) => [`render/${slug}`, f]));

/** Every rendering lesson's claims (the `render` group). */
export async function rendering(): Promise<void> {
  for (const f of Object.values(LESSONS)) await f();
}
