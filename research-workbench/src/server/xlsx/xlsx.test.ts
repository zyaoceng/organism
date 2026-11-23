import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectWorkbook, resolveOutputs } from '../../domain/workbook/detect';
import { computeSensitivity } from '../../domain/workbook/sensitivity';
import type { WorkbookData } from '../../domain/workbook/types';
import { zipFiles } from '../vault/zip';
import { HyperFormulaEngine, createEngine } from './engine';
import { readWorkbook } from './read';
import { XlsxError, entryData, readZip } from './zipRead';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const MAIN = 'CRWD 簡明損益表';
const NEXT4 = '未來四季營收';
const MODEL = '營收模型';

const crwd = readWorkbook(fixture('CRWD_簡明損益表.xlsx'));
const sheetOf = (wb: WorkbookData, name: string) => wb.sheets.find((s) => s.name === name)!;

/** A one-sheet xlsx from raw <row> XML, for cases no fixture covers. */
function tinyXlsx(sheetData: string, extra: { name: string; data: string }[] = []): Buffer {
  const part = (name: string, data: string) => ({ name, data: Buffer.from(data, 'utf8') });
  return zipFiles([
    part('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    part('xl/workbook.xml', '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="表 1" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>'),
    part('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>'),
    part('xl/worksheets/sheet1.xml', `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>${sheetData}</x:sheetData></x:worksheet>`),
    ...extra.map((e) => part(e.name, e.data)),
  ]);
}

describe('readZip', () => {
  it('reads back what the ZIP writer wrote, stored or deflated', () => {
    const files = [
      { name: 'a.txt', data: Buffer.from('hello hello hello hello') },
      { name: '資料夾/中文.xml', data: Buffer.from('<x>營收</x>') },
      { name: 'empty', data: Buffer.alloc(0) },
    ];
    const entries = readZip(zipFiles(files));
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    entries.forEach((e, i) => expect(entryData(e).equals(files[i].data)).toBe(true));
    expect(entries[0]).toMatchObject({ method: 8, size: 23 });
  });

  it('reads a file LibreOffice wrote', () => {
    const names = readZip(fixture('CRWD_簡明損益表.xlsx')).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['xl/workbook.xml', 'xl/worksheets/sheet3.xml', 'xl/sharedStrings.xml', 'xl/comments1.xml']));
  });

  it('refuses what is not a ZIP, and says why', () => {
    const code = (buf: Buffer) => {
      try {
        readZip(buf);
        return 'ok';
      } catch (err) {
        return err instanceof XlsxError ? err.code : 'other';
      }
    };
    expect(code(Buffer.from('not a zip at all, just some text that is long enough'))).toBe('not-zip');
    expect(code(Buffer.alloc(0))).toBe('not-zip');
    // an encrypted workbook is an OLE file
    expect(code(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]))).toBe('not-zip');
    // a file cut off mid-download loses its directory
    const whole = zipFiles([{ name: 'a', data: Buffer.from('abc') }]);
    expect(code(whole.subarray(0, whole.length - 10))).toBe('not-zip');
  });

  it('notices damaged contents', () => {
    const zip = Buffer.from(zipFiles([{ name: 'a.txt', data: Buffer.from('hello hello hello hello') }]));
    zip[37] ^= 0xff; // inside the packed bytes, after the 30-byte header and the 5-byte name
    expect(() => entryData(readZip(zip)[0])).toThrow(XlsxError);
  });
});

