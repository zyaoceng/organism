/**
 * Recalculates a workbook read by read.ts. HyperFormula does the arithmetic (GPL-3.0 key); the
 * FormulaEngine interface keeps it replaceable. Before any trial value is shown, selfCheck()
 * compares what this engine computes against what Excel stored in the file.
 */
import { AlwaysSparse, DetailedCellError, HyperFormula, type RawCellContent, type SimpleCellAddress } from 'hyperformula';
import { cellAddress, colToNumber, formulaFunctions, hasThreeDReference, normalizeFormula, parseAddress } from '../../domain/workbook/shiftFormula';
import {
  MISMATCH_LIST_LIMIT,
  type CellMismatch,
  type CellOverride,
  type CellRef,
  type CellValue,
  type FormulaEngine,
  type SelfCheckReport,
  type UnsupportedFunction,
  type WorkbookCell,
  type WorkbookData,
} from '../../domain/workbook/types';

export type { FormulaEngine } from '../../domain/workbook/types';

/** Two numbers agree when they differ by less than this share of the larger one. */
export const SELF_CHECK_TOLERANCE = 1e-6;
// below this, both count as zero (Excel stores 1e-17 where the exact answer is 0)
const ABSOLUTE_FLOOR = 1e-9;

const SUPPORTED_FUNCTIONS = new Set(HyperFormula.getRegisteredFunctionNames('enGB'));

function valuesAgree(cached: CellValue, computed: CellValue, cachedIsError: boolean): boolean {
  if (typeof cached === 'number' && typeof computed === 'number') {
    const diff = Math.abs(cached - computed);
    return diff <= ABSOLUTE_FLOOR || diff <= SELF_CHECK_TOLERANCE * Math.max(Math.abs(cached), Math.abs(computed));
  }
  // any error against any error: engines name the same failure differently (#N/A vs #VALUE!)
  if (cachedIsError) return typeof computed === 'string' && computed.startsWith('#');
  // Excel stores "" for a formula that returns an empty cell's text
  if ((cached === '' || cached === null) && (computed === '' || computed === null)) return true;
  if (typeof cached === 'boolean' && typeof computed === 'number') return Number(cached) === computed;
  return cached === computed;
}

type NameLookup = (name: string) => string | undefined;

/** What the engine is given for a cell: a formula with `=`, a number or boolean, or text behind an apostrophe. */
function cellContent(cell: WorkbookCell, names: NameLookup): RawCellContent {
  if (cell.formula !== undefined) {
    const formula = normalizeFormula(cell.formula, names);
    // an array formula works on whole ranges and fills its range with the result
    return cell.arrayRef ? `=ARRAYFORMULA(${formula})` : `=${formula}`;
  }
  // the apostrophe keeps "0050" and "=x" as text instead of being parsed
  if (typeof cell.value === 'string') return cell.type === 'error' ? cell.value : `'${cell.value}`;
  return cell.value;
}

/** Defined names visible from a sheet: its own first, then the workbook's. Print areas and the like are not values. */
function nameLookup(workbook: WorkbookData, sheet: string): NameLookup {
  const names = new Map<string, string>();
  for (const dn of workbook.definedNames) {
    if (dn.name.startsWith('_xlnm.') || (dn.sheet !== undefined && dn.sheet !== sheet)) continue;
    const key = dn.name.toLowerCase();
    if (dn.sheet !== undefined || !names.has(key)) names.set(key, dn.formula);
  }
  return (name) => names.get(name.toLowerCase());
}

/** Addresses an array formula fills, other than the cell holding it; empty for a range that does not parse. */
function spillAddresses(master: WorkbookCell): string[] {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(master.arrayRef ?? '');
  if (!m) return [];
  const [c1, c2] = [colToNumber(m[1]), colToNumber(m[3])];
  const [r1, r2] = [Number(m[2]), Number(m[4])];
  // a whole-column array formula is not expanded cell by cell
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > 100_000) return [];
  const out: string[] = [];
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== master.row || c !== master.col) out.push(cellAddress(c, r));
  return out;
}

