import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CellRef, WorkbookData } from '../../domain/workbook/types';
import { zipFiles } from '../vault/zip';
import { createEngine } from './engine';
import { sha256Hex } from './file';
import { PatchError, patchXlsx, writeZip, type PatchInput } from './patch';
import { readWorkbook } from './read';
import { loadWorkbook } from './view';
import { buildPatched, unintendedDifferences } from './write';
import { entryData, readZip } from './zipRead';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const CRWD = 'CRWD_簡明損益表.xlsx';
const NO_RESULTS = 'CRWD_無計算結果.xlsx';
const SHARED = '共用公式.xlsx';
const MODEL = '營收模型';
const SOFFICE = '/usr/bin/soffice';

const parts = (buf: Buffer) => new Map(readZip(buf).map((e) => [e.name, e]));
const xmlOf = (buf: Buffer, part: string) => entryData(parts(buf).get(part)!).toString('utf8');
const cellsOf = (wb: WorkbookData) => wb.sheets.flatMap((s) => Object.values(s.cells).map((c) => [`${s.name}!${c.address}`, c] as const));
/** The raw XML of one cell. */
const cellXml = (xml: string, address: string) => new RegExp(`<(?:\\w+:)?c r="${address}"(?:[^>]*/>|[^>]*>.*?</(?:\\w+:)?c>)`).exec(xml)?.[0] ?? '';

/**
 * Everything a patch must leave alone: every ZIP entry it does not name keeps its packed bytes,
 * every sheet part it rewrote is the original text with only the named cells replaced, and every
 * cell not named reads exactly as before.
 */
function expectOnlyThese(original: Buffer, patched: Buffer, changedParts: string[], removedParts: string[], named: Record<string, string[]>, sheetParts: Record<string, string>) {
  const [before, after] = [parts(original), parts(patched)];
  expect([...after.keys()]).toEqual([...before.keys()].filter((n) => !removedParts.includes(n)));
  for (const [name, e] of before) {
    if (changedParts.includes(name) || removedParts.includes(name)) continue;
    const now = after.get(name)!;
    expect(now.packed.equals(e.packed), `${name} keeps its packed bytes`).toBe(true);
    expect([now.method, now.crc, now.size, now.dosTime, now.dosDate, now.madeBy, now.externalAttrs]).toEqual([e.method, e.crc, e.size, e.dosTime, e.dosDate, e.madeBy, e.externalAttrs]);
  }
  for (const [sheet, addresses] of Object.entries(named)) {
    const part = sheetParts[sheet];
    let was = xmlOf(original, part);
    let now = xmlOf(patched, part);
    for (const a of addresses) {
      const [x, y] = [cellXml(was, a), cellXml(now, a)];
      expect(x && y, `${sheet}!${a} is in both`).toBeTruthy();
      was = was.replace(x, `[${a}]`);
      now = now.replace(y, `[${a}]`);
    }
    expect(now).toBe(was);
  }
  const namedKeys = new Set(Object.entries(named).flatMap(([sheet, list]) => list.map((a) => `${sheet}!${a}`)));
  const [a, b] = [readWorkbook(original), readWorkbook(patched)];
  expect(cellsOf(b).filter(([k]) => !namedKeys.has(k))).toEqual(cellsOf(a).filter(([k]) => !namedKeys.has(k)));
  expect(b.sheets.map((s) => [s.name, s.hidden, s.merges])).toEqual(a.sheets.map((s) => [s.name, s.hidden, s.merges]));
  expect(b.sharedStrings).toEqual(a.sharedStrings);
  expect(b.definedNames).toEqual(a.definedNames);
}

const CRWD_PARTS = { [MODEL]: 'xl/worksheets/sheet3.xml' };
const cell = (wb: WorkbookData, sheet: string, address: string) => wb.sheets.find((s) => s.name === sheet)!.cells[address];

