/**
 * Finds the assumptions, the results and the side-by-side table in a workbook by the text written
 * in it, never by fixed positions: the real file is laid out by hand (and by an AI that inserts
 * rows), so rows and columns move. Whatever cannot be found is reported in `warnings`, naming the
 * header or label that is missing, and every place a result could be is listed in `candidates`.
 */
import { cellAddress, formulaRefs, numberToCol } from './shiftFormula';
import type {
  AssumptionStatus,
  AssumptionTable,
  CellRef,
  CellValue,
  DetectResult,
  DetectWarning,
  DetectedAssumption,
  LabelAnchor,
  OutputCandidate,
  OutputKey,
  OutputMapping,
  PartyColumn,
  PartyKey,
  PartyPeriod,
  PartyTable,
  PeriodAnchor,
  WorkbookCell,
  WorkbookData,
  WorkbookSheet,
} from './types';

/** Text as compared: full-width forms folded (NFKC), no whitespace, upper case. */
export const normalizeLabel = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').toUpperCase();

/** A formula's value when the file stores none (from the engine); detection works without it. */
export type ComputedValue = (ref: CellRef) => CellValue;

interface Grid {
  sheet: WorkbookSheet;
  /** Row number → its cells, left to right. */
  rows: Map<number, WorkbookCell[]>;
  rowNumbers: number[];
  /** Normalized text → the cells holding exactly it, in reading order. */
  labels: Map<string, WorkbookCell[]>;
}

function gridOf(sheet: WorkbookSheet): Grid {
  const rows = new Map<number, WorkbookCell[]>();
  for (const cell of Object.values(sheet.cells)) {
    const row = rows.get(cell.row);
    if (row) row.push(cell);
    else rows.set(cell.row, [cell]);
  }
  const rowNumbers = [...rows.keys()].sort((a, b) => a - b);
  const labels = new Map<string, WorkbookCell[]>();
  for (const r of rowNumbers) {
    const cells = rows.get(r)!.sort((a, b) => a.col - b.col);
    for (const cell of cells) {
      if (typeof cell.value !== 'string' || cell.type !== 'string') continue;
      const key = normalizeLabel(cell.value);
      if (!key) continue;
      const list = labels.get(key);
      if (list) list.push(cell);
      else labels.set(key, [cell]);
    }
  }
  return { sheet, rows, rowNumbers, labels };
}

const textOf = (cell: WorkbookCell | undefined): string | null => (cell && cell.type === 'string' && typeof cell.value === 'string' && cell.value.trim() !== '' ? cell.value.trim() : null);
const at = (grid: Grid, col: number, row: number) => grid.sheet.cells[cellAddress(col, row)];
/** A number, or a formula whose result is not known to be text: where a figure lives. */
const holdsNumber = (cell: WorkbookCell | undefined) => !!cell && (cell.type === 'number' || (cell.formula !== undefined && cell.type === 'empty'));

function numberOf(grid: Grid, cell: WorkbookCell | undefined, computed?: ComputedValue): number | null {
  if (!cell) return null;
  if (cell.type === 'number') return cell.value as number;
  if (cell.formula !== undefined && cell.type === 'empty' && computed) {
    const v = computed({ sheet: grid.sheet.name, address: cell.address });
    return typeof v === 'number' ? v : null;
  }
  return null;
}

/** Which cell with this text it is on the sheet, from 1. */
function occurrenceOf(grid: Grid, cell: WorkbookCell): number {
  return (grid.labels.get(normalizeLabel(String(cell.value))) ?? []).indexOf(cell) + 1;
}

const anchorFor = (grid: Grid, cell: WorkbookCell): LabelAnchor => ({ sheet: grid.sheet.name, labelText: String(cell.value).trim(), occurrence: occurrenceOf(grid, cell) });

/** The first figure to the right of a label on its row. */
function numberRightOf(grid: Grid, label: WorkbookCell): WorkbookCell | null {
  return (grid.rows.get(label.row) ?? []).find((c) => c.col > label.col && holdsNumber(c)) ?? null;
}

/** The nearest text to the left of a cell on its row: its label. */
function labelLeftOf(grid: Grid, cell: { row: number; col: number }): WorkbookCell | null {
  const row = grid.rows.get(cell.row) ?? [];
  for (let i = row.length - 1; i >= 0; i--) if (row[i].col < cell.col && textOf(row[i])) return row[i];
  return null;
}

// ---------------------------------------------------------------------------------------------
// anchors
// ---------------------------------------------------------------------------------------------

