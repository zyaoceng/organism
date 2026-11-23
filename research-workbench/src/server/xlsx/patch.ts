/**
 * Builds the bytes of an xlsx in which only the named cells differ from the original. Pure: bytes
 * in, bytes out; write.ts is the one place that puts them on disk.
 *
 * The XML of a part is edited as text, never parsed and written out again, so everything that is
 * not one of the named cells keeps the exact bytes its writer gave it. A ZIP entry that is not
 * edited is copied with its packed bytes.
 *
 * - A number cell gets the new <v>. A formula cell becomes that constant (the user's decision).
 * - A status text becomes an existing shared string with that text when there is one, else an
 *   inline string. No shared string is ever edited: other cells use them.
 * - A shared formula a replaced cell belongs to is written out as one plain formula per remaining
 *   cell, so no cell is left pointing at a master that is gone.
 * - workbook.xml gets fullCalcOnLoad, so Excel recalculates when it opens the file.
 * - When a formula cell was replaced, the calculation chain (which lists it) is dropped together
 *   with its content type and its relationship; Excel builds a new one.
 * - `cached` refreshes the stored results of the cells the caller names, for readers that do not
 *   recalculate.
 */
import zlib from 'node:zlib';
import { cellAddress, colToNumber, parseAddress } from '../../domain/workbook/shiftFormula';
import type { CellRef, CellValue, WorkbookData } from '../../domain/workbook/types';
import { crc32 } from '../vault/zip';
import { readWorkbook, relsPath, resolveTarget } from './read';
import { entryData, readZip, type ZipEntry } from './zipRead';

export type PatchErrorCode = 'duplicate' | 'bad-value' | 'no-sheet' | 'no-cell' | 'array-formula' | 'not-number' | 'not-text' | 'structure';

