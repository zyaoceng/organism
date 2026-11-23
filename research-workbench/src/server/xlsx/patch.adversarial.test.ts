/**
 * Adversarial checks of the write-back: a workbook laid out the way Excel writes one (declaration
 * with CRLF, shared strings with rich text and phonetic runs, shared formulas, an array formula,
 * merges, validations, conditional formats, defined names, a calculation chain, binary parts) and
 * XML that is legal but unusual (prefixes, single quotes, attributes in any order, line breaks
 * inside tags, comments, a byte order mark). After every patch: each ZIP entry not named is byte
 * for byte the original, the text of a rewritten sheet outside the named cells is the original's,
 * every changed part is well-formed, and LibreOffice reads the same formulas from the new file as
 * from the old one.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SaxesParser } from 'saxes';
import { describe, expect, it } from 'vitest';
import type { WorkbookData } from '../../domain/workbook/types';
import { zipFiles } from '../vault/zip';
import { createEngine } from './engine';
import { patchXlsx, type PatchInput, type PatchResult } from './patch';
import { readWorkbook } from './read';
import { entryData, readZip } from './zipRead';

const SOFFICE = '/usr/bin/soffice';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const parts = (buf: Buffer) => new Map(readZip(buf).map((e) => [e.name, e]));
const xmlOf = (buf: Buffer, part: string) => entryData(parts(buf).get(part)!).toString('utf8');
const cell = (wb: WorkbookData, sheet: string, address: string) => wb.sheets.find((s) => s.name === sheet)!.cells[address];

function wellFormed(xml: string, part: string) {
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', (e) => {
    throw new Error(`${part}: ${e.message}`);
  });
  parser.write(xml.replace(/^﻿/, '')).close();
}

/** A sheet's XML cut into its cell elements (by address, in order) and the text between them. */
function cutCells(xml: string): { between: string[]; cells: [string, string][] } {
  const re = /<((?:\w+:)?)c(?=[\s>/])(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/\1c\s*>)/g;
  const between: string[] = [];
  const cells: [string, string][] = [];
  let at = 0;
  const data = xml.indexOf('sheetData');
  re.lastIndex = data;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    between.push(xml.slice(at, m.index));
    const r = /\sr\s*=\s*["']([A-Z]+\d+)["']/.exec(m[0].slice(0, m[0].indexOf('>')))?.[1] ?? `#${cells.length}`;
    cells.push([r, m[0]]);
    at = m.index + m[0].length;
  }
  between.push(xml.slice(at));
  return { between, cells };
}

/** Everything a patch must leave alone, checked without the patcher's own scanner. */
function expectUntouched(original: Buffer, r: PatchResult, named: Record<string, string[]>) {
  const [before, after] = [parts(original), parts(r.bytes)];
  expect([...after.keys()]).toEqual([...before.keys()].filter((n) => !r.removedParts.includes(n)));
  for (const [name, e] of before) {
    if (r.removedParts.includes(name)) continue;
    const now = after.get(name)!;
    if (!r.changedParts.includes(name)) {
      expect(now.packed.equals(e.packed), `${name} keeps its packed bytes`).toBe(true);
      expect([now.method, now.crc, now.size]).toEqual([e.method, e.crc, e.size]);
    } else wellFormed(entryData(now).toString('utf8'), name);
  }
  const allowed = new Set(['xl/workbook.xml', ...Object.keys(named), ...(r.removedParts.length ? ['[Content_Types].xml', 'xl/_rels/workbook.xml.rels'] : [])]);
  expect(r.changedParts.filter((p) => !allowed.has(p))).toEqual([]);
  for (const [part, addresses] of Object.entries(named)) {
    const [was, now] = [cutCells(xmlOf(original, part)), cutCells(xmlOf(r.bytes, part))];
    expect(now.between).toEqual(was.between);
    expect(now.cells.map((c) => c[0])).toEqual(was.cells.map((c) => c[0]));
    was.cells.forEach(([address, text], i) => {
      if (!addresses.includes(address)) expect(now.cells[i][1], `${part} ${address}`).toBe(text);
    });
  }
}

const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;
const part = (name: string, data: string | Buffer) => ({ name, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data });

const STYLES = `${DECL}<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><dxfs count="1"><dxf><font><b/></font></dxf></dxfs></styleSheet>`;

