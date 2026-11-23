import { describe, expect, it } from 'vitest';
import { detectWorkbook, normalizeLabel, partyCell, resolveAnchor, resolveOutputs } from './detect';
import { cellAddress } from './shiftFormula';
import type { WorkbookCell, WorkbookData, WorkbookSheet } from './types';

type Entry = number | string | null | { f: string; v?: number | string };

/** A sheet from rows of values; `{ f, v }` is a formula with its stored result (none when `v` is left out). */
function sheet(name: string, rows: Entry[][]): WorkbookSheet {
  const cells: Record<string, WorkbookCell> = {};
  rows.forEach((row, r) =>
    row.forEach((entry, c) => {
      if (entry === null || entry === '') return;
      const address = cellAddress(c + 1, r + 1);
      const value = typeof entry === 'object' ? (entry.v ?? null) : entry;
      const cell: WorkbookCell = { address, row: r + 1, col: c + 1, type: value === null ? 'empty' : typeof value === 'number' ? 'number' : 'string', value };
      if (typeof entry === 'object') Object.assign(cell, { formula: entry.f, hasCached: entry.v !== undefined });
      cells[address] = cell;
    }),
  );
  return { name, hidden: false, cells, merges: [] };
}
const workbook = (...sheets: WorkbookSheet[]): WorkbookData => ({ sheets, sharedStrings: [], definedNames: [], date1904: false });

const MODEL_ROWS: Entry[][] = [
  ['營收模型'],
  [],
  ['一、端點＝台數 × 每台單價'],
  ['項目', '取用值', '下緣', '上緣', '依據', '判斷'],
  ['台數年增率', 0.16, 0.12, 0.2, '最近四季 14%–18%', '要'],
  ['單價年增率', 0.025, 0.01, 0.04, '續約漲價', '已定'],
  ['四季後 ARR', { f: 'B5*B6', v: 4295.9 }, null, null, '基期 × 成長'],
  [],
  ['二、獲利假設'],
  ['項目', '取用值', '下緣', '上緣', '依據', '判斷'],
  ['營業利益率', 0.225, 0.21, 0.24, '最近四季', '要'],
  ['稀釋股數', { f: '主表!G13', v: 1030 }, null, null, '連到主表', '已定'],
  [],
  ['每季結果', '3Q27', '4Q27', '1Q28', '2Q28', '四季合計'],
  ['訂閱營收', { f: 'B7/4', v: 1482 }, { f: 'B15+1', v: 1588 }, { f: 'C15+1', v: 1692 }, { f: 'D15+1', v: 1796 }, { f: 'SUM(B15:E15)', v: 6558 }],
  ['總營收', { f: 'B15+74', v: 1556 }, { f: 'C15+75', v: 1663 }, { f: 'D15+76', v: 1768 }, { f: 'E15+77', v: 1873 }, { f: 'SUM(B16:E16)', v: 6860 }],
  [],
  ['估值', '數值', null, null, '依據'],
  ['股價', 229.44],
  ['EV/Sales 倍數', 25],
  ['淨現金', 5150],
  ['股數', { f: 'B12', v: 1030 }],
  ['目標價', { f: '(B20*F16+B21)/B22', v: 171.5 }],
  ['目前股價對應倍數', { f: '(B19*B22-B21)/F16', v: 33.7 }],
  ['目標價對股價', { f: 'B23/B19-1', v: -0.25 }],
];

const MAIN_ROWS: Entry[][] = [
  ['簡明損益表'],
  [null, '2Q27', '3Q27', null, null, null, null, null, 'FY27'],
  [null, '實際', '我的預估', '賣方共識', 'FUNDA 預估', 'Allen 預估', '公司財測', '財報實際', '我的預估', '賣方共識', '公司財測'],
  ['總營收', 1471.4, { f: '營收模型!B16', v: 1556 }, 1550, 1562, 1570, 1545, null, { f: 'B4+C4', v: 6077 }, 6060, 6040],
  ['調整後 EPS', 0.3, { f: 'C4*0.2/1030', v: 0.32 }, 0.32, 0.33, 0.36, 0.31, null, { f: 'I4*0.2/1025', v: 1.24 }, 1.23, 1.21],
  ['EPS 年增率', null, { f: 'C5/B5-1', v: 0.07 }],
];