function resolveInGrid(grid: Grid, anchor: LabelAnchor): WorkbookCell | { address: string; row: number; col: number } | null {
  const label = (grid.labels.get(normalizeLabel(anchor.labelText)) ?? [])[anchor.occurrence - 1];
  if (!label) return null;
  if (!anchor.columnLabel) return numberRightOf(grid, label);
  const want = normalizeLabel(anchor.columnLabel);
  // the nearest row above that carries the column header, right of the label
  for (let i = grid.rowNumbers.indexOf(label.row) - 1; i >= 0; i--) {
    const headerRow = grid.rows.get(grid.rowNumbers[i])!;
    const header = headerRow.find((c) => c.col > label.col && textOf(c) !== null && normalizeLabel(textOf(c)!) === want);
    if (!header) continue;
    let col = header.col;
    if (anchor.subColumnLabel) {
      const sub = normalizeLabel(anchor.subColumnLabel);
      // the header's columns end where the next header on its row begins
      const nextHeader = headerRow.find((c) => c.col > header.col && textOf(c) !== null);
      const limit = nextHeader ? nextHeader.col : Infinity;
      let found: number | null = null;
      for (let r = header.row + 1; r < label.row && found === null; r++) {
        const hit = (grid.rows.get(r) ?? []).find((c) => c.col >= header.col && c.col < limit && textOf(c) !== null && normalizeLabel(textOf(c)!) === sub);
        if (hit) found = hit.col;
      }
      if (found === null) return null;
      col = found;
    }
    return at(grid, col, label.row) ?? { address: cellAddress(col, label.row), row: label.row, col };
  }
  return null;
}

/** The cell an anchor points at in this workbook, or null when its label (or header) is gone. */
export function resolveAnchor(workbook: WorkbookData, anchor: LabelAnchor | null): CellRef | null {
  if (!anchor) return null;
  const sheet = workbook.sheets.find((s) => s.name === anchor.sheet);
  if (!sheet) return null;
  const cell = resolveInGrid(gridOf(sheet), anchor);
  return cell ? { sheet: sheet.name, address: cell.address } : null;
}

export interface ResolvedOutputs {
  revenueQuarters: { period: string; cell: CellRef | null }[];
  revenueTotal: CellRef | null;
  eps: { period: string; cell: CellRef | null }[];
  targetPrice: CellRef | null;
  multiple: CellRef | null;
  shareCount: CellRef | null;
  netCash: CellRef | null;
}

/** Resolves a saved (or just detected) mapping against the workbook as it is now. */
export function resolveOutputs(workbook: WorkbookData, mapping: OutputMapping): ResolvedOutputs {
  const grids = new Map<string, Grid>();
  const resolve = (anchor: LabelAnchor | null): CellRef | null => {
    if (!anchor) return null;
    let grid = grids.get(anchor.sheet);
    if (!grid) {
      const sheet = workbook.sheets.find((s) => s.name === anchor.sheet);
      if (!sheet) return null;
      grids.set(anchor.sheet, (grid = gridOf(sheet)));
    }
    const cell = resolveInGrid(grid, anchor);
    return cell ? { sheet: anchor.sheet, address: cell.address } : null;
  };
  return {
    revenueQuarters: mapping.revenueQuarters.map((p) => ({ period: p.period, cell: resolve(p.anchor) })),
    revenueTotal: resolve(mapping.revenueTotal),
    eps: mapping.eps.map((p) => ({ period: p.period, cell: resolve(p.anchor) })),
    targetPrice: resolve(mapping.targetPrice),
    multiple: resolve(mapping.multiple),
    shareCount: resolve(mapping.shareCount),
    netCash: resolve(mapping.netCash),
  };
}

// ---------------------------------------------------------------------------------------------
// assumption tables
// ---------------------------------------------------------------------------------------------

type HeaderKey = 'value' | 'low' | 'high' | 'basis';
const HEADER_WORDS: [HeaderKey, string][] = [
  ['value', '取用值'],
  ['low', '下緣'],
  ['high', '上緣'],
  ['basis', '依據'],
];
const HEADER_NAMES: Record<HeaderKey, string> = { value: '取用值', low: '下緣', high: '上緣', basis: '依據' };
// a header is a short cell; a sentence that mentions 取用值 is not one
const HEADER_MAX_LENGTH = 12;

function headersOnRow(cells: WorkbookCell[]): Partial<Record<HeaderKey, number>> {
  const found: Partial<Record<HeaderKey, number>> = {};
  for (const cell of cells) {
    const text = textOf(cell);
    if (!text) continue;
    const norm = normalizeLabel(text);
    if (norm.length > HEADER_MAX_LENGTH) continue;
    const hit = HEADER_WORDS.find(([key, word]) => found[key] === undefined && norm.includes(word));
    if (hit) found[hit[0]] = cell.col;
  }
  return found;
}