describe('readWorkbook', () => {
  it('reads the four sheets by their Chinese names', () => {
    expect(crwd.sheets.map((s) => s.name)).toEqual([MAIN, NEXT4, MODEL, '說明']);
    expect(crwd.sheets.every((s) => !s.hidden)).toBe(true);
    expect(crwd.sharedStrings).toEqual(expect.arrayContaining(['取用值', '下緣', '上緣', '依據', '要', '已定', '我的預估', '財報實際']));
  });

  it('gives each cell its formula, stored result, number format and note', () => {
    const model = sheetOf(crwd, MODEL);
    expect(model.cells.B15).toMatchObject({ address: 'B15', row: 15, col: 2, type: 'number', value: 0.16, numFmt: '0.0%' });
    expect(model.cells.B15.formula).toBeUndefined();
    expect(model.cells.B15.note).toContain('公司 2Q27 法說會（2026-08-26）');
    expect(model.cells.A15).toMatchObject({ type: 'string', value: '端點台數年增率' });
    expect(model.cells.F15.value).toBe('要');
    expect(model.cells.B86).toMatchObject({ formula: '(B82*B83+B84)/B85', hasCached: true, type: 'number' });
    expect(model.cells.B86.value).toBeCloseTo(171.53, 2);
    // a cross-sheet link, as the file spells it
    expect(sheetOf(crwd, MAIN).cells.I4.formula).toBe('營收模型!B65');
    expect(model.cells.B68.formula).toBe("B67/'CRWD 簡明損益表'!D6-1");
    expect(sheetOf(crwd, MAIN).merges).toEqual(['I2:N2', 'O2:T2', 'U2:Z2', 'AA2:AF2']);
  });

  it('expands shared formulas, reads shared and rich strings, notes and defined names', () => {
    const wb = readWorkbook(fixture('共用公式.xlsx'));
    const s = sheetOf(wb, '共用公式');
    expect(['C2', 'C3', 'C6'].map((a) => s.cells[a].formula)).toEqual(['B2*資料!$B$1', 'B3*資料!$B$1', 'B6*資料!$B$1']);
    expect(['D2', 'D4', 'D6'].map((a) => s.cells[a].formula)).toEqual(['SUM(B$2:B2)', 'SUM(B$2:B4)', 'SUM(B$2:B6)']);
    expect(s.cells.C6).toMatchObject({ value: 75, hasCached: true });
    expect(s.cells.A1.value).toBe('項目');
    // rich-text runs are joined; the phonetic guide is not part of the text
    expect(s.cells.A8.value).toBe('含稅合計');
    expect(s.cells.A3.value).toBe('第 2 項');
    expect(s.cells.D8).toMatchObject({ type: 'string', value: '超過', formula: 'IF(C8>200,"超過","未超過")' });
    expect(s.cells.C8).toMatchObject({ numFmt: '#,##0.0', note: 'Eric:\n含 10% 稅' });
    expect(sheetOf(wb, '資料').cells.B2.numFmt).toBe('0.00%');
    expect(wb.definedNames).toEqual([{ name: '稅率', formula: '資料!$B$2' }]);
  });

  it('marks formulas that have no stored result', () => {
    const bare = readWorkbook(fixture('CRWD_無計算結果.xlsx'));
    const cell = sheetOf(bare, MODEL).cells.B86;
    expect(cell).toMatchObject({ formula: '(B82*B83+B84)/B85', hasCached: false, type: 'empty', value: null });
    // constants are untouched
    expect(sheetOf(bare, MODEL).cells.B82.value).toBe(25);
  });

  it('reads prefixed XML, cells without addresses, inline strings, booleans and errors', () => {
    const wb = readWorkbook(
      tinyXlsx(
        '<x:row><x:c t="inlineStr"><x:is><x:t>標題</x:t></x:is></x:c><x:c><x:v>1.5</x:v></x:c></x:row>' +
          '<x:row r="3"><x:c r="B3" t="b"><x:v>1</x:v></x:c><x:c r="C3" t="e"><x:f>1/0</x:f><x:v>#DIV/0!</x:v></x:c><x:c r="D3" t="str"><x:v>a_x000A_b</x:v></x:c><x:c r="E3"><x:f t="dataTable" ref="E3:F4" r1="A1"/><x:v>2</x:v></x:c></x:row>',
      ),
    );
    const s = wb.sheets[0];
    expect(s.name).toBe('表 1');
    expect(s.cells.A1.value).toBe('標題');
    expect(s.cells.B1.value).toBe(1.5);
    expect(s.cells.B3).toMatchObject({ type: 'boolean', value: true });
    expect(s.cells.C3).toMatchObject({ type: 'error', value: '#DIV/0!', formula: '1/0', hasCached: true });
    expect(s.cells.D3.value).toBe('a\nb');
    expect(s.cells.E3).toMatchObject({ unsupported: 'data table', value: 2 });
    expect(s.cells.E3.formula).toBeUndefined();
  });

  it('reads an array formula with its range, and the engine recalculates the cells it fills', () => {
    const wb = readWorkbook(
      tinyXlsx(
        '<x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c><x:c r="B1"><x:f t="array" ref="B1:B2">A1:A2*10</x:f><x:v>10</x:v></x:c><x:c r="C1"><x:f>SUM(B1:B2)</x:f><x:v>30</x:v></x:c></x:row>' +
          '<x:row r="2"><x:c r="A2"><x:v>2</x:v></x:c><x:c r="B2"><x:v>20</x:v></x:c></x:row>',
      ),
    );
    expect(wb.sheets[0].cells.B1).toMatchObject({ formula: 'A1:A2*10', arrayRef: 'B1:B2' });
    const engine = createEngine(wb);
    expect(engine.selfCheck()).toMatchObject({ state: 'verified', formulaCells: 3, compared: 3 });
    engine.set([{ sheet: '表 1', address: 'A2', value: 4 }]);
    expect(engine.get([{ sheet: '表 1', address: 'B2' }, { sheet: '表 1', address: 'C1' }])).toEqual([40, 50]);
    engine.dispose();
  });

  it('refuses a ZIP that is not a workbook, and broken XML', () => {
    expect(() => readWorkbook(zipFiles([{ name: 'readme.txt', data: Buffer.from('hi') }]))).toThrow(/not an Excel workbook/);
    const broken = tinyXlsx('<x:row><x:c></x:row>');
    expect(() => readWorkbook(broken)).toThrow(XlsxError);
  });
});

