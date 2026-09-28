/**
 * Browser walkthrough of the V1 acceptance tests (docs/PRODUCT_SPEC.md §8).
 *
 *   npm run e2e                       builds the client, starts a server on a throwaway data dir, runs
 *   BASE_URL=http://127.0.0.1:5173 npm run e2e    runs against an already running app (dev mode)
 *
 * Uses the synthetic "demo" price provider so it runs offline. Screenshots: e2e/output/.
 * CHROME=/path/to/chrome overrides the browser executable.
 */
import { spawn, execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'e2e', 'output');
fs.mkdirSync(out, { recursive: true });

let server = null;
let dataDir = null;
let BASE = process.env.BASE_URL;
if (!BASE) {
  execSync('npx vite build', { cwd: root, stdio: 'inherit' });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
  const port = 4400 + Math.floor(Math.random() * 400);
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_PORT: String(port), WORKBENCH_QUIET: '1' }, stdio: 'inherit' });
  BASE = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const launch = { executablePath: process.env.CHROME ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) };
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, locale: 'en-US' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());

const results = [];
let shot = 0;
async function snap(name) {
  shot++;
  await page.screenshot({ path: path.join(out, `${String(shot).padStart(2, '0')}-${name}.png`) });
}
async function test(id, title, fn) {
  try {
    await fn();
    results.push({ id, title, ok: true });
    console.log(`PASS  T${id} ${title}`);
  } catch (e) {
    results.push({ id, title, ok: false, error: e.message });
    console.log(`FAIL  T${id} ${title}\n      ${e.message.split('\n')[0]}`);
    await snap(`fail-T${id}`);
  }
}
const api = async (p, init) => {
  const r = await fetch(`${BASE}${p}`, init);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
};

// ------------------------------------------------------------ helpers
const row = (name, nth = 0) => page.getByTestId(`row-${name}`).nth(nth);
async function selectRow(name, nth = 0) {
  await row(name, nth).locator('.namecell').click({ position: { x: 5, y: 8 } });
}
async function setCell(name, periodIndex, value, nth = 0) {
  const cell = row(name, nth).locator('.cell').nth(periodIndex);
  await cell.click();
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
}
async function fillRow(name, values, nth = 0) {
  for (const [i, v] of values.entries()) if (v !== null && v !== undefined) await setCell(name, i, v, nth);
}
async function rename(name, to, nth = 0) {
  await selectRow(name, nth);
  await page.keyboard.press('F2');
  const input = row(name, nth).locator('.name input');
  await input.fill(to);
  await input.press('Enter');
  await row(to).waitFor();
}
async function addChild(parent, name, nth = 0) {
  await selectRow(parent, nth);
  await page.keyboard.press('a');
  const input = page.getByTestId('row-New node').locator('.name input');
  await input.fill(name);
  await input.press('Enter');
  await row(name).waitFor();
}
async function setFormula(text) {
  const box = page.locator('[data-testid=inspector] .formula-box');
  await box.fill(text);
  await box.press('Control+Enter');
  await page.waitForTimeout(150);
}
async function setUnit(kind, scale) {
  await page.getByLabel('Unit kind').selectOption(kind);
  if (scale) await page.getByLabel('Scale').selectOption(String(scale));
}
const kpi = async (id) => (await page.getByTestId(id).innerText()).trim();
const num = (s) => Number(String(s).replace(/[^0-9.\-]/g, ''));
async function waitSaved() {
  await page.waitForFunction(() => document.querySelector('.save-dot')?.classList.contains('saved'), null, { timeout: 10000 });
}
async function commitUpdate({ title, reason, asOf }) {
  await waitSaved();
  await page.getByTestId('toggle-draft').click();
  await page.getByTestId('commit-title').fill(title);
  await page.getByTestId('commit-asof').fill(asOf);
  await page.getByTestId('commit-reason').fill(reason);
  await page.getByTestId('commit-submit').click();
  await page.getByTestId('committed-summary').waitFor({ timeout: 15000 });
}