const DAY_ZERO_1904 = { year: 1904, month: 1, day: 1 };
// Excel also reads 2026/1/31 and 2026-01-31 as dates in DATEVALUE and in text arithmetic
const DATE_FORMATS = ['DD/MM/YYYY', 'DD/MM/YY', 'YYYY/MM/DD', 'YYYY-MM-DD'];

export class HyperFormulaEngine implements FormulaEngine {
  private hf: HyperFormula | null = null;
  private workbook: WorkbookData | null = null;
  private loadWarnings: string[] = [];
  /** Keys ("sheet\0address") of cells currently overridden. */
  private overridden = new Map<string, CellRef>();
  /** Keys of cells an array formula fills: their content is the formula's, not the stored constant. */
  private spill = new Set<string>();

  load(workbook: WorkbookData): void {
    this.dispose();
    this.workbook = workbook;
    this.loadWarnings = [];
    const sheets: Record<string, RawCellContent[][]> = {};
    for (const sheet of workbook.sheets) {
      const rows: RawCellContent[][] = [];
      const names = nameLookup(workbook, sheet.name);
      for (const cell of Object.values(sheet.cells)) {
        if (cell.formula === undefined || !cell.arrayRef) continue;
        for (const address of spillAddresses(cell)) if (sheet.cells[address]?.formula === undefined) this.spill.add(`${sheet.name}\0${address}`);
      }
      for (const cell of Object.values(sheet.cells)) {
        if (this.spill.has(`${sheet.name}\0${cell.address}`)) continue;
        if (cell.unsupported) this.loadWarnings.push(`${sheet.name}!${cell.address}: ${cell.unsupported} is not recalculated`);
        if (cell.formula !== undefined && hasThreeDReference(cell.formula)) this.loadWarnings.push(`${sheet.name}!${cell.address}: a reference across several sheets is not recalculated`);
        const content = cellContent(cell, names);
        if (content === null) continue;
        (rows[cell.row - 1] ??= [])[cell.col - 1] = content;
      }
      // the engine wants dense rows
      sheets[sheet.name] = Array.from(rows, (r) => Array.from(r ?? [], (c) => c ?? null));
    }
    this.hf = HyperFormula.buildFromSheets(sheets, {
      licenseKey: 'gpl-v3',
      // as Excel: =A1 of an empty cell is 0, SUMPRODUCT(A1:A3*B1:B3) multiplies cell by cell
      evaluateNullToZero: true,
      useArrayArithmetic: true,
      dateFormats: DATE_FORMATS,
      ...(workbook.date1904 ? { nullDate: DAY_ZERO_1904 } : {}),
      // Excel's sheet size (the engine's default stops at 40,000 rows), stored sparsely: one stray
      // cell far down and one far right must not allocate the whole rectangle between them
      maxRows: 1048576,
      maxColumns: 16384,
      chooseAddressMappingPolicy: new AlwaysSparse(),
    });
  }

  set(overrides: CellOverride[]): void {
    const hf = this.engine();
    const next = new Map<string, CellOverride>(overrides.map((o) => [`${o.sheet}\0${o.address}`, o]));
    // resolve every address first, so a bad one changes nothing
    const targets = [...next.values()].map((o) => ({ at: this.locate(o), value: o.value }));
    hf.batch(() => {
      for (const [key, ref] of this.overridden) {
        if (next.has(key)) continue;
        const original = this.workbook!.sheets.find((s) => s.name === ref.sheet)?.cells[ref.address];
        hf.setCellContents(this.locate(ref), [[original && !this.spill.has(key) ? cellContent(original, nameLookup(this.workbook!, ref.sheet)) : null]]);
      }
      for (const t of targets) hf.setCellContents(t.at, [[t.value]]);
    });
    this.overridden = new Map([...next].map(([k, o]) => [k, { sheet: o.sheet, address: o.address }]));
  }

