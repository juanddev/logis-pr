// Render setiap *.html di folder ini menjadi PNG (2x) di ../images/
// Pemakaian: node docs/illustrations-src/render.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const dir = __dirname;
  const out = path.join(dir, '..', 'images');
  fs.mkdirSync(out, { recursive: true });
  const only = process.argv[2];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && (!only || f.includes(only))).sort();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  for (const f of files) {
    await page.goto('file://' + path.join(dir, f));
    await page.evaluate(() => document.fonts.ready);
    const card = await page.$('#card');
    const target = path.join(out, f.replace(/\.html$/, '.png'));
    await card.screenshot({ path: target });
    console.log('✓', path.relative(process.cwd(), target));
  }
  await browser.close();
})();
