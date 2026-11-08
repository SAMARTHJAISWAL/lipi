"""End-to-end checks for the lipi playground in a real browser.

Usage: python scripts/e2e.py [base_url]     (default http://localhost:5173/)
"""
import sys
import time

from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173/'
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: object, detail: object = '') -> None:
    results.append((name, bool(ok), str(detail)))


def wait_for(fn, timeout: float = 8.0, step: float = 0.1):
    end = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() > end:
            return v
        time.sleep(step)


def status(page: Page) -> str:
    return page.locator('#run-status').inner_text()


def set_code(page: Page, src: str) -> None:
    page.locator('#code').fill(src)
    page.wait_for_timeout(250)


def run(page: Page) -> None:
    page.get_by_role('button', name='Run').click()
    wait_for(lambda: status(page) not in ('', 'Running…'), 8)


def console_text(page: Page) -> str:
    return page.locator('#console').inner_text()


EXPECTED = {
    'Hello, numbers': ['42', 'true', '3.142857142857143'],
    'Fibonacci, two ways': ['75025', '75025', '1836311903'],
    'Collatz': ['6171', '261'],
}

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chromium')
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, permissions=['clipboard-read', 'clipboard-write'])
    page = ctx.new_page()
    errors: list[str] = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(BASE)
    page.wait_for_function('window.__lipi !== undefined')
    page.evaluate('localStorage.clear()')
    page.goto(BASE)
    page.wait_for_function('window.__lipi !== undefined')

    # The opening program draws the Mandelbrot set.
    check('opens with a program that compiles', wait_for(lambda: 'Compiles' in page.locator('#diagnostic').inner_text(), 5), page.locator('#diagnostic').inner_text())
    check('and runs it straight away', wait_for(lambda: status(page).startswith('Ran in'), 8), status(page))
    lit = page.evaluate("""() => { const c = document.getElementById('canvas'); const d = c.getContext('2d').getImageData(0, 0, 256, 256).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 60 || d[i + 2] > 60) n++; return n; }""")
    check('the Mandelbrot set is drawn on the canvas', page.locator('#canvas').is_visible() and lit > 5000, lit)
    stages = page.locator('#pipeline li').evaluate_all('els => els.map(e => e.className)')
    check('all four compiler stages pass', stages == ['ok', 'ok', 'ok', 'ok'], stages)

    # Every example runs and prints what it should.
    for title, want in EXPECTED.items():
        page.select_option('#examples', label=title)
        wait_for(lambda: status(page).startswith('Ran in'), 8)
        check(f'example "{title}" prints the right output', console_text(page).split('\n') == want, console_text(page)[:80])
    page.select_option('#examples', label='Primes')
    wait_for(lambda: status(page).startswith('Ran in'), 8)
    check('example "Primes" prints 15 primes', console_text(page).split('\n')[-1] == '47' and len(console_text(page).split('\n')) == 15)
    page.select_option('#examples', label='Interference rings')
    check('example "Interference rings" draws', wait_for(lambda: status(page).startswith('Ran in') and page.locator('#canvas').is_visible(), 8))
    check('choosing an example puts it in the address', 'example=circles' in page.url, page.url)

    # A type error: explained, marked, and not run.
    page.select_option('#examples', label='A type error')
    page.wait_for_timeout(400)
    diag = page.locator('#diagnostic').inner_text()
    check('a type error is explained with its line', 'Type error on line 8' in diag and 'float(...)' in diag, diag)
    check('the error is underlined in the editor', page.locator('#highlight mark.err').count() >= 1)
    check('its line number is flagged', page.locator('#gutter .bad').inner_text() == '8')
    check('the type-check stage shows the failure', page.locator('#pipeline li').nth(2).get_attribute('class') == 'bad')
    check('a program with an error is not run', 'Fix the error first' in status(page), status(page))
    code = page.locator('#code').input_value().replace('print(area(r));', 'print(area(float(r)));')
    set_code(page, code)
    check('fixing it clears the error as you type', 'Compiles' in page.locator('#diagnostic').inner_text())
    page.locator('#code').press('Control+Enter')
    wait_for(lambda: status(page).startswith('Ran in'), 8)
    check('Ctrl+Enter runs it', console_text(page) == '12.56636', console_text(page))

    # Runtime errors and runaway loops.
    set_code(page, 'fn main() {\n  let zero = 0;\n  print(1);\n  print(10 / zero);\n}\n')
    run(page)
    check('dividing by zero is reported in plain words', 'Division by zero' in status(page) and console_text(page) == '1', (status(page), console_text(page)))
    set_code(page, 'fn down(n: int) -> int {\n  return down(n + 1);\n}\nfn main() {\n  print(down(0));\n}\n')
    run(page)
    check('runaway recursion is reported', 'Too much recursion' in status(page), status(page))
    set_code(page, 'fn main() {\n  let i = 0;\n  while true {\n    i += 1;\n  }\n}\n')
    page.get_by_role('button', name='Run').click()
    check('a running program shows Stop', wait_for(lambda: page.locator('#run-label').inner_text() == 'Stop', 2))
    t0 = time.time()
    page.get_by_role('button', name='Stop').click()
    check('Stop ends a loop that never finishes', wait_for(lambda: status(page) == 'Stopped.', 2) and time.time() - t0 < 2, status(page))
    page.get_by_role('button', name='Run').click()
    t0 = time.time()
    check('an endless loop is stopped after 5 seconds anyway', wait_for(lambda: 'still running after 5 seconds' in status(page), 9), f'{time.time() - t0:.1f} s')
    check('the page stays responsive meanwhile', page.evaluate('1 + 1') == 2)

    # Tabs.
    set_code(page, 'fn sq(x: int) -> int {\n  return x * x;\n}\nfn main() {\n  print(sq(12));\n}\n')
    for tab, view, needle in [('Tokens', '#tokens', 'tokens'), ('Syntax tree', '#tree', 'fn'), ('WebAssembly', '#wat', 'i32.mul'), ('Bytes', '#hex', '0061736d')]:
        page.get_by_role('tab', name=tab).click()
        text = page.locator(view).inner_text()
        if tab == 'Bytes':
            text = text.replace(' ', '').replace('\n', '')
        check(f'the {tab} tab shows its stage', needle in text, text[:60])
    page.get_by_role('tab', name='Bytes').focus()
    page.keyboard.press('ArrowLeft')
    check('arrow keys move between tabs', page.get_by_role('tab', name='WebAssembly').get_attribute('aria-selected') == 'true')
    page.locator('#pipeline button').nth(1).click()
    check('clicking a stage opens its view', page.get_by_role('tab', name='Syntax tree').get_attribute('aria-selected') == 'true')

    # Share.
    page.get_by_role('button', name='Share').click()
    page.wait_for_timeout(400)
    link = page.evaluate('navigator.clipboard.readText()')
    check('Share copies a link with the program in it', '#code=' in link, link[:60])
    other = ctx.new_page()
    other.goto(link)
    other.wait_for_function('window.__lipi !== undefined')
    check('the link opens the same program and runs it', wait_for(lambda: other.locator('#console').inner_text() == '144', 8), other.locator('#console').inner_text())
    other.close()
    # The same link pasted into a tab that is already open (only the #fragment changes).
    page.goto(BASE + '#example=hello')
    page.wait_for_function('window.__lipi !== undefined')
    wait_for(lambda: status(page).startswith('Ran in'), 8)
    page.evaluate(f'location.hash = {link.split("#", 1)[1]!r}')
    check('a link pasted into an open tab runs the new program', wait_for(lambda: console_text(page) == '144', 8), console_text(page))

    # Editor behaviour.
    set_code(page, 'fn main() {')
    page.locator('#code').press('End')
    page.locator('#code').press('Enter')
    check('Enter after { indents the next line', page.locator('#code').input_value().endswith('{\n  '), repr(page.locator('#code').input_value()))
    page.locator('#code').press('}')
    check('typing } outdents it', page.locator('#code').input_value().endswith('{\n}'), repr(page.locator('#code').input_value()))
    page.wait_for_timeout(300)
    page.goto(BASE)
    page.wait_for_function('window.__lipi !== undefined')
    check('a reload keeps the draft', page.locator('#code').input_value().endswith('{\n}'), repr(page.locator('#code').input_value()[-20:]))

    check('the title is plain text', page.evaluate("document.querySelector('.brand').closest('a') === null"))
    check('nothing links to GitHub', page.evaluate("[...document.querySelectorAll('a')].filter(a => a.href.includes('github.com')).length") == 0)
    check('no console errors', not errors, ' | '.join(errors[:3]))

    phone = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
    phone.goto(BASE + '#example=fib')
    phone.wait_for_function('window.__lipi !== undefined')
    check('phone: the example runs', wait_for(lambda: phone.locator('#console').inner_text().startswith('75025'), 8))
    check('phone: no sideways scrolling', phone.evaluate('document.documentElement.scrollWidth - innerWidth') == 0)
    small = phone.evaluate("[...document.querySelectorAll('button, select')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 36).map(b => b.textContent.trim())")
    check('phone: controls are big enough to tap', not small, small)
    browser.close()

fails = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'  ({detail})' if detail and not ok else ''))
print(f'\n{len(results) - len(fails)}/{len(results)} checks passed')
sys.exit(1 if fails else 0)
