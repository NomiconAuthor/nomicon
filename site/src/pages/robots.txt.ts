/** robots.txt: everything may be crawled; the sitemap lists every page. */
import type { APIContext } from 'astro';

export function GET({ site }: APIContext) {
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap.xml', site).href}\n`, {
    headers: { 'Content-Type': 'text/plain' },
  });
}