describe('HyperFormulaEngine', () => {
  it('reproduces every result LibreOffice stored in the CRWD workbook', () => {
    const check = createEngine(crwd).selfCheck();
    expect(check).toMatchObject({ state: 'verified', mismatchCount: 0, mismatches: [], missingCached: 0, unsupportedFunctions: [], loadWarnings: [] });
    expect(check.formulaCells).toBeGreaterThan(200);
    expect(check.compared).toBe(check.formulaCells);
  });

  it('gives the handoff numbers: revenue 1,556 / 1,663 / 1,768 / 1,873 = 6,861, target about 171.5 at 25×, 33.7× at 229.44', () => {
    const engine = createEngine(crwd);
    const at = (sheet: string, ...addresses: string[]) => engine.get(addresses.map((address) => ({ sheet, address }))) as number[];
    expect(at(MODEL, 'B67', 'C67', 'D67', 'E67', 'F67').map(Math.round)).toEqual([1556, 1663, 1768, 1873, 6861]);
    const [multiple, target, implied, price] = at(MODEL, 'B82', 'B86', 'B87', 'B81');
    expect(multiple).toBe(25);
    expect(target).toBeGreaterThan(171);
    expect(target).toBeLessThan(172);
    expect(price).toBe(229.44);
    expect(implied).toBeCloseTo(33.7, 1);
    // the conservative version (growth held at 25.8%)
    expect(at(MODEL, 'B75', 'C75', 'D75', 'E75').map(Math.round)).toEqual([1553, 1643, 1744, 1851]);
    // the main sheet's 我的預估 and the four-quarter sheet both follow the model
    expect(at(MAIN, 'I6')[0]).toBeCloseTo(at(MODEL, 'B67')[0], 6);
    expect(at(NEXT4, 'Z7')[0]).toBeCloseTo(at(MODEL, 'F67')[0], 6);
    expect(at(MAIN, 'I14')[0]).toBeCloseTo(0.32, 2);
  });

  it('recalculates across sheets when a value is overridden, and goes back when it is dropped', () => {
    const engine = createEngine(crwd);
    const cells = [
      { sheet: MODEL, address: 'B86' },
      { sheet: MODEL, address: 'F67' },
      { sheet: MAIN, address: 'I14' },
      { sheet: MAIN, address: 'U6' },
    ];
    const base = engine.get(cells) as number[];
    // the multiple moves the target price only
    engine.set([{ sheet: MODEL, address: 'B82', value: 30 }]);
    const at30 = engine.get(cells) as number[];
    expect(at30[0]).toBeCloseTo((30 * base[1] + 5150) / 1030, 6);
    expect(at30.slice(1)).toEqual(base.slice(1));
    // endpoint growth moves revenue, EPS on the main sheet and the fiscal year; the multiple is back at 25
    engine.set([{ sheet: MODEL, address: 'B15', value: 0.2 }]);
    const growth = engine.get(cells) as number[];
    expect(growth[1]).toBeGreaterThan(base[1] + 50);
    expect(growth[2]).toBeGreaterThan(base[2]);
    expect(growth[3]).toBeGreaterThan(base[3]);
    expect(growth[0]).toBeCloseTo((25 * growth[1] + 5150) / 1030, 6);
    // a formula cell can be overridden by a number, and comes back as a formula
    engine.set([{ sheet: MODEL, address: 'B85', value: 515 }]);
    expect((engine.get(cells) as number[])[0]).toBeCloseTo(base[0] * 2, 6);
    engine.set([]);
    expect(engine.get(cells)).toEqual(base);
    expect(engine.selfCheck().state).toBe('verified');
  });

  it('a bad override changes nothing', () => {
    const engine = createEngine(crwd);
    const target = { sheet: MODEL, address: 'B86' };
    const before = engine.get([target]);
    expect(() => engine.set([{ sheet: MODEL, address: 'B82', value: 30 }, { sheet: '沒有這個分頁', address: 'A1', value: 1 }])).toThrow(/沒有這個分頁/);
    expect(engine.get([target])).toEqual(before);
    expect(() => new HyperFormulaEngine().get([target])).toThrow(/No workbook/);
  });

  it('handles shared formulas, a bare CJK sheet name and a CJK defined name', () => {
    const engine = createEngine(readWorkbook(fixture('共用公式.xlsx')));
    expect(engine.selfCheck()).toMatchObject({ state: 'verified', formulaCells: 12, compared: 12 });
    const get = (...addresses: string[]) => engine.get(addresses.map((address) => ({ sheet: '共用公式', address })));
    expect(get('C4', 'D6', 'C8', 'D8')).toEqual([45, 150, 247.5, '超過']);
    // 單價 on the other sheet feeds the shared formula; 稅率 is the defined name
    engine.set([
      { sheet: '資料', address: 'B1', value: 1 },
      { sheet: '資料', address: 'B2', value: 0 },
    ]);
    expect(get('C4', 'C8', 'D8')).toEqual([30, 150, '未超過']);
  });

  it('with no stored results it still calculates, and reports that it cannot be verified', () => {
    const engine = createEngine(readWorkbook(fixture('CRWD_無計算結果.xlsx')));
    const check = engine.selfCheck();
    expect(check).toMatchObject({ state: 'no-cached-values', compared: 0, mismatchCount: 0 });
    expect(check.missingCached).toBe(check.formulaCells);
    expect(Math.round(engine.get([{ sheet: MODEL, address: 'F67' }])[0] as number)).toBe(6861);
  });

  it('lists the cells whose stored result it cannot reproduce', () => {
    const tampered: WorkbookData = structuredClone(crwd);
    sheetOf(tampered, MODEL).cells.B86.value = 180;
    sheetOf(tampered, MODEL).cells.B87.value = 33.69395; // off by 1.3e-6 of the value: outside the tolerance
    sheetOf(tampered, MODEL).cells.F67.value = 6860.9794; // off by 1.3e-9 of the value: inside it
    const check = createEngine(tampered).selfCheck();
    expect(check.state).toBe('mismatch');
    expect(check.mismatchCount).toBe(2);
    expect(check.mismatches[0]).toMatchObject({ sheet: MODEL, address: 'B86', formula: '(B82*B83+B84)/B85', cached: 180 });
    expect(check.mismatches[0].computed).toBeCloseTo(171.53, 2);
    expect(check.mismatches[1].address).toBe('B87');
  });

  it('reports functions it does not have, and things it does not recalculate', () => {
    const wb = readWorkbook(
      tinyXlsx(
        '<x:row r="1"><x:c r="A1"><x:v>2</x:v></x:c><x:c r="B1"><x:f>_xlfn.FANCYNEW(A1)+SUM(A1)</x:f><x:v>5</x:v></x:c><x:c r="C1"><x:f>FANCYNEW(A1)</x:f><x:v>5</x:v></x:c>' +
          '<x:c r="D1"><x:f t="dataTable" ref="D1:D2" r1="A1"/><x:v>2</x:v></x:c><x:c r="E1"><x:f>SUM(Jan:Mar!A1)</x:f><x:v>6</x:v></x:c><x:c r="F1" t="str"><x:f>"0050"&amp;""</x:f><x:v>0050</x:v></x:c><x:c r="G1" t="inlineStr"><x:is><x:t>0050</x:t></x:is></x:c><x:c r="H1" t="b"><x:f>G1=F1</x:f><x:v>1</x:v></x:c></x:row>',
      ),
    );
    const check = createEngine(wb).selfCheck();
    expect(check.unsupportedFunctions).toEqual([{ name: 'FANCYNEW', cells: ['表 1!B1', '表 1!C1'], count: 2 }]);
    expect(check.loadWarnings).toEqual(['表 1!D1: data table is not recalculated', '表 1!E1: a reference across several sheets is not recalculated']);
    expect(check.state).toBe('mismatch');
    // text that looks like a number stays text
    expect(check.mismatches.map((m) => m.address)).toEqual(['B1', 'C1', 'E1']);
  });
});

