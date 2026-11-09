// The shared half of the lesson-claims checker: claim() and fact(), the record of failures, and
// the number formats lessons use. lesson-claims.ts runs the groups; per-lesson claim modules
// (claims/render/<slug>.ts, ...) import these helpers so that each lesson's claims can live in a
// file of its own.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// import.meta.url is the bundle's (test/.claims.mjs, or <dir>/t/claims.mjs beside a src link), not this file's.
const here = dirname(fileURLToPath(import.meta.url));
const pages = join(here, '..', 'src', 'pages');
const src = join(here, '..', 'src');

// ------------------------------------------------------------------------------------------
// Claims

export interface Failure {
  lesson: string;
  message: string;
}
export const failures: Failure[] = [];
export let checked = 0;
const lessonText = new Map<string, string>();
const norm = (s: string) => s.replace(/\*\*/g, '').replace(/\\(['"])/g, '$1').replace(/\s+/g, ' ');
/** A lesson's MDX under src/pages, or (for the labs) a .ts source file under src, whose strings are the text the lab shows. */
export function text(lesson: string): string {
  let t = lessonText.get(lesson);
  if (t === undefined) {
    t = norm(readFileSync(lesson.endsWith('.ts') ? join(src, lesson) : join(pages, lesson), 'utf8'));
    lessonText.set(lesson, t);
  }
  return t;
}
/** The lesson must contain exactly this text (bold markers and line breaks ignored). */
export function claim(lesson: string, expected: string): void {
  checked++;
  if (!text(lesson).includes(norm(expected))) failures.push({ lesson, message: `should say: ${expected}` });
}
/** A fact the lesson states in words, checked as a condition. */
export function fact(lesson: string, ok: boolean, what: string): void {
  checked++;
  if (!ok) failures.push({ lesson, message: `no longer true: ${what}` });
}

// Number formats the lessons use.
export const int = (x: number) => Math.round(x).toLocaleString('en-US');
export const d1 = (x: number) => x.toFixed(1);
export const d2 = (x: number) => x.toFixed(2);
export const pct = (x: number) => `${Math.round(x)}%`;