const STATUS_MAX_LENGTH = 60;
const STATUS_NOTE = '(?:\\s*[(\\[:;,.?!\\-—–、。].*|\\s+.*)?';
/** Text that is a figure typed as text: 「18%」「1,234.5」. */
const numberLikeText = (cell: WorkbookCell | undefined) => {
  const text = textOf(cell);
  return text !== null && /^[-+]?(?:\d[\d,]*)?\.?\d+%?$/.test(normalizeLabel(text));
};

function statusOf(cell: WorkbookCell | undefined): AssumptionStatus | null {
  const text = textOf(cell);
  if (!text) return null;
  // the word alone, or followed by a note: 「要（等法說）」「要：看 ARR」「已定 10/3」; 「要素」 is not one
  const norm = text.normalize('NFKC').trim();
  if (norm.length > STATUS_MAX_LENGTH) return null;
  if (new RegExp(`^要\\s*(?:判斷|決定|確認)?${STATUS_NOTE}$`, 's').test(norm)) return 'needs-decision';
  if (new RegExp(`^已\\s*(?:定|決定|確認)${STATUS_NOTE}$`, 's').test(norm)) return 'decided';
  return null;
}

interface TableScan {
  tables: AssumptionTable[];
  assumptions: DetectedAssumption[];
  warnings: DetectWarning[];
  /** The row closest to being a header when the sheet has none: its row number and what it has. */
  nearest: { row: number; found: HeaderKey[] } | null;
}