  get(cells: CellRef[]): CellValue[] {
    const hf = this.engine();
    return cells.map((c) => plain(hf.getCellValue(this.locate(c))));
  }

  /** Meaningful right after load(): with overrides set, the stored results no longer apply. */
  selfCheck(): SelfCheckReport {
    const hf = this.engine();
    const mismatches: CellMismatch[] = [];
    const unsupported = new Map<string, UnsupportedFunction>();
    let formulaCells = 0;
    let compared = 0;
    let mismatchCount = 0;
    for (const sheet of this.workbook!.sheets) {
      const cells = Object.values(sheet.cells).sort((a, b) => a.row - b.row || a.col - b.col);
      for (const cell of cells) {
        // a cell an array formula fills is checked like a formula cell: its stored value is a result
        const filled = cell.formula === undefined && cell.type !== 'empty' && this.spill.has(`${sheet.name}\0${cell.address}`);
        if (cell.formula === undefined && !filled) continue;
        formulaCells++;
        const formula = cell.formula ?? '';
        if (filled) {
          compared++;
          const computed = plain(hf.getCellValue(this.locate({ sheet: sheet.name, address: cell.address })));
          if (valuesAgree(cell.value, computed, cell.type === 'error')) continue;
          mismatchCount++;
          if (mismatches.length < MISMATCH_LIST_LIMIT) mismatches.push({ sheet: sheet.name, address: cell.address, formula, cached: cell.value, computed });
          continue;
        }
        if (cell.formula === undefined) continue;
        for (const name of formulaFunctions(cell.formula)) {
          if (SUPPORTED_FUNCTIONS.has(name)) continue;
          const u = unsupported.get(name) ?? { name, cells: [], count: 0 };
          u.count++;
          if (u.cells.length < 5) u.cells.push(`${sheet.name}!${cell.address}`);
          unsupported.set(name, u);
        }
        if (!cell.hasCached) continue;
        compared++;
        const computed = plain(hf.getCellValue(this.locate({ sheet: sheet.name, address: cell.address })));
        if (valuesAgree(cell.value, computed, cell.type === 'error')) continue;
        mismatchCount++;
        if (mismatches.length < MISMATCH_LIST_LIMIT) mismatches.push({ sheet: sheet.name, address: cell.address, formula: cell.formula, cached: cell.value, computed });
      }
    }
    return {
      state: formulaCells > 0 && compared === 0 ? 'no-cached-values' : mismatchCount > 0 ? 'mismatch' : 'verified',
      formulaCells,
      compared,
      missingCached: formulaCells - compared,
      mismatchCount,
      mismatches,
      unsupportedFunctions: [...unsupported.values()].sort((a, b) => a.name.localeCompare(b.name)),
      loadWarnings: [...this.loadWarnings],
    };
  }

  /** Frees the engine's memory; the instance can be loaded again. */
  dispose(): void {
    this.hf?.destroy();
    this.hf = null;
    this.workbook = null;
    this.overridden.clear();
    this.spill.clear();
  }

  private engine(): HyperFormula {
    if (!this.hf) throw new Error('No workbook is loaded');
    return this.hf;
  }

  private locate(ref: CellRef): SimpleCellAddress {
    const sheet = this.engine().getSheetId(ref.sheet);
    if (sheet === undefined) throw new Error(`No sheet named ${ref.sheet}`);
    const { col, row } = parseAddress(ref.address);
    return { sheet, col: col - 1, row: row - 1 };
  }
}

function plain(value: unknown): CellValue {
  if (value instanceof DetailedCellError) return value.value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

export function createEngine(workbook: WorkbookData): HyperFormulaEngine {
  const engine = new HyperFormulaEngine();
  engine.load(workbook);
  return engine;
}
