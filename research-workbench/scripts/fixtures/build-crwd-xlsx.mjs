/**
 * Builds the test workbooks in src/server/xlsx/fixtures/. The user's real file cannot be read from
 * here, so CRWD_簡明損益表.xlsx follows the description in the workflow handoff (section 9): four
 * sheets, the revenue model in seven steps, cross-sheet formulas, notes with sources. Its inputs are
 * tuned to the handoff's numbers: four-quarter revenue 1,556 / 1,663 / 1,768 / 1,873 = 6,861 and a
 * target price of about 171.5 at 25× EV/Sales.
 *
 *   npx tsx scripts/fixtures/build-crwd-xlsx.mjs
 *
 * The script writes formulas only; headless LibreOffice then opens, recalculates and re-saves the
 * file, so the stored results come from an engine other than the one the app uses. Needs `soffice`.
 * Two more files are derived: one with the stored results stripped, and a small hand-written one
 * that uses shared formulas, shared strings and a defined name (LibreOffice writes none of the first).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from '../../src/server/vault/zip.ts';
import { entryData, readZip } from '../../src/server/xlsx/zipRead.ts';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server/xlsx/fixtures');

// ---------------------------------------------------------------------------------------------
// a small xlsx writer: inline strings, formulas without results, notes, merges, a few styles
// ---------------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colName = (n) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

const FONTS = { black: 0, blue: 1, green: 2, bold: 3 };
const FORMATS = { general: 0, int: 3, pct: 164, one: 165, two: 4, four: 166 };

/** Style index for a font colour, a number format and the yellow "needs a decision" fill. */
const styles = [];
function style(font = 'black', fmt = 'general', yellow = false) {
  const key = `${font}|${fmt}|${yellow}`;
  let i = styles.indexOf(key);
  if (i < 0) i = styles.push(key) - 1;
  return i + 1; // 0 is the default style
}

