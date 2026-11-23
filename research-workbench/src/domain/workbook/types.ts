/**
 * The user's Excel workbook as plain JSON, and what the assumptions panel finds in it. Excel is the
 * only store of assumption values: everything here is read from the file on each load and nothing
 * of it is kept in the database except the saved label anchors (OutputMapping).
 */

export type CellValue = number | string | boolean | null;

export type CellType = 'number' | 'string' | 'boolean' | 'error' | 'empty';

export interface WorkbookCell {
  /** A1 address without `$`. */
  address: string;
  /** 1-based. */
  row: number;
  /** 1-based (A = 1). */
  col: number;
  /** Type of `value`. A formula with no stored result is 'empty'. */
  type: CellType;
  /** A constant's value, or the result Excel stored for a formula (an error is its text, e.g. "#DIV/0!"). */
  value: CellValue;
  /** Formula text without the leading `=`; shared formulas are already expanded. */
  formula?: string;
  /** Formula cells only: false when the file holds no stored result for it. */
  hasCached?: boolean;
  /** Number format code, e.g. "0.0%"; absent for General. */
  numFmt?: string;
  /** The cell's note (Excel comment) text. */
  note?: string;
  /** An array formula's range (e.g. "B2:B5") on the cell that holds the formula; the other cells of the range hold its results. */
  arrayRef?: string;
  /** Formula kinds this reader does not expand (data tables). */
  unsupported?: string;
}

export interface WorkbookSheet {
  name: string;
  hidden: boolean;
  /** Keyed by address. Only cells present in the file. */
  cells: Record<string, WorkbookCell>;
  /** Merged ranges, e.g. "I1:N1". */
  merges: string[];
}

export interface DefinedName {
  name: string;
  /** Without the leading `=`. */
  formula: string;
  /** Sheet name when the name is local to one sheet. */
  sheet?: string;
}

export interface WorkbookData {
  sheets: WorkbookSheet[];
  sharedStrings: string[];
  definedNames: DefinedName[];
  date1904: boolean;
}

export interface CellRef {
  sheet: string;
  address: string;
}

export interface CellOverride extends CellRef {
  value: number;
}

/** A cell whose recomputed value differs from the one stored in the file. */
export interface CellMismatch extends CellRef {
  formula: string;
  cached: CellValue;
  computed: CellValue;
}

export interface UnsupportedFunction {
  name: string;
  /** "sheet!address", at most a few. */
  cells: string[];
  count: number;
}

/**
 * 'verified': every stored result was reproduced. 'mismatch': some were not (see `mismatches`).
 * 'no-cached-values': the file stores no results at all, so the engine cannot be checked against it.
 */
export type SelfCheckState = 'verified' | 'mismatch' | 'no-cached-values';

export interface SelfCheckReport {
  state: SelfCheckState;
  formulaCells: number;
  /** Formula cells that had a stored result to compare with. */
  compared: number;
  /** Formula cells with no stored result. */
  missingCached: number;
  mismatchCount: number;
  /** The first MISMATCH_LIST_LIMIT of them, in sheet order. */
  mismatches: CellMismatch[];
  unsupportedFunctions: UnsupportedFunction[];
  /** Things the engine does not recalculate (a data table, a reference across several sheets). */
  loadWarnings: string[];
}

export const MISMATCH_LIST_LIMIT = 50;

/**
 * Recalculates the workbook. `set` replaces the whole set of overrides: cells overridden by an
 * earlier call and not named again go back to what the file holds.
 */
export interface FormulaEngine {
  load(workbook: WorkbookData): void;
  set(overrides: CellOverride[]): void;
  get(cells: CellRef[]): CellValue[];
  selfCheck(): SelfCheckReport;
}

/**
 * Finds a cell by the text next to it instead of by position, so it survives inserted rows and
 * columns. `occurrence` counts cells with exactly that text (after normalizeLabel) in reading order,
 * from 1. Without `columnLabel` the cell is the first number to the right of the label. With it, the
 * cell is on the label's row under the header `columnLabel` (the nearest one above); `subColumnLabel`
 * then picks the column under that header carrying this second-level header (e.g. 3Q27 → 我的預估).
 */
export interface LabelAnchor {
  sheet: string;
  labelText: string;
  occurrence: number;
  columnLabel?: string;
  subColumnLabel?: string;
}

export type AssumptionStatus = 'needs-decision' | 'decided';

