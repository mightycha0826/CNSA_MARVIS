// Smoke test in mock mode: opens the page and checks that the console has no errors and the main events flow.
//   1) npm run dev   (in another terminal)
//   2) npm run smoke [address]   default address: https://localhost:5173/
// Playwright has to be installed (it is not among the project's dependencies).
const { chromium } = require('playwright');

const base = process.argv[2] || 'https://localhost:5173/';
const MUST = ['layers:ready', 'env:update', 'telemetry:update', 'alert:raise', 'alert:clear', 'hazard:update',
  'voice:command', 'nav:request', 'layer:toggle', 'mode:change'];

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}?mock=1&mockSpeed=10`);
  await page.waitForTimeout(8000); // 80 s at 10 times the speed = more than one round of the timetable
  const result = await page.evaluate(() => {
    const m = window.__marswalk;
    const brief = (v) => JSON.parse(JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? `${x.constructor.name}(${x.length})` : k === 'layerSet' || k === 'traverse' ? '{…}' : x)));
    return { counts: Object.fromEntries(m.counts), last: brief(m.last), button: document.getElementById('xr-button').textContent,
      canvas: !!document.querySelector('#app canvas') };
  });
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await browser.close();
  console.log(JSON.stringify(result, null, 1));
  const missing = MUST.filter((n) => !result.counts[n]);
  if (errors.length) console.error('Console errors:\n' + errors.join('\n'));
  if (missing.length) console.error('Events that did not flow: ' + missing.join(', '));
  if (errors.length || missing.length || !result.canvas) process.exit(1);
  console.log('OK: no console errors, all ' + MUST.length + ' main events seen');
})();
