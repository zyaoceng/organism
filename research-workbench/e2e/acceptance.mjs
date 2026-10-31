/**
 * Browser walkthrough of the V1 acceptance tests (docs/PRODUCT_SPEC.md §8).
 *
 *   npm run e2e                       builds the client, starts a server on a throwaway data dir, runs
 *   BASE_URL=http://127.0.0.1:5173 npm run e2e    runs against an already running app (dev mode)
 *
 * Uses the synthetic "demo" price provider so it runs offline. Screenshots: e2e/output/.
 * T1–T20 run in advanced mode (set below, only when nothing is saved); T21 switches to basic mode.
 * T22 writes as an AI client with a token from tokens.json, so it runs only when this script started the server.
 * T23 (dashboard) and T24 (trade log) add two companies with trades; one of them is recorded by an AI client when tokens are at hand.
 * T25 plays the Obsidian plugin with the obsidian token from tokens.json, so it also needs the server this script started.
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
// The app opens in Chinese by default; these checks are written against the English interface.
// Only when nothing is saved, because T20 switches to Chinese and reloads.
await page.addInitScript(() => {
  try {
    if (!localStorage.getItem('workbench.lang')) localStorage.setItem('workbench.lang', 'en');
  } catch {
    /* storage blocked */
  }
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
// Advanced mode shows every page and tool. Only when missing, so T21's switch to basic survives reloads.
await page.addInitScript(() => {
  try {
    if (!localStorage.getItem('workbench.advanced')) localStorage.setItem('workbench.advanced', '1');
  } catch {
    /* about:blank has no storage */
  }
});

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
/** A write as the user: through the page's request context, which carries the browser's session cookie. */
async function userWrite(method, p, body) {
  await page.request.get(`${BASE}/api/session`);
  const r = await page.request.fetch(`${BASE}${p}`, { method, data: body ?? {} });
  if (!r.ok()) throw new Error(`${method} ${p}: ${r.status()} ${await r.text()}`);
  return r.json();
}
/** Writes as an AI client (or another token holder) named in `${dataDir}/tokens.json`; needs the server this script started. */
function tokenWrite(name) {
  if (!dataDir) throw new Error('tokenWrite needs the server started by this script (no BASE_URL)');
  const token = JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8')).tokens[name];
  if (!token) throw new Error(`no token "${name}" in tokens.json`);
  return async (method, p, body) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

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
  await page.getByTestId('nav-trades').click();
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

await test(21, 'Basic mode: four daily pages, Market inside Trades, simpler inspector and commit', async () => {
  await page.getByTestId('nav-model').click();
  await page.getByTestId('advanced-toggle').uncheck();
  const nav = await page.locator('.sidebar nav a').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  assert.deepEqual(nav, ['nav-model', 'nav-valuation', 'nav-trades', 'nav-history']);
  assert.equal(await page.getByTestId('lang-toggle').count(), 0, 'language switch is advanced-only');
  // backup from the sidebar
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('sidebar-export').click()]);
  assert.match(download.suggestedFilename(), /\.json$/);
  // the old Market route opens Trades: one chart, no MFE/MAE, only real price sources plus the current one
  await page.goto(`${BASE}/#/p/${projectId}/market`);
  await page.getByTestId('trades-page').waitFor();
  await page.getByTestId('price-chart').waitFor();
  assert.match(page.url(), /\/trades$/);
  assert.equal(await page.getByTestId('price-chart').count(), 1);
  assert.doesNotMatch(await page.getByTestId('trade-table').innerText(), /MFE/);
  await page.locator('[data-testid=price-source] option[value=demo]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-testid=price-source] option[value=csv]').count(), 0);
  assert.equal(await page.locator('[data-testid=price-source] option[value=yahoo]').count(), 1);
  await page.waitForTimeout(300);
  await snap('basic-trades');
  // a deep link into a hidden page still works and shows where you are
  await page.goto(`${BASE}/#/p/${projectId}/evidence`);
  await page.getByTestId('nav-evidence').waitFor();
  assert.match(await page.getByTestId('nav-evidence').getAttribute('class'), /\bon\b/);
  // valuation keeps the peer table, drops the growth table
  await page.getByTestId('nav-valuation').click();
  await page.getByTestId('peer-table').waitFor();
  assert.equal(await page.getByText('Growth and returns').count(), 0);
  await snap('basic-valuation');
  // inspector: units in a closed Settings fold, no change history
  await page.getByTestId('nav-model').click();
  await selectRow('AI Market Share');
  const insp = page.getByTestId('inspector');
  assert.equal(await page.getByLabel('Unit kind').isVisible(), false);
  await insp.getByText('Settings', { exact: true }).click();
  assert.equal(await page.getByLabel('Unit kind').isVisible(), true);
  assert.doesNotMatch(await insp.innerText(), /Change history/);
  // commit: title prefilled, the new link cited without a checklist, headline impact only
  await setCell('Gross Margin', 4, 24);
  await selectRow('Gross Margin');
  await page.waitForFunction(() => document.querySelector('[data-testid=inspector] input.title')?.value === 'Gross Margin');
  const links = await page.locator('[data-testid=ev-link]').count();
  await insp.getByPlaceholder('Paste a URL and press Enter').fill('https://example.com/basic-mode');
  await insp.getByPlaceholder('Paste a URL and press Enter').press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=ev-link]').length > n, links);
  await snap('basic-model');
  await waitSaved();
  await page.getByTestId('toggle-draft').click();
  assert.match(await page.getByTestId('commit-title').inputValue(), /Gross Margin/);
  assert.equal(await page.getByPlaceholder('Filter evidence…').count(), 0);
  assert.doesNotMatch(await page.getByTestId('impact').innerText(), /Causal chain/);
  await page.getByTestId('commit-asof').fill('2026-10-01');
  await page.getByTestId('commit-reason').fill('Mix shift lifts FY28 gross margin by 1pp.');
  await page.getByTestId('commit-submit').click();
  await page.getByTestId('committed-summary').waitFor({ timeout: 15000 });
  await snap('basic-commit');
  const revs = await api(`/api/projects/${projectId}/revisions`);
  const last = revs.at(-1);
  assert.equal(last.seq, 4);
  assert.match(last.title, /Gross Margin/);
  assert.equal(last.citedEvidenceIds.length, 1, 'exactly the newly linked evidence is cited');
  await page.getByTestId('toggle-draft').click();
  // company list: no demo source in basic mode; a card opens the model
  await page.goto(`${BASE}/`);
  await page.getByTestId('new-project').click();
  await page.locator('[data-testid=np-source] option[value=finmind]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-testid=np-source] option[value=demo]').count(), 0);
  await page.getByTestId('new-project-form').getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('project-card').first().click();
  await page.getByTestId('tree').waitFor();
  assert.match(page.url(), /\/model$/);
  // first visit (fresh browser context, nothing saved): basic mode, no language switch
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p2.on('pageerror', (e) => errors.push(e.message));
  try {
    await p2.goto(`${BASE}/`);
    await p2.getByTestId('new-project').waitFor();
    assert.equal(await p2.getByTestId('advanced-toggle').isChecked(), false);
    assert.equal(await p2.getByTestId('lang-toggle').count(), 0);
  } finally {
    await p2.close();
  }
});