function scanAssumptions(grid: Grid, computed?: ComputedValue): TableScan {
  const name = grid.sheet.name;
  const warnings: DetectWarning[] = [];
  /** `row` is the header's last row, `top` its first: 下緣／上緣 may sit a row under a merged 區間. */
  const headerRows: { row: number; top: number; cols: Partial<Record<HeaderKey, number>> }[] = [];
  let nearest: TableScan['nearest'] = null;
  for (let i = 0; i < grid.rowNumbers.length; i++) {
    const r = grid.rowNumbers[i];
    let cols = headersOnRow(grid.rows.get(r)!);
    let found = Object.keys(cols) as HeaderKey[];
    let row = r;
    if (found.length > 0 && found.length < 3 && grid.rowNumbers[i + 1] === r + 1) {
      const under = headersOnRow(grid.rows.get(r + 1)!);
      const both = { ...under, ...cols };
      if (Object.keys(under).length < 3 && Object.keys(both).length >= 3) {
        cols = both;
        found = Object.keys(both) as HeaderKey[];
        row = r + 1;
        i++;
      }
    }
    if (found.length >= 3) {
      headerRows.push({ row, top: r, cols });
      const again = grid.rows.get(r)!.filter((c) => textOf(c) !== null && normalizeLabel(textOf(c)!).length <= HEADER_MAX_LENGTH && normalizeLabel(textOf(c)!).includes(HEADER_NAMES.value));
      if (again.length > 1) {
        warnings.push({ code: 'table-side-by-side', sheet: name, message: `分頁「${name}」第 ${r} 列有 ${again.length} 組「取用值」表頭並排（${again.map((c) => c.address).join('、')}），只讀得到最左邊那一張；其他的請搬到它下面。` });
      }
    } else if (found.length > 0 && (!nearest || found.length > nearest.found.length)) nearest = { row: r, found };
  }

  const tables: AssumptionTable[] = [];
  const assumptions: DetectedAssumption[] = [];
  const lastRow = grid.rowNumbers[grid.rowNumbers.length - 1] ?? 0;
  headerRows.forEach((header, index) => {
    const { cols } = header;
    const missing = HEADER_WORDS.filter(([key]) => cols[key] === undefined).map(([key]) => HEADER_NAMES[key]);
    if (cols.value === undefined) {
      warnings.push({ code: 'header-incomplete', sheet: name, message: `分頁「${name}」第 ${header.row} 列有「下緣」「上緣」「依據」，但沒有「取用值」這個表頭，這張表讀不出假設。` });
      return;
    }
    if (missing.length) warnings.push({ code: 'header-incomplete', sheet: name, message: `分頁「${name}」第 ${header.row} 列的假設表沒有「${missing.join('」「')}」這個表頭，這一欄會是空的。` });
    const figureCols = [cols.value, cols.low, cols.high].filter((c): c is number => c !== undefined);
    const headerCols = new Set<number>(Object.values(cols));
    const firstHeaderCol = Math.min(...headerCols);

    // the table runs to the next header row, or to a row that is a header of something else:
    // text in two or more of the figure columns (e.g. 每季結果 | 3Q27 | 4Q27)
    let end = index + 1 < headerRows.length ? headerRows[index + 1].row - 1 : lastRow;
    for (const r of grid.rowNumbers) {
      if (r <= header.row || r > end) continue;
      if (figureCols.filter((c) => textOf(at(grid, c, r)) !== null && !numberLikeText(at(grid, c, r))).length >= 2) {
        end = r - 1;
        break;
      }
    }
    const span = grid.rowNumbers.filter((r) => r > header.row && r <= end);
    const isDataRow = (r: number) => figureCols.some((c) => holdsNumber(at(grid, c, r)));

    // the label column: left of the headers, the one with the most text on data rows
    const labelCounts = new Map<number, number>();
    // when nothing is on the left, the labels are in a column to the right of the figures
    const rightCounts = new Map<number, number>();
    // the status column: any other column, the one with the most 要／已定
    const statusCounts = new Map<number, number>();
    for (const r of span) {
      for (const cell of grid.rows.get(r)!) {
        if (headerCols.has(cell.col)) continue;
        if (statusOf(cell)) statusCounts.set(cell.col, (statusCounts.get(cell.col) ?? 0) + 1);
        else if (textOf(cell) && !numberLikeText(cell) && isDataRow(r)) {
          const counts = cell.col < firstHeaderCol ? labelCounts : rightCounts;
          counts.set(cell.col, (counts.get(cell.col) ?? 0) + 1);
        }
      }
    }
    const most = (counts: Map<number, number>) => [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    const labelCol = most(labelCounts) ?? most(rightCounts);
    const statusCol = most(statusCounts);

    /** The text of a row that is only a title: text, and nothing in the figure or status columns. */
    const titleAt = (r: number): string | null => {
      const cells = grid.rows.get(r);
      if (!cells || headerRows.some((h) => r >= h.top && r <= h.row)) return null;
      if (cells.some((c) => c.type === 'number' || c.formula !== undefined)) return null;
      if (figureCols.some((c) => at(grid, c, r)) || (statusCol !== undefined && statusOf(at(grid, statusCol, r)))) return null;
      return textOf(cells.find((c) => textOf(c)));
    };
    let section = titleAt(header.top - 1) ?? titleAt(header.top - 2);
    let formulaRows = 0;
    let rowCount = 0;
    const textValues: WorkbookCell[] = [];
    const unlabelled: WorkbookCell[] = [];
    for (const r of span) {
      const title = titleAt(r);
      if (title) {
        section = title;
        continue;
      }
      const valueCell = at(grid, cols.value, r);
      const value = numberOf(grid, valueCell, computed);
      if (numberLikeText(valueCell)) textValues.push(valueCell!);
      if (!valueCell || (value === null && !holdsNumber(valueCell))) continue;
      const labelCell = labelCol !== undefined && textOf(at(grid, labelCol, r)) ? at(grid, labelCol, r) : labelLeftOf(grid, valueCell);
      if (!labelCell) {
        if (valueCell.formula === undefined) unlabelled.push(valueCell);
        continue;
      }
      const lowCell = cols.low !== undefined ? at(grid, cols.low, r) : undefined;
      const highCell = cols.high !== undefined ? at(grid, cols.high, r) : undefined;
      const low = numberOf(grid, lowCell, computed);
      const high = numberOf(grid, highCell, computed);
      const statusCell = statusCol !== undefined ? at(grid, statusCol, r) : undefined;
      const status = statusOf(statusCell);
      const isFormula = valueCell.formula !== undefined;
      // a formula with no range and no status is a computed line of the model, not an assumption
      if (isFormula && !status && low === null && high === null) {
        formulaRows++;
        continue;
      }
      if (value === null) continue;
      rowCount++;
      const label = textOf(labelCell)!;
      const occurrence = occurrenceOf(grid, labelCell);
      assumptions.push({
        id: `${name}!${label}#${occurrence}`,
        sheet: name,
        label,
        occurrence,
        section,
        row: r,
        valueCell: valueCell.address,
        value,
        valueIsFormula: isFormula,
        ...(valueCell.numFmt ? { numFmt: valueCell.numFmt } : {}),
        lowCell: lowCell && low !== null ? lowCell.address : null,
        low,
        highCell: highCell && high !== null ? highCell.address : null,
        high,
        basis: cols.basis !== undefined ? textOf(at(grid, cols.basis, r)) : null,
        note: valueCell.note ?? null,
        statusCell: status && statusCell ? statusCell.address : null,
        status,
        origin: 'table',
      });
    }
    const valueLetter = numberToCol(cols.value);
    if (textValues.length) {
      warnings.push({
        code: 'value-not-number',
        sheet: name,
        message: `分頁「${name}」的取用值 ${textValues.slice(0, 8).map((c) => c.address).join('、')}${textValues.length > 8 ? ` 等 ${textValues.length} 格` : ''} 是文字不是數字（例如「${textOf(textValues[0])}」），這${textValues.length > 1 ? '幾' : '一'}列讀不出來；請在 Excel 把它改成數字格式。`,
      });
    }
    if (unlabelled.length) {
      warnings.push({ code: 'table-empty', sheet: name, message: `分頁「${name}」的取用值 ${unlabelled.slice(0, 8).map((c) => c.address).join('、')} 同一列找不到假設名稱，這${unlabelled.length > 1 ? '幾' : '一'}列沒有讀進來。` });
    }
    if (rowCount === 0 && !textValues.length && !unlabelled.length) {
      const why = formulaRows > 0 ? `${valueLetter} 欄下面只有公式，而且沒有區間也沒有「要」「已定」，都當成算式列` : `${valueLetter} 欄（取用值）下面第 ${header.row + 1} 到 ${end} 列沒有數字`;
      warnings.push({ code: 'table-empty', sheet: name, message: `分頁「${name}」第 ${header.row} 列有假設表的表頭，但下面沒有讀到任何假設：${why}。` });
    }
    if (statusCol === undefined && rowCount > 0) {
      warnings.push({ code: 'no-status-column', sheet: name, message: `分頁「${name}」第 ${header.row} 列的假設表找不到內容是「要」或「已定」的欄，分不出哪些要判斷。` });
    }
    const letter = (c: number | undefined) => (c === undefined ? null : numberToCol(c));
    tables.push({
      sheet: name,
      headerRow: header.row,
      columns: { label: letter(labelCol), value: letter(cols.value), low: letter(cols.low), high: letter(cols.high), basis: letter(cols.basis), status: letter(statusCol) },
      formulaRows,
    });
  });

  const seen = new Map<string, number>();
  for (const a of assumptions) seen.set(normalizeLabel(a.label), (seen.get(normalizeLabel(a.label)) ?? 0) + 1);
  const repeated = [...new Set(assumptions.filter((a) => seen.get(normalizeLabel(a.label))! > 1).map((a) => a.label))];
  if (repeated.length) {
    warnings.push({ code: 'duplicate-label', sheet: name, message: `分頁「${name}」有名稱相同的假設：「${repeated.join('」「')}」。它們靠出現順序區分，在中間插入同名的列會對錯。` });
  }
  return { tables, assumptions, warnings, nearest: headerRows.length ? null : nearest };
}

// ---------------------------------------------------------------------------------------------
// the side-by-side table
// ---------------------------------------------------------------------------------------------

const PARTY_LABELS: [PartyKey, string[]][] = [
  ['mine', ['我的預估']],
  ['linear', ['線性推估']],
  ['consensus', ['賣方共識']],
  ['funda', ['FUNDA預估', 'FUNDA']],
  ['allen', ['ALLEN預估', 'ALLEN']],
  ['guidance', ['公司財測']],
  ['actual', ['財報實際']],
];

function partyOf(cell: WorkbookCell): PartyKey | null {
  const text = textOf(cell);
  if (!text) return null;
  const norm = normalizeLabel(text);
  return PARTY_LABELS.find(([, names]) => names.includes(norm))?.[0] ?? null;
}

function scanPartyTables(grid: Grid): PartyTable[] {
  const headers = grid.rowNumbers
    .map((r) => ({ row: r, cells: grid.rows.get(r)!.filter((c) => partyOf(c) !== null) }))
    .filter((h) => h.cells.length >= 3);
  return headers.map((header, index) => {
    // the period names sit on the nearest row above that has text over these columns
    const firstCol = header.cells[0].col;
    let periodRow: WorkbookCell[] = [];
    for (let r = header.row - 1; r >= Math.max(1, header.row - 3) && periodRow.length === 0; r--) {
      periodRow = (grid.rows.get(r) ?? []).filter((c) => textOf(c) !== null && c.col >= firstCol);
    }
    const periods: PartyPeriod[] = [];
    for (const cell of header.cells) {
      // a merged period header keeps its text in its leftmost cell
      const over = [...periodRow].reverse().find((c) => c.col <= cell.col);
      const period = over ? textOf(over)! : '';
      const column: PartyColumn = { party: partyOf(cell)!, label: textOf(cell)!, col: numberToCol(cell.col) };
      const last = periods[periods.length - 1];
      if (last && last.period === period) last.columns.push(column);
      else periods.push({ period, columns: [column] });
    }
    const end = index + 1 < headers.length ? headers[index + 1].row : Infinity;
    const partyCols = header.cells.map((c) => c.col);
    const rows = grid.rowNumbers
      .filter((r) => r > header.row && r < end)
      .flatMap((r) => {
        const label = (grid.rows.get(r) ?? []).find((c) => c.col < firstCol && textOf(c) !== null);
        return label && partyCols.some((c) => holdsNumber(at(grid, c, r))) ? [{ label: textOf(label)!, row: r }] : [];
      });
    return { sheet: grid.sheet.name, headerRow: header.row, periods, rows };
  });
}

// ---------------------------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------------------------

const QUARTER_RE = /^(?:[1-4]Q\d{2,4}|(?:FY)?\d{2,4}Q[1-4]|Q[1-4](?:FY)?\d{2,4})$/;
const stripBrackets = (norm: string) => norm.replace(/\([^)]*\)/g, '');

