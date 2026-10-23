import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

// Static site: `npm run build` writes plain files to dist/ for any web server.
// Themes are picked at runtime (src/themes.ts, public/themes.js), so code blocks are
// highlighted for every theme at once and each theme picks its colours with CSS.
export const baseConfig = {
  // The public domain: used for canonical links and link-preview (og:) URLs.
  site: 'https://nomicon.app',
  integrations: [mdx()],
  trailingSlash: 'ignore',
  // Lessons that were renamed keep working at their old address. The old /low-level/ section
  // is handled by src/pages/low-level/[...slug].astro, which keeps the #anchor too.
  redirects: {
    '/flecs/systems-and-commands': '/flecs/commands/',
    '/flecs/learn-more': '/flecs/#learn-more',
  },
  build: { format: 'directory' },
  markdown: {
    shikiConfig: { themes: { dark: 'github-dark', tome: 'material-theme-palenight', vs: 'dark-plus' }, defaultColor: 'dark' },
  },
  vite: { build: { target: 'es2022' } },
};

export default defineConfig(baseConfig);
