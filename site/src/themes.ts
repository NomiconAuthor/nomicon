/**
 * The site's themes. Every theme ships in every build; which ones the theme menu
 * offers (and which is the default) is set in public/themes.js, which can be
 * edited on the server without rebuilding.
 */
export const THEMES: Array<{ id: string; name: string }> = [
  { id: 'nomicon', name: 'Nomicon' },
  { id: 'dusk', name: 'Dusk' },
  { id: 'vs', name: 'Visual Studio' },
];

/** Changes every build; appended to /themes.js so browsers and CDNs fetch the new copy after a deploy. */
export const BUILD_ID = Date.now().toString(36);