export class PatchError extends Error {
  constructor(
    public readonly code: PatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

export interface NumberEdit extends CellRef {
  value: number;
}

export interface TextEdit extends CellRef {
  text: string;
}

export interface CachedEdit extends CellRef {
  /** The result to store for the cell; null stores none. */
  value: CellValue;
}

export interface PatchInput {
  numbers: NumberEdit[];
  texts: TextEdit[];
  /** Stored results to refresh; cells also named in `numbers` or `texts` are not allowed here. */
  cached?: CachedEdit[];
}

export interface PatchResult {
  bytes: Buffer;
  /** ZIP entries whose content differs from the original. */
  changedParts: string[];
  /** ZIP entries left out (the calculation chain). */
  removedParts: string[];
  /** Cells of `numbers` that held a formula. */
  replacedFormulas: CellRef[];
  /** Cells whose shared formula was written out as a plain one (same formula, other XML). */
  unshared: CellRef[];
  /** Cells of `cached` whose result could not be stored and was left out instead (an error Excel has no name for). */
  cacheDropped: CellRef[];
}

/** The errors Excel stores in a cell of type "e". */
const EXCEL_ERRORS = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA']);

const key = (c: CellRef) => `${c.sheet}\0${c.address}`;

// ---------------------------------------------------------------------------------------------
// XML as text
// ---------------------------------------------------------------------------------------------

interface Tag {
  start: number;
  /** Just past the closing `>`. */
  end: number;
  /** Name without its prefix. */
  local: string;
  /** The prefix with its colon ("x:"), or "". */
  prefix: string;
  kind: 'open' | 'close' | 'empty';
}

const bad = (what: string): never => {
  throw new PatchError('structure', what);
};

/** The next element tag at or after `from`; comments, CDATA, processing instructions and declarations are stepped over. */
function nextTag(xml: string, from: number): Tag | null {
  let i = from;
  for (;;) {
    i = xml.indexOf('<', i);
    if (i < 0) return null;
    const skipTo = (opener: string, closer: string): boolean => {
      if (!xml.startsWith(opener, i)) return false;
      const e = xml.indexOf(closer, i + opener.length);
      if (e < 0) bad('The XML ends inside a comment or a declaration');
      i = e + closer.length;
      return true;
    };
    if (skipTo('<!--', '-->') || skipTo('<![CDATA[', ']]>') || skipTo('<?', '?>') || skipTo('<!', '>')) continue;
    let j = i + 1;
    let quote = '';
    for (; j < xml.length; j++) {
      const ch = xml[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (j >= xml.length) bad('The XML ends inside a tag');
    const close = xml[i + 1] === '/';
    let n = i + (close ? 2 : 1);
    const nameStart = n;
    while (n < j && !/[\s/>]/.test(xml[n])) n++;
    const name = xml.slice(nameStart, n);
    const colon = name.indexOf(':');
    return { start: i, end: j + 1, local: name.slice(colon + 1), prefix: colon < 0 ? '' : name.slice(0, colon + 1), kind: close ? 'close' : xml[j - 1] === '/' ? 'empty' : 'open' };
  }
}

/** Just past the end tag that closes the open tag `tag`. */
function elementEnd(xml: string, tag: Tag): number {
  if (tag.kind === 'empty') return tag.end;
  let depth = 1;
  let at = tag.end;
  for (;;) {
    const t = nextTag(xml, at);
    if (!t) return bad(`<${tag.prefix}${tag.local}> is never closed`);
    if (t.kind === 'open') depth++;
    else if (t.kind === 'close' && --depth === 0) return t.end;
    at = t.end;
  }
}

const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? '';
  });
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');
/** Characters XML 1.0 cannot carry. */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

const attrPattern = (name: string, anyPrefix: boolean) => new RegExp(`(\\s)(${anyPrefix ? '(?:[\\w.-]+:)?' : ''}${name})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);

/** An attribute's value as written in the tag `raw` (entities decoded); `anyPrefix` also takes `r:id` for `id`. */
function attrOf(raw: string, name: string, anyPrefix = false): string | undefined {
  const m = attrPattern(name, anyPrefix).exec(raw);
  return m ? unescapeXml(m[3] ?? m[4] ?? '') : undefined;
}

/** The open (or empty) tag `raw` with the attribute set to `value`, or removed for null. Other attributes keep their text. */
function setAttr(raw: string, name: string, value: string | null): string {
  const re = attrPattern(name, false);
  if (re.test(raw)) return raw.replace(re, (_m, space: string) => (value === null ? '' : `${space}${name}="${escapeAttr(value)}"`));
  if (value === null) return raw;
  const at = raw.endsWith('/>') ? raw.length - 2 : raw.length - 1;
  return `${raw.slice(0, at).trimEnd()} ${name}="${escapeAttr(value)}"${raw.slice(at)}`;
}

/** An empty tag `<c …/>` as the open tag `<c …>`. */
const asOpenTag = (raw: string) => (raw.endsWith('/>') ? `${raw.slice(0, -2).trimEnd()}>` : raw);

interface Splice {
  start: number;
  end: number;
  text: string;
}

function applySplices(xml: string, splices: Splice[]): string {
  // one pass: a slice of the whole text per splice takes minutes on a sheet of megabytes with thousands of cells to write
  const pieces: string[] = [];
  let at = 0;
  for (const s of [...splices].sort((a, b) => a.start - b.start)) {
    if (s.start < at) bad('Two changes overlap');
    pieces.push(xml.slice(at, s.start), s.text);
    at = s.end;
  }
  pieces.push(xml.slice(at));
  return pieces.join('');
}

// ---------------------------------------------------------------------------------------------
// the cells of a sheet part
// ---------------------------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

interface CellSpan extends Span {
  address: string;
  /** End of the cell's own tag. */
  openEnd: number;
  prefix: string;
  f?: Span & { openEnd: number };
  v?: Span;
  is?: Span;
  /** Any other child (extLst), kept as it is. */
  others: Span[];
}

/** Where each cell of the sheet's grid sits in the XML, by address. Addresses are worked out as read.ts does. */
function scanSheet(xml: string): Map<string, CellSpan> {
  const cells = new Map<string, CellSpan>();
  let at = 0;
  let tag: Tag | null;
  // the first <sheetData> is the grid: nothing before it in a worksheet can hold one
  for (;;) {
    tag = nextTag(xml, at);
    if (!tag) return cells;
    at = tag.end;
    if (tag.local === 'sheetData') break;
  }
  if (tag.kind !== 'open') return cells;
  let rowNo = 0;
  let colNo = 0;
  for (;;) {
    tag = nextTag(xml, at);
    if (!tag) return bad('<sheetData> is never closed');
    at = tag.end;
    if (tag.kind === 'close') {
      if (tag.local === 'sheetData') return cells;
      continue;
    }
    const raw = xml.slice(tag.start, tag.end);
    if (tag.local === 'row') {
      const r = attrOf(raw, 'r');
      rowNo = r ? Number(r) : rowNo + 1;
      colNo = 0;
      continue;
    }
    if (tag.local !== 'c') {
      at = elementEnd(xml, tag);
      continue;
    }
    const r = attrOf(raw, 'r');
    const pos = r ? parseAddress(r) : { row: rowNo, col: colNo + 1 };
    colNo = pos.col;
    const cell: CellSpan = { address: cellAddress(pos.col, pos.row), start: tag.start, end: tag.end, openEnd: tag.end, prefix: tag.prefix, others: [] };
    if (tag.kind === 'open') {
      for (;;) {
        const child = nextTag(xml, at);
        if (!child) return bad(`Cell ${cell.address} is never closed`);
        if (child.kind === 'close') {
          cell.end = at = child.end;
          break;
        }
        const span = { start: child.start, end: elementEnd(xml, child), openEnd: child.end };
        at = span.end;
        if (child.local === 'f') cell.f = span;
        else if (child.local === 'v') cell.v = span;
        else if (child.local === 'is') cell.is = span;
        else cell.others.push(span);
      }
    }
    // the same address twice: readers keep the last one, and so does this
    cells.set(cell.address, cell);
  }
}

interface CellEdit {
  /** Replace whatever the cell holds with this number. */
  number?: number;
  /** Replace it with this text: the shared string of that index, or an inline string. */
  text?: { value: string; sharedIndex: number | null };
  /** Write this formula (no `=`) as a plain <f>, keeping the stored result. */
  formula?: string;
  /** Store this result; null stores none. */
  cached?: { value: CellValue };
}

/** A number as an xsd:double; JavaScript's shortest text that reads back as the same number. */
const numberText = (n: number) => (Object.is(n, -0) ? '0' : String(n));

/** How a result is stored: the cell's type attribute (null: none, a number) and its <v> text; null when it cannot be stored. */
function storedResult(value: CellValue): { type: string | null; text: string } | null {
  if (typeof value === 'number') return Number.isFinite(value) ? { type: null, text: numberText(value) } : null;
  if (typeof value === 'boolean') return { type: 'b', text: value ? '1' : '0' };
  if (typeof value !== 'string') return null;
  if (EXCEL_ERRORS.has(value)) return { type: 'e', text: value };
  // an error only the engine has a name for (#CYCLE!, #LIC!): better no stored result than a made-up one
  if (/^#[A-Z0-9/_]+[!?]$/.test(value) || INVALID_XML.test(value)) return null;
  return { type: 'str', text: escapeText(value) };
}

function renderCell(xml: string, cell: CellSpan, edit: CellEdit): { text: string; cacheDropped: boolean } {
  const p = cell.prefix;
  const raw = (s: Span | undefined) => (s ? xml.slice(s.start, s.end) : '');
  let open = asOpenTag(xml.slice(cell.start, cell.openEnd));
  let f = raw(cell.f);
  let value = raw(cell.v) + raw(cell.is);
  let cacheDropped = false;
  const setValue = (type: string | null, body: string) => {
    open = setAttr(open, 't', type);
    value = body;
  };
  const v = (text: string) => `<${p}v>${text}</${p}v>`;

  if (edit.formula !== undefined && cell.f) {
    // the same <f> without what made it part of a shared formula; its other attributes (ca, aca) stay
    let fOpen = asOpenTag(xml.slice(cell.f.start, cell.f.openEnd));
    for (const name of ['t', 'ref', 'si']) fOpen = setAttr(fOpen, name, null);
    f = `${fOpen}${escapeText(edit.formula)}</${p}f>`;
  }
  if (edit.number !== undefined) {
    // cm marks a dynamic-array formula; a constant has none
    if (cell.f) open = setAttr(open, 'cm', null);
    f = '';
    setValue(null, v(numberText(edit.number)));
  } else if (edit.text) {
    f = '';
    if (edit.text.sharedIndex !== null) setValue('s', v(String(edit.text.sharedIndex)));
    else setValue('inlineStr', `<${p}is><${p}t>${escapeText(edit.text.value)}</${p}t></${p}is>`);
  } else if (edit.cached) {
    const stored = edit.cached.value === null ? null : storedResult(edit.cached.value);
    cacheDropped = stored === null && edit.cached.value !== null;
    if (stored) setValue(stored.type, v(stored.text));
    else setValue(null, '');
  }
  return { text: `${open}${f}${value}${cell.others.map(raw).join('')}</${p}c>`, cacheDropped };
}

// ---------------------------------------------------------------------------------------------
// the package
// ---------------------------------------------------------------------------------------------

/** Every element directly under the root: its tag and where it ends. */
function topLevel(xml: string): { root: Tag; children: { tag: Tag; end: number }[] } {
  const root = nextTag(xml, 0);
  if (!root || root.kind === 'close') return bad('The part has no root element');
  const children: { tag: Tag; end: number }[] = [];
  if (root.kind === 'empty') return { root, children };
  let at = root.end;
  for (;;) {
    const tag = nextTag(xml, at);
    if (!tag) return bad('The root element is never closed');
    if (tag.kind === 'close') return { root, children };
    const end = elementEnd(xml, tag);
    children.push({ tag, end });
    at = end;
  }
}

/** The direct children of the first top-level element with that name. */
function childTags(xml: string, parent: string): string[] {
  const top = topLevel(xml).children.find((c) => c.tag.local === parent);
  if (!top || top.tag.kind !== 'open') return [];
  const out: string[] = [];
  let at = top.tag.end;
  for (;;) {
    const tag = nextTag(xml, at);
    if (!tag || tag.kind === 'close') return out;
    out.push(xml.slice(tag.start, tag.end));
    at = elementEnd(xml, tag);
  }
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  span: Span;
}

function relationships(xml: string, basePart: string): Relationship[] {
  return topLevel(xml)
    .children.filter((c) => c.tag.local === 'Relationship')
    .map((c) => {
      const raw = xml.slice(c.tag.start, c.tag.end);
      return { id: attrOf(raw, 'Id') ?? '', type: attrOf(raw, 'Type') ?? '', target: resolveTarget(basePart, attrOf(raw, 'Target') ?? ''), span: { start: c.tag.start, end: c.end } };
    });
}

/** workbook.xml with fullCalcOnLoad set on its calculation properties; unchanged when it already is. */
function withFullCalc(xml: string): string {
  const { root, children } = topLevel(xml);
  const calcPr = children.find((c) => c.tag.local === 'calcPr');
  if (calcPr) {
    const raw = xml.slice(calcPr.tag.start, calcPr.tag.end);
    const now = attrOf(raw, 'fullCalcOnLoad');
    if (now === '1' || now === 'true') return xml;
    return xml.slice(0, calcPr.tag.start) + setAttr(raw, 'fullCalcOnLoad', '1') + xml.slice(calcPr.tag.end);
  }
  // the schema puts calcPr after these, in this order
  const before = ['definedNames', 'externalReferences', 'functionGroups', 'sheets'].map((name) => children.find((c) => c.tag.local === name)).find(Boolean);
  if (!before) return bad('The workbook part lists no sheets');
  return `${xml.slice(0, before.end)}<${root.prefix}calcPr fullCalcOnLoad="1"/>${xml.slice(before.end)}`;
}

/** Whether `address` lies inside the range "B2:B5". */
function inRange(range: string, address: string): boolean {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(range);
  if (!m) return false;
  const { row, col } = parseAddress(address);
  const [c1, c2] = [colToNumber(m[1]), colToNumber(m[3] ?? m[1])];
  const [r1, r2] = [Number(m[2]), Number(m[4] ?? m[2])];
  return row >= Math.min(r1, r2) && row <= Math.max(r1, r2) && col >= Math.min(c1, c2) && col <= Math.max(c1, c2);
}

const DEFLATE = 8;

/** A ZIP of the entries in their order. `replaced` gives new content by name; every other entry keeps its packed bytes. */
export function writeZip(entries: ZipEntry[], replaced: Map<string, Buffer> = new Map()): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = replaced.get(e.name);
    const packed = data ? zlib.deflateRawSync(data) : e.packed;
    const method = data ? DEFLATE : e.method;
    const crc = data ? crc32(data) : e.crc;
    const size = data ? data.length : e.size;
    // the sizes are in the header, so no data descriptor follows (bit 3); the name encoding (bit 11) stays
    const flags = data ? e.flags & 0x0800 : e.flags & ~0x0008;
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(e.dosTime, 10);
    local.writeUInt16LE(e.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(e.dosTime, 12);
    central.writeUInt16LE(e.dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(e.internalAttrs, 36);
    central.writeUInt32LE(e.externalAttrs, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ---------------------------------------------------------------------------------------------
// the patch
// ---------------------------------------------------------------------------------------------

/**
 * The bytes of `original` with the cells of `input` changed and nothing else. `workbook` is
 * `original` as read.ts parses it (parsed here when not given). Throws PatchError when a cell cannot
 * be changed safely, and XlsxError when `original` is not a readable xlsx.
 */
export function patchXlsx(original: Buffer, input: PatchInput, workbook: WorkbookData = readWorkbook(original)): PatchResult {
  const cached = input.cached ?? [];
  const seen = new Set<string>();
  for (const c of [...input.numbers, ...input.texts, ...cached]) {
    if (seen.has(key(c))) throw new PatchError('duplicate', `${c.sheet}!${c.address} is named twice`);
    seen.add(key(c));
  }
  for (const n of input.numbers) if (typeof n.value !== 'number' || !Number.isFinite(n.value)) throw new PatchError('bad-value', `${n.sheet}!${n.address}: the new value is not a finite number`);
  for (const t of input.texts) if (typeof t.text !== 'string' || !t.text || INVALID_XML.test(t.text)) throw new PatchError('bad-value', `${t.sheet}!${t.address}: the new text cannot be stored`);

  const entries = readZip(original);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const text = (part: string): string => {
    const entry = byName.get(part);
    if (!entry) return bad(`The file has no part ${part}`);
    return entryData(entry).toString('utf8');
  };

  // the parts, found the way read.ts finds them
  const rootRel = byName.has('_rels/.rels') ? relationships(text('_rels/.rels'), '').find((r) => r.type.endsWith('/officeDocument')) : undefined;
  const workbookPart = rootRel?.target ?? 'xl/workbook.xml';
  const workbookXml = text(workbookPart);
  const workbookRelsPart = relsPath(workbookPart);
  const workbookRelsXml = byName.has(workbookRelsPart) ? text(workbookRelsPart) : '';
  const workbookRels = workbookRelsXml ? relationships(workbookRelsXml, workbookPart) : [];
  const sheetPart = new Map<string, string>();
  for (const raw of childTags(workbookXml, 'sheets')) {
    const name = attrOf(raw, 'name');
    const part = workbookRels.find((r) => r.id === attrOf(raw, 'id', true))?.target;
    if (name !== undefined && part && byName.has(part)) sheetPart.set(name, part);
  }

  // what is asked of each sheet
  const edits = new Map<string, Map<string, CellEdit>>();
  const editOf = (c: CellRef): CellEdit => {
    const sheet = workbook.sheets.find((s) => s.name === c.sheet);
    if (!sheet || !sheetPart.has(c.sheet)) throw new PatchError('no-sheet', `The file has no sheet named ${c.sheet}`);
    let ofSheet = edits.get(c.sheet);
    if (!ofSheet) edits.set(c.sheet, (ofSheet = new Map()));
    let edit = ofSheet.get(c.address);
    if (!edit) ofSheet.set(c.address, (edit = {}));
    return edit;
  };
  const parsedCell = (c: CellRef) => workbook.sheets.find((s) => s.name === c.sheet)?.cells[c.address];
  /** A cell an array formula holds or fills cannot be changed on its own. */
  const refuseArray = (c: CellRef) => {
    const sheet = workbook.sheets.find((s) => s.name === c.sheet);
    const cell = sheet?.cells[c.address];
    const inArray = Object.values(sheet?.cells ?? {}).some((o) => o.arrayRef !== undefined && inRange(o.arrayRef, c.address));
    if (cell?.arrayRef !== undefined || cell?.unsupported || inArray) throw new PatchError('array-formula', `${c.sheet}!${c.address} belongs to an array formula or a data table`);
  };

  const replacedFormulas: CellRef[] = [];
  for (const n of input.numbers) {
    const edit = editOf(n);
    const cell = parsedCell(n);
    if (!cell) throw new PatchError('no-cell', `${n.sheet}!${n.address} is an empty cell`);
    refuseArray(n);
    if (cell.formula === undefined && cell.type === 'string') throw new PatchError('not-number', `${n.sheet}!${n.address} holds text, not a number`);
    if (cell.formula !== undefined) replacedFormulas.push({ sheet: n.sheet, address: n.address });
    edit.number = n.value;
  }
  const sharedIndex = (value: string) => {
    const i = workbook.sharedStrings.indexOf(value);
    return i < 0 ? null : i;
  };
  for (const t of input.texts) {
    const edit = editOf(t);
    const cell = parsedCell(t);
    if (!cell) throw new PatchError('no-cell', `${t.sheet}!${t.address} is an empty cell`);
    refuseArray(t);
    if (cell.formula !== undefined || cell.type !== 'string') throw new PatchError('not-text', `${t.sheet}!${t.address} does not hold plain text`);
    edit.text = { value: t.text, sharedIndex: sharedIndex(t.text) };
  }
  for (const c of cached) editOf(c).cached = { value: c.value };

  const replaced = new Map<string, Buffer>();
  const unshared: CellRef[] = [];
  const cacheDropped: CellRef[] = [];
  for (const [sheetName, ofSheet] of edits) {
    const part = sheetPart.get(sheetName)!;
    const xml = text(part);
    const spans = scanSheet(xml);
    const parsed = workbook.sheets.find((s) => s.name === sheetName)!;
    const sharedGroup = (cell: CellSpan): string | undefined => {
      if (!cell.f) return undefined;
      const raw = xml.slice(cell.f.start, cell.f.openEnd);
      return attrOf(raw, 't') === 'shared' ? attrOf(raw, 'si') : undefined;
    };
    // a shared formula that loses a cell is written out for the cells that stay
    const broken = new Set<string>();
    for (const [address, edit] of ofSheet) {
      const cell = spans.get(address);
      if (!cell) throw new PatchError('no-cell', `${sheetName}!${address} is not in the sheet's XML`);
      const group = edit.number !== undefined || edit.text ? sharedGroup(cell) : undefined;
      if (group !== undefined) broken.add(group);
    }
    if (broken.size) {
      for (const cell of spans.values()) {
        const group = sharedGroup(cell);
        if (group === undefined || !broken.has(group)) continue;
        const edit = ofSheet.get(cell.address) ?? {};
        if (edit.number !== undefined || edit.text) continue;
        const formula = parsed.cells[cell.address]?.formula;
        if (formula === undefined) throw new PatchError('structure', `${sheetName}!${cell.address} is part of a shared formula that could not be read`);
        edit.formula = formula;
        ofSheet.set(cell.address, edit);
        unshared.push({ sheet: sheetName, address: cell.address });
      }
    }
    const splices: Splice[] = [];
    for (const [address, edit] of ofSheet) {
      const cell = spans.get(address)!;
      const out = renderCell(xml, cell, edit);
      if (out.cacheDropped) cacheDropped.push({ sheet: sheetName, address });
      splices.push({ start: cell.start, end: cell.end, text: out.text });
    }
    const next = applySplices(xml, splices);
    if (next !== xml) replaced.set(part, Buffer.from(next, 'utf8'));
  }

