/**
 * Reads an xlsx file into plain JSON (src/domain/workbook/types.ts): every cell's formula, the
 * result Excel stored for it, its number format and its note. Read-only; nothing here writes.
 */
import { SaxesParser } from 'saxes';
import { cellAddress, parseAddress, shiftFormula } from '../../domain/workbook/shiftFormula';
import type { CellType, CellValue, DefinedName, WorkbookCell, WorkbookData, WorkbookSheet } from '../../domain/workbook/types';
import { XlsxError, entryData, readZip, type ZipEntry } from './zipRead';

/** All the parts read from one file, unpacked. */
export const MAX_WORKBOOK_XML_BYTES = 32 * 1024 * 1024;

interface XmlNode {
  /** Local name: `x:row` and `row` are both `row`. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function parseXml(xml: string, part: string): XmlNode {
  const root: XmlNode = { name: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    const node: XmlNode = { name: tag.name.replace(/^.*:/, ''), attrs: tag.attributes as Record<string, string>, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  parser.on('closetag', () => void stack.pop());
  parser.on('text', (t) => (stack[stack.length - 1].text += t));
  parser.on('cdata', (t) => (stack[stack.length - 1].text += t));
  parser.on('error', (e) => {
    throw new XlsxError('bad-xml', `${part}: ${e.message}`);
  });
  parser.write(xml.replace(/^﻿/, '')).close();
  return root.children[0] ?? root;
}

const child = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const children = (n: XmlNode | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];
/** Attribute by local name: `r:id` is read as `id`. */
const attr = (n: XmlNode, name: string) => n.attrs[name] ?? Object.entries(n.attrs).find(([k]) => k.endsWith(`:${name}`))?.[1];

/** Excel writes control characters as _xHHHH_. */
const unescapeText = (s: string) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** Text of a string item: plain <t>, or rich-text runs; phonetic guides (rPh) are not part of it. */
function stringItemText(si: XmlNode): string {
  let s = '';
  for (const c of si.children) {
    if (c.name === 't') s += c.text;
    else if (c.name === 'r') for (const t of children(c, 't')) s += t.text;
  }
  return unescapeText(s);
}

// built-in number formats that are not General (ECMA-376 18.8.30)
const BUILTIN_FORMATS: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

/** Number format code for each cell style index. */
function readStyles(root: XmlNode | undefined): (string | undefined)[] {
  if (!root) return [];
  const custom = new Map<number, string>();
  for (const f of children(child(root, 'numFmts'), 'numFmt')) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode);
  return children(child(root, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    const code = custom.get(id) ?? BUILTIN_FORMATS[id];
    return code && code !== 'General' ? code : undefined;
  });
}