// 0 要, 1 假設 (rich text), 2 標籤 with a phonetic run, 3 text with entities and kept spaces, 4 已定 (only when asked for)
const strings = (decided: boolean) =>
  `${DECL}<sst xmlns="${MAIN}" count="9" uniqueCount="${decided ? 5 : 4}"><si><t>要</t></si><si><r><rPr><b/><sz val="11"/></rPr><t>假</t></r><r><t xml:space="preserve">設 </t></r></si><si><t>標籤</t><rPh sb="0" eb="2"><t>ヒョウセン</t></rPh><phoneticPr fontId="1"/></si><si><t xml:space="preserve"> a &amp; b &lt;c&gt; </t></si>${decided ? '<si><t>已定</t></si>' : ''}</sst>`;

const PNG = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7919 + (i >> 3)) & 255));

/** Model sheet rows 2–6: A value, B value, C…G shared formulas held by row 2, H status, I array formula. */
function modelSheet(): string {
  const row = (n: number) => {
    const first = n === 2;
    const f = (col: string, si: number, text: string) => `<c r="${col}${n}"${col === 'C' ? ' s="2"' : ''}><f t="shared"${first ? ` ref="${col}2:${col}6"` : ''} si="${si}"${first ? `>${text}</f>` : '/>'}<v>0</v></c>`;
    return (
      `<row r="${n}" spans="1:9" x14ac:dyDescent="0.25"><c r="A${n}" s="1"><v>${n / 10}</v></c><c r="B${n}"><v>${n * 10}</v></c>` +
      f('C', 0, 'B2*資料!$B$1') +
      f('D', 1, 'SUM(B$2:B2)+LOG10(B2)+A2') +
      `<c r="E${n}" t="str"><f t="shared"${first ? ' ref="E2:E6"' : ''} si="2"${first ? `>IF($A2&gt;0.3,"A1 &amp; "&amp;B2,'Data 2'!A2)</f>` : '/>'}<v>x</v></c>` +
      f('F', 3, "SUM('Data 2'!A:A)+SUM('Data 2'!2:2)+SUM('Data 2'!$A2:B$7)") +
      f('G', 4, 'B2+1E+2+rate*B2%+資料!B2') +
      `<c r="H${n}" s="1" t="s"><v>0</v></c>` +
      (first ? `<c r="I2"><f t="array" ref="I2:I3">A2:A3*2</f><v>0.4</v></c>` : n === 3 ? '<c r="I3"><v>0.6</v></c>' : '') +
      '</row>'
    );
  };
  return (
    `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="A1:L9"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="C2" sqref="C2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols><col min="1" max="1" width="12" customWidth="1"/></cols><sheetData>` +
    `<row r="1" spans="1:9" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>1</v></c><c r="B1" t="s"><v>2</v></c><c r="C1" t="s"><v>3</v></c><c r="H1" t="inlineStr"><is><r><rPr><b/></rPr><t>狀</t></r><r><t>態</t></r></is></c></row>` +
    [2, 3, 4, 5, 6].map(row).join('') +
    // a shared formula running across a row, and a total over the shared column
    `<row r="8" spans="1:12" x14ac:dyDescent="0.25"><c r="A8"><v>3</v></c><c r="H8"><f t="shared" ref="H8:K8" si="5">$A8*2+SUM($C2:C6)+C$2</f><v>0</v></c><c r="I8"><f t="shared" si="5"/><v>0</v></c><c r="J8"><f t="shared" si="5"/><v>0</v></c><c r="K8"><f t="shared" si="5"/><v>0</v></c></row>` +
    `<row r="9" spans="1:12" x14ac:dyDescent="0.25"><c r="C9"><f>SUM(C2:C6)</f><v>0</v></c><c r="D9"><f>C9*rate</f><v>0</v></c></row>` +
    `</sheetData><mergeCells count="1"><mergeCell ref="J1:L1"/></mergeCells><conditionalFormatting sqref="H2:H6"><cfRule type="containsText" dxfId="0" priority="1" operator="containsText" text="要"><formula>NOT(ISERROR(SEARCH("要",H2)))</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="H2:H6"><formula1>"要,已定"</formula1></dataValidation></dataValidations><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
  );
}

const DATA_SHEET = `${DECL}<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1.5</v></c></row><row r="2"><c r="A2"><v>7</v></c><c r="B2"><f>模型!B2+模型!C2</f><v>0</v></c></row><row r="3"><c r="B3"><f>SUM(模型!C2:C6)+模型!A2</f><v>0</v></c></row></sheetData></worksheet>`;
const DATA2_SHEET = `${DECL}<worksheet xmlns="${MAIN}"><sheetData>${[1, 2, 3, 4, 5, 6, 7].map((n) => `<row r="${n}"><c r="A${n}"><v>${n}</v></c><c r="B${n}"><v>${n * 2}</v></c></row>`).join('')}</sheetData></worksheet>`;

/** A workbook as Excel lays one out. */
function excelLike(o: { decided?: boolean; model?: string } = {}): Buffer {
  return zipFiles([
    part(
      '[Content_Types].xml',
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${[1, 2, 3].map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ),
    part('_rels/.rels', `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>${rel('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`),
    part('docProps/core.xml', `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>我</dc:creator></cp:coreProperties>`),
    part(
      'xl/workbook.xml',
      `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="166925"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12000"/></bookViews><sheets><sheet name="模型" sheetId="1" r:id="rId1"/><sheet name="資料" sheetId="2" r:id="rId2"/><sheet name="Data 2" sheetId="3" r:id="rId3"/></sheets><definedNames><definedName name="rate">資料!$B$1</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">模型!$A$1:$L$9</definedName></definedNames><calcPr calcId="191029"/><extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:workbookPr chartTrackingRefBase="1"/></ext></extLst></workbook>`,
    ),
    part(
      'xl/_rels/workbook.xml.rels',
      `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId3', 'worksheet', 'worksheets/sheet3.xml')}${rel('rId2', 'worksheet', 'worksheets/sheet2.xml')}${rel('rId1', 'worksheet', 'worksheets/sheet1.xml')}${rel('rId6', 'calcChain', 'calcChain.xml')}${rel('rId5', 'sharedStrings', 'sharedStrings.xml')}${rel('rId4', 'styles', 'styles.xml')}</Relationships>`,
    ),
    part('xl/worksheets/sheet1.xml', o.model ?? modelSheet()),
    part('xl/worksheets/sheet2.xml', DATA_SHEET),
    part('xl/worksheets/sheet3.xml', DATA2_SHEET),
    part('xl/styles.xml', STYLES),
    part('xl/sharedStrings.xml', strings(o.decided ?? false)),
    part('xl/calcChain.xml', `${DECL}<calcChain xmlns="${MAIN}"><c r="C2" i="1" l="1"/><c r="C3" i="1"/><c r="C9" i="1"/><c r="B2" i="2"/></calcChain>`),
    part('xl/media/image1.png', PNG),
    part('customXml/item1.xml', '<?xml version="1.0" encoding="utf-16"?><a b=\'c\'/>'),
  ]);
}

const M = 'xl/worksheets/sheet1.xml';
const num = (address: string, value: number, sheet = '模型') => ({ sheet, address, value });

/** Opens each file in headless LibreOffice, recalculating everything, and reads what it saves. */
function throughLibreOffice(files: Buffer[]): WorkbookData[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-adv-'));
  try {
    fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(
      path.join(dir, 'profile', 'user', 'registrymodifications.xcu'),
      '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item></oor:items>',
    );
    const names = files.map((bytes, i) => {
      fs.writeFileSync(path.join(dir, `f${i}.xlsx`), bytes);
      return path.join(dir, `f${i}.xlsx`);
    });
    execFileSync(SOFFICE, [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--calc', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', path.join(dir, 'out'), ...names], { stdio: 'pipe', timeout: 240_000 });
    return files.map((_, i) => readWorkbook(fs.readFileSync(path.join(dir, 'out', `f${i}.xlsx`))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const formulasOf = (wb: WorkbookData, skip: Set<string>) =>
  Object.fromEntries(wb.sheets.flatMap((s) => Object.values(s.cells).filter((c) => !skip.has(`${s.name}!${c.address}`)).map((c) => [`${s.name}!${c.address}`, c.formula ?? (c.type === 'number' ? null : c.value)])));

const CASES: { name: string; decided?: boolean; input: PatchInput; unshared?: string[] }[] = [
  { name: 'the cell that holds a shared formula', input: { numbers: [num('C2', 99)], texts: [] }, unshared: ['C3', 'C4', 'C5', 'C6'] },
  { name: 'a cell in the middle of every shared formula at once', input: { numbers: ['C', 'D', 'E', 'F', 'G'].map((c) => num(`${c}4`, 5)), texts: [] }, unshared: ['C', 'D', 'E', 'F', 'G'].flatMap((c) => [2, 3, 5, 6].map((n) => `${c}${n}`)) },
  { name: 'the first cell of a shared formula that runs along a row', input: { numbers: [num('H8', 1)], texts: [] }, unshared: ['I8', 'J8', 'K8'] },
  { name: 'constants other sheets read, and a status with no 已定 among the shared strings', input: { numbers: [num('A2', 0.9), num('B4', 123.456), num('B1', 2, '資料')], texts: [{ sheet: '模型', address: 'H3', text: '已定' }] } },
  { name: 'a status when 已定 is a shared string', decided: true, input: { numbers: [], texts: [{ sheet: '模型', address: 'H5', text: '已定' }] } },
  { name: 'a formula on another sheet', input: { numbers: [num('B2', 4, '資料')], texts: [] } },
];

describe('a workbook laid out the way Excel writes one', () => {
  for (const c of CASES) {
    it(`keeps everything else as it was: ${c.name}`, () => {
      const original = excelLike({ decided: c.decided });
      const before = readWorkbook(original);
      const r = patchXlsx(original, c.input, before);
      expect(r.unshared.map((u) => u.address).sort()).toEqual([...(c.unshared ?? [])].sort());
      const named: Record<string, string[]> = {};
      const partOf = (sheet: string) => (sheet === '模型' ? M : 'xl/worksheets/sheet2.xml');
      for (const e of [...c.input.numbers, ...c.input.texts, ...r.unshared]) (named[partOf(e.sheet)] ??= []).push(e.address);
      expectUntouched(original, r, named);
      const after = readWorkbook(r.bytes);
      for (const n of c.input.numbers) expect(cell(after, n.sheet, n.address)).toEqual({ ...cell(before, n.sheet, n.address), type: 'number', value: n.value, formula: undefined, hasCached: undefined });
      for (const t of c.input.texts) expect(cell(after, t.sheet, t.address)).toEqual({ ...cell(before, t.sheet, t.address), value: t.text });
      // every other cell reads the same: formula, stored result, format
      const skip = new Set([...c.input.numbers, ...c.input.texts].map((e) => `${e.sheet}!${e.address}`));
      for (const s of before.sheets) for (const x of Object.values(s.cells)) if (!skip.has(`${s.name}!${x.address}`)) expect(cell(after, s.name, x.address), `${s.name}!${x.address}`).toEqual(x);
      expect(after.sharedStrings).toEqual(before.sharedStrings);
      expect(after.definedNames).toEqual(before.definedNames);
      expect(after.sheets.map((s) => s.merges)).toEqual(before.sheets.map((s) => s.merges));
      // the calculation chain goes only when a formula went
      expect(r.removedParts).toEqual(r.replacedFormulas.length ? ['xl/calcChain.xml'] : []);
      expect(xmlOf(r.bytes, 'xl/workbook.xml')).toContain('<calcPr calcId="191029" fullCalcOnLoad="1"/><extLst>');
      expect(xmlOf(r.bytes, 'xl/sharedStrings.xml')).toBe(xmlOf(original, 'xl/sharedStrings.xml'));
    });
  }

  it.skipIf(!fs.existsSync(SOFFICE))(
    'LibreOffice reads the same formulas from every patched file as from the original, and computes what the engine computes',
    () => {
      const originals = [excelLike(), excelLike({ decided: true })];
      const patched = CASES.map((c) => patchXlsx(originals[c.decided ? 1 : 0], c.input).bytes);
      const lo = throughLibreOffice([...originals, ...patched]);
      CASES.forEach((c, i) => {
        const was = lo[c.decided ? 1 : 0];
        const now = lo[2 + i];
        const skip = new Set([...c.input.numbers, ...c.input.texts].map((e) => `${e.sheet}!${e.address}`));
        expect(now.sheets.map((s) => s.name)).toEqual(was.sheets.map((s) => s.name));
        expect(formulasOf(now, skip), c.name).toEqual(formulasOf(was, skip));
        expect(now.sheets.map((s) => s.merges)).toEqual(was.sheets.map((s) => s.merges));
        expect(now.definedNames).toEqual(was.definedNames);
        for (const n of c.input.numbers) expect(cell(now, n.sheet, n.address)).toMatchObject({ type: 'number', value: n.value });
        for (const n of c.input.numbers) expect(cell(now, n.sheet, n.address).formula).toBeUndefined();
        for (const t of c.input.texts) expect(cell(now, t.sheet, t.address).value).toBe(t.text);
        // the numbers LibreOffice computes from the new file are the engine's
        const ours = readWorkbook(patched[i]);
        const engine = createEngine(ours);
        let compared = 0;
        try {
          for (const s of ours.sheets) {
            for (const x of Object.values(s.cells)) {
              if (x.formula === undefined) continue;
              const [mine] = engine.get([{ sheet: s.name, address: x.address }]);
              const theirs = cell(now, s.name, x.address)?.value;
              if (typeof mine !== 'number') continue;
              expect(Math.abs((theirs as number) - mine), `${c.name}: ${s.name}!${x.address}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(mine)));
              compared++;
            }
          }
        } finally {
          engine.dispose();
        }
        expect(compared).toBeGreaterThan(20);
      });
    },
    300_000,
  );
});

describe('XML that is legal and unusual', () => {
  // prefixed elements, single quotes, attributes in any order, line breaks inside tags, a comment that looks like a cell,
  // a byte order mark, CRLF between rows, cells and rows without an address, an attribute value holding ">" and one
  // holding what looks like another attribute, an extension list inside a cell, CDATA in a formula
  const sheet =
    '﻿<?xml version=\'1.0\' encoding=\'UTF-8\'?>\r\n<x:worksheet xmlns:x="' +
    MAIN +
    '"\r\n  xmlns:q="urn:q">\r\n<x:sheetData>\r\n' +
    '<!-- <x:c r="B2"><x:v>666</x:v></x:c> -->\r\n' +
    '<x:row spans="1:5"\r\n   r="2">\r\n  <x:c s="1" q:note="a>b" r=\'A2\'><x:v>1</x:v></x:c>\r\n  <x:c\r\n    q:t="keep" t="n" q:x=\' t="s" \' s="2"><x:v> 2 </x:v><x:extLst><x:ext uri="u"><q:c r="B2"/></x:ext></x:extLst></x:c>' +
    "<x:c t='str' r=\"C2\"><x:f xml:space=\"preserve\" si='0' ref=\"C2:C4\" t=\"shared\"> A2&amp;<![CDATA[\"<\"]]> </x:f><x:v>1&lt;</x:v></x:c></x:row>\r\n" +
    '<x:row><x:c><x:v>3</x:v></x:c><x:c t="inlineStr"><x:is><x:t>要</x:t></x:is></x:c><x:c t="str"><x:f t="shared" si="0"></x:f><x:v>3&lt;</x:v></x:c></x:row>\r\n' +
    '<x:row r="4"><x:c r="A4"><x:v>4</x:v></x:c><x:c r="C4" t="str"><x:f si="0" t="shared"/><x:v>4&lt;</x:v></x:c><x:c r="E4"><x:v>5</x:v></x:c></x:row>\r\n' +
    '</x:sheetData>\r\n<x:mergeCells><x:mergeCell ref="D1:E1"/></x:mergeCells></x:worksheet>\r\n';
  const original = () => excelLike({ model: sheet });

  it('is read the same by the patcher and the reader, and only the named cells change', () => {
    const bytes = original();
    const before = readWorkbook(bytes);
    expect(cell(before, '模型', 'B2')).toMatchObject({ value: 2 });
    expect(cell(before, '模型', 'C3').formula).toBe(' A3&"<" ');
    for (const input of [
      { numbers: [num('B2', 8)], texts: [] },
      { numbers: [num('A3', 9)], texts: [{ sheet: '模型', address: 'B3', text: '已定' }] },
      { numbers: [num('C2', 7)], texts: [] },
      { numbers: [num('C3', 7), num('E4', 6)], texts: [] },
    ] as PatchInput[]) {
      const r = patchXlsx(bytes, input, before);
      const named = [...input.numbers, ...input.texts, ...r.unshared].map((e) => e.address);
      const [was, now] = [xmlOf(bytes, M), xmlOf(r.bytes, M)];
      wellFormed(now, M);
      expect(now.startsWith('﻿<?xml')).toBe(true);
      // outside the row of a named cell nothing moved, and the comment is still a comment
      expect(now).toContain('<!-- <x:c r="B2"><x:v>666</x:v></x:c> -->');
      const lines = (xml: string) => xml.split('\r\n<x:row');
      lines(was).forEach((line, i) => {
        const row = /^ r="(\d)"/.exec(line)?.[1] ?? (i === 1 ? '2' : i === 2 ? '3' : '');
        if (!named.some((a) => a.endsWith(row)) || !row) expect(lines(now)[i]).toBe(line);
      });
      const after = readWorkbook(r.bytes);
      const skip = new Set([...input.numbers, ...input.texts].map((e) => e.address));
      for (const x of Object.values(before.sheets[0].cells)) if (!skip.has(x.address)) expect(cell(after, '模型', x.address), x.address).toEqual(x);
      for (const n of input.numbers) expect(cell(after, '模型', n.address)).toMatchObject({ type: 'number', value: n.value });
      for (const n of input.numbers) expect(cell(after, '模型', n.address).formula).toBeUndefined();
      for (const t of input.texts) expect(cell(after, '模型', t.address)).toMatchObject({ type: 'string', value: t.text });
      expect(after.sheets[0].merges).toEqual(['D1:E1']);
    }
    // the cell keeps its other attributes, its extension list and its prefix
    const r = patchXlsx(bytes, { numbers: [num('B2', 8)], texts: [] }, before);
    expect(xmlOf(r.bytes, M)).toContain('<x:c\r\n    q:t="keep" q:x=\' t="s" \' s="2"><x:v>8</x:v><x:extLst><x:ext uri="u"><q:c r="B2"/></x:ext></x:extLst></x:c>');
  });
});

describe('a large sheet', () => {
  it('is patched in a few seconds, a shared formula of thousands of cells included', () => {
    const rows: string[] = [];
    for (let n = 1; n <= 3000; n++) {
      let row = `<row r="${n}"><c r="A${n}"><v>${n}</v></c><c r="B${n}"><f t="shared"${n === 1 ? ' ref="B1:B3000"' : ''} si="0"${n === 1 ? '>A1*2+$A$1</f>' : '/>'}<v>${n * 2 + 1}</v></c>`;
      for (let c = 3; c <= 30; c++) row += `<c r="${String.fromCharCode(64 + (c > 26 ? 1 : 0)) === 'A' ? 'A' + String.fromCharCode(64 + c - 26) : String.fromCharCode(64 + c)}${n}" s="1"><v>${n + c}</v></c>`;
      rows.push(`${row}</row>`);
    }
    const bytes = excelLike({ model: `${DECL}<worksheet xmlns="${MAIN}"><sheetData>${rows.join('')}</sheetData></worksheet>` });
    const before = readWorkbook(bytes);
    const started = Date.now();
    const r = patchXlsx(bytes, { numbers: [num('B1', 5), num('AD3000', 1)], texts: [], cached: Array.from({ length: 2000 }, (_, i) => ({ sheet: '模型', address: `C${i + 1}`, value: i })) }, before);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.unshared.length).toBe(2999);
    const after = readWorkbook(r.bytes);
    expect(cell(after, '模型', 'B1')).toMatchObject({ type: 'number', value: 5 });
    expect(cell(after, '模型', 'B3000')).toEqual(cell(before, '模型', 'B3000'));
    expect(cell(after, '模型', 'B3000').formula).toBe('A3000*2+$A$1');
    expect(cell(after, '模型', 'AD3000').value).toBe(1);
    expect(cell(after, '模型', 'C2000').value).toBe(1999);
    expect(Object.keys(after.sheets[0].cells).length).toBe(Object.keys(before.sheets[0].cells).length);
  }, 60_000);
});