/** A small workbook from raw parts. */
function workbookZip(o: { sheetData: string; workbookExtra?: string; sharedStrings?: string; calcChain?: boolean; prefix?: string }): Buffer {
  const p = o.prefix ?? '';
  const ns = p ? `xmlns:${p.slice(0, -1)}` : 'xmlns';
  const part = (name: string, data: string) => ({ name, data: Buffer.from(data, 'utf8') });
  const rel = (id: number, type: string, target: string) => `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  return zipFiles([
    part(
      '[Content_Types].xml',
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${o.sharedStrings ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}${o.calcChain ? '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' : ''}</Types>`,
    ),
    part('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel(1, 'officeDocument', 'xl/workbook.xml')}</Relationships>`),
    part(
      'xl/workbook.xml',
      `<${p}workbook ${ns}="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><${p}sheets><${p}sheet name="假設 &amp; 結果" sheetId="1" r:id="rId1"/></${p}sheets>${o.workbookExtra ?? ''}</${p}workbook>`,
    ),
    part(
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel(1, 'worksheet', 'worksheets/sheet1.xml')}${o.sharedStrings ? rel(2, 'sharedStrings', 'sharedStrings.xml') : ''}${o.calcChain ? rel(3, 'calcChain', 'calcChain.xml') : ''}</Relationships>`,
    ),
    part('xl/worksheets/sheet1.xml', `<${p}worksheet ${ns}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><${p}sheetData>${o.sheetData}</${p}sheetData></${p}worksheet>`),
    ...(o.sharedStrings ? [part('xl/sharedStrings.xml', o.sharedStrings)] : []),
    ...(o.calcChain ? [part('xl/calcChain.xml', '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B2" i="1"/><c r="B3"/></calcChain>')] : []),
  ]);
}
const SHEET = '假設 & 結果';

describe('patchXlsx changes the named cells and nothing else', () => {
  it('in the CRWD workbook: a number, a formula replaced by a number and a status text', () => {
    const original = fixture(CRWD);
    const input: PatchInput = { numbers: [{ sheet: MODEL, address: 'B82', value: 30 }, { sheet: MODEL, address: 'B49', value: 300.5 }], texts: [{ sheet: MODEL, address: 'F15', text: '已定' }] };
    const r = patchXlsx(original, input);
    expect(r.changedParts.sort()).toEqual(['xl/workbook.xml', 'xl/worksheets/sheet3.xml']);
    expect(r.removedParts).toEqual([]);
    expect(r.replacedFormulas).toEqual([{ sheet: MODEL, address: 'B49' }]);
    expectOnlyThese(original, r.bytes, r.changedParts, [], { [MODEL]: ['B82', 'B49', 'F15'] }, CRWD_PARTS);

    const after = readWorkbook(r.bytes);
    expect(cell(after, MODEL, 'B82')).toMatchObject({ type: 'number', value: 30 });
    expect(cell(after, MODEL, 'B49')).toMatchObject({ type: 'number', value: 300.5 });
    expect(cell(after, MODEL, 'B49').formula).toBeUndefined();
    expect(cell(after, MODEL, 'F15')).toMatchObject({ type: 'string', value: '已定' });
    // the style (number format) and the note of a replaced cell stay
    const before = readWorkbook(original);
    for (const a of ['B82', 'B49', 'F15']) {
      expect(cell(after, MODEL, a).numFmt).toBe(cell(before, MODEL, a).numFmt);
      expect(cell(after, MODEL, a).note).toBe(cell(before, MODEL, a).note);
    }
    const xml = xmlOf(r.bytes, 'xl/worksheets/sheet3.xml');
    expect(cellXml(xml, 'B82')).toBe('<c r="B82" s="18"><v>30</v></c>');
    expect(cellXml(xml, 'B49')).toMatch(/^<c r="B49" s="\d+"><v>300\.5<\/v><\/c>$/);
    // stored results of other formulas were not asked for and are not touched
    expect(cell(after, MODEL, 'B86')).toEqual(cell(before, MODEL, 'B86'));
  });

  it('in the workbook without stored results', () => {
    const original = fixture(NO_RESULTS);
    const r = patchXlsx(original, { numbers: [{ sheet: MODEL, address: 'B82', value: 22.5 }], texts: [{ sheet: MODEL, address: 'F15', text: '已定' }] });
    expectOnlyThese(original, r.bytes, r.changedParts, [], { [MODEL]: ['B82', 'F15'] }, CRWD_PARTS);
    const after = readWorkbook(r.bytes);
    expect(cell(after, MODEL, 'B82').value).toBe(22.5);
    expect(cell(after, MODEL, 'B86')).toMatchObject({ type: 'empty', hasCached: false });
  });

  it('in the workbook with shared formulas, inline strings and a defined name', () => {
    const original = fixture(SHARED);
    const r = patchXlsx(original, { numbers: [{ sheet: '共用公式', address: 'B3', value: 25 }, { sheet: '資料', address: 'B1', value: 2 }], texts: [] });
    expect(r.changedParts.sort()).toEqual(['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    expectOnlyThese(original, r.bytes, r.changedParts, [], { 共用公式: ['B3'], 資料: ['B1'] }, { 共用公式: 'xl/worksheets/sheet1.xml', 資料: 'xl/worksheets/sheet2.xml' });
    // a constant inside nobody's shared formula: the shared formulas stay shared
    expect(r.unshared).toEqual([]);
    expect(xmlOf(r.bytes, 'xl/worksheets/sheet1.xml')).toContain('<f t="shared" si="0"/>');
  });

  it('writes numbers so that they read back exactly', () => {
    const values = [0.1 + 0.2, 1e-7, -1234567.891, 1e21, 0, -0, 16.01 / 100];
    const rows = values.map((_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>1</v></c></row>`).join('');
    const original = workbookZip({ sheetData: rows });
    const r = patchXlsx(original, { numbers: values.map((value, i) => ({ sheet: SHEET, address: `A${i + 1}`, value })), texts: [] });
    const after = readWorkbook(r.bytes);
    values.forEach((v, i) => expect(cell(after, SHEET, `A${i + 1}`).value).toBe(v === 0 ? 0 : v));
  });

  it('keeps the element prefix, cells without an address, and the other attributes of a cell', () => {
    const original = workbookZip({ prefix: 'x:', sheetData: '<x:row r="2"><x:c t="str" s="3"><x:f>"a"&amp;"b"</x:f><x:v>ab</x:v></x:c><x:c s="4" ph="1"><x:v>7</x:v></x:c><x:c r="D2"/></x:row>' });
    const r = patchXlsx(original, { numbers: [{ sheet: SHEET, address: 'B2', value: 8 }], texts: [] });
    const xml = xmlOf(r.bytes, 'xl/worksheets/sheet1.xml');
    expect(xml).toContain('<x:row r="2"><x:c t="str" s="3"><x:f>"a"&amp;"b"</x:f><x:v>ab</x:v></x:c><x:c s="4" ph="1"><x:v>8</x:v></x:c><x:c r="D2"/></x:row>');
    expect(xmlOf(r.bytes, 'xl/workbook.xml')).toContain('</x:sheets><x:calcPr fullCalcOnLoad="1"/></x:workbook>');
  });
});

