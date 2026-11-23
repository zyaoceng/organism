/**
 * What the assumptions panel shows, built from a parsed workbook and its engine: assumptions,
 * results (as the file is and with trial values), sensitivity rows, the side-by-side table, and the
 * diagnosis text. Everything is computed from the file on each call; nothing here stores values.
 */
import { detectWorkbook, normalizeLabel, resolveOutputs } from '../../domain/workbook/detect';
import { computeSensitivity } from '../../domain/workbook/sensitivity';
import { numberToCol } from '../../domain/workbook/shiftFormula';
import type { CellOverride, CellRef, CellValue, DetectResult, LabelAnchor, OutputMapping, SelfCheckReport, TrialRange, WorkbookData } from '../../domain/workbook/types';
import type {
  AssumptionDTO,
  PartyTableDTO,
  PartyValueDTO,
  WorkbookFileDTO,
  WorkbookOutputDTO,
  WorkbookOutputsDTO,
  WorkbookPeriodOutputDTO,
  WorkbookSensitivityDTO,
  WorkbookWarningDTO,
} from '../../shared/api';
import { createEngine, type HyperFormulaEngine } from './engine';
import { readWorkbook } from './read';

/** A party's figure further than this from 我的預估 is flagged. */
export const PARTY_GAP_THRESHOLD = 0.1;

/** A parsed file with its engine. The engine holds no overrides between calls. */
export interface LoadedWorkbook {
  sha256: string;
  workbook: WorkbookData;
  engine: HyperFormulaEngine;
  selfCheck: SelfCheckReport;
  detect: DetectResult;
}

/** Parses and loads the bytes; throws XlsxError when they are not a readable xlsx. */
export function loadWorkbook(bytes: Buffer, sha256: string): LoadedWorkbook {
  const workbook = readWorkbook(bytes);
  const engine = createEngine(workbook);
  // before any override, and before detection asks the engine for values the file does not store
  const selfCheck = engine.selfCheck();
  const detect = detectWorkbook(workbook, (ref) => engine.get([ref])[0]);
  return { sha256, workbook, engine, selfCheck, detect };
}

