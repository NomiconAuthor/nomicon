/**
 * sitemap.xml: every real page (home, section indexes, lessons, labs, sandbox), built from the
 * files in src/pages so it never needs editing. Redirect pages (/low-level/, renamed lessons)
 * are left out. robots.txt points search engines here.
 */
import type { APIContext } from 'astro';

export function GET({ site }: APIContext) {
  const lessons = Object.keys(import.meta.glob('./{engine,flecs,ai,physics,network}/*.mdx')).map((f) => f.replace(/^\.\/|\.mdx$/g, '') + '/');
  const pages = ['', 'engine/', 'flecs/', 'ai/', 'physics/', 'network/', 'labs/', 'pathing-lab/', 'tactics-lab/', 'feel-lab/', 'flecs/sandbox/', ...lessons.sort()];
  const urls = pages.map((p) => `  <url><loc>${new URL(p, site).href}</loc></url>`).join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}