interface Found {
  grid: Grid;
  label: WorkbookCell;
  /** Higher fits the wanted label better. */
  score: number;
}

/** Labels with a figure to their right, best match first, the preferred sheets first among equals. */
function findLabels(grids: Grid[], score: (norm: string) => number): Found[] {
  const found: Found[] = [];
  for (const grid of grids) {
    for (const [norm, cells] of grid.labels) {
      const s = score(norm);
      if (s <= 0) continue;
      for (const label of cells) if (numberRightOf(grid, label)) found.push({ grid, label, score: s });
    }
  }
  return found.sort((a, b) => b.score - a.score || grids.indexOf(a.grid) - grids.indexOf(b.grid) || a.label.row - b.label.row || a.label.col - b.label.col);
}

interface RevenueBlock {
  grid: Grid;
  quarters: PeriodAnchor[];
  total: LabelAnchor;
}

/** Rows headed by four quarters and a 合計 column that have a 總營收 line under them. */
function findRevenueBlocks(grid: Grid): RevenueBlock[] {
  const blocks: RevenueBlock[] = [];
  const headerRows = grid.rowNumbers.flatMap((r) => {
    const cells = grid.rows.get(r)!;
    const total = cells.find((c) => textOf(c) !== null && normalizeLabel(textOf(c)!).includes('合計') && cells.filter((x) => x.col < c.col && textOf(x) !== null && QUARTER_RE.test(normalizeLabel(textOf(x)!))).length >= 4);
    if (!total) return [];
    const quarters = cells.filter((c) => c.col < total.col && textOf(c) !== null && QUARTER_RE.test(normalizeLabel(textOf(c)!))).slice(-4);
    return [{ row: r, total, quarters }];
  });
  headerRows.forEach((header, index) => {
    const end = index + 1 < headerRows.length ? headerRows[index + 1].row : Infinity;
    const firstCol = header.quarters[0].col;
    let best: { label: WorkbookCell; score: number } | null = null;
    for (const r of grid.rowNumbers) {
      if (r <= header.row || r >= end) continue;
      const label = (grid.rows.get(r) ?? []).find((c) => c.col < firstCol && textOf(c) !== null);
      if (!label) continue;
      const norm = stripBrackets(normalizeLabel(textOf(label)!));
      const score = norm === '總營收' ? 3 : norm === '營收合計' || norm === '營收' ? 2 : norm.includes('總營收') ? 1 : 0;
      if (score > (best?.score ?? 0)) best = { label, score };
    }
    if (!best) return;
    // with a second header row of parties under each quarter, the figure is under 我的預估
    const mine = grid.rowNumbers
      .filter((r) => r > header.row && r < best!.label.row)
      .flatMap((r) => grid.rows.get(r)!)
      .find((c) => c.col >= firstCol && partyOf(c) === 'mine');
    const base = anchorFor(grid, best.label);
    const anchor = (cell: WorkbookCell): LabelAnchor => ({ ...base, columnLabel: textOf(cell)!, ...(mine ? { subColumnLabel: textOf(mine)! } : {}) });
    blocks.push({ grid, quarters: header.quarters.map((c) => ({ period: textOf(c)!, anchor: anchor(c) })), total: anchor(header.total) });
  });
  return blocks;
}