await test(22, 'An AI client edits the draft through its checked route; the open page picks it up', async () => {
  if (!dataDir) {
    console.log('      (skipped: needs the server started by this script, for tokens.json)');
    return;
  }
  const ai = tokenWrite('claude-desktop');
  await page.goto(`${BASE}/#/p/${projectId}/model`);
  await page.getByTestId('tree').waitFor();
  await waitSaved();
  // a user write carries the browser's cookie and is recorded as the user
  const note = await userWrite('POST', `/api/projects/${projectId}/notes`, { body: 'Checked the AI connection.' });
  assert.equal(note.createdBy, 'user');
  // the AI previews, then writes with the version the preview returned
  const ops = [{ op: 'set_value', node: 'AI Market Share', period: 'FY2027', scenario: 'base', value: '33%' }];
  const url = `/api/projects/${projectId}/draft/ops`;
  const dry = await ai('POST', url, { ops, dryRun: true, rationale: 'e2e preview' });
  assert.equal(dry.dryRun, true);
  assert.match(dry.results[0].cells[0].after, /33\.0%/);
  await assert.rejects(ai('POST', url, { ops: [{ ...ops[0], value: '33' }], expectedVersion: dry.version, rationale: 'no unit' }), /OP_FAILED.*百分比/);
  await assert.rejects(ai('POST', url, { ops, rationale: 'no version' }), /EXPECTED_VERSION_REQUIRED/);
  const res = await ai('POST', url, { ops, expectedVersion: dry.version, rationale: 'AI share 33% in 2027 (e2e)' });
  assert.equal(res.dryRun, false);
  assert.equal(res.version, dry.version + 1);
  // the page polls every 10 s: a toast names the AI and the cell shows the new value
  await page.getByTestId('toast').filter({ hasText: 'Claude' }).first().waitFor({ timeout: 15000 });
  await row('AI Market Share').locator('.cell').nth(3).filter({ hasText: '33.0%' }).waitFor({ timeout: 15000 });
  await snap('ai-edit-picked-up');
  const history = await api(`/api/projects/${projectId}/draft/ops?limit=5`);
  assert.equal(history[0].actor, 'agent:claude-desktop');
  assert.equal(history[0].kind, 'ops');
  await page.getByTestId('draft-history').click();
  await page.getByTestId('draft-history-list').getByText('Claude Desktop').first().waitFor();
  await page.getByTestId('draft-history').click();
  // a plain draft PUT is refused for an AI: it must use the checked route
  const b = await api(`/api/projects/${projectId}`);
  await assert.rejects(ai('PUT', `/api/projects/${projectId}/draft`, { state: b.draft.state, version: b.draft.version }), /USE_DRAFT_OPS/);
  // the settings page lists the AI clients and the text to paste
  await page.goto(`${BASE}/`);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('ai-client-claude-desktop').getByText(/connected \(\d\d:\d\d\)/).waitFor();
  assert.match(await page.getByTestId('ai-client-claude-desktop').innerText(), /Claude Desktop/);
  assert.match(await page.getByTestId('ai-instructions').locator('textarea').inputValue(), /research-workbench/);
  await snap('settings');
});

