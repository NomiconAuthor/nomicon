# Steps every debugger (every variant) on every lesson to the end, exercises the query
# playground presets and runs any benchmark widgets. Serve site/dist on :4330 first.
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
PORT = sys.argv[1] if len(sys.argv) > 1 else '4330'
src = Path(__file__).resolve().parent.parent / 'site' / 'src' / 'pages' / 'flecs'
pages = sorted((int(re.search(r'^order:\s*(\d+)', f.read_text(), re.M).group(1)), f.stem) for f in src.glob('*.mdx'))
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1440, 'height': 1000})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.set_default_timeout(8000)
    for _, name in pages:
        pg.goto(f'http://localhost:{PORT}/flecs/{name}/'); pg.wait_for_timeout(1200)
        title = pg.locator('.lesson h1').inner_text(); num = pg.locator('.lesson .kicker').inner_text()
        ds = pg.locator('flecs-debugger')
        for k in range(ds.count()):
            d = ds.nth(k); nv = max(1, d.locator('.fdbg-var').count())
            for v in range(nv):
                if d.locator('.fdbg-var').count(): d.locator('.fdbg-var').nth(v).click(); pg.wait_for_timeout(600)
                for i in range(40):
                    d.get_by_role('button', name='Run the current line to the end').click()
                    if 'End of the code' in d.locator('.fdbg-status').inner_text(): break
                else: errs.append(f'{name}: debugger {k} variant {v} never reached the end')
        q = pg.locator('flecs-query')
        for i in range(q.locator('.qpg-preset').count() if q.count() else 0):
            q.locator('.qpg-preset').nth(i).click(); pg.wait_for_timeout(120)
        bs = pg.locator('flecs-bench')
        for k in range(bs.count()):
            bs.nth(k).locator('.bench-run').click()
            bs.nth(k).locator('table').wait_for(timeout=120000)
        sp = pg.locator('flecs-script')
        for k in range(sp.locator('.spg-preset').count() if sp.count() else 0):
            sp.locator('.spg-preset').nth(k).click(); sp.locator('.spg-run').click(); pg.wait_for_timeout(80)
        if sp.count() and 'Physics' not in sp.inner_text(): errs.append(f'{name}: script playground did not render')
        nt = pg.locator('flecs-net')
        if nt.count():
            for label in ['Spawn local spark', 'Spawn ship', 'Send update →', 'Tick (move)', 'Rename a ship', 'Send update →', 'Delete oldest ship', 'Spawn ship', 'Send update →']:
                nt.get_by_role('button', name=label).click()
            if 'make_alive' not in nt.locator('.net-log').inner_text(): errs.append(f'{name}: networking demo did not replicate')
        print(num, title, '| debuggers', ds.count(), '| benches', bs.count(), '| errors so far', len(errs), flush=True)
    print(errs[:5])
    b.close()