const num = (v: CellValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function assumptionDTOs(detect: DetectResult): AssumptionDTO[] {
  return detect.assumptions.map((a) => ({
    id: a.id,
    sheet: a.sheet,
    label: a.label,
    section: a.section,
    cell: a.valueCell,
    value: a.value,
    valueIsFormula: a.valueIsFormula,
    numFmt: a.numFmt ?? null,
    low: a.low,
    high: a.high,
    basis: a.basis,
    note: a.note,
    status: a.status,
    origin: a.origin,
  }));
}

export interface TrialInput {
  /** By assumption id. */
  overrides: { id: string; value: number }[];
  trialRanges?: Record<string, TrialRange>;
}

/** Ids in `input` that are not assumptions of this workbook. */
export function unknownAssumptionIds(detect: DetectResult, input: TrialInput): string[] {
  const known = new Set(detect.assumptions.map((a) => a.id));
  return [...input.overrides.map((o) => o.id), ...Object.keys(input.trialRanges ?? {})].filter((id) => !known.has(id));
}

/**
 * The results and the sensitivity rows with the trial values applied. `fileValue` is the same
 * cell recalculated without them. Leaves the engine without overrides.
 */
export function evaluate(loaded: LoadedWorkbook, mapping: OutputMapping, input: TrialInput = { overrides: [] }): { outputs: WorkbookOutputsDTO; sensitivity: WorkbookSensitivityDTO } {
  const { engine, detect, workbook } = loaded;
  const byId = new Map(detect.assumptions.map((a) => [a.id, a]));
  const overrides: CellOverride[] = input.overrides.flatMap((o) => {
    const a = byId.get(o.id);
    return a ? [{ sheet: a.sheet, address: a.valueCell, value: o.value }] : [];
  });
  const resolved = resolveOutputs(workbook, mapping);
  // the sensitivity rows follow one EPS: the first full year, else the first period there is
  const epsPick = resolved.eps.find((e) => e.cell && normalizeLabel(e.period).startsWith('FY')) ?? resolved.eps.find((e) => e.cell) ?? null;

  const read = (cell: CellRef | null) => (cell ? num(engine.get([cell])[0]) : null);
  const cells: (CellRef | null)[] = [
    ...resolved.revenueQuarters.map((q) => q.cell),
    ...resolved.eps.map((e) => e.cell),
    resolved.revenueTotal,
    resolved.targetPrice,
    resolved.multiple,
    resolved.shareCount,
    resolved.netCash,
  ];
  try {
    engine.set([]);
    const fileValues = cells.map(read);
    const s = computeSensitivity(engine, {
      assumptions: detect.assumptions,
      outputs: { targetPrice: resolved.targetPrice, revenue: resolved.revenueTotal, eps: epsPick?.cell ?? null },
      trialRanges: input.trialRanges,
      baseOverrides: overrides,
    });
    // the engine now holds the trial values
    const values = cells.map(read);
    let i = 0;
    const next = (cell: CellRef | null): WorkbookOutputDTO => {
      const out = { cell, value: values[i], fileValue: fileValues[i] };
      i++;
      return out;
    };
    const periods = (list: { period: string; cell: CellRef | null }[]): WorkbookPeriodOutputDTO[] => list.map((p) => ({ period: p.period, ...next(p.cell) }));
    const revenueQuarters = periods(resolved.revenueQuarters);
    const eps = periods(resolved.eps);
    return {
      outputs: {
        revenueQuarters,
        eps,
        epsPeriod: epsPick?.period ?? null,
        revenueTotal: next(resolved.revenueTotal),
        targetPrice: next(resolved.targetPrice),
        multiple: next(resolved.multiple),
        shareCount: next(resolved.shareCount),
        netCash: next(resolved.netCash),
      },
      sensitivity: { rows: s.rows, withoutRange: s.withoutRange },
    };
  } finally {
    engine.set([]);
  }
}

/** The side-by-side tables as the file is, each figure compared with 我的預估 of its row and period. */
export function partyTables(loaded: LoadedWorkbook): PartyTableDTO[] {
  const { engine, detect, workbook } = loaded;
  return detect.partyTables.map((table) => {
    const sheet = workbook.sheets.find((s) => s.name === table.sheet);
    return {
      sheet: table.sheet,
      periods: table.periods.map((p) => ({ period: p.period, columns: p.columns.map((c) => ({ party: c.party, label: c.label })) })),
      rows: table.rows.map((row) => {
        let numFmt: string | null = null;
        const cells = table.periods.map((period) => {
          const raw = period.columns.map((c) => {
            const address = `${c.col}${row.row}`;
            numFmt ??= sheet?.cells[address]?.numFmt ?? null;
            return engine.get([{ sheet: table.sheet, address }])[0];
          });
          const mineAt = period.columns.findIndex((c) => c.party === 'mine');
          const mine = mineAt >= 0 ? num(raw[mineAt]) : null;
          return period.columns.map((_, i): PartyValueDTO => {
            const value = num(raw[i]);
            const gap = i !== mineAt && value !== null && mine !== null && mine !== 0 ? (value - mine) / Math.abs(mine) : null;
            const text = typeof raw[i] === 'string' && raw[i] !== '' ? (raw[i] as string) : null;
            return { value, text, gap, flagged: gap !== null && Math.abs(gap) > PARTY_GAP_THRESHOLD };
          });
        });
        return { label: row.label, numFmt, cells };
      }),
    };
  });
}

const anchorText = (a: LabelAnchor) => `「${a.sheet}」的「${a.labelText}」第 ${a.occurrence} 次${a.columnLabel ? `，欄「${a.columnLabel}」${a.subColumnLabel ? `／「${a.subColumnLabel}」` : ''}` : ''}`;

const OUTPUT_NAMES = { revenueTotal: '未來四季營收合計', targetPrice: '目標價', multiple: '倍數', shareCount: '股數', netCash: '淨現金' } as const;

/** One warning for each anchor of a saved mapping that the file no longer has. */
export function mappingWarnings(workbook: WorkbookData, mapping: OutputMapping): WorkbookWarningDTO[] {
  const resolved = resolveOutputs(workbook, mapping);
  const out: WorkbookWarningDTO[] = [];
  const gone = (name: string, anchor: LabelAnchor) => out.push({ code: 'mapping-unresolved', sheet: anchor.sheet, message: `已存的對照找不到${name}：${anchorText(anchor)}。` });
  mapping.revenueQuarters.forEach((p, i) => resolved.revenueQuarters[i].cell || gone(`${p.period} 營收`, p.anchor));
  mapping.eps.forEach((p, i) => resolved.eps[i].cell || gone(`${p.period} EPS`, p.anchor));
  for (const key of ['revenueTotal', 'targetPrice', 'multiple', 'shareCount', 'netCash'] as const) {
    const anchor = mapping[key];
    if (anchor && !resolved[key]) gone(OUTPUT_NAMES[key], anchor);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// diagnosis
// ---------------------------------------------------------------------------------------------

/** A formula's shape without its constants: numbers become n, text becomes "…". Cell references stay. */
export function maskFormula(formula: string): string {
  return formula.replace(/"(?:[^"]|"")*"/g, '"…"').replace(/(?<![A-Za-z$_.\d'!:])\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?(?![A-Za-z_!:'\d])/g, 'n');
}

function sheetExtent(cells: { row: number; col: number }[]): string {
  if (!cells.length) return '空白';
  const rows = cells.map((c) => c.row);
  const cols = cells.map((c) => c.col);
  return `${numberToCol(Math.min(...cols))}${Math.min(...rows)}:${numberToCol(Math.max(...cols))}${Math.max(...rows)}`;
}

export interface DiagnosisInput {
  vaultReadable: boolean;
  file: WorkbookFileDTO | null;
  loaded: LoadedWorkbook | null;
  /** The saved mapping, when there is one. */
  savedMapping: OutputMapping | null;
}

/**
 * Plain text the user pastes back so the layout of a file nobody else can see becomes known:
 * sheets, the headers and labels that were found with their addresses, what was not found, and the
 * self-check. Labels and addresses only: no figure of the workbook is in it.
 */
export function diagnosisText(d: DiagnosisInput): string {
  const out: string[] = ['研究工作台 Excel 診斷（只有分頁、表頭、標籤和位置，不含任何數字）'];
  out.push(`筆記庫資料夾：${d.vaultReadable ? '伺服器讀得到' : '伺服器讀不到'}`);
  if (!d.file) {
    out.push('檔案：這家公司還沒有連結 Excel');
    return `${out.join('\n')}\n`;
  }
  const f = d.file;
  out.push(`檔案：${f.name}`);
  out.push(`狀態：${f.state}${f.reason ? `（${f.reason}）` : ''}${f.excelOpen ? '，Excel 正開著這個檔' : ''}`);
  out.push(`大小：${f.size ?? '未知'} bytes；修改時間：${f.modifiedAt ?? '未知'}；sha256：${f.sha256 ? f.sha256.slice(0, 12) : '未知'}`);
  const l = d.loaded;
  if (!l) return `${out.join('\n')}\n`;

  out.push('', `分頁（${l.workbook.sheets.length} 個）`);
  for (const s of l.workbook.sheets) {
    const cells = Object.values(s.cells);
    out.push(`- ${s.name}${s.hidden ? '（隱藏）' : ''}：範圍 ${sheetExtent(cells)}，${cells.length} 格，其中公式 ${cells.filter((c) => c.formula !== undefined).length} 格`);
  }

  out.push('', `假設表（${l.detect.tables.length} 張）`);
  for (const t of l.detect.tables) {
    const col = (name: string, letter: string | null) => `${name} ${letter ? `${letter}${t.headerRow}` : '找不到'}`;
    out.push(`- ${t.sheet} 第 ${t.headerRow} 列：${col('標籤', t.columns.label)}、${col('取用值', t.columns.value)}、${col('下緣', t.columns.low)}、${col('上緣', t.columns.high)}、${col('依據', t.columns.basis)}、${col('要／已定', t.columns.status)}；算式列 ${t.formulaRows} 列`);
  }
  out.push('', `假設（${l.detect.assumptions.length} 個，標「要」${l.detect.assumptions.filter((a) => a.status === 'needs-decision').length} 個）`);
  for (const a of l.detect.assumptions) {
    const range = a.lowCell && a.highCell ? `下緣 ${a.lowCell}、上緣 ${a.highCell}` : '沒有區間';
    const status = a.status === 'needs-decision' ? `要（${a.statusCell}）` : a.status === 'decided' ? `已定（${a.statusCell}）` : '沒有標記';
    out.push(`- ${a.sheet}!${a.valueCell}「${a.label}」：${a.valueIsFormula ? '公式' : '數字'}，${range}，${status}${a.origin === 'output' ? '，在假設表外' : ''}${a.section ? `，段落「${a.section}」` : ''}`);
  }

  const mapping = d.savedMapping ?? l.detect.outputs;
  const resolved = resolveOutputs(l.workbook, mapping);
  const at = (cell: CellRef | null) => (cell ? `${cell.sheet}!${cell.address}` : '找不到');
  out.push('', `結果格（${d.savedMapping ? '用已存的對照' : '自動偵測'}）`);
  mapping.revenueQuarters.forEach((p, i) => out.push(`- ${p.period} 營收：${at(resolved.revenueQuarters[i].cell)}，${anchorText(p.anchor)}`));
  const single = (name: string, anchor: LabelAnchor | null, cell: CellRef | null) => out.push(`- ${name}：${anchor ? `${at(cell)}，${anchorText(anchor)}` : '找不到'}`);
  single('未來四季營收合計', mapping.revenueTotal, resolved.revenueTotal);
  mapping.eps.forEach((p, i) => out.push(`- ${p.period} EPS：${at(resolved.eps[i].cell)}，${anchorText(p.anchor)}`));
  if (!mapping.eps.length) out.push('- EPS：找不到');
  single('目標價', mapping.targetPrice, resolved.targetPrice);
  single('倍數', mapping.multiple, resolved.multiple);
  single('股數', mapping.shareCount, resolved.shareCount);
  single('淨現金', mapping.netCash, resolved.netCash);
  const others = l.detect.candidates.filter((c) => !c.chosen);
  if (others.length) {
    out.push('', `其他可能的位置（${others.length} 個）`);
    const names = { revenue: '未來四季營收合計', eps: 'EPS', targetPrice: '目標價', multiple: '倍數', shareCount: '股數', netCash: '淨現金' };
    for (const c of others) out.push(`- ${names[c.output]}：${c.address ? `${c.anchor.sheet}!${c.address}` : '找不到'}，${anchorText(c.anchor)}`);
  }

  out.push('', `各方並列表（${l.detect.partyTables.length} 張）`);
  for (const t of l.detect.partyTables) {
    out.push(`- ${t.sheet} 第 ${t.headerRow} 列`);
    for (const p of t.periods) out.push(`  期間「${p.period}」：${p.columns.map((c) => `${c.label} ${c.col}`).join('、')}`);
    out.push(`  列：${t.rows.map((r) => `${r.label}（${r.row}）`).join('、')}`);
  }

  const warnings = [...l.detect.warnings.map((w) => ({ code: w.code as string, message: w.message })), ...(d.savedMapping ? mappingWarnings(l.workbook, d.savedMapping) : [])];
  out.push('', `找不到或不確定的（${warnings.length} 項）`);
  for (const w of warnings) {
    // this one sentence quotes the totals it compares
    const message = w.code === 'output-ambiguous' && w.message.includes('數字不同') ? '未來四季營收合計有多個位置而且數字不同，位置見上面的「其他可能的位置」。' : w.message;
    out.push(`- [${w.code}] ${message}`);
  }

  const c = l.selfCheck;
  out.push('', `自我檢查：${c.state}`);
  out.push(`公式 ${c.formulaCells} 格，檔案存有結果 ${c.compared} 格，沒存結果 ${c.missingCached} 格，重算對不上 ${c.mismatchCount} 格`);
  for (const m of c.mismatches) out.push(`- 對不上：${m.sheet}!${m.address}  =${maskFormula(m.formula)}`);
  for (const u of c.unsupportedFunctions) out.push(`- 不支援的函數 ${u.name}：${u.count} 格，例如 ${u.cells.join('、')}`);
  for (const w of c.loadWarnings) out.push(`- 沒有重算：${w}`);
  return `${out.join('\n')}\n`;
}