let tradesBefore = 0;
let delta;
let credo;
await test(23, 'Dashboard: every company with price, target, upside; sort, filter, update all prices, Ctrl+K', async () => {
  const rowsBefore = (await api('/api/dashboard')).rows.filter((r) => !r.archivedAt).length;
  tradesBefore = (await api('/api/trades')).trades.length;
  const create = async (name, ticker, exchange, currency) =>
    (await userWrite('POST', '/api/projects', { name, lang: 'en', security: { name, ticker, exchange, apiSymbol: ticker, currency, priceSource: 'demo' } })).id;
  delta = await create('Delta Electronics', '2308', 'TWSE', 'TWD');
  credo = await create('Credo Technology', 'CRDO', 'NASDAQ', 'USD');
  const closes = async (pid) => {
    const sec = (await api(`/api/projects/${pid}`)).securities[0];
    const bars = (await api(`/api/securities/${sec.id}/bars`)).bars;
    return (d) => bars.find((b) => b.date === d).close;
  };
  // Delta: an open long with a stop 10% below the entry
  const deltaClose = await closes(delta);
  const entry = deltaClose('2026-09-22');
  await userWrite('POST', `/api/projects/${delta}/trades`, { side: 'long', entryDate: '2026-09-22', entryPrice: entry, quantity: 1000, stopAtEntry: Math.round(entry * 90) / 100, entryReason: 'e2e open position' });
  // Credo: a closed trade, recorded by an AI client when the tokens are at hand
  const credoClose = await closes(credo);
  const credoTrade = { side: 'long', entryDate: '2026-09-01', entryPrice: credoClose('2026-09-01'), exitDate: '2026-09-15', exitPrice: credoClose('2026-09-15'), entryReason: 'e2e closed trade' };
  if (dataDir) await tokenWrite('claude-code')('POST', `/api/projects/${credo}/trades`, { ...credoTrade, quantityShares: 100 });
  else await userWrite('POST', `/api/projects/${credo}/trades`, { ...credoTrade, quantity: 100 });

  await page.goto(`${BASE}/#/`);
  await page.getByTestId('dash-table').waitFor();
  const cards = page.getByTestId('project-card');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=project-card]').length === n, rowsBefore + 2);
  const dash = await api('/api/dashboard');
  const lite = dash.rows.find((r) => r.projectId === projectId);
  assert.equal(lite.research.asOfDate, '2026-10-01', 'last research is the basic-mode commit (T21)');
  const liteText = await page.locator(`[data-testid=project-card][data-project-id="${projectId}"]`).innerText();
  assert.ok(liteText.includes(lite.research.asOfDate), liteText);
  assert.match(liteText, /uncommitted/, 'T22 left an AI edit in the draft');
  assert.ok(lite.target.base > 0 && liteText.includes(lite.target.base.toFixed(1)), 'base target shown');
  if (dataDir) assert.match(liteText, /Claude Desktop/, 'latest AI activity');
  assert.equal(dash.rows.find((r) => r.projectId === delta).positions.open, 1);
  // sort by name: A→Z, then Z→A, then back to the server order
  await page.getByTestId('dash-sort-name').click();
  assert.match(await cards.first().innerText(), /Credo Technology/);
  await page.getByTestId('dash-sort-name').click();
  assert.match(await cards.first().innerText(), /Lite-On Technology/);
  assert.equal(await page.getByTestId('dash-sort-name').getAttribute('aria-sort'), 'descending');
  await page.getByTestId('dash-sort-name').click();
  assert.equal(await page.getByTestId('dash-sort-name').getAttribute('aria-sort'), 'none');
  // filter by code
  await page.getByTestId('dash-search').fill('2308');
  assert.equal(await cards.count(), 1);
  assert.match(await cards.first().innerText(), /Delta Electronics/);
  await page.getByTestId('dash-search').fill('');
  assert.equal(await cards.count(), rowsBefore + 2);
  // update all prices in the background, with progress
  await page.getByTestId('refresh-all').click();
  await page.locator('[data-testid=refresh-status][data-state=done]').waitFor({ timeout: 30000 });
  const run = await api('/api/market/refresh');
  assert.ok(run.total >= rowsBefore + 2, `every company is refreshed (${run.total})`);
  assert.equal(run.ok, run.total, JSON.stringify(run.items.filter((i) => i.status !== 'ok')));
  // the table reloads when the run ends: Delta now has a price
  await page.locator(`[data-testid=project-card][data-project-id="${delta}"]`).getByText('no price').waitFor({ state: 'detached' });
  await snap('dashboard');
  // Ctrl+K on the home page switches company
  await page.keyboard.press('Control+k');
  await page.getByTestId('company-switcher-input').fill('2308');
  await page.getByTestId('company-hit').filter({ hasText: 'Delta Electronics' }).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/p/${delta}/model$`));
  await page.getByTestId('tree').waitFor();
  // and inside a company, the search palette lists companies first (same tab)
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('Lite-On');
  await page.locator('.search-pop .res > div').first().filter({ hasText: 'Lite-On Technology' }).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/p/${projectId}/model$`));
  await page.getByTestId('tree').waitFor();
});