/** Resolves a relationship target against the part that holds it. */
function resolveTarget(basePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = basePart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const relsPath = (part: string) => part.replace(/([^/]+)$/, '_rels/$1.rels');

function readSheet(root: XmlNode, name: string, hidden: boolean, strings: string[], formats: (string | undefined)[]): WorkbookSheet {
  const cells: Record<string, WorkbookCell> = {};
  /** Shared formula masters by `si`. */
  const shared = new Map<string, { formula: string; row: number; col: number }>();
  let rowNo = 0;
  for (const rowNode of children(child(root, 'sheetData'), 'row')) {
    rowNo = rowNode.attrs.r ? Number(rowNode.attrs.r) : rowNo + 1;
    let colNo = 0;
    for (const c of children(rowNode, 'c')) {
      // `r` is optional: without it the cell follows the previous one
      const pos = c.attrs.r ? parseAddress(c.attrs.r) : { row: rowNo, col: colNo + 1 };
      colNo = pos.col;
      const address = cellAddress(pos.col, pos.row);
      const f = child(c, 'f');
      const v = child(c, 'v');
      const t = c.attrs.t ?? 'n';

      let type: CellType = 'empty';
      let value: CellValue = null;
      if (t === 'inlineStr') {
        const is = child(c, 'is');
        if (is) [type, value] = ['string', stringItemText(is)];
      } else if (v) {
        if (t === 's') [type, value] = ['string', strings[Number(v.text)] ?? ''];
        else if (t === 'str') [type, value] = ['string', unescapeText(v.text)];
        else if (t === 'b') [type, value] = ['boolean', v.text === '1'];
        else if (t === 'e') [type, value] = ['error', v.text];
        else if (v.text !== '' && Number.isFinite(Number(v.text))) [type, value] = ['number', Number(v.text)];
      }

      const cell: WorkbookCell = { address, row: pos.row, col: pos.col, type, value };
      if (f) {
        let formula = f.text;
        const kind = f.attrs.t;
        if (kind === 'shared' && f.attrs.si !== undefined) {
          const master = shared.get(f.attrs.si);
          if (formula !== '') shared.set(f.attrs.si, { formula, row: pos.row, col: pos.col });
          else if (master) formula = shiftFormula(master.formula, pos.row - master.row, pos.col - master.col);
        }
        if (kind === 'dataTable') cell.unsupported = 'data table';
        else if (formula !== '') {
          cell.formula = formula.replace(/^=/, '');
          cell.hasCached = type !== 'empty';
          if (kind === 'array' && f.attrs.ref) cell.arrayRef = f.attrs.ref;
        }
      }
      const numFmt = formats[Number(c.attrs.s ?? 0)];
      if (numFmt) cell.numFmt = numFmt;
      if (type !== 'empty' || cell.formula !== undefined || cell.unsupported) cells[address] = cell;
    }
  }
  const merges = children(child(root, 'mergeCells'), 'mergeCell').map((m) => m.attrs.ref);
  return { name, hidden, cells, merges };
}

/** Parses the bytes of an xlsx file. Throws XlsxError when the file cannot be read as one. */
export function readWorkbook(buf: Buffer): WorkbookData {
  const entries = new Map<string, ZipEntry>(readZip(buf).map((e) => [e.name, e]));
  let unpacked = 0;
  const xml = (part: string): XmlNode | undefined => {
    const entry = entries.get(part);
    if (!entry) return undefined;
    // many sheets that are each just under the limit add up
    unpacked += entry.size;
    if (unpacked > MAX_WORKBOOK_XML_BYTES) throw new XlsxError('too-large', `The workbook's parts are larger than ${MAX_WORKBOOK_XML_BYTES / 1024 / 1024} MB unpacked`);
    return parseXml(entryData(entry).toString('utf8'), part);
  };
  const rels = (part: string) =>
    children(xml(relsPath(part)), 'Relationship').map((r) => ({ id: r.attrs.Id, type: r.attrs.Type ?? '', target: resolveTarget(part, r.attrs.Target ?? '') }));

  // the workbook part is named by the package relationships; xl/workbook.xml is only the usual place
  const rootRel = children(xml('_rels/.rels'), 'Relationship').find((r) => (r.attrs.Type ?? '').endsWith('/officeDocument'));
  const workbookPart = rootRel ? resolveTarget('', rootRel.attrs.Target ?? '') : 'xl/workbook.xml';
  const workbook = xml(workbookPart);
  if (!workbook) throw new XlsxError('missing-part', 'The file has no workbook part: it is not an Excel workbook');
  const workbookRels = rels(workbookPart);

  const stringsPart = workbookRels.find((r) => r.type.endsWith('/sharedStrings'))?.target;
  const sharedStrings = children(stringsPart ? xml(stringsPart) : undefined, 'si').map(stringItemText);
  const stylesPart = workbookRels.find((r) => r.type.endsWith('/styles'))?.target;
  const formats = readStyles(stylesPart ? xml(stylesPart) : undefined);

  const sheets: WorkbookSheet[] = [];
  for (const s of children(child(workbook, 'sheets'), 'sheet')) {
    const part = workbookRels.find((r) => r.id === attr(s, 'id'))?.target;
    // chart sheets and macro sheets have no cell grid
    if (!part || !/\/worksheet$/.test(workbookRels.find((r) => r.target === part)?.type ?? '')) continue;
    const root = xml(part);
    if (!root) throw new XlsxError('missing-part', `Sheet ${s.attrs.name} is missing from the file`);
    const sheet = readSheet(root, s.attrs.name, (s.attrs.state ?? 'visible') !== 'visible', sharedStrings, formats);
    const commentsPart = rels(part).find((r) => r.type.endsWith('/comments'))?.target;
    for (const c of children(child(commentsPart ? xml(commentsPart) : undefined, 'commentList'), 'comment')) {
      const text = child(c, 'text');
      if (!text || !c.attrs.ref) continue;
      const pos = parseAddress(c.attrs.ref);
      const address = cellAddress(pos.col, pos.row);
      // a note can sit on a cell with no content
      const cell = (sheet.cells[address] ??= { address, row: pos.row, col: pos.col, type: 'empty', value: null });
      cell.note = stringItemText(text).trim();
    }
    sheets.push(sheet);
  }

  const allSheetNames = children(child(workbook, 'sheets'), 'sheet').map((s) => s.attrs.name);
  const definedNames: DefinedName[] = children(child(workbook, 'definedNames'), 'definedName').map((d) => ({
    name: d.attrs.name,
    formula: d.text.replace(/^=/, ''),
    ...(d.attrs.localSheetId !== undefined ? { sheet: allSheetNames[Number(d.attrs.localSheetId)] } : {}),
  }));
  const pr = child(workbook, 'workbookPr');
  return { sheets, sharedStrings, definedNames, date1904: pr?.attrs.date1904 === '1' || pr?.attrs.date1904 === 'true' };
}
