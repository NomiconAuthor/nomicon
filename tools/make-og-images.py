# Makes the link-preview cards (1200 x 630 JPEG) for every page of the built site, from each
# page's title, description and section, into site/public/og/, and lists them in
# site/src/og-cards.json for Base.astro. Rebuild the site afterwards so pages point at them.
#
#   cd site && npm run build
#   python3 tools/make-og-images.py [--fonts DIR]
#
# Fonts: by default the cards use the site's own @fontsource packages from site/node_modules
# (run npm install first). --fonts DIR points at a folder holding cinzel-latin-700-normal.woff2,
# roboto-latin-400-normal.woff2 and roboto-latin-500-normal.woff2 instead.
import base64, html, json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'site' / 'dist'
OUT = ROOT / 'site' / 'public' / 'og'
LIST = ROOT / 'site' / 'src' / 'og-cards.json'
SECTIONS = {'engine': 'Engine fundamentals', 'flecs': 'flecs', 'ai': 'Game AI', 'physics': 'Physics', 'labs': 'Labs', 'pathing-lab': 'Labs', 'tactics-lab': 'Labs'}

fonts = None
if '--fonts' in sys.argv:
    fonts = Path(sys.argv[sys.argv.index('--fonts') + 1])
FONTSOURCE = ROOT / 'site' / 'node_modules' / '@fontsource'

def font_file(file: str) -> Path:
    if fonts:
        return fonts / file
    return FONTSOURCE / file.split('-latin')[0] / 'files' / file

def font_css() -> str:
    def face(family, weight, file):
        data = base64.b64encode(font_file(file).read_bytes()).decode()
        return f"@font-face{{font-family:'{family}';font-weight:{weight};src:url(data:font/woff2;base64,{data}) format('woff2');}}"
    return face('Cinzel', 700, 'cinzel-latin-700-normal.woff2') + face('Roboto', 400, 'roboto-latin-400-normal.woff2') + face('Roboto', 500, 'roboto-latin-500-normal.woff2')

ICON = (ROOT / 'site' / 'public' / 'favicon.svg').read_text()

def card(kicker: str, title: str, desc: str, url: str) -> str:
    size = 76 if len(title) < 28 else 64 if len(title) < 44 else 54
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{font_css()}
html,body{{margin:0;width:1200px;height:630px;background:#120f1b;color:#f1ecf8;font-family:Roboto,sans-serif}}
.c{{position:absolute;inset:0;padding:64px 80px;box-sizing:border-box;display:flex;flex-direction:column;
  background:radial-gradient(900px 500px at 85% 0%,#2a1f4a 0%,transparent 60%),radial-gradient(700px 400px at 0% 100%,#1f1734 0%,transparent 60%)}}
.c::after{{content:'';position:absolute;inset:22px;border:1px solid #3a2f55;border-radius:18px;pointer-events:none}}
.brand{{display:flex;align-items:center;gap:16px;font-family:Cinzel,serif;font-size:34px;color:#e9bf68;letter-spacing:.04em}}
.brand svg{{width:52px;height:52px}}
.k{{margin-top:56px;font-size:24px;letter-spacing:.14em;text-transform:uppercase;color:#a598bb;font-weight:500}}
h1{{font-family:Cinzel,serif;font-weight:700;font-size:{size}px;line-height:1.12;margin:14px 0 0;color:#f1ecf8}}
p{{font-size:27px;line-height:1.45;color:#c9bfdb;margin:22px 0 0;max-width:1000px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}}
.u{{margin-top:auto;font-size:22px;color:#b994ff;font-family:'Roboto',monospace}}
</style></head><body><div class="c">
<div class="brand">{ICON}<span>nomicon</span></div>
<div class="k">{html.escape(kicker)}</div><h1>{html.escape(title)}</h1><p>{html.escape(desc)}</p>
<div class="u">{html.escape(url)}</div></div></body></html>"""

def meta(text: str, prop: str) -> str:
    m = re.search(rf'<meta (?:name|property)="{re.escape(prop)}" content="([^"]*)"', text)
    return html.unescape(m.group(1)) if m else ''

pages = []
for f in sorted(DIST.rglob('index.html')):
    rel = f.parent.relative_to(DIST).as_posix()
    if rel.startswith(('low-level', '_astro')) or rel in ('flecs/systems-and-commands', 'flecs/learn-more'):
        continue
    text = f.read_text(encoding='utf8')
    if 'http-equiv="refresh"' in text:
        continue
    name = 'home' if rel == '.' else rel.replace('/', '--')
    title = meta(text, 'og:title') or 'Nomicon'
    desc = meta(text, 'og:description')
    sec = rel.split('/')[0] if rel != '.' else ''
    kicker = SECTIONS.get(sec, 'Interactive explainers for game programmers')
    m = re.search(r'<p class="kicker">Lesson (\d+)</p>', text)
    if m:
        kicker += f' · Lesson {m.group(1)}'
    pages.append((name, kicker, 'Nomicon' if rel == '.' else title, desc, 'nomicon.app/' + ('' if rel == '.' else rel + '/')))

OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1200, 'height': 630})
    for name, kicker, title, desc, url in pages:
        pg.set_content(card(kicker, title, desc, url))
        pg.wait_for_timeout(150 if fonts else 600)
        pg.screenshot(path=str(OUT / f'{name}.jpg'), type='jpeg', quality=85)
    b.close()
LIST.write_text(json.dumps(sorted(n for n, *_ in pages), indent=2) + '\n')
print(f'{len(pages)} cards in {OUT}')