describe('the CRWD workbook, detected', () => {
  const detected = detectWorkbook(crwd);
  const outputs = resolveOutputs(crwd, detected.outputs);

  it('finds the seven steps, with 要 and 已定', () => {
    expect(detected.warnings).toEqual([]);
    expect(detected.tables.map((t) => t.headerRow)).toHaveLength(7);
    expect(detected.tables.every((t) => t.sheet === MODEL && t.columns.value === 'B' && t.columns.status === 'F')).toBe(true);
    const table = detected.assumptions.filter((a) => a.origin === 'table');
    expect(table).toHaveLength(26);
    expect([...new Set(table.map((a) => a.section))].map((s) => s!.slice(0, 2))).toEqual(['一、', '二、', '三、', '四、', '五、', '六、', '七、']);
    expect(table.filter((a) => a.status === 'needs-decision').map((a) => a.label)).toEqual([
      '端點台數年增率',
      '四季後滲透率',
      'Guardian 每台單價（美元）',
      '每人代理人帳號數',
      '每個帳號單價（美元）',
      '購買比例',
      '未來四季實現比例',
      '營業利益率',
    ]);
    expect(table.find((a) => a.label === '端點台數年增率')).toMatchObject({ value: 0.16, low: 0.12, high: 0.2, valueCell: 'B15', numFmt: '0.0%', basis: '最近四季台數年增 14%–18%，取中位數' });
    expect(table.find((a) => a.label === '端點台數年增率')!.note).toContain('FUNDA');
    // a value that links to another sheet is still an assumption
    expect(table.find((a) => a.label === '1Q27 淨新增 ARR')).toMatchObject({ value: 255.8, valueIsFormula: true, status: 'decided' });
  });

  it('finds the results by their labels', () => {
    expect(outputs.revenueQuarters.map((q) => `${q.period} ${q.cell?.sheet}!${q.cell?.address}`)).toEqual(['3Q27 營收模型!B67', '4Q27 營收模型!C67', '1Q28 營收模型!D67', '2Q28 營收模型!E67']);
    expect(outputs.revenueTotal).toEqual({ sheet: MODEL, address: 'F67' });
    expect(outputs.targetPrice).toEqual({ sheet: MODEL, address: 'B86' });
    expect(outputs.multiple).toEqual({ sheet: MODEL, address: 'B82' });
    expect(outputs.netCash).toEqual({ sheet: MODEL, address: 'B84' });
    expect(outputs.shareCount).toEqual({ sheet: MODEL, address: 'B85' });
    expect(outputs.eps.map((e) => `${e.period} ${e.cell?.address}`)).toEqual(['3Q27 I14', '4Q27 O14', 'FY27 U14', 'FY28 AA14']);
    // the four-quarter sheet holds the same total and is listed as the other place
    expect(detected.candidates.filter((c) => c.output === 'revenue').map((c) => [c.anchor.sheet, c.address, c.chosen])).toEqual([
      [MODEL, 'F67', true],
      [NEXT4, 'Z7', false],
    ]);
  });

  it('finds the six parties for each forecast period', () => {
    const main = detected.partyTables.find((t) => t.sheet === MAIN)!;
    expect(main.periods.map((p) => p.period)).toEqual(['3Q27', '4Q27', 'FY27', 'FY28']);
    expect(main.periods[0].columns.map((c) => `${c.label}:${c.col}`)).toEqual(['我的預估:I', '賣方共識:J', 'FUNDA 預估:K', 'Allen 預估:L', '公司財測:M', '財報實際:N']);
    expect(main.rows.map((r) => r.label)).toEqual(expect.arrayContaining(['訂閱', '總營收', '調整後營業利益', '調整後 EPS']));
    const next4 = detected.partyTables.find((t) => t.sheet === NEXT4)!;
    expect(next4.periods.map((p) => p.period)).toEqual(['3Q27', '4Q27', '1Q28', '2Q28', '四季合計']);
    expect(next4.periods[0].columns.map((c) => c.party)).toEqual(['mine', 'linear', 'consensus', 'funda', 'allen', 'guidance']);
  });

  it('detects the same cells when the file stores no results', () => {
    const bare = readWorkbook(fixture('CRWD_無計算結果.xlsx'));
    const engine = createEngine(bare);
    const again = detectWorkbook(bare, (ref) => engine.get([ref])[0]);
    expect(again.outputs).toEqual(detected.outputs);
    expect(again.warnings).toEqual([]);
    expect(again.assumptions.map((a) => [a.id, a.valueCell, a.status])).toEqual(detected.assumptions.map((a) => [a.id, a.valueCell, a.status]));
    expect(again.assumptions.find((a) => a.label === '1Q27 淨新增 ARR')!.value).toBeCloseTo(255.8, 6);
  });

  it('sensitivity: with a trial range of 20–30× the multiple decides the target price; revenue barely moves', () => {
    const engine = createEngine(crwd);
    const multiple = detected.assumptions.find((a) => a.origin === 'output')!;
    expect(multiple).toMatchObject({ label: 'EV/Sales 倍數', value: 25, low: null, high: null });
    const input = { assumptions: detected.assumptions, outputs: { targetPrice: outputs.targetPrice, revenue: outputs.revenueTotal, eps: outputs.eps[0].cell } };

    // from the sheet's ranges alone the multiple is not in the list
    const sheetOnly = computeSensitivity(engine, input);
    expect(sheetOnly.withoutRange).toContain(multiple.id);
    expect(sheetOnly.rows).toHaveLength(12);
    expect(sheetOnly.rows[0]).toMatchObject({ label: '端點台數年增率', rangeSource: 'sheet' });
    expect(Math.round(sheetOnly.base.revenue!)).toBe(6861);

    const withTrial = computeSensitivity(engine, { ...input, trialRanges: { [multiple.id]: { low: 20, high: 30 } } });
    const [first, second] = withTrial.rows;
    expect(first).toMatchObject({ id: multiple.id, low: 20, high: 30, rangeSource: 'trial' });
    expect(first.targetPrice.delta).toBeCloseTo((10 * withTrial.base.revenue!) / 1030, 4);
    expect(first.revenue.delta).toBe(0);
    expect(second.label).toBe('端點台數年增率');
    // the multiple moves the target price more than ten times as much as the next assumption
    expect(Math.abs(first.targetPrice.delta!)).toBeGreaterThan(10 * Math.abs(second.targetPrice.delta!));
    // no assumption moves four-quarter revenue by more than about 2% across its whole range
    for (const row of withTrial.rows) expect(Math.abs(row.revenue.delta!) / withTrial.base.revenue!).toBeLessThan(0.025);
    // the margin moves EPS and nothing else
    const margin = withTrial.rows.find((r) => r.label === '營業利益率')!;
    expect(margin.targetPrice.delta).toBeCloseTo(0, 9);
    expect(margin.eps.delta).toBeGreaterThan(0.04);
    // the engine is left at the file's values
    expect(engine.get([outputs.targetPrice!])[0]).toBeCloseTo(sheetOnly.base.targetPrice!, 9);
  });
});
