/**
 * The search index: every lesson split at its `##` headings, plus the labs' concept cards.
 * Built once at build time; the search box (components/Search.astro) loads it on first use.
 */
import GithubSlugger from 'github-slugger';
import { CONCEPTS as PATHING } from '../lab/learn/concepts';
import { CONCEPTS as TACTICS } from '../tactics/concepts';

interface Entry {
  /** Section name shown as a kicker. */
  s: string;
  /** Page (lesson or lab) title. */
  t: string;
  /** Heading within the page, if any. */
  h: string;
  u: string;
  /** Plain text, for matching and snippets. */
  x: string;
}

const SECTION: Record<string, string> = { engine: 'engine', flecs: 'flecs', ai: 'game AI', physics: 'physics' };

function plain(md: string): string {
  return md
    .replace(/^import .*$/gm, '')
    .replace(/<\/?[A-Z][^>]*>/g, ' ') // components (keep what's inside Tips)
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/-{2,}/g, ' ')
    .replace(/^\s*[-+] /gm, ' ')
    .replace(/^\s*\d+\. /gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function GET() {
  const raw = import.meta.glob<string>('./{engine,flecs,ai,physics}/*.mdx', { query: '?raw', import: 'default', eager: true });
  const out: Entry[] = [];
  for (const [file, src] of Object.entries(raw)) {
    const [, section, name] = file.match(/^\.\/(\w+)\/([\w-]+)\.mdx$/)!;
    const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
    const front = fm ? fm[1] : '';
    const title = (front.match(/^title:\s*(.*)$/m)?.[1] ?? name).replace(/^['"]|['"]$/g, '');
    const summary = (front.match(/^summary:\s*(.*)$/m)?.[1] ?? '').replace(/^'|'$/g, '').replace(/''/g, "'");
    const body = fm ? src.slice(fm[0].length) : src;
    const url = `/${section}/${name}/`;
    const slugger = new GithubSlugger();
    // Split at level-2 headings; the part before the first one is the lesson's introduction.
    const parts = body.split(/^## (.+)$/m);
    out.push({ s: SECTION[section] ?? section, t: title, h: '', u: url, x: plain(`${summary} ${parts[0]}`) });
    for (let i = 1; i < parts.length; i += 2) {
      const heading = parts[i].trim().replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '');
      out.push({ s: SECTION[section] ?? section, t: title, h: heading, u: `${url}#${slugger.slug(heading)}`, x: plain(parts[i + 1] ?? '') });
    }
  }
  for (const [lab, url, list] of [
    ['Pathing lab', '/pathing-lab/', PATHING],
    ['Tactics lab', '/tactics-lab/', TACTICS],
  ] as const)
    for (const c of list) out.push({ s: 'labs', t: lab, h: c.title, u: `${url}#concept-${c.id}`, x: plain([...c.body, c.look ?? ''].join(' ')) });
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
}