describe('a formula cell that is replaced', () => {
  it('writes out the shared formula it belonged to for the cells that keep it', () => {
    const original = fixture(SHARED);
    const before = readWorkbook(original);
    // C2 holds the formula C3:C6 share
    const r = patchXlsx(original, { numbers: [{ sheet: '共用公式', address: 'C2', value: 99 }], texts: [] });
    expect(r.replacedFormulas).toEqual([{ sheet: '共用公式', address: 'C2' }]);
    expect(r.unshared.map((c) => c.address)).toEqual(['C3', 'C4', 'C5', 'C6']);
    const after = readWorkbook(r.bytes);
    expect(cell(after, '共用公式', 'C2')).toMatchObject({ type: 'number', value: 99 });
    expect(cell(after, '共用公式', 'C2').formula).toBeUndefined();
    for (const a of ['C3', 'C4', 'C5', 'C6', 'D2', 'D3', 'D6', 'C8', 'D8']) expect(cell(after, '共用公式', a)).toEqual(cell(before, '共用公式', a));
    const xml = xmlOf(r.bytes, 'xl/worksheets/sheet1.xml');
    expect(cellXml(xml, 'C2')).toBe('<c r="C2"><v>99</v></c>');
    expect(cellXml(xml, 'C4')).toBe('<c r="C4"><f>B4*資料!$B$1</f><v>45</v></c>');
    // the other shared formula is untouched
    expect(cellXml(xml, 'D2')).toBe('<c r="D2"><f t="shared" ref="D2:D6" si="1">SUM(B$2:B2)</f><v>10</v></c>');
    expect(cellXml(xml, 'D3')).toBe('<c r="D3"><f t="shared" si="1"/><v>30</v></c>');
    // and the engine computes the same from the new file as from the old one with that cell overridden
    const [e1, e2] = [createEngine(before), createEngine(after)];
    e1.set([{ sheet: '共用公式', address: 'C2', value: 99 }]);
    const refs: CellRef[] = ['C3', 'C6', 'C8', 'D6'].map((address) => ({ sheet: '共用公式', address }));
    expect(e2.get(refs)).toEqual(e1.get(refs));
    e1.dispose();
    e2.dispose();
  });

  it('also when the replaced cell is not the one holding the shared formula, escaping what XML needs', () => {
    const original = workbookZip({
      sheetData:
        '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0" ca="1">IF(A1&lt;2,"小 &amp; 少",A1)</f><v>0</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>3</v></c></row>',
    });
    const before = readWorkbook(original);
    const r = patchXlsx(original, { numbers: [{ sheet: SHEET, address: 'B2', value: 5 }], texts: [] });
    const xml = xmlOf(r.bytes, 'xl/worksheets/sheet1.xml');
    expect(cellXml(xml, 'B1')).toBe('<c r="B1"><f ca="1">IF(A1&lt;2,"小 &amp; 少",A1)</f><v>0</v></c>');
    expect(cellXml(xml, 'B3')).toBe('<c r="B3"><f>IF(A3&lt;2,"小 &amp; 少",A3)</f><v>3</v></c>');
    const after = readWorkbook(r.bytes);
    expect(cell(after, SHEET, 'B1')).toEqual(cell(before, SHEET, 'B1'));
    expect(cell(after, SHEET, 'B3')).toEqual(cell(before, SHEET, 'B3'));
  });

  it('drops the calculation chain with its content type and its relationship; a constant leaves it alone', () => {
    const sheetData = '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f>A2*2</f><v>2</v></c></row><row r="3"><c r="B3"><f>B2+1</f><v>3</v></c></row>';
    const original = workbookZip({ sheetData, calcChain: true });
    const kept = patchXlsx(original, { numbers: [{ sheet: SHEET, address: 'A2', value: 4 }], texts: [] });
    expect(kept.removedParts).toEqual([]);
    expect(parts(kept.bytes).get('xl/calcChain.xml')!.packed.equals(parts(original).get('xl/calcChain.xml')!.packed)).toBe(true);
    expect(parts(kept.bytes).get('[Content_Types].xml')!.packed.equals(parts(original).get('[Content_Types].xml')!.packed)).toBe(true);

    const r = patchXlsx(original, { numbers: [{ sheet: SHEET, address: 'B2', value: 10 }], texts: [] });
    expect(r.removedParts).toEqual(['xl/calcChain.xml']);
    expect(parts(r.bytes).has('xl/calcChain.xml')).toBe(false);
    expect(xmlOf(r.bytes, '[Content_Types].xml')).not.toContain('calcChain');
    expect(xmlOf(r.bytes, '[Content_Types].xml')).toContain('/xl/worksheets/sheet1.xml');
    expect(xmlOf(r.bytes, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain');
    expect(xmlOf(r.bytes, 'xl/_rels/workbook.xml.rels')).toContain('worksheets/sheet1.xml');
    expect(cell(readWorkbook(r.bytes), SHEET, 'B3')).toMatchObject({ formula: 'B2+1', value: 3 });
  });

  it('refuses a cell of an array formula, a text cell for a number, a formula for a status, and cells that are not there', () => {
    const original = workbookZip({
      sheetData: '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="array" ref="B1:B2">A1:A2*2</f><v>2</v></c><c r="C1" t="inlineStr"><is><t>要</t></is></c><c r="D1" t="str"><f>"要"</f><v>要</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>4</v></c></row>',
    });
    const code = (input: PatchInput) => {
      try {
        patchXlsx(original, input);
        return 'ok';
      } catch (e) {
        return e instanceof PatchError ? e.code : `other: ${(e as Error).message}`;
      }
    };
    const n = (address: string, value = 1, sheet = SHEET) => ({ numbers: [{ sheet, address, value }], texts: [] });
    expect(code(n('B1'))).toBe('array-formula');
    expect(code(n('B2'))).toBe('array-formula');
    expect(code(n('C1'))).toBe('not-number');
    expect(code(n('Z9'))).toBe('no-cell');
    expect(code(n('A1', 1, '沒有這個分頁'))).toBe('no-sheet');
    expect(code(n('A1', Number.NaN))).toBe('bad-value');
    expect(code({ numbers: [], texts: [{ sheet: SHEET, address: 'D1', text: '已定' }] })).toBe('not-text');
    expect(code({ numbers: [], texts: [{ sheet: SHEET, address: 'A1', text: '已定' }] })).toBe('not-text');
    expect(code({ numbers: [{ sheet: SHEET, address: 'A1', value: 1 }], texts: [], cached: [{ sheet: SHEET, address: 'A1', value: 2 }] })).toBe('duplicate');
    expect(code(n('A1', 5))).toBe('ok');
  });
});

describe('a status text', () => {
  it('points at the shared string that already says 已定, and no shared string is edited', () => {
    const original = fixture(CRWD);
    const before = readWorkbook(original);
    const index = before.sharedStrings.indexOf('已定');
    expect(index).toBeGreaterThan(-1);
    const yao = xmlOf(original, 'xl/worksheets/sheet3.xml').match(/<c r="F15"[^>]*><v>(\d+)<\/v><\/c>/)![1];
    const r = patchXlsx(original, { numbers: [], texts: [{ sheet: MODEL, address: 'F15', text: '已定' }] });
    expect(cellXml(xmlOf(r.bytes, 'xl/worksheets/sheet3.xml'), 'F15')).toBe(`<c r="F15" s="4" t="s"><v>${index}</v></c>`);
    expect(parts(r.bytes).get('xl/sharedStrings.xml')!.packed.equals(parts(original).get('xl/sharedStrings.xml')!.packed)).toBe(true);
    // the other cells that say 要 use the same shared string and still say 要
    const after = readWorkbook(r.bytes);
    const others = Object.values(before.sheets.find((s) => s.name === MODEL)!.cells).filter((c) => c.value === '要' && c.address !== 'F15');
    expect(others.length).toBeGreaterThan(3);
    expect(xmlOf(r.bytes, 'xl/worksheets/sheet3.xml')).toContain(`<v>${yao}</v>`);
    for (const c of others) expect(cell(after, MODEL, c.address).value).toBe('要');
  });

  it('becomes an inline string when no shared string says 已定', () => {
    const sharedStrings = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="2"><si><t>要</t></si><si><t>假設</t></si></sst>';
    const original = workbookZip({ sharedStrings, sheetData: '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" s="2" t="s"><v>0</v></c></row><row r="2"><c r="B2" t="s"><v>0</v></c></row>' });
    const r = patchXlsx(original, { numbers: [], texts: [{ sheet: SHEET, address: 'B1', text: '已定' }] });
    expect(cellXml(xmlOf(r.bytes, 'xl/worksheets/sheet1.xml'), 'B1')).toBe('<c r="B1" s="2" t="inlineStr"><is><t>已定</t></is></c>');
    expect(xmlOf(r.bytes, 'xl/sharedStrings.xml')).toBe(sharedStrings);
    expect(r.changedParts.sort()).toEqual(['xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const after = readWorkbook(r.bytes);
    expect([cell(after, SHEET, 'A1').value, cell(after, SHEET, 'B1').value, cell(after, SHEET, 'B2').value]).toEqual(['假設', '已定', '要']);
  });
});

describe('fullCalcOnLoad', () => {
  it('is added to the calculation properties the workbook has', () => {
    const r = patchXlsx(fixture(CRWD), { numbers: [{ sheet: MODEL, address: 'B82', value: 30 }], texts: [] });
    const [was, now] = [xmlOf(fixture(CRWD), 'xl/workbook.xml'), xmlOf(r.bytes, 'xl/workbook.xml')];
    expect(now).toBe(was.replace('iterateDelta="0.0001"/>', 'iterateDelta="0.0001" fullCalcOnLoad="1"/>'));
  });

  it('is put in a new element after the defined names when the workbook has none', () => {
    const r = patchXlsx(fixture(SHARED), { numbers: [{ sheet: '共用公式', address: 'B2', value: 11 }], texts: [] });
    expect(xmlOf(r.bytes, 'xl/workbook.xml')).toContain('</definedNames><calcPr fullCalcOnLoad="1"/></workbook>');
    expect(readWorkbook(r.bytes).definedNames).toEqual(readWorkbook(fixture(SHARED)).definedNames);
  });

  it('leaves workbook.xml alone when it is already set', () => {
    const once = patchXlsx(fixture(CRWD), { numbers: [{ sheet: MODEL, address: 'B82', value: 30 }], texts: [] });
    const twice = patchXlsx(once.bytes, { numbers: [{ sheet: MODEL, address: 'B82', value: 31 }], texts: [] });
    expect(twice.changedParts).toEqual(['xl/worksheets/sheet3.xml']);
    expect(parts(twice.bytes).get('xl/workbook.xml')!.packed.equals(parts(once.bytes).get('xl/workbook.xml')!.packed)).toBe(true);
  });
});

describe('stored results', () => {
  it('are written as numbers, text, booleans and errors; an error Excel has no name for stores nothing', () => {
    const original = workbookZip({
      sheetData:
        '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c><c r="C1" t="str"><f>IF(A1&gt;0,"正","負")</f><v>正</v></c><c r="D1" t="b"><f>A1&gt;0</f><v>1</v></c><c r="E1"><f>1/A1</f><v>1</v></c><c r="F1"><f>A1</f><v>1</v></c><c r="G1"><f>A1+1</f></c></row>',
    });
    const r = patchXlsx(original, {
      numbers: [{ sheet: SHEET, address: 'A1', value: 0 }],
      texts: [],
      cached: [
        { sheet: SHEET, address: 'B1', value: 0 },
        { sheet: SHEET, address: 'C1', value: '負 <&>' },
        { sheet: SHEET, address: 'D1', value: false },
        { sheet: SHEET, address: 'E1', value: '#DIV/0!' },
        { sheet: SHEET, address: 'F1', value: '#CYCLE!' },
        { sheet: SHEET, address: 'G1', value: 1 },
      ],
    });
    const xml = xmlOf(r.bytes, 'xl/worksheets/sheet1.xml');
    expect(cellXml(xml, 'B1')).toBe('<c r="B1"><f>A1*2</f><v>0</v></c>');
    expect(cellXml(xml, 'C1')).toBe('<c r="C1" t="str"><f>IF(A1&gt;0,"正","負")</f><v>負 &lt;&amp;&gt;</v></c>');
    expect(cellXml(xml, 'D1')).toBe('<c r="D1" t="b"><f>A1&gt;0</f><v>0</v></c>');
    expect(cellXml(xml, 'E1')).toBe('<c r="E1" t="e"><f>1/A1</f><v>#DIV/0!</v></c>');
    expect(cellXml(xml, 'F1')).toBe('<c r="F1"><f>A1</f></c>');
    expect(cellXml(xml, 'G1')).toBe('<c r="G1"><f>A1+1</f><v>1</v></c>');
    expect(r.cacheDropped).toEqual([{ sheet: SHEET, address: 'F1' }]);
    const after = readWorkbook(r.bytes);
    expect(cell(after, SHEET, 'E1')).toMatchObject({ type: 'error', value: '#DIV/0!', formula: '1/A1' });
    expect(cell(after, SHEET, 'F1')).toMatchObject({ type: 'empty', hasCached: false });
  });

  it('buildPatched refreshes them from the engine when the file was verified, and leaves them when it was not', () => {
    const original = fixture(CRWD);
    const loaded = loadWorkbook(original, sha256Hex(original));
    const cells = { changes: [{ sheet: MODEL, address: 'B82', label: '倍數', before: 25, after: 30, wasFormula: false }], statusChanges: [] };
    const built = buildPatched(original, loaded, cells);
    expect(built.recalculated).toBeGreaterThan(0);
    const after = readWorkbook(built.bytes);
    // 目標價 = (倍數 × EPS × 股數 + 淨現金) ÷ 股數, which the file stored as 171.53 for 25 倍
    const was = cell(loaded.workbook, MODEL, 'B86').value as number;
    const now = cell(after, MODEL, 'B86').value as number;
    expect(was).toBeCloseTo(171.53, 2);
    expect(now).toBeGreaterThan(was);
    const engine = createEngine(after);
    expect(engine.selfCheck()).toMatchObject({ state: 'verified', mismatchCount: 0, compared: loaded.selfCheck.compared });
    expect(engine.get([{ sheet: MODEL, address: 'B86' }])[0]).toBeCloseTo(now, 9);
    engine.dispose();
    // every cell that reads differently is the changed one or a formula whose result moved
    const moved = cellsOf(after).filter(([k, c]) => JSON.stringify(c) !== JSON.stringify(cell(loaded.workbook, k.split('!')[0], c.address)));
    expect(moved.length).toBe(built.recalculated + 1);
    expect(moved.filter(([, c]) => c.formula === undefined).map(([k]) => k)).toEqual([`${MODEL}!B82`]);
    loaded.engine.dispose();

    const bare = fixture(NO_RESULTS);
    const unverified = loadWorkbook(bare, sha256Hex(bare));
    expect(unverified.selfCheck.state).toBe('no-cached-values');
    const plain = buildPatched(bare, unverified, cells);
    expect(plain.recalculated).toBe(0);
    expect(cell(readWorkbook(plain.bytes), MODEL, 'B86')).toMatchObject({ type: 'empty', hasCached: false });
    unverified.engine.dispose();
  });

  it('unintendedDifferences names a cell that changed without being asked for', () => {
    const original = fixture(CRWD);
    const before = readWorkbook(original);
    const sneaky = patchXlsx(original, { numbers: [{ sheet: MODEL, address: 'B82', value: 30 }, { sheet: MODEL, address: 'B83', value: 1 }], texts: [] });
    const cells = { changes: [{ sheet: MODEL, address: 'B82', label: '倍數', before: 25, after: 30, wasFormula: false }], statusChanges: [] };
    expect(unintendedDifferences(before, readWorkbook(sneaky.bytes), cells, [], [])).toEqual([`${MODEL}!B83 changed and was not meant to`]);
    const honest = patchXlsx(original, { numbers: [{ sheet: MODEL, address: 'B82', value: 30 }], texts: [] });
    expect(unintendedDifferences(before, readWorkbook(honest.bytes), cells, [], [])).toEqual([]);
    expect(unintendedDifferences(before, readWorkbook(honest.bytes), { ...cells, changes: [{ ...cells.changes[0], after: 31 }] }, [], [])).toEqual([`${MODEL}!B82 did not become the number asked for`]);
  });
});

describe('writeZip', () => {
  it('copies entries as they are packed, stored or deflated, and drops the data descriptors LibreOffice writes', () => {
    const original = fixture(CRWD);
    const entries = readZip(original);
    expect(entries.some((e) => e.flags & 8)).toBe(true);
    const again = readZip(writeZip(entries));
    expect(again.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    again.forEach((e, i) => {
      expect(e.packed.equals(entries[i].packed)).toBe(true);
      expect(e.flags & 8).toBe(0);
      expect(entryData(e).equals(entryData(entries[i]))).toBe(true);
    });
    // unzip agrees
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-zip-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.xlsx'), writeZip(entries));
      if (fs.existsSync('/usr/bin/unzip')) expect(execFileSync('/usr/bin/unzip', ['-tq', path.join(dir, 'a.xlsx')], { encoding: 'utf8' })).toContain('No errors');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!fs.existsSync(SOFFICE))('LibreOffice opens the written file', () => {
  /** Opens the file in headless LibreOffice with "recalculate on load: always" and saves it again. */
  function recalculated(bytes: Buffer): WorkbookData {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lo-'));
    try {
      fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'out'));
      fs.writeFileSync(
        path.join(dir, 'profile', 'user', 'registrymodifications.xcu'),
        '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item></oor:items>',
      );
      fs.writeFileSync(path.join(dir, 'in.xlsx'), bytes);
      execFileSync(SOFFICE, [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--calc', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', path.join(dir, 'out'), path.join(dir, 'in.xlsx')], { stdio: 'pipe', timeout: 150_000 });
      return readWorkbook(fs.readFileSync(path.join(dir, 'out', 'in.xlsx')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  /** Every formula result LibreOffice computed, against this app's engine on the same bytes. */
  function expectSameNumbers(bytes: Buffer, lo: WorkbookData) {
    const ours = readWorkbook(bytes);
    const engine = createEngine(ours);
    let compared = 0;
    try {
      for (const sheet of ours.sheets) {
        const theirs = lo.sheets.find((s) => s.name === sheet.name)!;
        for (const c of Object.values(sheet.cells)) {
          const [mine] = engine.get([{ sheet: sheet.name, address: c.address }]);
          const other = theirs.cells[c.address]?.value ?? null;
          if (typeof mine === 'number') {
            expect(typeof other, `${sheet.name}!${c.address}`).toBe('number');
            expect(Math.abs((other as number) - mine), `${sheet.name}!${c.address}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(mine)));
            if (c.formula !== undefined) compared++;
          } else if (c.formula === undefined && typeof mine === 'string') expect(other, `${sheet.name}!${c.address}`).toBe(mine);
        }
      }
    } finally {
      engine.dispose();
    }
    return compared;
  }

  it('recalculates to the numbers of the engine: a changed number, a formula replaced by a number, a status text', () => {
    const original = fixture(CRWD);
    const loaded = loadWorkbook(original, sha256Hex(original));
    const cells = {
      changes: [
        { sheet: MODEL, address: 'B82', label: '倍數', before: 25, after: 30, wasFormula: false },
        { sheet: MODEL, address: 'B49', label: '3Q26 淨新增 ARR', before: 0, after: 300, wasFormula: true },
      ],
      statusChanges: [{ sheet: MODEL, address: 'F15', label: '端點台數年增率', before: '要', after: '已定' }],
    };
    const built = buildPatched(original, loaded, cells);
    loaded.engine.dispose();
    const lo = recalculated(built.bytes);
    expect(lo.sheets.map((s) => s.name)).toEqual(loaded.workbook.sheets.map((s) => s.name));
    expect(cell(lo, MODEL, 'B82')).toMatchObject({ type: 'number', value: 30 });
    expect(cell(lo, MODEL, 'B49')).toMatchObject({ type: 'number', value: 300 });
    expect(cell(lo, MODEL, 'B49').formula).toBeUndefined();
    expect(cell(lo, MODEL, 'F15').value).toBe('已定');
    expect(expectSameNumbers(built.bytes, lo)).toBeGreaterThan(200);
    // and what this app stored as results is what LibreOffice computes
    const stored = readWorkbook(built.bytes);
    for (const [k, c] of cellsOf(stored)) {
      if (c.formula === undefined || typeof c.value !== 'number') continue;
      const other = cell(lo, k.split('!')[0], c.address).value as number;
      expect(Math.abs(other - c.value), k).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(c.value)));
    }
  }, 180_000);

  it('recalculates stale stored results too, which proves the comparison is against a fresh calculation', () => {
    const original = fixture(CRWD);
    // only the cell changes; the stored target price still says 171.53
    const stale = patchXlsx(original, { numbers: [{ sheet: MODEL, address: 'B82', value: 30 }], texts: [] });
    expect(cell(readWorkbook(stale.bytes), MODEL, 'B86').value).toBeCloseTo(171.53, 2);
    const lo = recalculated(stale.bytes);
    expect(cell(lo, MODEL, 'B86').value as number).toBeGreaterThan(200);
    expect(expectSameNumbers(stale.bytes, lo)).toBeGreaterThan(200);
  }, 180_000);

  it('opens a workbook whose shared formula was written out', () => {
    const original = fixture(SHARED);
    const r = patchXlsx(original, { numbers: [{ sheet: '共用公式', address: 'C2', value: 99 }], texts: [] });
    const lo = recalculated(r.bytes);
    expect(cell(lo, '共用公式', 'C2')).toMatchObject({ type: 'number', value: 99 });
    expect(expectSameNumbers(r.bytes, lo)).toBeGreaterThan(8);
  }, 180_000);
});