function stylesXml() {
  const xfs = styles.map((key) => {
    const [font, fmt, yellow] = key.split('|');
    return `<xf numFmtId="${FORMATS[fmt]}" fontId="${FONTS[font]}" fillId="${yellow === 'true' ? 2 : 0}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.0"/><numFmt numFmtId="166" formatCode="0.0000"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF0000FF"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF008000"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${xfs.join('')}</cellXfs>
</styleSheet>`;
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.rows = new Map(); // row → Map(col → cell)
    this.merges = [];
    this.notes = [];
    this.widths = {};
  }
  /** value: a number, a string, or `=formula`. */
  set(col, row, value, s = 0, note) {
    if (value === undefined || value === null || value === '') return;
    if (!this.rows.has(row)) this.rows.set(row, new Map());
    this.rows.get(row).set(col, { value, s });
    if (note) this.notes.push({ ref: `${colName(col)}${row}`, text: note });
  }
  xml(withNotes) {
    const rows = [...this.rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([r, cells]) => {
        const cs = [...cells.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([c, cell]) => {
            const ref = `${colName(c)}${r}`;
            const s = cell.s ? ` s="${cell.s}"` : '';
            if (typeof cell.value === 'number') return `<c r="${ref}"${s}><v>${cell.value}</v></c>`;
            if (cell.value.startsWith('=')) return `<c r="${ref}"${s}><f>${esc(cell.value.slice(1))}</f></c>`;
            return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.value)}</t></is></c>`;
          });
        return `<row r="${r}">${cs.join('')}</row>`;
      });
    const cols = Object.entries(this.widths).map(([c, w]) => `<col min="${c}" max="${c}" width="${w}" customWidth="1"/>`);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${cols.length ? `<cols>${cols.join('')}</cols>` : ''}<sheetData>${rows.join('')}</sheetData>
${this.merges.length ? `<mergeCells count="${this.merges.length}">${this.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
${withNotes && this.notes.length ? '<legacyDrawing r:id="rId2"/>' : ''}</worksheet>`;
  }
  commentsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Claude</author></authors><commentList>${this.notes
      .map((n) => `<comment ref="${n.ref}" authorId="0"><text><r><t xml:space="preserve">${esc(n.text)}</t></r></text></comment>`)
      .join('')}</commentList></comments>`;
  }
  vmlXml() {
    const shapes = this.notes.map((n, i) => {
      const m = /^([A-Z]+)(\d+)$/.exec(n.ref);
      const col = [...m[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      return `<v:shape id="_x0000_s${1025 + i}" type="#_x0000_t202" style="position:absolute;margin-left:60pt;margin-top:2pt;width:160pt;height:60pt;z-index:${i + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox/><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:AutoFill>False</x:AutoFill><x:Row>${Number(m[2]) - 1}</x:Row><x:Column>${col}</x:Column></x:ClientData></v:shape>`;
    });
    return `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes.join('')}</xml>`;
  }
}

function workbookZip(sheets) {
  const files = [];
  const add = (name, text) => files.push({ name, data: Buffer.from(text, 'utf8') });
  const overrides = sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  sheets.forEach((s, i) => {
    if (s.notes.length) overrides.push(`<Override PartName="/xl/comments${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>`);
  });
  add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join('')}</Types>`,
  );
  add(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets><calcPr fullCalcOnLoad="1"/></workbook>`,
  );
  add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  add('xl/styles.xml', stylesXml());
  sheets.forEach((s, i) => {
    add(`xl/worksheets/sheet${i + 1}.xml`, s.xml(true));
    if (!s.notes.length) return;
    add(`xl/comments${i + 1}.xml`, s.commentsXml());
    add(`xl/drawings/vmlDrawing${i + 1}.vml`, s.vmlXml());
    add(
      `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments${i + 1}.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing${i + 1}.vml"/></Relationships>`,
    );
  });
  return zipFiles(files);
}

// ---------------------------------------------------------------------------------------------
// the CRWD workbook
// ---------------------------------------------------------------------------------------------

const MAIN = 'CRWD 簡明損益表';
const NEXT4 = '未來四季營收';
const MODEL = '營收模型';
const HELP = '說明';
const q = (name) => `'${name}'!`; // every cross-sheet reference is written quoted

const blue = (fmt) => style('blue', fmt);
const black = (fmt) => style('black', fmt);
const green = (fmt) => style('green', fmt);
const BOLD = style('bold');

// ---- 營收模型: built first so the other sheets can point at its rows --------------------------

const model = new Sheet(MODEL);
model.widths = { 1: 34, 2: 12, 3: 10, 4: 10, 5: 58, 6: 8 };
/** Row numbers by key, for formulas. */
const M = {};
let r = 1;
model.set(1, r++, 'CRWD 營收模型：未來四季訂閱營收拆成七步', BOLD);
model.set(1, r++, '單位：百萬美元（另註者除外）。藍字手填、黑字公式、綠字連到其他分頁、黃底是要判斷的格子。');
r++;

function step(title) {
  model.set(1, r++, title, BOLD);
  ['項目', '取用值', '下緣', '上緣', '依據', '判斷'].forEach((h, i) => model.set(i + 1, r, h, BOLD));
  r++;
}
/** An assumption row. `value` may be a formula; `status` is 要 or 已定. */
function assume(key, label, value, low, high, fmt, basis, status, note) {
  M[key] = r;
  const isFormula = typeof value === 'string';
  model.set(1, r, label);
  model.set(2, r, value, style(isFormula ? 'green' : 'blue', fmt, status === '要'), note);
  model.set(3, r, low, blue(fmt));
  model.set(4, r, high, blue(fmt));
  model.set(5, r, basis);
  model.set(6, r, status);
  r++;
}
/** A computed row: a formula in the value column, no range and no status. */
function calc(key, label, formula, fmt, basis) {
  M[key] = r;
  model.set(1, r, label);
  model.set(2, r, formula, black(fmt));
  model.set(5, r, basis);
  r++;
}
const B = (key) => `B${M[key]}`;

step('一、基期：2Q27 期末 ARR（年度經常性收入）');
const SRC_2Q27 = '來源：公司 2Q27 法說會（2026-08-26）';
assume('arrCloud', '雲端 ARR', 905, null, null, 'one', '公司 2Q27 法說會揭露', '已定', SRC_2Q27);
assume('arrSiem', 'SIEM ARR', 695, null, null, 'one', '公司 2Q27 法說會揭露', '已定', SRC_2Q27);
assume('arrIdentity', '身分 ARR', 585, null, null, 'one', '公司 2Q27 法說會揭露', '已定', SRC_2Q27);
assume('arrGuardian', 'Guardian ARR', 43, null, null, 'one', '推論：公家採購案報價 × 已部署台數', '已定', '推論。來源：加州橘郡運輸局採購文件（2026-11-23 已去信索取逐項報價）');
assume('arrEndpoint', '端點與其他 ARR', 3613, null, null, 'one', '期末 ARR 5,841 減去以上四塊', '已定', '期末 ARR 5,841 百萬美元。來源：公司 2Q27 8-K（2026-08-26）');
calc('arrBase', '期末 ARR 合計', `=SUM(B${M.arrCloud}:B${M.arrEndpoint})`, 'one', '五塊加總，應等於 5,841');
r++;

step('二、端點＝台數 × 每台單價');
assume('epUnits', '端點台數年增率', 0.16, 0.12, 0.2, 'pct', '最近四季台數年增 14%–18%，取中位數', '要', '假設。來源：公司 2Q27 法說會（2026-08-26）、FUNDA（2026-11-10）');
assume('epPrice', '每台單價年增率', 0.025, 0.01, 0.04, 'pct', '續約漲價 1%–4%', '已定', '假設。來源：通路訪談（2026-11-18）');
calc('epArr', '四季後端點 ARR', `=${B('arrEndpoint')}*(1+${B('epUnits')})*(1+${B('epPrice')})`, 'one', '基期 ×（1＋台數年增）×（1＋單價年增）');
calc('epNew', '端點淨新增 ARR', `=${B('epArr')}-${B('arrEndpoint')}`, 'one', '');
r++;

step('三、Guardian＝員工電腦台數 × 滲透率 × 每台單價');
assume('gdSeats', '員工電腦台數（百萬台）', 26, null, null, 'one', '既有客戶的員工電腦 2,600 萬台', '已定', '來源：公司 2Q27 法說會（2026-08-26）');
assume('gdPen', '四季後滲透率', 0.163, 0.12, 0.2, 'pct', '目前 6.6%，每季加 2–3 個百分點', '要', '假設。目前滲透率＝43 ÷（26 × 25）');
assume('gdPrice', 'Guardian 每台單價（美元）', 25, 20, 30, 'one', '公家採購案報價 20–30 美元', '要', '尚無官方資料。參照：加州橘郡運輸局採購案（2026-11-23 去信索取）');
calc('gdArr', '四季後 Guardian ARR', `=${B('gdSeats')}*${B('gdPen')}*${B('gdPrice')}`, 'one', '台數 × 滲透率 × 單價');
calc('gdNew', 'Guardian 淨新增 ARR', `=${B('gdArr')}-${B('arrGuardian')}`, 'one', '');
r++;

step('四、身分＝既有年增＋代理人帳號');
assume('idGrowth', '既有身分年增率', 0.34, 0.3, 0.38, 'pct', '最近四季年增 32%–36%', '已定', '來源：公司 2Q27 法說會（2026-08-26）');
assume('agStaff', '員工人數（百萬人）', 26, null, null, 'one', '一人一台電腦，同第三步台數', '已定', '假設');
assume('agPer', '每人代理人帳號數', 5, 0.3, 8, 'one', '電腦上實測 0.3–8 個；管理層說的 90 個數的是帳號', '要', '八筆量法見「第二題拆解」筆記（2026-11-23）');
assume('agPrice', '每個帳號單價（美元）', 35, 25, 45, 'one', '機器帳號報價 25–45 美元', '要', '來源：同業公開報價（2026-11-23）');
assume('agBuy', '購買比例', 0.17, 0.1, 0.25, 'pct', '身分模組現有客戶滲透率', '要', '假設');
assume('agRealize', '未來四季實現比例', 0.1, 0.05, 0.15, 'pct', '合約分年認列，第一年約一成', '要', '假設');
calc('agArr', '代理人帳號 ARR', `=${B('agStaff')}*${B('agPer')}*${B('agPrice')}*${B('agBuy')}*${B('agRealize')}`, 'one', '員工 × 每人帳號 × 單價 × 購買比例 × 實現比例');
calc('idNew', '身分淨新增 ARR', `=${B('arrIdentity')}*${B('idGrowth')}+${B('agArr')}`, 'one', '既有年增＋代理人帳號');
r++;

step('五、雲端與 SIEM：沿用最近一年的年增率');
assume('clGrowth', '雲端年增率', 0.29, null, null, 'pct', '沒有拆解，沿用最近一年', '已定', '來源：公司 2Q27 法說會（2026-08-26）');
assume('siGrowth', 'SIEM 年增率', 0.6, null, null, 'pct', '沒有拆解，沿用最近一年', '已定', '來源：公司 2Q27 法說會（2026-08-26）');
calc('clNew', '雲端淨新增 ARR', `=${B('arrCloud')}*${B('clGrowth')}`, 'one', '');
calc('siNew', 'SIEM 淨新增 ARR', `=${B('arrSiem')}*${B('siGrowth')}`, 'one', '');
r++;

step('六、五塊加總，照去年四季占比分到每季，換成訂閱營收');
calc('newTotal', '未來四季淨新增 ARR 合計', `=${B('epNew')}+${B('gdNew')}+${B('idNew')}+${B('clNew')}+${B('siNew')}`, 'one', '端點＋Guardian＋身分＋雲端＋SIEM');
// last year's four quarters of net new ARR are links to the main sheet's reference row (D..G = 3Q26..2Q27)
['3Q26', '4Q26', '1Q27', '2Q27'].forEach((p, i) =>
  assume(`share${i}`, `${p} 淨新增 ARR`, `=${q(MAIN)}${colName(4 + i)}18`, null, null, 'one', '去年同季，用來算每季占比', '已定'),
);
assume('factor', '訂閱營收換算係數', 0.9845, null, null, 'four', '最近四季「訂閱營收 ÷（季初季末 ARR 平均 ÷ 4）」的平均', '已定', '推論');
r++;

step('七、獲利假設');
assume('margin', '營業利益率', 0.225, 0.21, 0.24, 'pct', '最近四季 21.7%–22.3%；公司長期目標 24% 以上', '要', '假設。來源：公司 2Q27 法說會（2026-08-26）');
assume('below', '營業利益以下淨額（每季）', -20, -28, -12, 'one', '利息收入減所得稅，最近四季 −14 至 −19', '已定', '假設');
assume('shares', '稀釋股數（百萬股）', 1030, 1026, 1034, 'int', '每季增加約 5 百萬股', '已定', '來源：公司 2Q27 10-Q（2026-08-27）');
r++;

// results: one column per quarter (B..E) and the four-quarter total (F)
const QUARTERS = ['3Q27', '4Q27', '1Q28', '2Q28'];
function areaHeader(title) {
  model.set(1, r, title, BOLD);
  QUARTERS.forEach((p, i) => model.set(2 + i, r, p, BOLD));
  model.set(6, r, '四季合計', BOLD);
  r++;
}
/** A row across the four quarters; `f(colLetter, i)` gives each formula. */
function quarterRow(key, label, f, fmt, total) {
  M[key] = r;
  model.set(1, r, label);
  QUARTERS.forEach((_p, i) => model.set(2 + i, r, f(colName(2 + i), i), black(fmt)));
  if (total) model.set(6, r, total(r), black(fmt));
  r++;
}
const sumBE = (row) => `=SUM(B${row}:E${row})`;

areaHeader('每季結果');
quarterRow('resShare', '季度占比', (_c, i) => `=B${M[`share${i}`]}/SUM($B$${M.share0}:$B$${M.share3})`, 'pct', sumBE);
quarterRow('resNew', '淨新增 ARR', (c) => `=$B$${M.newTotal}*${c}${M.resShare}`, 'one', sumBE);
quarterRow('resArr', '期末 ARR', (c, i) => (i === 0 ? `=$B$${M.arrBase}+B${M.resNew}` : `=${colName(1 + i)}${r}+${c}${M.resNew}`), 'one');
quarterRow('resSub', '訂閱營收', (c, i) => `=(${i === 0 ? `$B$${M.arrBase}` : `${colName(1 + i)}${M.resArr}`}+${c}${M.resArr})/2/4*$B$${M.factor}`, 'one', sumBE);
// professional services: the linear estimate on 未來四季營收 (row 6, the second of each quarter's six columns)
model.set(1, r, '專業服務');
QUARTERS.forEach((_p, i) => model.set(2 + i, r, `=${q(NEXT4)}${colName(3 + 6 * i)}6`, green('one')));
model.set(6, r, sumBE(r), black('one'));
M.resSvc = r++;
quarterRow('resRev', '總營收', (c) => `=${c}${M.resSub}+${c}${M.resSvc}`, 'one', sumBE);
// year-ago quarters are D..G on the main sheet
model.set(1, r, '年增率');
QUARTERS.forEach((_p, i) => model.set(2 + i, r, `=${colName(2 + i)}${M.resRev}/${q(MAIN)}${colName(4 + i)}6-1`, green('pct')));
model.set(6, r, `=F${M.resRev}/SUM(${q(MAIN)}D6:G6)-1`, green('pct'));
M.resYoy = r++;
quarterRow('resOp', '調整後營業利益', (c) => `=${c}${M.resRev}*$B$${M.margin}`, 'one', sumBE);
quarterRow('resNi', '調整後淨利', (c) => `=${c}${M.resOp}+$B$${M.below}`, 'one', sumBE);
quarterRow('resEps', '調整後 EPS', (c) => `=${c}${M.resNi}/$B$${M.shares}`, 'two', sumBE);
r++;

areaHeader('對照');
quarterRow('cmpModel', '拆解模型', (c) => `=${c}${M.resRev}`, 'one', sumBE);
model.set(1, r, '保守版（年增率持平 25.8%）');
QUARTERS.forEach((_p, i) => model.set(2 + i, r, `=${q(MAIN)}${colName(4 + i)}6*(1+0.258)`, green('one')));
model.set(6, r, sumBE(r), black('one'));
M.cmpFlat = r++;
// 未來四季營收 row 7 is total revenue: linear is the 2nd, consensus the 3rd of each quarter's six columns
[
  ['cmpLinear', '線性推估', 3],
  ['cmpStreet', '賣方共識', 4],
].forEach(([key, label, first]) => {
  model.set(1, r, label);
  QUARTERS.forEach((_p, i) => model.set(2 + i, r, `=${q(NEXT4)}${colName(first + 6 * i)}7`, green('one')));
  model.set(6, r, sumBE(r), black('one'));
  M[key] = r++;
});
quarterRow('cmpGap', '拆解模型高於賣方共識', (c) => `=${c}${M.cmpModel}/${c}${M.cmpStreet}-1`, 'pct', () => `=F${M.cmpModel}/F${M.cmpStreet}-1`);
r++;

model.set(1, r, '估值（EV/Sales）', BOLD);
model.set(2, r, '數值', BOLD);
model.set(5, r, '依據', BOLD);
r++;
function valuation(key, label, value, fmt, basis, { yellow = false, note } = {}) {
  M[key] = r;
  model.set(1, r, label);
  model.set(2, r, value, style(typeof value === 'string' ? 'black' : 'blue', fmt, yellow), note);
  model.set(5, r, basis);
  r++;
}
valuation('price', '股價（美元）', 229.44, 'two', '2026-11-20 收盤', { note: '來源：Interactive Brokers（2026-11-20 收盤）' });
valuation('multiple', 'EV/Sales 倍數', 25, 'one', '2023 年至今中位數 17.8 倍；他給 25 倍', { yellow: true, note: '假設。還在等決定：維持 25 倍還是往上調' });
valuation('valRev', '未來四季營收', `=F${M.resRev}`, 'one', '每季結果的四季合計');
valuation('netCash', '淨現金', 5150, 'int', '現金與有價證券減負債', { note: '來源：公司 2Q27 10-Q（2026-08-27）' });
valuation('valShares', '股數（百萬股）', `=${B('shares')}`, 'int', '第七步的稀釋股數');
valuation('target', '目標價（美元）', `=(${B('multiple')}*${B('valRev')}+${B('netCash')})/${B('valShares')}`, 'two', '（倍數 × 未來四季營收 ＋ 淨現金）÷ 股數');
valuation('impliedMultiple', '目前股價對應倍數', `=(${B('price')}*${B('valShares')}-${B('netCash')})/${B('valRev')}`, 'one', '（股價 × 股數 − 淨現金）÷ 未來四季營收');
valuation('upside', '目標價對股價', `=${B('target')}/${B('price')}-1`, 'pct', '');
valuation('median', '2023 年至今倍數中位數', 17.8, 'one', '估值錨點筆記（2026-11-23）');
valuation('peerPanw', '同業倍數：Palo Alto Networks', 19.2, 'one', '同業估值對照筆記（2026-11-23）');
valuation('peerFtnt', '同業倍數：Fortinet', 13.2, 'one', '同業估值對照筆記（2026-11-23）');
valuation('peerZs', '同業倍數：Zscaler', 6.6, 'one', '同業估值對照筆記（2026-11-23）');

// ---- CRWD 簡明損益表 ---------------------------------------------------------------------------

const main = new Sheet(MAIN);
main.widths = { 1: 22 };
const PARTIES = ['我的預估', '賣方共識', 'FUNDA 預估', 'Allen 預估', '公司財測', '財報實際'];
const ACTUAL_QUARTERS = ['1Q26', '2Q26', '3Q26', '4Q26', '1Q27', '2Q27']; // columns B..G
const FY26 = 8; // column H
const FORECASTS = ['3Q27', '4Q27', 'FY27', 'FY28']; // six columns each, from I
const firstCol = (period) => 9 + 6 * FORECASTS.indexOf(period);
const ROW = { sub: 4, svc: 5, rev: 6, yoy: 7, qoq: 8, op: 9, margin: 10, below: 11, ni: 12, shares: 13, eps: 14, epsYoy: 15, arr: 17, arrNew: 18, arrYoy: 19 };

main.set(1, 1, 'CRWD 簡明損益表（百萬美元，EPS 為美元）', BOLD);
ACTUAL_QUARTERS.forEach((p, i) => {
  main.set(2 + i, 2, p, BOLD);
  main.set(2 + i, 3, '實際', BOLD);
});
main.set(FY26, 2, 'FY26', BOLD);
main.set(FY26, 3, '實際', BOLD);
FORECASTS.forEach((p) => {
  const c = firstCol(p);
  main.set(c, 2, p, BOLD);
  main.merges.push(`${colName(c)}2:${colName(c + 5)}2`);
  PARTIES.forEach((party, i) => main.set(c + i, 3, party, BOLD));
});
[
  ['sub', '訂閱'],
  ['svc', '專業服務'],
  ['rev', '總營收'],
  ['yoy', '年增率'],
  ['qoq', '季增率'],
  ['op', '調整後營業利益'],
  ['margin', '營業利益率'],
  ['below', '營業利益以下淨額'],
  ['ni', '調整後淨利'],
  ['shares', '稀釋股數'],
  ['eps', '調整後 EPS'],
  ['epsYoy', 'EPS 年增率'],
  ['arr', '參考：期末 ARR'],
  ['arrNew', '參考：淨新增 ARR'],
  ['arrYoy', '參考：ARR 年增率'],
].forEach(([key, label]) => main.set(1, ROW[key], label));

const ACTUALS = {
  sub: [1051, 1102, 1165.6, 1236, 1315, 1398.9],
  svc: [66.4, 67.6, 68.9, 70, 71.3, 72.5],
  op: [201, 255, 262, 286, 301, 327],
  below: [-15, -17, -14, -16, -18, -19],
  shares: [1000, 1004, 1009, 1013, 1018, 1023],
  arr: [4350, 4589.2, 4857.2, 5221.2, 5477, 5841],
};
const FILED = ['2025-06-03', '2025-08-27', '2025-12-02', '2026-03-03', '2026-06-02', '2026-08-26'];
/** The derived rows of one column: totals, margins and EPS from the rows above them. */
function derived(sheet, c, { yoyOf, qoqOf } = {}) {
  const C = colName(c);
  sheet.set(c, ROW.rev, `=${C}${ROW.sub}+${C}${ROW.svc}`, black('one'));
  if (yoyOf) sheet.set(c, ROW.yoy, `=${C}${ROW.rev}/${yoyOf}${ROW.rev}-1`, black('pct'));
  if (qoqOf) sheet.set(c, ROW.qoq, `=${C}${ROW.rev}/${qoqOf}${ROW.rev}-1`, black('pct'));
  sheet.set(c, ROW.margin, `=${C}${ROW.op}/${C}${ROW.rev}`, black('pct'));
  sheet.set(c, ROW.ni, `=${C}${ROW.op}+${C}${ROW.below}`, black('one'));
  sheet.set(c, ROW.eps, `=${C}${ROW.ni}/${C}${ROW.shares}`, black('two'));
  if (yoyOf) sheet.set(c, ROW.epsYoy, `=${C}${ROW.eps}/${yoyOf}${ROW.eps}-1`, black('pct'));
}
ACTUAL_QUARTERS.forEach((p, i) => {
  const c = 2 + i;
  const note = `來源：公司 ${p} 8-K（${FILED[i]}）`;
  main.set(c, ROW.sub, ACTUALS.sub[i], blue('one'), note);
  main.set(c, ROW.svc, ACTUALS.svc[i], blue('one'), note);
  main.set(c, ROW.op, ACTUALS.op[i], blue('one'), note);
  main.set(c, ROW.below, ACTUALS.below[i], blue('one'), note);
  main.set(c, ROW.shares, ACTUALS.shares[i], blue('int'), note);
  main.set(c, ROW.arr, ACTUALS.arr[i], blue('one'), note);
  derived(main, c, { yoyOf: i >= 4 ? colName(c - 4) : undefined, qoqOf: i >= 1 ? colName(c - 1) : undefined });
  if (i === 0) main.set(c, ROW.arrNew, 210, blue('one'), note);
  else main.set(c, ROW.arrNew, `=${colName(c)}${ROW.arr}-${colName(c - 1)}${ROW.arr}`, black('one'));
  if (i >= 4) main.set(c, ROW.arrYoy, `=${colName(c)}${ROW.arr}/${colName(c - 4)}${ROW.arr}-1`, black('pct'));
});
// FY26 = 1Q26..4Q26 (B..E)
for (const key of ['sub', 'svc', 'op', 'below']) main.set(FY26, ROW[key], `=SUM(B${ROW[key]}:E${ROW[key]})`, black('one'));
main.set(FY26, ROW.shares, `=AVERAGE(B${ROW.shares}:E${ROW.shares})`, black('int'));
derived(main, FY26);

// 我的預估: the two forecast quarters link to the model's results (B = 3Q27, C = 4Q27)
['3Q27', '4Q27'].forEach((p, i) => {
  const c = firstCol(p);
  const mc = colName(2 + i);
  main.set(c, ROW.sub, `=${q(MODEL)}${mc}${M.resSub}`, green('one'));
  main.set(c, ROW.svc, `=${q(MODEL)}${mc}${M.resSvc}`, green('one'));
  main.set(c, ROW.op, `=${q(MODEL)}${mc}${M.resOp}`, green('one'));
  main.set(c, ROW.below, `=${q(MODEL)}$B$${M.below}`, green('one'));
  main.set(c, ROW.shares, `=${q(MODEL)}$B$${M.shares}`, green('int'));
  // year-ago quarter: 3Q26 is D, 4Q26 is E; the quarter before 3Q27 is 2Q27 (G), before 4Q27 is 3Q27's 我的預估
  derived(main, c, { yoyOf: colName(4 + i), qoqOf: i === 0 ? 'G' : colName(firstCol('3Q27')) });
});
{
  // FY27 = 1Q27 + 2Q27 actual (F, G) + the two forecast quarters
  const c = firstCol('FY27');
  const [q3, q4] = [colName(firstCol('3Q27')), colName(firstCol('4Q27'))];
  for (const key of ['sub', 'svc', 'op', 'below']) main.set(c, ROW[key], `=F${ROW[key]}+G${ROW[key]}+${q3}${ROW[key]}+${q4}${ROW[key]}`, black('one'));
  main.set(c, ROW.shares, `=AVERAGE(F${ROW.shares},G${ROW.shares},${q3}${ROW.shares},${q4}${ROW.shares})`, black('int'));
  derived(main, c, { yoyOf: colName(FY26) });
}
{
  // FY28: the model stops at 2Q28, so the year grows at the model's four-quarter rate (marked 推論)
  const c = firstCol('FY28');
  const C = colName(c);
  const fy27 = colName(firstCol('FY27'));
  main.set(c, ROW.svc, `=${fy27}${ROW.svc}*(1+${q(NEXT4)}B12)^4`, green('one'), '推論：FY27 專業服務 ×（1＋最近 4 季季增率平均）的四次方');
  main.set(c, ROW.sub, `=${fy27}${ROW.rev}*(1+${q(MODEL)}F${M.resYoy})-${C}${ROW.svc}`, green('one'), '推論：FY27 總營收 ×（1＋拆解模型未來四季年增率）減專業服務');
  main.set(c, ROW.op, `=(${C}${ROW.sub}+${C}${ROW.svc})*${q(MODEL)}$B$${M.margin}`, green('one'));
  main.set(c, ROW.below, `=4*${q(MODEL)}$B$${M.below}`, green('one'));
  main.set(c, ROW.shares, `=${q(MODEL)}$B$${M.shares}`, green('int'));
  derived(main, c, { yoyOf: fy27 });
}

/** Hand-filled figures of the other parties: [訂閱, 專業服務, 營業利益, 以下淨額, 股數] or totals only. */
function party(period, index, values, source) {
  const c = firstCol(period) + index;
  const C = colName(c);
  if (values.sub !== undefined) {
    main.set(c, ROW.sub, values.sub, blue('one'), source);
    main.set(c, ROW.svc, values.svc, blue('one'), source);
    main.set(c, ROW.rev, `=${C}${ROW.sub}+${C}${ROW.svc}`, black('one'));
  } else {
    main.set(c, ROW.rev, values.rev, blue('one'), source);
  }
  if (values.op !== undefined) {
    main.set(c, ROW.op, values.op, blue('one'), source);
    main.set(c, ROW.margin, `=${C}${ROW.op}/${C}${ROW.rev}`, black('pct'));
  }
  main.set(c, ROW.eps, values.eps, blue('two'), source);
}
const STREET = '來源：funda.ai 公司頁的賣方共識（2026-11-21）';
const FUNDA = '來源：FUNDA 研究報告（2026-11-10）';
const ALLEN = '來源：Vocus 美股 Insight（2026-11-15）';
const GUIDE = '來源：公司 2Q27 法說會財測中位數（2026-08-26）';
party('3Q27', 1, { sub: 1478, svc: 72, op: 344, eps: 0.32 }, STREET);
party('3Q27', 2, { rev: 1562, eps: 0.33 }, FUNDA);
party('3Q27', 3, { rev: 1570, eps: 0.36 }, ALLEN);
party('3Q27', 4, { rev: 1545, op: 338, eps: 0.31 }, GUIDE);
party('4Q27', 1, { sub: 1578, svc: 74, op: 370, eps: 0.34 }, STREET);
party('4Q27', 2, { rev: 1668, eps: 0.35 }, FUNDA);
party('4Q27', 3, { rev: 1680, eps: 0.38 }, ALLEN);
party('FY27', 1, { rev: 6059.7, op: 1342, eps: 1.23 }, STREET);
party('FY27', 2, { rev: 6088, eps: 1.26 }, FUNDA);
party('FY27', 3, { rev: 6108, eps: 1.32 }, ALLEN);
party('FY27', 4, { rev: 6040, op: 1325, eps: 1.21 }, GUIDE);
party('FY28', 1, { rev: 7480, op: 1680, eps: 1.52 }, STREET);
party('FY28', 2, { rev: 7650, eps: 1.6 }, FUNDA);
party('FY28', 3, { rev: 7800, eps: 1.75 }, ALLEN);

// ---- 未來四季營收 ------------------------------------------------------------------------------

const next4 = new Sheet(NEXT4);
next4.widths = { 1: 30 };
const N4_PARTIES = ['我的預估', '線性推估', '賣方共識', 'FUNDA', 'Allen', '公司財測'];
const N4_PERIODS = [...QUARTERS, '四季合計'];
next4.set(1, 1, '未來四季營收（百萬美元）', BOLD);
N4_PERIODS.forEach((p, i) => {
  const c = 2 + 6 * i;
  next4.set(c, 3, p, BOLD);
  next4.merges.push(`${colName(c)}3:${colName(c + 5)}3`);
  N4_PARTIES.forEach((name, k) => next4.set(c + k, 4, name, BOLD));
});
next4.set(1, 5, '訂閱');
next4.set(1, 6, '專業服務');
next4.set(1, 7, '總營收');
next4.set(1, 8, '年增率');
next4.set(1, 11, '最近 4 季季增率平均：訂閱');
next4.set(1, 12, '最近 4 季季增率平均：專業服務');
// main sheet C..G = 2Q26..2Q27
const avgQoq = (row) => `=AVERAGE(${['D', 'E', 'F', 'G'].map((c, i) => `${q(MAIN)}${c}${row}/${q(MAIN)}${'CDEF'[i]}${row}-1`).join(',')})`;
next4.set(2, 11, avgQoq(ROW.sub), green('pct'));
next4.set(2, 12, avgQoq(ROW.svc), green('pct'));

const N4_STREET = [
  [1478, 72],
  [1578, 74],
  [1672, 75],
  [1772, 77],
];
const N4_FUNDA = [1562, 1668, 1775, 1880];
const N4_ALLEN = [1570, 1680, 1795, 1905];
QUARTERS.forEach((_p, i) => {
  const c = 2 + 6 * i;
  const [mine, linear, street] = [0, 1, 2].map((k) => colName(c + k));
  const mc = colName(2 + i);
  const prevLinear = colName(c - 5);
  // 我的預估: subscription from the model, services from the linear estimate
  next4.set(c, 5, `=${q(MODEL)}${mc}${M.resSub}`, green('one'));
  next4.set(c, 6, `=${linear}6`, black('one'));
  next4.set(c, 7, `=${mine}5+${mine}6`, black('one'));
  next4.set(c, 8, `=${mine}7/${q(MAIN)}${colName(4 + i)}6-1`, green('pct'));
  // 線性推估: the previous quarter × (1 + the average growth of the last four quarters)
  next4.set(c + 1, 5, i === 0 ? `=${q(MAIN)}G${ROW.sub}*(1+$B$11)` : `=${prevLinear}5*(1+$B$11)`, i === 0 ? green('one') : black('one'));
  next4.set(c + 1, 6, i === 0 ? `=${q(MAIN)}G${ROW.svc}*(1+$B$12)` : `=${prevLinear}6*(1+$B$12)`, i === 0 ? green('one') : black('one'));
  next4.set(c + 1, 7, `=${linear}5+${linear}6`, black('one'));
  next4.set(c + 2, 5, N4_STREET[i][0], blue('one'), STREET);
  next4.set(c + 2, 6, N4_STREET[i][1], blue('one'), STREET);
  next4.set(c + 2, 7, `=${street}5+${street}6`, black('one'));
  next4.set(c + 3, 7, N4_FUNDA[i], blue('one'), FUNDA);
  next4.set(c + 4, 7, N4_ALLEN[i], blue('one'), ALLEN);
  if (i === 0) next4.set(c + 5, 7, 1545, blue('one'), GUIDE);
});
{
  // 四季合計: each party's four quarters, six columns apart
  const c = 2 + 6 * 4;
  for (let k = 0; k < 5; k++) {
    for (const row of k < 3 ? [5, 6, 7] : [7]) {
      next4.set(c + k, row, `=${[0, 1, 2, 3].map((i) => `${colName(2 + 6 * i + k)}${row}`).join('+')}`, black('one'));
    }
  }
  next4.set(c, 8, `=${colName(c)}7/SUM(${q(MAIN)}D6:G6)-1`, green('pct'));
}

// ---- 說明 --------------------------------------------------------------------------------------

const help = new Sheet(HELP);
help.widths = { 1: 110 };
[
  ['這個檔案怎麼用？', true],
  ['「營收模型」放假設，「未來四季營收」和「CRWD 簡明損益表」的「我的預估」都連到它。改假設只改「營收模型」的取用值。'],
  [''],
  ['哪些格子要我判斷？', true],
  ['「營收模型」最右邊標「要」的列，取用值是黃底。標「已定」的不用再看。'],
  [''],
  ['顏色代表什麼？', true],
  ['藍字手填、黑字公式、綠字連到其他分頁。每個手填值的註解寫來源和日期。'],
  [''],
  ['目標價怎麼算？', true],
  ['估值用 EV/Sales：目標價＝（倍數 × 未來四季營收 ＋ 淨現金）÷ 股數。倍數在「營收模型」的估值區。'],
  [''],
  ['各方數字放哪裡？', true],
  ['每個預估期間六欄：我的預估、賣方共識、FUNDA 預估、Allen 預估、公司財測、財報實際。財報後把實際值填進最後一欄。'],
].forEach(([text, bold], i) => help.set(1, i + 1, text, bold ? BOLD : 0));

// ---------------------------------------------------------------------------------------------
// write, recalculate with LibreOffice, derive the variants
// ---------------------------------------------------------------------------------------------

function recalcWithLibreOffice(source) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crwd-xlsx-'));
  const input = path.join(work, 'in.xlsx');
  const outDir = path.join(work, 'out');
  fs.writeFileSync(input, source);
  // its own profile directory, so a running LibreOffice does not swallow the command
  execFileSync('soffice', [`-env:UserInstallation=file://${work}/profile`, '--headless', '--calc', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', outDir, input], { stdio: 'pipe' });
  const result = fs.readFileSync(path.join(outDir, 'in.xlsx'));
  fs.rmSync(work, { recursive: true, force: true });
  return result;
}

/** The same file with every formula's stored result removed, as a tool that never calculated would save it. */
function stripCachedValues(xlsx) {
  const files = readZip(xlsx).map((e) => {
    let data = entryData(e);
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)) {
      const xml = data.toString('utf8').replace(/<c ([^>]*)>(<f[^>]*(?:\/>|>[^<]*<\/f>))<v>[^<]*<\/v><\/c>/g, (_m, attrs, f) => `<c ${attrs.replace(/\s*t="[^"]*"/, '')}>${f}</c>`);
      data = Buffer.from(xml, 'utf8');
    }
    return { name: e.name, data };
  });
  return zipFiles(files);
}

/**
 * A small workbook written the way Excel writes: shared strings (one with a phonetic guide), shared
 * formulas down two columns, a bare CJK sheet name in a formula, a defined name, a note. The stored
 * results are worked out here by hand.
 */
function sharedFormulaWorkbook() {
  const units = [10, 20, 30, 40, 50];
  const price = 1.5;
  const rate = 0.1;
  const strings = ['項目', '數量', '金額', '累計', '單價', '稅率', '含稅合計'];
  let running = 0;
  const rows = units.map((u, i) => {
    const n = i + 2;
    running += u;
    const amount = i === 0 ? `<f t="shared" ref="C2:C6" si="0">B2*資料!$B$1</f>` : `<f t="shared" si="0"/>`;
    const cum = i === 0 ? `<f t="shared" ref="D2:D6" si="1">SUM(B$2:B2)</f>` : `<f t="shared" si="1"/>`;
    return `<row r="${n}"><c r="A${n}" t="inlineStr"><is><t>第 ${i + 1} 項</t></is></c><c r="B${n}"><v>${u}</v></c><c r="C${n}">${amount}<v>${u * price}</v></c><c r="D${n}">${cum}<v>${running}</v></c></row>`;
  });
  const total = units.reduce((a, u) => a + u * price, 0);
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>${rows.join('')}<row r="8"><c r="A8" t="s"><v>6</v></c><c r="C8" s="1"><f>SUM(C2:C6)*(1+稅率)</f><v>${total * (1 + rate)}</v></c><c r="D8" t="str"><f>IF(C8&gt;200,"超過","未超過")</f><v>超過</v></c></row></sheetData><legacyDrawing r:id="rId2"/></worksheet>`;
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c><c r="B1"><v>${price}</v></c></row><row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" s="2"><v>${rate}</v></c></row></sheetData></worksheet>`;
  const text = (name, body) => ({ name, data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`, 'utf8') });
  return zipFiles([
    text(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>',
    ),
    text('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    text(
      'xl/workbook.xml',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="共用公式" sheetId="1" r:id="rId1"/><sheet name="資料" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="稅率">資料!$B$2</definedName></definedNames></workbook>',
    ),
    text(
      'xl/_rels/workbook.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    ),
    text(
      'xl/styles.xml',
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.0"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
    ),
    text(
      'xl/sharedStrings.xml',
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
        .map((s, i) => (i === 6 ? `<si><r><t>含稅</t></r><r><rPr><b/></rPr><t>合計</t></r><rPh sb="0" eb="2"><t>ガンゼイ</t></rPh><phoneticPr fontId="1"/></si>` : `<si><t>${s}</t></si>`))
        .join('')}</sst>`,
    ),
    text('xl/worksheets/sheet1.xml', sheet1.replace(/^<\?xml[^>]*\?>\n/, '')),
    text('xl/worksheets/sheet2.xml', sheet2.replace(/^<\?xml[^>]*\?>\n/, '')),
    text(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>',
    ),
    text(
      'xl/comments1.xml',
      '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Eric</author></authors><commentList><comment ref="C8" authorId="0"><text><r><rPr><b/></rPr><t>Eric:</t></r><r><t xml:space="preserve">\n含 10% 稅</t></r></text></comment></commentList></comments>',
    ),
    {
      name: 'xl/drawings/vmlDrawing1.vml',
      data: Buffer.from(
        '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"/><v:shape id="_x0000_s1025" type="#_x0000_t202" style="visibility:hidden"><x:ClientData ObjectType="Note"><x:Row>7</x:Row><x:Column>2</x:Column></x:ClientData></v:shape></xml>',
        'utf8',
      ),
    },
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const crwd = recalcWithLibreOffice(workbookZip([main, next4, model, help]));
fs.writeFileSync(path.join(OUT_DIR, 'CRWD_簡明損益表.xlsx'), crwd);
fs.writeFileSync(path.join(OUT_DIR, 'CRWD_無計算結果.xlsx'), stripCachedValues(crwd));
fs.writeFileSync(path.join(OUT_DIR, '共用公式.xlsx'), sharedFormulaWorkbook());
console.log(`Wrote 3 workbooks to ${OUT_DIR}`);