export interface DetectedAssumption {
  /** `${sheet}!${label}#${occurrence}`: stable while the label text stays the same. */
  id: string;
  sheet: string;
  label: string;
  /** Which cell with this label on the sheet, from 1. */
  occurrence: number;
  /** Title of the step the row sits under, e.g. "二、端點＝台數 × 每台單價". */
  section: string | null;
  row: number;
  /** The 取用值 cell. */
  valueCell: string;
  value: number;
  valueIsFormula: boolean;
  numFmt?: string;
  lowCell: string | null;
  low: number | null;
  highCell: string | null;
  high: number | null;
  basis: string | null;
  /** The note on the value cell (source). */
  note: string | null;
  statusCell: string | null;
  /** 要 → 'needs-decision', 已定 → 'decided', neither → null. */
  status: AssumptionStatus | null;
  /** 'table': a row of an assumption table. 'output': the valuation multiple found by its label. */
  origin: 'table' | 'output';
}

export interface AssumptionTable {
  sheet: string;
  headerRow: number;
  /** Column letters; null when that header is absent. */
  columns: { label: string | null; value: string | null; low: string | null; high: string | null; basis: string | null; status: string | null };
  /** Rows whose 取用值 is a formula with no range and no status: results, not assumptions. */
  formulaRows: number;
}

export interface PeriodAnchor {
  period: string;
  anchor: LabelAnchor;
}

/** Where the results are. Saved per project; every anchor is re-resolved against the file on load. */
export interface OutputMapping {
  /** The next four quarters' total revenue, in order. */
  revenueQuarters: PeriodAnchor[];
  revenueTotal: LabelAnchor | null;
  /** 我的預估 EPS for each forecast period of the parties table. */
  eps: PeriodAnchor[];
  targetPrice: LabelAnchor | null;
  multiple: LabelAnchor | null;
  shareCount: LabelAnchor | null;
  netCash: LabelAnchor | null;
}

export type OutputKey = 'revenue' | 'eps' | 'targetPrice' | 'multiple' | 'shareCount' | 'netCash';

export interface OutputCandidate {
  output: OutputKey;
  anchor: LabelAnchor;
  /** The resolved cell (for `revenue`, the total or else the first quarter). */
  address: string | null;
  cached: CellValue;
  chosen: boolean;
}

export type PartyKey = 'mine' | 'linear' | 'consensus' | 'funda' | 'allen' | 'guidance' | 'actual';

export interface PartyColumn {
  party: PartyKey;
  /** Header text as written in the sheet. */
  label: string;
  /** Column letter. */
  col: string;
}

export interface PartyPeriod {
  period: string;
  columns: PartyColumn[];
}

export interface PartyRow {
  label: string;
  row: number;
}

/** One sheet's side-by-side table: cell = column letter of (period, party) + row number. */
export interface PartyTable {
  sheet: string;
  headerRow: number;
  periods: PartyPeriod[];
  rows: PartyRow[];
}

export type DetectWarningCode =
  | 'no-assumption-table'
  | 'header-incomplete'
  | 'no-status-column'
  | 'table-empty'
  | 'table-side-by-side'
  | 'value-not-number'
  | 'duplicate-label'
  | 'output-missing'
  | 'output-ambiguous'
  | 'no-party-table';

export interface DetectWarning {
  code: DetectWarningCode;
  sheet?: string;
  /** One sentence for the user (Traditional Chinese, like the workbook itself), naming exactly what was not found. */
  message: string;
}

export interface DetectResult {
  tables: AssumptionTable[];
  assumptions: DetectedAssumption[];
  outputs: OutputMapping;
  /** Every place an output could be, including the chosen one. */
  candidates: OutputCandidate[];
  partyTables: PartyTable[];
  warnings: DetectWarning[];
}

/** A range used only for the what-if, never written to the file. */
export interface TrialRange {
  low: number;
  high: number;
}

export interface SensitivityOutputs {
  targetPrice: CellRef | null;
  revenue: CellRef | null;
  eps: CellRef | null;
}

export interface SensitivityEffect {
  atLow: number | null;
  atHigh: number | null;
  /** atHigh − atLow; null when either end did not give a number. */
  delta: number | null;
}

export interface TornadoRow {
  id: string;
  label: string;
  section: string | null;
  low: number;
  high: number;
  /** 'sheet': 下緣／上緣 from the workbook. 'trial': supplied for this what-if only. */
  rangeSource: 'sheet' | 'trial';
  targetPrice: SensitivityEffect;
  revenue: SensitivityEffect;
  eps: SensitivityEffect;
}

export interface SensitivityResult {
  /** Values with only the base overrides applied. */
  base: { targetPrice: number | null; revenue: number | null; eps: number | null };
  /** Largest absolute target-price change first. */
  rows: TornadoRow[];
  /** Ids of assumptions left out because they have no complete range. */
  withoutRange: string[];
}