const OUTPUT_NAMES: Record<OutputKey, string> = { revenue: '未來四季營收', eps: 'EPS', targetPrice: '目標價', multiple: '倍數', shareCount: '股數', netCash: '淨現金' };

/**
 * Reads the workbook's layout. `computed` supplies formula results when the file stores none; it is
 * only used to fill in values, so detection gives the same cells without it.
 */
export function detectWorkbook(workbook: WorkbookData, computed?: ComputedValue): DetectResult {
  const warnings: DetectWarning[] = [];
  const grids = workbook.sheets.filter((s) => !s.hidden).map(gridOf);
  const cachedAt = (grid: Grid, address: string | null): CellValue => {
    if (!address) return null;
    const cell = grid.sheet.cells[address];
    return cell ? (numberOf(grid, cell, computed) ?? cell.value) : null;
  };

  // --- assumptions
  const scans = grids.map((g) => scanAssumptions(g, computed));
  const tables = scans.flatMap((s) => s.tables);
  const assumptions = scans.flatMap((s) => s.assumptions);
  for (const s of scans) warnings.push(...s.warnings);
  if (tables.length === 0) {
    const near = scans.map((s, i) => ({ grid: grids[i], nearest: s.nearest })).filter((x) => x.nearest).sort((a, b) => b.nearest!.found.length - a.nearest!.found.length)[0];
    const hint = near
      ? `最接近的是分頁「${near.grid.sheet.name}」第 ${near.nearest!.row} 列，只有「${near.nearest!.found.map((k) => HEADER_NAMES[k]).join('」「')}」。`
      : '整個檔案沒有任何一格寫這四個詞。';
    warnings.push({ code: 'no-assumption-table', message: `找不到假設表：沒有任何一列同時有「取用值」「下緣」「上緣」「依據」其中三個表頭。${hint}` });
  }

  // sheets that hold assumption tables come first when a result could be on several sheets
  const tableSheets = new Set(tables.map((t) => t.sheet));
  const ordered = [...grids.filter((g) => tableSheets.has(g.sheet.name)), ...grids.filter((g) => !tableSheets.has(g.sheet.name))];
  const candidates: OutputCandidate[] = [];
  const outputs: OutputMapping = { revenueQuarters: [], revenueTotal: null, eps: [], targetPrice: null, multiple: null, shareCount: null, netCash: null };
  const where = (f: { grid: Grid; label: WorkbookCell }) => `「${f.grid.sheet.name}」第 ${f.label.row} 列「${textOf(f.label)}」`;
  const missing = (output: OutputKey, wanted: string) => warnings.push({ code: 'output-missing', message: `找不到${OUTPUT_NAMES[output]}：${wanted}` });

  /** Records every candidate, picks the first, and warns when the runner-up fits as well on the same sheet. */
  const choose = (output: 'targetPrice' | 'multiple' | 'shareCount' | 'netCash', found: Found[], wanted: string): Found | null => {
    found.forEach((f, i) => {
      const cell = numberRightOf(f.grid, f.label);
      candidates.push({ output, anchor: anchorFor(f.grid, f.label), address: cell?.address ?? null, cached: cachedAt(f.grid, cell?.address ?? null), chosen: i === 0 });
    });
    if (found.length === 0) {
      missing(output, wanted);
      return null;
    }
    const rivals = found.filter((f) => f !== found[0] && f.score === found[0].score && f.grid === found[0].grid);
    if (rivals.length) {
      warnings.push({ code: 'output-ambiguous', sheet: found[0].grid.sheet.name, message: `${OUTPUT_NAMES[output]}有 ${rivals.length + 1} 個可能的位置，先用${where(found[0])}；其他：${rivals.map(where).join('、')}。` });
    }
    outputs[output] = anchorFor(found[0].grid, found[0].label);
    return found[0];
  };

  // --- target price, then the cells its formula is built from
  const target = choose(
    'targetPrice',
    findLabels(ordered, (norm) => (stripBrackets(norm) === '目標價' ? 3 : norm.startsWith('目標價') && !/[對比較]/.test(norm) ? 2 : norm.includes('目標價') ? 1 : 0)),
    '沒有任何一格的文字含「目標價」而且右邊有數字。',
  );
  const targetCell = target ? numberRightOf(target.grid, target.label) : null;
  const precedents: { grid: Grid; label: WorkbookCell }[] = [];
  if (target && targetCell?.formula) {
    for (const ref of formulaRefs(targetCell.formula)) {
      if (ref.to) continue;
      const grid = ref.sheet === null ? target.grid : grids.find((g) => g.sheet.name === ref.sheet);
      const cell = grid?.sheet.cells[ref.address];
      const label = grid && cell ? labelLeftOf(grid, cell) : null;
      // only labels whose own first figure is that cell can be found again later
      if (grid && cell && label && numberRightOf(grid, label) === cell) precedents.push({ grid, label });
    }
  }
  const near = (word: string): Found[] => {
    const fromFormula = precedents.filter((p) => normalizeLabel(textOf(p.label)!).includes(word)).map((p) => ({ ...p, score: 10 }));
    if (fromFormula.length) return fromFormula;
    // otherwise the same word on the target price's sheet, nearest row first
    const sameSheet = findLabels(target ? [target.grid] : ordered, (norm) => (norm.includes(word) ? 1 : 0));
    return target ? sameSheet.sort((a, b) => Math.abs(a.label.row - target.label.row) - Math.abs(b.label.row - target.label.row)) : sameSheet;
  };
  const multiple = choose('multiple', near('倍數'), '目標價的公式沒有指到標籤含「倍數」的格子，同一分頁也沒有這樣的標籤。');
  choose('shareCount', near('股數'), '目標價的公式沒有指到標籤含「股數」的格子，同一分頁也沒有這樣的標籤。');
  choose('netCash', near('淨現金'), '目標價的公式沒有指到標籤含「淨現金」的格子，同一分頁也沒有這樣的標籤。');

  // --- the next four quarters' revenue
  const blocks = ordered.flatMap(findRevenueBlocks);
  blocks.forEach((b, i) => {
    const cell = resolveInGrid(b.grid, b.total);
    candidates.push({ output: 'revenue', anchor: b.total, address: cell?.address ?? null, cached: cachedAt(b.grid, cell?.address ?? null), chosen: i === 0 });
  });
  if (blocks.length === 0) {
    missing('revenue', '沒有任何一列同時有四個季度（例如 3Q27）和「合計」當表頭，而且下面有「總營收」這一列。');
  } else {
    outputs.revenueQuarters = blocks[0].quarters;
    outputs.revenueTotal = blocks[0].total;
    const totals = candidates.filter((c) => c.output === 'revenue');
    const chosen = totals[0].cached;
    const differing = totals.filter((c) => typeof chosen === 'number' && typeof c.cached === 'number' && Math.abs(c.cached - chosen) > 0.005 * Math.abs(chosen));
    if (differing.length) {
      warnings.push({
        code: 'output-ambiguous',
        sheet: blocks[0].grid.sheet.name,
        message: `未來四季營收合計有 ${totals.length} 個位置而且數字不同，先用「${totals[0].anchor.sheet}」的 ${chosen}；其他：${differing.map((c) => `「${c.anchor.sheet}」${c.address} 是 ${c.cached}`).join('、')}。`,
      });
    }
  }

  // --- the side-by-side table, and 我的預估 EPS for each of its periods
  const partyTables = grids.flatMap(scanPartyTables);
  if (partyTables.length === 0) {
    warnings.push({ code: 'no-party-table', message: '找不到各方並列表：沒有任何一列同時有「我的預估」「賣方共識」「FUNDA 預估」「Allen 預估」「公司財測」「財報實際」其中三個。' });
  }
  for (const table of partyTables) {
    const grid = grids.find((g) => g.sheet.name === table.sheet)!;
    const row = table.rows.find((r) => /EPS|每股盈餘/.test(normalizeLabel(r.label)) && !/年增|季增|成長|YOY|QOQ/.test(normalizeLabel(r.label)));
    if (!row) continue;
    const label = (grid.rows.get(row.row) ?? []).find((c) => textOf(c) === row.label)!;
    const eps: PeriodAnchor[] = table.periods.flatMap((p) => {
      const mine = p.columns.find((c) => c.party === 'mine');
      return mine ? [{ period: p.period, anchor: { ...anchorFor(grid, label), columnLabel: p.period, subColumnLabel: mine.label } }] : [];
    });
    eps.forEach((e) => {
      const cell = resolveInGrid(grid, e.anchor);
      candidates.push({ output: 'eps', anchor: e.anchor, address: cell?.address ?? null, cached: cachedAt(grid, cell?.address ?? null), chosen: outputs.eps.length === 0 });
    });
    if (outputs.eps.length === 0) outputs.eps = eps;
  }
  if (outputs.eps.length === 0 && partyTables.length > 0) missing('eps', '各方並列表裡沒有標籤含「EPS」的列，或那張表沒有「我的預估」欄。');

  // the multiple is the one assumption that usually sits outside the tables: make it editable too
  if (multiple) {
    const cell = numberRightOf(multiple.grid, multiple.label)!;
    const value = numberOf(multiple.grid, cell, computed);
    const sheet = multiple.grid.sheet.name;
    if (value !== null && cell.formula === undefined && !assumptions.some((a) => a.sheet === sheet && a.valueCell === cell.address)) {
      const label = textOf(multiple.label)!;
      const occurrence = occurrenceOf(multiple.grid, multiple.label);
      assumptions.push({
        id: `${sheet}!${label}#${occurrence}`,
        sheet,
        label,
        occurrence,
        section: null,
        row: cell.row,
        valueCell: cell.address,
        value,
        valueIsFormula: false,
        ...(cell.numFmt ? { numFmt: cell.numFmt } : {}),
        lowCell: null,
        low: null,
        highCell: null,
        high: null,
        basis: null,
        note: cell.note ?? null,
        statusCell: null,
        status: null,
        origin: 'output',
      });
    }
  }

  return { tables, assumptions, outputs, candidates, partyTables, warnings };
}

/** The cell of one (row, period, party) of a side-by-side table, or null when that party has no column there. */
export function partyCell(table: PartyTable, rowLabel: string, period: string, party: PartyKey): CellRef | null {
  const row = table.rows.find((r) => r.label === rowLabel);
  const column = table.periods.find((p) => p.period === period)?.columns.find((c) => c.party === party);
  return row && column ? { sheet: table.sheet, address: `${column.col}${row.row}` } : null;
}