await test(24, 'Trade log across companies: R, P&L per currency, research snapshot, filters', async () => {
  await page.goto(`${BASE}/#/`);
  await page.getByTestId('nav-journal').click();
  await page.getByTestId('journal-table').waitFor();
  const rows = page.getByTestId('journal-row');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=journal-row]').length === n, tradesBefore + 2);
  const lite = rows.filter({ hasText: 'Lite-On Technology' });
  assert.match(await lite.first().innerText(), /#2 \(2026-09-20\)/, 'the snapshot known on the entry date');
  await page.getByTestId('journal-summary-TWD').waitFor();
  await page.getByTestId('journal-summary-USD').waitFor();
  assert.doesNotMatch(await page.getByTestId('journal-summary').innerText(), /total/i, 'no cross-currency total');
  if (dataDir) assert.match(await rows.filter({ hasText: 'Credo Technology' }).innerText(), /recorded by Claude Code/);
  const open = (await api('/api/trades?status=open')).trades;
  const deltaTrade = open.find((x) => x.project.id === delta);
  assert.equal(deltaTrade.metrics.markSource, 'quote', 'marked with the refreshed quote');
  assert.notEqual(deltaTrade.metrics.rMultiple, null);
  await page.getByTestId('journal-status').getByRole('button', { name: 'Open', exact: true }).click();
  assert.equal(await rows.count(), open.length);
  await snap('journal');
  // a row opens that trade on the company's Trades page
  await rows.filter({ hasText: 'Delta Electronics' }).click();
  await page.waitForURL(new RegExp(`/p/${delta}/trades/${deltaTrade.id}$`));
  await page.getByTestId('trade-table').locator('tr.sel').filter({ hasText: '2026-09-22' }).waitFor();
});