describe('normalizeLabel', () => {
  it('folds full-width forms, spaces and case', () => {
    expect(normalizeLabel(' 目標價（美元） ')).toBe('目標價(美元)');
    expect(normalizeLabel('Allen 預估')).toBe('ALLEN預估');
    expect(normalizeLabel('３Ｑ２７')).toBe('3Q27');
  });
});

describe('assumption tables', () => {
  const result = detectWorkbook(workbook(sheet('主表', MAIN_ROWS), sheet('營收模型', MODEL_ROWS)));

  it('finds a table under each repeated header row and groups rows by the title above', () => {
    expect(result.tables.map((t) => [t.sheet, t.headerRow, t.formulaRows])).toEqual([
      ['營收模型', 4, 1],
      ['營收模型', 10, 0],
    ]);
    expect(result.tables[0].columns).toEqual({ label: 'A', value: 'B', low: 'C', high: 'D', basis: 'E', status: 'F' });
    expect(result.assumptions.filter((a) => a.origin === 'table').map((a) => [a.label, a.section, a.valueCell, a.value, a.low, a.high, a.status])).toEqual([
      ['台數年增率', '一、端點＝台數 × 每台單價', 'B5', 0.16, 0.12, 0.2, 'needs-decision'],
      ['單價年增率', '一、端點＝台數 × 每台單價', 'B6', 0.025, 0.01, 0.04, 'decided'],
      ['營業利益率', '二、獲利假設', 'B11', 0.225, 0.21, 0.24, 'needs-decision'],
      ['稀釋股數', '二、獲利假設', 'B12', 1030, null, null, 'decided'],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('a formula with a status is an assumption; one with neither status nor range is a computed line', () => {
    const shares = result.assumptions.find((a) => a.label === '稀釋股數')!;
    expect(shares).toMatchObject({ id: '營收模型!稀釋股數#1', valueIsFormula: true, statusCell: 'F12', lowCell: null, basis: '連到主表' });
    expect(result.assumptions.some((a) => a.label === '四季後 ARR')).toBe(false);
  });

  it('the results and valuation areas under the last table are not read as assumptions', () => {
    expect(result.assumptions.some((a) => ['訂閱營收', '總營收', '股價', '淨現金'].includes(a.label))).toBe(false);
  });

  it('the multiple outside the tables is added as an assumption without a range', () => {
    expect(result.assumptions.filter((a) => a.origin === 'output')).toEqual([
      expect.objectContaining({ id: '營收模型!EV/Sales 倍數#1', valueCell: 'B20', value: 25, low: null, high: null, status: null, section: null }),
    ]);
  });

  it('works with the columns moved and reordered, extra columns in between, and the table pushed down and right', () => {
    const moved = sheet('模型', [
      [],
      [],
      [null, null, '三、Guardian'],
      [null, '判斷', '假設', '單位', '依據／來源', '上緣', '下緣', '取用值（中位數）'],
      [null, '已定', '員工電腦台數', '百萬台', '法說會', null, null, 26],
      [null, '要', '每台單價', '美元', '採購案', 30, 20, 25],
      [null, null, '說明：以上單價尚無官方資料'],
      [null, '要', '滲透率', null, '假設', 0.2, 0.12, 0.163],
    ]);
    const r = detectWorkbook(workbook(moved));
    expect(r.tables[0]).toMatchObject({ headerRow: 4, columns: { label: 'C', value: 'H', low: 'G', high: 'F', basis: 'E', status: 'B' } });
    expect(r.assumptions.map((a) => [a.label, a.valueCell, a.low, a.high, a.status, a.basis, a.section])).toEqual([
      ['員工電腦台數', 'H5', null, null, 'decided', '法說會', '三、Guardian'],
      ['每台單價', 'H6', 20, 30, 'needs-decision', '採購案', '三、Guardian'],
      // a line of text between rows becomes the title of what follows
      ['滲透率', 'H8', 0.12, 0.2, 'needs-decision', '假設', '說明：以上單價尚無官方資料'],
    ]);
  });

  it('three of the four headers are enough; the missing one is named', () => {
    const r = detectWorkbook(workbook(sheet('模型', [['項目', '取用值', '下緣', '上緣'], ['成長率', 0.2, 0.1, 0.3]])));
    expect(r.assumptions).toHaveLength(1);
    expect(r.assumptions[0]).toMatchObject({ basis: null, status: null });
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['header-incomplete', 'no-status-column']));
    expect(r.warnings.find((w) => w.code === 'header-incomplete')!.message).toContain('「依據」');
  });

  it('without 取用值 the table cannot be read, and the warning says so', () => {
    const r = detectWorkbook(workbook(sheet('模型', [['項目', '下緣', '上緣', '依據'], ['成長率', 0.1, 0.3, 'x']])));
    expect(r.assumptions).toEqual([]);
    expect(r.warnings.find((w) => w.code === 'header-incomplete')!.message).toContain('沒有「取用值」');
  });

  it('no table: reports the closest row and which headers it has', () => {
    const r = detectWorkbook(workbook(sheet('說明', [['每個假設有四欄：取用值、下緣、上緣、依據']]), sheet('模型', [['x'], ['項目', '取用值', '備註', '依據'], ['成長率', 0.2]])));
    expect(r.tables).toEqual([]);
    const w = r.warnings.find((x) => x.code === 'no-assumption-table')!;
    expect(w.message).toContain('分頁「模型」第 2 列');
    expect(w.message).toContain('只有「取用值」「依據」');
    expect(detectWorkbook(workbook(sheet('空', [['a', 1]]))).warnings.find((x) => x.code === 'no-assumption-table')!.message).toContain('沒有任何一格');
  });

  it('two assumptions with the same name are told apart by order, with a warning', () => {
    const r = detectWorkbook(
      workbook(sheet('模型', [['項目', '取用值', '下緣', '上緣', '依據'], ['每台單價', 25, 20, 30, 'a'], ['年增率', 0.1, 0.05, 0.15, 'b'], ['每台單價', 35, 25, 45, 'c']])),
    );
    expect(r.assumptions.map((a) => a.id)).toEqual(['模型!每台單價#1', '模型!年增率#1', '模型!每台單價#2']);
    expect(r.warnings.find((w) => w.code === 'duplicate-label')!.message).toContain('「每台單價」');
  });

  it('formulas with no stored result take their value from the engine when one is given', () => {
    const bare = sheet('模型', [['項目', '取用值', '下緣', '上緣', '依據', '判斷'], ['股數', { f: '主表!G13' }, { f: 'B2-4' }, { f: 'B2+4' }, 'x', '已定'], ['成長率', 0.2, 0.1, 0.3, 'y', '要']]);
    expect(detectWorkbook(workbook(bare)).assumptions.map((a) => a.label)).toEqual(['成長率']);
    const values: Record<string, number> = { B2: 1030, C2: 1026, D2: 1034 };
    const withEngine = detectWorkbook(workbook(bare), (ref) => values[ref.address] ?? null);
    expect(withEngine.assumptions.map((a) => [a.label, a.value, a.low, a.high])).toEqual([
      ['股數', 1030, 1026, 1034],
      ['成長率', 0.2, 0.1, 0.3],
    ]);
  });
});

describe('results', () => {
  const wb = workbook(sheet('主表', MAIN_ROWS), sheet('營收模型', MODEL_ROWS));
  const result = detectWorkbook(wb);

  it('finds the four quarters and their total under the quarter headers', () => {
    const resolved = resolveOutputs(wb, result.outputs);
    expect(resolved.revenueQuarters).toEqual(['B16', 'C16', 'D16', 'E16'].map((address, i) => ({ period: ['3Q27', '4Q27', '1Q28', '2Q28'][i], cell: { sheet: '營收模型', address } })));
    expect(resolved.revenueTotal).toEqual({ sheet: '營收模型', address: 'F16' });
    expect(result.outputs.revenueTotal).toEqual({ sheet: '營收模型', labelText: '總營收', occurrence: 1, columnLabel: '四季合計' });
  });

  it('finds the target price by its label and its inputs through its formula', () => {
    const resolved = resolveOutputs(wb, result.outputs);
    expect([resolved.targetPrice, resolved.multiple, resolved.netCash, resolved.shareCount].map((c) => c?.address)).toEqual(['B23', 'B20', 'B21', 'B22']);
    // 目前股價對應倍數 also says 倍數, 目標價對股價 also says 目標價: neither is taken, and nothing is ambiguous
    expect(result.outputs.multiple?.labelText).toBe('EV/Sales 倍數');
    expect(result.candidates.filter((c) => c.output === 'targetPrice').map((c) => [c.address, c.chosen])).toEqual([
      ['B23', true],
      ['B25', false],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('finds 我的預估 EPS for each period of the side-by-side table', () => {
    expect(resolveOutputs(wb, result.outputs).eps).toEqual([
      { period: '3Q27', cell: { sheet: '主表', address: 'C5' } },
      { period: 'FY27', cell: { sheet: '主表', address: 'I5' } },
    ]);
    expect(result.outputs.eps[1].anchor).toEqual({ sheet: '主表', labelText: '調整後 EPS', occurrence: 1, columnLabel: 'FY27', subColumnLabel: '我的預估' });
  });

  it('anchors still point at the right cells after rows and a column are inserted', () => {
    const shifted = [...MODEL_ROWS.slice(0, 4), ['新假設', 1, 0, 2, '剛加的', '要'] as Entry[], ...MODEL_ROWS.slice(4, 13), ['（空一列）'] as Entry[], ...MODEL_ROWS.slice(13)].map((row) => [row[0] ?? null, null, ...row.slice(1)]);
    const moved = workbook(sheet('主表', [['插入的一列'], ...MAIN_ROWS]), sheet('營收模型', shifted));
    const resolved = resolveOutputs(moved, result.outputs);
    expect(resolved.revenueQuarters.map((q) => q.cell?.address)).toEqual(['C18', 'D18', 'E18', 'F18']);
    expect(resolved.revenueTotal?.address).toBe('G18');
    expect([resolved.targetPrice, resolved.multiple, resolved.netCash, resolved.shareCount].map((c) => c?.address)).toEqual(['C25', 'C22', 'C23', 'C24']);
    expect(resolved.eps.map((e) => e.cell?.address)).toEqual(['C6', 'I6']);
    // and the assumptions keep their ids
    const again = detectWorkbook(moved);
    expect(again.assumptions.find((a) => a.id === '營收模型!營業利益率#1')).toMatchObject({ valueCell: 'C12', value: 0.225 });
  });

  it('an anchor whose label or header is gone resolves to null', () => {
    expect(resolveAnchor(wb, { sheet: '營收模型', labelText: '目標價格', occurrence: 1 })).toBeNull();
    expect(resolveAnchor(wb, { sheet: '營收模型', labelText: '目標價', occurrence: 2 })).toBeNull();
    expect(resolveAnchor(wb, { sheet: '營收模型', labelText: '總營收', occurrence: 1, columnLabel: '3Q28' })).toBeNull();
    expect(resolveAnchor(wb, { sheet: '主表', labelText: '調整後 EPS', occurrence: 1, columnLabel: 'FY27', subColumnLabel: 'FUNDA 預估' })).toBeNull();
    expect(resolveAnchor(wb, { sheet: '不存在', labelText: '目標價', occurrence: 1 })).toBeNull();
    expect(resolveAnchor(wb, null)).toBeNull();
  });

  it('reports every result it cannot find, naming the label it looked for', () => {
    const r = detectWorkbook(workbook(sheet('模型', [['項目', '取用值', '下緣', '上緣', '依據'], ['成長率', 0.2, 0.1, 0.3, 'x']])));
    expect(r.outputs).toEqual({ revenueQuarters: [], revenueTotal: null, eps: [], targetPrice: null, multiple: null, shareCount: null, netCash: null });
    const messages = r.warnings.filter((w) => w.code === 'output-missing').map((w) => w.message);
    expect(messages).toHaveLength(5);
    for (const word of ['「目標價」', '「倍數」', '「股數」', '「淨現金」', '「總營收」']) expect(messages.some((m) => m.includes(word))).toBe(true);
    expect(r.warnings.some((w) => w.code === 'no-party-table')).toBe(true);
  });

  it('two equally good target prices on one sheet: the first is used and the other listed', () => {
    const r = detectWorkbook(workbook(sheet('估值', [['目標價', 171.5], ['倍數', 25], ['目標價', 205.8]])));
    expect(r.outputs.targetPrice).toEqual({ sheet: '估值', labelText: '目標價', occurrence: 1 });
    expect(r.candidates.filter((c) => c.output === 'targetPrice').map((c) => [c.anchor.occurrence, c.cached, c.chosen])).toEqual([
      [1, 171.5, true],
      [2, 205.8, false],
    ]);
    expect(r.warnings.find((w) => w.code === 'output-ambiguous')!.message).toContain('第 3 列');
    // no formula to follow: the multiple is found by its label on the same sheet
    expect(r.outputs.multiple).toEqual({ sheet: '估值', labelText: '倍數', occurrence: 1 });
  });

  it('two revenue totals that disagree are reported with both numbers', () => {
    const other = sheet('未來四季營收', [[null, '3Q27', '4Q27', '1Q28', '2Q28', '四季合計'], ['總營收', 1553, 1643, 1744, 1851, 6791]]);
    const r = detectWorkbook(workbook(sheet('主表', MAIN_ROWS), other, sheet('營收模型', MODEL_ROWS)));
    // the sheet that holds the assumption tables wins
    expect(r.outputs.revenueTotal?.sheet).toBe('營收模型');
    expect(r.candidates.filter((c) => c.output === 'revenue').map((c) => [c.anchor.sheet, c.cached, c.chosen])).toEqual([
      ['營收模型', 6860, true],
      ['未來四季營收', 6791, false],
    ]);
    expect(r.warnings.find((w) => w.code === 'output-ambiguous')!.message).toContain('6791');
  });
});

describe('side-by-side table', () => {
  const result = detectWorkbook(workbook(sheet('主表', MAIN_ROWS), sheet('營收模型', MODEL_ROWS)));

  it('groups the party columns under each period', () => {
    expect(result.partyTables).toHaveLength(1);
    const table = result.partyTables[0];
    expect(table.periods.map((p) => [p.period, p.columns.map((c) => `${c.party}:${c.col}`).join(' ')])).toEqual([
      ['3Q27', 'mine:C consensus:D funda:E allen:F guidance:G actual:H'],
      ['FY27', 'mine:I consensus:J guidance:K'],
    ]);
    expect(table.rows).toEqual([
      { label: '總營收', row: 4 },
      { label: '調整後 EPS', row: 5 },
      { label: 'EPS 年增率', row: 6 },
    ]);
  });

  it('gives the cell of a row, period and party', () => {
    const table = result.partyTables[0];
    expect(partyCell(table, '調整後 EPS', '3Q27', 'allen')).toEqual({ sheet: '主表', address: 'F5' });
    expect(partyCell(table, '總營收', 'FY27', 'guidance')).toEqual({ sheet: '主表', address: 'K4' });
    expect(partyCell(table, '總營收', 'FY27', 'funda')).toBeNull();
  });
});
