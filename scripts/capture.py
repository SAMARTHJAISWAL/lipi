"""Screenshots, the social preview and the README GIF.

Usage: python scripts/capture.py [base_url]     (default http://localhost:4173/)
Writes docs/hero.png, docs/stages.png, docs/phone.png, docs/demo.gif and public/og.png.
Needs Playwright (with Chromium) and Pillow.
"""
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image
from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
ROOT = Path(__file__).resolve().parent.parent


def ready(page: Page, url: str) -> None:
    page.goto(url)
    page.wait_for_function('window.__lipi !== undefined')
    page.evaluate('document.fonts.ready')
    page.wait_for_function("document.getElementById('run-status').textContent.startsWith('Ran in')", timeout=10000)
    page.wait_for_timeout(300)


def main() -> None:
    (ROOT / 'docs').mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chromium')
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, color_scheme='light')
        page = ctx.new_page()
        ready(page, BASE + '#example=mandelbrot')
        page.screenshot(path=str(ROOT / 'docs' / 'hero.png'))

        # The GIF: the same program through each stage.
        frames: list[tuple[Image.Image, int]] = []
        box = page.locator('.pane.stages').bounding_box()
        clip = {'x': box['x'] - 6, 'y': box['y'] - 6, 'width': box['width'] + 12, 'height': box['height'] + 12}
        for tab, hold in [('Output', 1600), ('Tokens', 1500), ('Syntax tree', 1600), ('WebAssembly', 1700), ('Bytes', 2200)]:
            page.get_by_role('tab', name=tab).click()
            page.wait_for_timeout(250)
            img = Image.open(BytesIO(page.screenshot(clip=clip))).convert('RGB')
            img = img.resize((720, round(720 * img.height / img.width)), Image.LANCZOS)
            frames.append((img, hold))
        imgs = [f for f, _ in frames]
        sheet = Image.new('RGB', (imgs[0].width, imgs[0].height * len(imgs)))
        for i, im in enumerate(imgs):
            sheet.paste(im, (0, i * imgs[0].height))
        pal = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
        q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in imgs]
        q[0].save(ROOT / 'docs' / 'demo.gif', save_all=True, append_images=q[1:], duration=[d for _, d in frames], loop=0, optimize=True)

        # Two stages side by side for the README.
        page.get_by_role('tab', name='WebAssembly').click()
        page.wait_for_timeout(200)
        page.screenshot(path=str(ROOT / 'docs' / 'stages.png'), clip=clip)

        og = browser.new_context(viewport={'width': 1200, 'height': 630}, color_scheme='light').new_page()
        ready(og, BASE + '#example=mandelbrot')
        og.screenshot(path=str(ROOT / 'public' / 'og.png'))

        phone = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True).new_page()
        ready(phone, BASE + '#example=fib')
        phone.screenshot(path=str(ROOT / 'docs' / 'phone.png'))
        browser.close()
    for f in ['docs/hero.png', 'docs/stages.png', 'docs/phone.png', 'docs/demo.gif', 'public/og.png']:
        print(f, f'{(ROOT / f).stat().st_size // 1024} KiB')


if __name__ == '__main__':
    main()