let projectId;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAKUlEQVR42mNkYPhfz0AEYBxVSF+FjIyMDKMKR0MFIxwNFYzCTBgFqQABAMLeCB3xkvZTAAAAAElFTkSuQmCC',
  'base64',
);

// ------------------------------------------------------------ run
await page.goto(`${BASE}/`);

await test(1, 'Create a company from the standardized template', async () => {
  await page.getByTestId('new-project').click();
  await page.getByTestId('np-name').fill('Lite-On Technology');
  await page.getByTestId('np-ticker').fill('2301');
  assert.equal(await page.getByTestId('np-symbol').inputValue(), '2301.TW');
  await page.getByTestId('np-source').selectOption('demo');
  await page.getByTestId('np-create').click();
  await page.getByTestId('tree').waitFor();
  projectId = page.url().split('/p/')[1].split('/')[0];
  for (const n of ['EPS', 'Revenue', 'Gross Margin', 'Net Income', 'Diluted Shares', 'P/E', 'ROIC', 'Target P/E', 'Target Price']) await row(n).waitFor();
  const b = await api(`/api/projects/${projectId}`);
  assert.equal(b.head.kind, 'initial');
  assert.deepEqual(b.securities[0].apiSymbol, '2301.TW');
  await snap('template');
});

await test(2, 'Create my own business segmentation', async () => {
  await rename('Business A', 'Core Power');
  await rename('Business B', 'AI Server Power');
  await rename('Business C', 'Legacy Consumer');
  await addChild('Revenue', 'Emerging Optionality');
  const kids = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="row-"]')].map((r) => r.getAttribute('data-testid')));
  assert.ok(kids.includes('row-Emerging Optionality'));
  // move the new segment above Legacy Consumer with Alt+Up
  await selectRow('Emerging Optionality');
  await page.keyboard.press('Alt+ArrowUp');
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="row-"]')].map((r) => r.getAttribute('data-testid').slice(4)));
  assert.ok(order.indexOf('Emerging Optionality') < order.indexOf('Legacy Consumer'), 'reordered');
});

await test(3, 'Add an arbitrary new assumption without code', async () => {
  // AI Server Power becomes TAM × share, capped by capacity
  await addChild('AI Server Power', 'AI Power TAM');
  await addChild('AI Server Power', 'AI Market Share');
  await setUnit('percent');
  await addChild('AI Server Power', 'Capacity Limit');
  await row('AI Market Share').waitFor();
  await waitSaved();
  const b = await api(`/api/projects/${projectId}`);
  assert.ok(b.draft.state.nodes.some((n) => n.name === 'AI Market Share' && n.unit.kind === 'percent'), 'custom node saved with its unit');
});

await test(4, 'Enter historical data and forecasts; create formulas from other metrics', async () => {
  //            FY2024 FY2025 FY2026 FY2027 FY2028
  await fillRow('Core Power', [800, 850]);
  await fillRow('YoY Growth', [null, null, 3, 3, 3], 0);
  await fillRow('AI Server Power', [300, 520]);
  await fillRow('AI Power TAM', [null, null, 9000, 12000, 15000]);
  await fillRow('AI Market Share', [null, null, 9, 10.5, 12]);
  await fillRow('Capacity Limit', [null, null, 1200, 1500, 2200]);
  await fillRow('Legacy Consumer', [600, 480]);
  await fillRow('YoY Growth', [null, null, -8, -8, -8], 2);
  await fillRow('Emerging Optionality', [0, 0, 5, 20, 60]);
  await fillRow('Gross Margin', [19, 20, 21, 22, 22]);
  await fillRow('Opex % of Revenue', [8, 8, 8, 8, 8]);
  await fillRow('Non-Operating Items', [25, 25, 25, 25, 25]);
  await fillRow('Tax Rate', [20, 20, 20, 20, 20]);
  await fillRow('Diluted Shares', [22.66, 22.66, 22.66, 22.66, 22.66]);
  await fillRow('Invested Capital', [520, 560, 620, 680, 740]);
  await selectRow('AI Server Power');
  await setFormula('MIN([AI Power TAM] * [AI Market Share], [Capacity Limit])');
  // Target P/E
  const pe = row('Target P/E').locator('.cell').first();
  await pe.click();
  await page.keyboard.type('25');
  await page.keyboard.press('Enter');
  await waitSaved();
  const eps = num(await kpi('kpi-eps'));
  const tp = num(await kpi('kpi-tp'));
  assert.ok(eps > 5 && eps < 40, `EPS FY2028 is plausible (${eps})`);
  assert.ok(Math.abs(tp - eps * 25) < 0.2, `target price = EPS × 25 (${tp} vs ${eps})`);
  const aiCell = await row('AI Server Power').locator('.cell').nth(4).innerText();
  assert.equal(num(aiCell), 1800, 'MIN(15000 × 12%, 2200) = 1800');
  await snap('model-filled');
});

