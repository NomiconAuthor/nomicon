/**
 * Shareable links for the labs: the lab's state as JSON, deflated and base64url-encoded
 * into the URL's #s= fragment. Fragments never reach the server, so links work on any
 * static host.
 */
import { h } from './dom';

const PREFIX = '#s=';

const toB64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function pack(state: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(state));
  return toB64(await through(json, new CompressionStream('deflate-raw')));
}

export async function unpack<T>(s: string): Promise<T | null> {
  try {
    const bytes = await through(fromB64(s), new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** The packed state in the current URL, if there is one. */
export function stateInUrl(): string | null {
  return location.hash.startsWith(PREFIX) ? location.hash.slice(PREFIX.length) : null;
}

/** Drop the state from the address bar once it's applied, so later edits don't look shared. */
export function clearUrlState(): void {
  if (stateInUrl()) history.replaceState(null, '', location.pathname + location.search);
}

/** A "Share" button for the navbar: builds the link, copies it, and says so. */
export function mountShareButton(state: () => unknown): void {
  const note = h('span', { class: 'share-note', role: 'status', 'aria-live': 'polite' });
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'concepts-btn share-btn',
      title: 'Copy a link to this exact setup',
      onclick: async () => {
        const url = `${location.origin}${location.pathname}${PREFIX}${await pack(state())}`;
        let copied = false;
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch {
          /* clipboard blocked: fall back to putting it in the address bar */
        }
        if (!copied) history.replaceState(null, '', url);
        note.textContent = copied ? 'Link copied' : 'Link is in the address bar';
        window.clearTimeout(Number(note.dataset.t));
        note.dataset.t = String(window.setTimeout(() => (note.textContent = ''), 2500));
      },
    },
    'Share',
  );
  const slot = document.querySelector('[data-nav-slot]');
  if (slot) slot.prepend(btn, note);
}
