from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1440, 'height': 1000})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.set_default_timeout(8000)
    for url, var in [('7-command-merging', 1), ('1-archetypes', 0)]:
        pg.goto(f'http://localhost:4322/flecs/{url}/'); pg.wait_for_timeout(1500)
        d = pg.locator('flecs-debugger').first
        if var: d.locator('.fdbg-var').nth(var).click(); pg.wait_for_timeout(1500)
        step = d.get_by_role('button', name='Step: next thing flecs does')
        n = 0
        try:
            for n in range(1, 200):
                step.click(timeout=5000)
                if 'End of the code' in d.locator('.fdbg-status').inner_text(): break
                if n == 12: d.screenshot(path=f'{url}.png')
        except Exception as e:
            print('HANG at step', n, d.locator('.fdbg-log .current').inner_text()[:100] if d.locator('.fdbg-log .current').count() else '')
        print(url, 'steps', n)
    print('errors', errs)
    b.close()