let firstTp;
await test(7, 'Attach URL, screenshot, file and note evidence to an assumption', async () => {
  await selectRow('AI Market Share');
  const insp = page.getByTestId('inspector');
  await insp.getByPlaceholder('Paste a URL and press Enter').fill('https://example.com/hyperscaler-qualification');
  await insp.getByPlaceholder('Paste a URL and press Enter').press('Enter');
  await page.getByTestId('ev-link').first().waitFor();
  await insp.getByTestId('ev-file-input').setInputFiles({ name: 'Q2-earnings-call.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% research workbench test\n') });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=ev-link]').length >= 2);
  // paste a screenshot from the clipboard
  await page.getByTestId('tree').focus();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, PNG.toString('base64'));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=ev-link]').length >= 3);
  await insp.getByRole('button', { name: '📝 Note' }).click();
  await insp.getByPlaceholder('Title (e.g. Channel check with supplier)').fill('Supplier channel check');
  await insp.getByPlaceholder('What was said / observed').fill('Two ODMs confirm rack power orders for 2H.');
  await insp.getByRole('button', { name: 'Add note evidence' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=ev-link]').length >= 4);
  const ev = await api(`/api/projects/${projectId}/evidence`);
  assert.deepEqual(ev.map((e) => e.kind).sort(), ['file', 'image', 'note', 'url']);
  const pdf = ev.find((e) => e.kind === 'file');
  const res = await fetch(`${BASE}${pdf.attachments[0].url}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /Q2-earnings-call\.pdf/);
  await snap('evidence-linked');
});

await test(8, 'Commit the initiation as a Research Update (knowledge date 2026-09-20)', async () => {
  await selectRow('AI Market Share');
  await page.getByTestId('inspector').getByLabel('Node name').click();
  await commitUpdate({ title: 'Initiation', reason: 'Initial model: AI power demand driven by hyperscaler TAM, share ramp to 12% by FY28.', asOf: '2026-09-20' });
  const revs = await api(`/api/projects/${projectId}/revisions`);
  assert.equal(revs.length, 2);
  assert.equal(revs[1].citedEvidenceIds.length, 4, 'newly linked evidence is cited by default');
  firstTp = revs[1].impact.headline.targetPrice.find((h) => h.scenario === 'base').after;
  await page.getByTestId('toggle-draft').click();
});

await test(13, 'Bear / Base / Bull via overrides, without duplicating the model', async () => {
  await selectRow('AI Market Share');
  for (const [sc, v] of [
    ['bear', 8],
    ['bull', 16],
  ]) {
    await page.getByTestId(`mx-${sc}-FY2028`).click();
    await page.keyboard.type(String(v));
    await page.keyboard.press('Enter');
  }
  await selectRow('Target P/E');
  for (const [sc, v] of [
    ['bear', 18],
    ['bull', 30],
  ]) {
    await page.getByTestId(`mx-${sc}-_`).click();
    await page.keyboard.type(String(v));
    await page.keyboard.press('Enter');
  }
  await waitSaved();
  const tps = {};
  for (const [i, sc] of ['bear', 'base', 'bull'].entries()) {
    await page.getByTestId('tree').focus();
    await page.keyboard.press(String(i + 1));
    tps[sc] = num(await kpi('kpi-tp'));
  }
  assert.ok(tps.bear < tps.base && tps.base < tps.bull, JSON.stringify(tps));
  const b = await api(`/api/projects/${projectId}`);
  const share = b.draft.state.nodes.find((n) => n.name === 'AI Market Share');
  assert.deepEqual(Object.keys(share.overrides).sort(), ['bear', 'bull']);
  assert.deepEqual(Object.keys(share.overrides.bear), ['FY2028'], 'only the overridden cell is stored');
  await page.keyboard.press('2');
});

await test(5, 'Changing an upstream assumption recalculates downstream values', async () => {
  const before = num(await kpi('kpi-eps'));
  await setCell('AI Market Share', 4, 15);
  const after = num(await kpi('kpi-eps'));
  assert.ok(after > before, `EPS rose (${before} → ${after})`);
});

await test(9, 'One piece of information changes several assumptions; draft shows what changed before commit', async () => {
  await setCell('Capacity Limit', 4, 2600);
  await setCell('Gross Margin', 4, 23);
  await selectRow('AI Market Share');
  await page.getByTestId('inspector').getByPlaceholder('Paste a URL and press Enter').fill('https://example.com/capacity-guidance-raised');
  await page.getByTestId('inspector').getByPlaceholder('Paste a URL and press Enter').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=ev-link]').length >= 5);
  await waitSaved();
  await page.getByTestId('toggle-draft').click();
  const list = await page.getByTestId('change-list').innerText();
  assert.match(list, /AI Market Share 2028E: 12\.0% → 15\.0%/);
  assert.match(list, /Capacity Limit 2028E: 2,200 → 2,600/);
  assert.match(list, /Gross Margin 2028E: 22\.0% → 23\.0%/);
  assert.match(await page.getByTestId('impact').innerText(), /Target price/);
  await snap('draft-review');
  await page.getByTestId('toggle-draft').click();
});

await test(11, 'Commit shows how the update changed EPS', async () => {
  await commitUpdate({ title: 'Hyperscaler qualification confirmed; capacity guidance raised', reason: 'Customer qualification confirmed and management raised FY28 capacity. Share 12% → 15%, capacity 2,200 → 2,600, GM +1pp on mix.', asOf: '2026-09-26' });
  const txt = await page.getByTestId('committed-summary').innerText();
  assert.match(txt, /Research Update #3/);
  assert.match(txt, /EPS 2028E/);
  await snap('commit-impact');
});

await test(12, 'Commit shows how the update changed the target price, with attribution', async () => {
  const revs = await api(`/api/projects/${projectId}/revisions`);
  const r = revs[2];
  const h = r.impact.headline.targetPrice.find((x) => x.scenario === 'base');
  assert.ok(Math.abs(h.before - firstTp) < 1e-6, 'before = previous snapshot target');
  assert.ok(h.after > h.before, 'target price increased');
  const names = r.impact.attribution.map((a) => a.name).sort();
  // the Bear/Bull target multiples set in T13 are part of this update too
  assert.deepEqual(names, ['AI Market Share', 'Capacity Limit', 'Gross Margin', 'Target P/E']);
  assert.ok(r.citedEvidenceIds.length === 1, 'the new source is cited');
  await page.getByTestId('toggle-draft').click();
});

await test(10, 'The previous model state remains recoverable (view snapshot #2)', async () => {
  await page.getByTestId('nav-history').click();
  await page.getByTestId('timeline').waitFor();
  await page.locator('.tl-item').filter({ hasText: 'Initiation' }).click();
  await page.getByTestId('view-snapshot').click();
  await page.getByTestId('viewing-banner').waitFor();
  const share = await row('AI Market Share').locator('.cell').nth(4).innerText();
  assert.equal(share.trim(), '12.0%', 'old snapshot shows the old assumption');
  await snap('time-travel');
  await page.getByTestId('back-to-draft').click();
  assert.equal((await row('AI Market Share').locator('.cell').nth(4).innerText()).trim(), '15.0%');
});

await test(14, 'Tree stays readable with cross-branch formulas (dependency highlighting)', async () => {
  await selectRow('NOPAT');
  await page.waitForTimeout(100);
  const inRows = await page.evaluate(() => [...document.querySelectorAll('.tree-row.dep-in')].map((r) => r.getAttribute('data-testid').slice(4)));
  assert.ok(inRows.includes('Operating Income') && inRows.includes('Tax Rate'), inRows.join(','));
  const outRows = await page.evaluate(() => [...document.querySelectorAll('.tree-row.dep-out')].map((r) => r.getAttribute('data-testid').slice(4)));
  assert.ok(outRows.includes('ROIC') && outRows.includes('Reinvestment ROI'), outRows.join(','));
  assert.match(await page.getByTestId('inspector').innerText(), /Depends on/);
  await snap('dependencies');
});

await test(15, 'Historical estimates do not change when current data updates', async () => {
  const revs = await api(`/api/projects/${projectId}/revisions`);
  const before = await api(`/api/projects/${projectId}/revisions/${revs[1].id}`);
  await page.getByTestId('nav-market').click();
  await page.getByTestId('refresh-market').click();
  await page.waitForTimeout(800);
  const after = await api(`/api/projects/${projectId}/revisions/${revs[1].id}`);
  assert.deepEqual(after.computed, before.computed);
  assert.deepEqual(after.market, before.market);
});

await test(16, 'Current price and daily OHLCV with chart, MA and ATR', async () => {
  await page.getByTestId('price-chart').waitFor();
  await page.waitForTimeout(500);
  assert.ok((await page.locator('[data-testid=price-chart] canvas').count()) > 0, 'chart canvas rendered');
  const price = num(await kpi('kpi-price'));
  assert.ok(price > 0);
  const sec = (await api(`/api/projects/${projectId}`)).securities[0];
  const bars = await api(`/api/securities/${sec.id}/bars`);
  assert.ok(bars.bars.length > 400);
  assert.equal(bars.provider, 'demo');
  await snap('market');
});

await test(17, 'Record an entry and an exit and see them on the chart', async () => {
  await page.getByTestId('nav-trades').click();
  await page.getByTestId('new-trade-form').waitFor();
  await page.getByTestId('tr-date').fill('2026-09-21');
  await page.getByTestId('tr-qty').fill('2000');
  await page.getByTestId('tr-reason').fill('Qualification news, breakout above 20-day range');
  await page.getByTestId('tr-save').click();
  await page.getByTestId('exit-form').waitFor();
  await page.getByTestId('exit-date').fill('2026-09-25');
  await page.getByTestId('exit-reason').fill('Test exit');
  await page.getByTestId('exit-save').click();
  await page.waitForTimeout(600);
  const trades = await api(`/api/projects/${projectId}/trades`);
  assert.equal(trades.length, 1);
  const revs = await api(`/api/projects/${projectId}/revisions`);
  assert.equal(trades[0].revisionId, revs[1].id, 'entry on 09-21 uses the snapshot known on 09-20, not the later one');
  assert.ok(trades[0].atrAtEntry > 0 && trades[0].stopAtEntry < trades[0].entryPrice);
  assert.ok(trades[0].exitPrice > 0);
  const table = await page.getByTestId('trade-table').innerText();
  assert.match(table, /#2 \(2026-09-20\)/);
  await snap('trades');
});

await test(6, 'Attached files remain accessible later (reopen from the evidence library)', async () => {
  await page.getByTestId('nav-evidence').click();
  await page.getByTestId('evidence-row').filter({ hasText: 'Q2-earnings-call.pdf' }).click();
  const href = await page.getByTestId('attachment-link').first().getAttribute('href');
  const res = await fetch(`${BASE}${href}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /research workbench test/);
  await snap('evidence-library');
});