  const removed = new Set<string>();
  let nextWorkbookRels = workbookRelsXml;
  const chain = workbookRels.find((r) => r.type.endsWith('/calcChain'));
  if (replacedFormulas.length && chain && byName.has(chain.target)) {
    removed.add(chain.target);
    nextWorkbookRels = applySplices(workbookRelsXml, [{ ...chain.span, text: '' }]);
    replaced.set(workbookRelsPart, Buffer.from(nextWorkbookRels, 'utf8'));
    const typesPart = '[Content_Types].xml';
    if (byName.has(typesPart)) {
      const typesXml = text(typesPart);
      const overrides = topLevel(typesXml).children.filter((c) => c.tag.local === 'Override' && (attrOf(typesXml.slice(c.tag.start, c.tag.end), 'PartName') ?? '').toLowerCase() === `/${chain.target}`.toLowerCase());
      if (overrides.length) replaced.set(typesPart, Buffer.from(applySplices(typesXml, overrides.map((c) => ({ start: c.tag.start, end: c.end, text: '' }))), 'utf8'));
    }
  }
  const nextWorkbook = withFullCalc(workbookXml);
  if (nextWorkbook !== workbookXml) replaced.set(workbookPart, Buffer.from(nextWorkbook, 'utf8'));

  const kept = entries.filter((e) => !removed.has(e.name));
  return { bytes: writeZip(kept, replaced), changedParts: [...replaced.keys()], removedParts: [...removed], replacedFormulas, unshared, cacheDropped };
}