await test(25, 'Obsidian: the plugin pulls notes, sends a reflection back; the page and the trade log show it', async () => {
  if (!dataDir) {
    console.log('      (skipped: needs the server started by this script, for tokens.json)');
    return;
  }
  const token = JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8')).tokens.obsidian;
  assert.ok(token, 'tokens.json has an obsidian token');
  const vault = async (method, p, body) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const ok = async (method, p, body) => {
    const r = await vault(method, p, body);
    if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const ping = await ok('GET', '/api/vault/ping');
  assert.equal(ping.ok, true);
  // pull every note the way the plugin does: pages after a cursor until `more` is false
  const notes = [];
  let after = 0;
  for (let guard = 0; guard < 50; guard++) {
    const pg = await ok('GET', `/api/vault/notes?after=${after}&limit=200`);
    notes.push(...pg.notes);
    after = pg.nextAfter;
    if (!pg.more) break;
  }
  const trade = (await api(`/api/projects/${projectId}/trades`))[0];
  assert.ok(trade, 'Lite-On has a trade');
  const tradeNote = notes.find((n) => n.wbId === trade.id);
  const companyNote = notes.find((n) => n.wbId === projectId);
  assert.ok(tradeNote && companyNote, 'the company and its trade are notes');
  assert.equal(tradeNote.kind, 'trade');
  assert.match(tradeNote.body, /## 反思/, 'a new trade note has a reflection heading');
  const tradePath = `研究工作台/${tradeNote.path}`;
  const companyPath = `研究工作台/${companyNote.path}`;
  // the plugin reports where the notes are, and one it left alone
  await ok('POST', '/api/vault/status', {
    protocol: ping.protocol,
    pluginVersion: '0.1.0',
    vaultName: 'e2e 筆記庫',
    cursor: after,
    pending: 0,
    skippedOpen: 0,
    missing: 0,
    conflicts: [{ wbId: projectId, reason: 'hand-edited', paths: [companyPath] }],
    errors: [],
    paths: { reset: true, set: { [trade.id]: tradePath, [projectId]: companyPath }, removed: [] },
  });
  const sent = await ok('POST', '/api/vault/reflections', { items: [{ wbId: trade.id, text: '測試反思：進場太早', path: tradePath, mtime: Date.now() }] });
  assert.equal(sent.results[0].status, 'stored', JSON.stringify(sent.results));
  // the same text again is not a new version
  assert.equal((await ok('POST', '/api/vault/reflections', { items: [{ wbId: trade.id, text: '測試反思：進場太早', path: tradePath, mtime: Date.now() }] })).results[0].status, 'unchanged');

  await page.goto(`${BASE}/#/p/${projectId}/trades/${trade.id}`);
  const card = page.locator(`[data-testid=reflection-card][data-note-id="${trade.id}"]`);
  await card.getByTestId('reflection-text').filter({ hasText: '測試反思：進場太早' }).waitFor();
  assert.match(await card.getByTestId('reflection-open').getAttribute('href'), /^obsidian:\/\/open\?vault=e2e/);
  // a new version written while the page is open shows up on the next poll
  await ok('POST', '/api/vault/reflections', { items: [{ wbId: trade.id, text: '第二版：停損應設在前低', path: tradePath, mtime: Date.now() }] });
  await card.getByTestId('reflection-text').filter({ hasText: '第二版' }).waitFor({ timeout: 15000 });
  await card.getByTestId('reflection-versions-toggle').filter({ hasText: '(2)' }).click();
  await card.getByTestId('reflection-versions').getByText('測試反思：進場太早').waitFor();
  await snap('obsidian-reflection');

  // the trade log shows an excerpt
  await page.goto(`${BASE}/#/journal`);
  await page.locator(`[data-testid=journal-row][data-trade-id="${trade.id}"]`).getByTestId('journal-reflection').filter({ hasText: '第二版' }).waitFor();

  // the settings page shows the vault and the note the plugin left alone
  await page.goto(`${BASE}/#/settings`);
  const sec = page.getByTestId('settings-obsidian');
  await sec.getByTestId('obsidian-status').getByText(/connected \(\d\d:\d\d\)/).waitFor();
  assert.match(await sec.innerText(), /e2e 筆記庫/);
  assert.match(await sec.getByTestId('obsidian-conflict').first().innerText(), /Lite-On Technology[\s\S]*edited by hand/);
  assert.equal(await sec.getByTestId('obsidian-zip').getAttribute('href'), '/api/vault/plugin.zip');
  await snap('settings-obsidian');

  // the zip is for the browser user only (it holds the token); 404 when the plugin is not built
  await page.request.get(`${BASE}/api/session`);
  const zip = await page.request.get(`${BASE}/api/vault/plugin.zip`);
  const built = fs.existsSync(path.join(root, 'dist', 'obsidian-plugin', 'main.js'));
  assert.equal(zip.status(), built ? 200 : 404);
  if (built) assert.equal((await zip.body()).subarray(0, 2).toString(), 'PK');
  assert.equal((await vault('GET', '/api/vault/plugin.zip')).status, 403);
  // the obsidian token works only on /api/vault/*
  const refused = await vault('POST', `/api/projects/${projectId}/notes`, { body: 'not from the plugin' });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code ?? refused.json.details?.code, 'OBSIDIAN_SCOPE', JSON.stringify(refused.json));
  // and a browser user cannot pretend to be the plugin
  const asUser = await page.request.fetch(`${BASE}/api/vault/reflections`, { method: 'POST', data: { items: [{ wbId: trade.id, text: 'x', path: tradePath, mtime: 0 }] } });
  assert.equal(asUser.status(), 403);
});

await browser.close();
if (server) server.kill();
if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed. Screenshots in e2e/output/.`);
if (errors.length) console.log(`Browser errors:\n  ${errors.join('\n  ')}`);
process.exit(failed.length || errors.length ? 1 : 0);