await test(18, 'Months later: reconstruct what I believed, why, and what changed my mind', async () => {
  await page.getByTestId('nav-history').click();
  await page.locator('.tl-item').filter({ hasText: 'Hyperscaler qualification' }).click();
  const detail = await page.getByTestId('revision-detail').innerText();
  assert.match(detail, /Customer qualification confirmed/);
  assert.match(detail, /capacity-guidance-raised/);
  assert.match(detail, /AI Market Share 2028E: 12\.0% → 15\.0%/);
  await page.getByTestId('hist-evolution').click();
  await page.getByTestId('evo-table').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=evo-table] tbody tr a').length >= 2);
  const rows = await page.getByTestId('evo-table').locator('tbody tr').count();
  assert.equal(rows, 2, 'two knowledge-dated estimates of EPS FY2028');
  await snap('evolution');
  // node-level history in the inspector
  await page.getByTestId('nav-model').click();
  await selectRow('AI Market Share');
  const insp = await page.getByTestId('inspector').innerText();
  assert.match(insp, /#3 Hyperscaler qualification confirmed/);
  assert.match(insp, /Customer qualification confirmed and management raised/);
  // post-mortem
  await page.getByTestId('nav-history').click();
  await page.getByTestId('hist-reviews').click();
  await page.getByTestId('new-review').click();
  await page.getByTestId('review-title').fill('Test review');
  await page.getByTestId('review-form').getByLabel('Assumption magnitude').check();
  await page.getByTestId('review-save').click();
  await page.waitForTimeout(400);
  const reviews = await api(`/api/projects/${projectId}/reviews`);
  assert.equal(reviews[0].categories[0].category, 'assumption_magnitude');
});

await test(19, 'Valuation workspace, catalysts, overview and search render', async () => {
  await page.getByTestId('nav-valuation').click();
  await page.getByTestId('valuation-page').waitFor();
  await page.getByTestId('add-peer').click();
  await snap('valuation');
  await page.getByTestId('nav-catalysts').click();
  await page.getByTestId('new-catalyst').click();
  await page.getByTestId('cat-title').fill('Q3 earnings call');
  await page.getByTestId('cat-date').fill('2026-10-30');
  await page.getByTestId('cat-expected').fill('Capacity guidance reiterated');
  await page.getByTestId('cat-save').click();
  await page.getByTestId('catalyst-card').first().waitFor();
  await page.getByTestId('nav-overview').click();
  await page.getByTestId('overview-page').waitFor();
  await snap('overview');
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('capacity');
  await page.waitForTimeout(200);
  assert.ok((await page.locator('.search-pop .res > div').count()) > 0);
  await page.keyboard.press('Escape');
});

await test(20, 'Interface switches to Chinese and back; user data stays as typed', async () => {
  await page.getByTestId('nav-history').click();
  await page.getByTestId('lang-toggle').getByRole('button', { name: '中文' }).click();
  await page.getByTestId('nav-model').getByText('模型').waitFor();
  await page.getByTestId('nav-history').click();
  await page.getByText('預估演變與校準').waitFor();
  await page.getByText('查看快照').waitFor();
  await snap('history-zh');
  await page.getByTestId('nav-model').click();
  await page.getByTestId('tree').waitFor();
  assert.ok(await page.getByTestId('row-AI Market Share').count(), 'node names are not translated');
  await snap('model-zh');
  await page.reload();
  await page.getByTestId('nav-model').getByText('模型').waitFor();
  await page.getByTestId('lang-toggle').getByRole('button', { name: 'English' }).click();
  await page.getByTestId('nav-model').getByText('Model').waitFor();
});

await browser.close();
if (server) server.kill();
if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed. Screenshots in e2e/output/.`);
if (errors.length) console.log(`Browser errors:\n  ${errors.join('\n  ')}`);
process.exit(failed.length || errors.length ? 1 : 0);
