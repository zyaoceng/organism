/**
 * Layouts the real file may have that the fixture does not: detection either reads them or says
 * exactly what it could not read.
 */
import { describe, expect, it } from 'vitest';
import { detectWorkbook, resolveAnchor, resolveOutputs } from './detect';
import { cellAddress } from './shiftFormula';
import type { DetectResult, WorkbookCell, WorkbookData, WorkbookSheet } from './types';

type Entry = number | string | null | { f: string; v?: number | string };

function sheet(name: string, rows: Entry[][], merges: string[] = []): WorkbookSheet {
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
  return { name, hidden: false, cells, merges };
}
const detect = (rows: Entry[][], merges: string[] = []): DetectResult => detectWorkbook({ sheets: [sheet('M', rows, merges)], sharedStrings: [], definedNames: [], date1904: false });
const brief = (d: DetectResult) => d.assumptions.map((a) => [a.label, a.valueCell, a.value, a.low, a.high, a.basis, a.status]);
const tableWarnings = (d: DetectResult) => d.warnings.filter((w) => !['output-missing', 'no-party-table'].includes(w.code));
const HEAD = ['項目', '取用值', '下緣', '上緣', '依據', '判斷'];

describe('要／已定 written with a note', () => {
  it('reads the status whatever follows the word, and never from a word that only starts with 要', () => {
    const d = detect([
      HEAD,
      ['a', 1, 0, 2, 'x', '要（等法說）'],
      ['b', 1, 0, 2, 'x', '要：看 ARR'],
      ['c', 1, 0, 2, 'x', '已定 (10/3)'],
      ['d', 1, 0, 2, 'x', ' 要 '],
      ['e', 1, 0, 2, 'x', '要判斷？'],
      ['f', 1, 0, 2, 'x', '已定，照財測'],
      ['g', 1, 0, 2, 'x', '要 等下季財報'],
      ['h', 1, 0, 2, 'x', '已 決定'],
      ['i', 1, 0, 2, '要素分析', '要素'],
      ['j', 1, 0, 2, 'x', '已經'],
      ['k', 1, 0, 2, 'x', '不要'],
    ]);
    expect(d.assumptions.map((a) => a.status)).toEqual(['needs-decision', 'needs-decision', 'decided', 'needs-decision', 'needs-decision', 'decided', 'needs-decision', 'decided', null, null, null]);
    expect(d.tables[0].columns.status).toBe('F');
    expect(d.assumptions[0].statusCell).toBe('F2');
    expect(tableWarnings(d)).toEqual([]);
  });

  it('a column where every 要 carries a note is still the status column', () => {
    const d = detect([HEAD, ['a', 1, 0, 2, 'x', '要（Q3 再看）'], ['b', 1, 0, 2, 'x', '已定（法說）']]);
    expect(d.assumptions.map((a) => a.status)).toEqual(['needs-decision', 'decided']);
    expect(d.warnings.some((w) => w.code === 'no-status-column')).toBe(false);
  });
});

describe('headers', () => {
  it('full-width characters, stray spaces and bracketed remarks in the header cells', () => {
    const d = detect([['項　目', ' 取 用 值 ', '下緣（保守）', '上緣 (樂觀)', '依　據', '要／已定'], ['成長率', 0.1, 0.05, 0.2, 'x', '要']]);
    expect(brief(d)).toEqual([['成長率', 'B2', 0.1, 0.05, 0.2, 'x', 'needs-decision']]);
    expect(tableWarnings(d)).toEqual([]);
  });

  it('下緣／上緣 one row below, under a merged 區間', () => {
    const d = detect(
      [['一、成長'], ['項目', '取用值', '區間', null, '依據', '狀態'], [null, null, '下緣', '上緣'], ['成長率', 0.1, 0.05, 0.2, 'x', '要'], ['單價', 5, 4, 6, 'y', '已定']],
      ['C2:D2', 'A2:A3', 'B2:B3'],
    );
    expect(brief(d)).toEqual([
      ['成長率', 'B4', 0.1, 0.05, 0.2, 'x', 'needs-decision'],
      ['單價', 'B5', 5, 4, 6, 'y', 'decided'],
    ]);
    expect(d.assumptions[0].section).toBe('一、成長');
    expect(d.tables).toHaveLength(1);
    expect(tableWarnings(d)).toEqual([]);
  });

  it('a complete header row is not merged with a stray header word under it', () => {
    const d = detect([HEAD, ['依據', 3, 1, 5, 'x', '要']]);
    expect(d.tables.map((t) => t.headerRow)).toEqual([1]);
    expect(brief(d)).toEqual([['依據', 'B2', 3, 1, 5, 'x', 'needs-decision']]);
  });

  it('synonyms it does not know: says which row came closest and which words it has', () => {
    const d = detect([['項目', '取用', '低標', '高標', '依據', '判斷'], ['a', 0.1, 0.05, 0.2, 'x', '要']]);
    expect(d.assumptions).toEqual([]);
    expect(d.warnings[0]).toMatchObject({ code: 'no-assumption-table' });
    expect(d.warnings[0].message).toContain('分頁「M」第 1 列，只有「依據」');
  });

  it('two tables side by side: the left one is read and the right one is reported, not silently lost', () => {
    const d = detect([
      [...HEAD, null, ...HEAD],
      ['a', 0.1, 0.05, 0.2, 'x', '要', null, 'k', 5, 1, 9, 'q', '已定'],
    ]);
    expect(brief(d)).toEqual([['a', 'B2', 0.1, 0.05, 0.2, 'x', 'needs-decision']]);
    const w = d.warnings.find((x) => x.code === 'table-side-by-side')!;
    expect(w.message).toContain('B1、I1');
  });

  it('two tables one under the other with different column orders', () => {
    const d = detect([
      HEAD,
      ['a', 0.1, 0.05, 0.2, 'x', '要'],
      [],
      ['判斷', '項目', '上緣', '下緣', '備註', '取用值'],
      ['已定', 'b', 9, 1, '不是依據', 5],
    ]);
    expect(brief(d)).toEqual([
      ['a', 'B2', 0.1, 0.05, 0.2, 'x', 'needs-decision'],
      ['b', 'F5', 5, 1, 9, null, 'decided'],
    ]);
    expect(tableWarnings(d).map((w) => w.code)).toEqual(['header-incomplete']);
    expect(tableWarnings(d)[0].message).toContain('第 4 列的假設表沒有「依據」');
  });

  it('the names in a column to the right of the figures', () => {
    const d = detect([['取用值', '下緣', '上緣', '依據', '項目', '判斷'], [0.1, 0.05, 0.2, 'x', '成長率', '要'], [5, 4, 6, 'y', '單價', '已定']]);
    expect(brief(d)).toEqual([
      ['成長率', 'A2', 0.1, 0.05, 0.2, 'x', 'needs-decision'],
      ['單價', 'A3', 5, 4, 6, 'y', 'decided'],
    ]);
  });
});

describe('rows that cannot be read are named', () => {
  it('figures typed as text', () => {
    const d = detect([HEAD, ['a', '18%', '12%', '20%', 'x', '要'], ['b', 0.2, 0.1, 0.3, 'y', '要'], ['c', '１，２３４', null, null, 'z', '已定']]);
    // the text row does not end the table: b is still read
    expect(brief(d)).toEqual([['b', 'B3', 0.2, 0.1, 0.3, 'y', 'needs-decision']]);
    const w = d.warnings.find((x) => x.code === 'value-not-number')!;
    expect(w.message).toContain('B2、B4');
    expect(w.message).toContain('「18%」');
  });

  it('a header with nothing under it', () => {
    const d = detect([HEAD, ['a', null, null, null, 'x', '要'], ['b']]);
    expect(d.assumptions).toEqual([]);
    const w = d.warnings.find((x) => x.code === 'table-empty')!;
    expect(w.message).toContain('第 1 列有假設表的表頭');
    expect(w.message).toContain('B 欄（取用值）');
  });

  it('a value with no name on its row', () => {
    const d = detect([HEAD, ['a', 1, 0, 2, 'x', '要'], [null, 7, 5, 9, null, '要']]);
    expect(d.assumptions.map((a) => a.label)).toEqual(['a']);
    expect(d.warnings.find((x) => x.code === 'table-empty')!.message).toContain('B3');
  });

  it('a results block under the table still ends it', () => {
    const d = detect([HEAD, ['a', 1, 0, 2, 'x', '要'], ['每季結果', '3Q27', '4Q27', '1Q28', '2Q28', '四季合計'], ['總營收', 10, 11, 12, 13, { f: 'SUM(B4:E4)', v: 46 }]]);
    expect(d.assumptions.map((a) => a.label)).toEqual(['a']);
    expect(d.outputs.revenueTotal).toMatchObject({ labelText: '總營收', columnLabel: '四季合計' });
  });
});

describe('rows an AI inserted', () => {
  const base: Entry[][] = [
    HEAD,
    ['成長率', 0.1, 0.05, 0.2, 'x', '要'],
    ['小計', { f: 'B2*2', v: 0.2 }],
    ['成長率', 0.3, 0.05, 0.4, 'y', '已定'],
    ['EV/Sales 倍數', 25],
    ['淨現金', 10],
    ['股數', 5],
    ['目標價', { f: '(B5*B3+B6)/B7', v: 3 }],
  ];

  it('ids and saved anchors keep pointing at the same assumption and result', () => {
    const before = detect(base);
    const moved: Entry[][] = [
      ['AI 加的標題'],
      [],
      base[0],
      ['（AI 註：成長率 見下方說明）'],
      ['新假設', 9, 1, 10, 'ai', '要'],
      base[1],
      base[2],
      ['另一個新假設', 2, 1, 3, 'ai', '已定'],
      base[3],
      [],
      ['股價', 99],
      ...base.slice(4).map((row) => row.map((e) => (typeof e === 'object' && e ? { ...e, f: '(B12*B7+B13)/B14' } : e))),
    ];
    const wb: WorkbookData = { sheets: [sheet('M', moved)], sharedStrings: [], definedNames: [], date1904: false };
    const after = detectWorkbook(wb);
    const at = (d: DetectResult, id: string) => d.assumptions.find((a) => a.id === id);
    // plain numbers under the header are assumptions too: nothing separates them from the table
    expect(before.assumptions.map((a) => a.id)).toEqual(['M!成長率#1', 'M!成長率#2', 'M!EV/Sales 倍數#1', 'M!淨現金#1', 'M!股數#1']);
    expect(at(after, 'M!成長率#1')).toMatchObject({ valueCell: 'B6', value: 0.1, status: 'needs-decision' });
    expect(at(after, 'M!成長率#2')).toMatchObject({ valueCell: 'B9', value: 0.3, status: 'decided' });
    expect(at(after, 'M!EV/Sales 倍數#1')).toMatchObject({ valueCell: 'B12', value: 25 });
    // the mapping saved before the insert, resolved against the file after it
    expect(resolveOutputs(wb, before.outputs)).toMatchObject({ targetPrice: { address: 'B15' }, multiple: { address: 'B12' }, netCash: { address: 'B13' }, shareCount: { address: 'B14' } });
    expect(after.warnings.filter((w) => w.code === 'duplicate-label')).toHaveLength(1);
  });

  it('a second row with the same name inserted above shifts the order, and the warning says so', () => {
    const wb: WorkbookData = { sheets: [sheet('M', [base[0], ['成長率', 0.9, 0.8, 1, 'ai', '要'], ...base.slice(1)])], sharedStrings: [], definedNames: [], date1904: false };
    const after = detectWorkbook(wb);
    expect(after.assumptions.filter((a) => a.label === '成長率').map((a) => a.id)).toEqual(['M!成長率#1', 'M!成長率#2', 'M!成長率#3']);
    expect(after.warnings.find((w) => w.code === 'duplicate-label')!.message).toContain('「成長率」');
  });

  it('an anchor on a sheet that was renamed or deleted resolves to nothing instead of another sheet', () => {
    const before = detect(base);
    const wb: WorkbookData = { sheets: [sheet('M (2)', base)], sharedStrings: [], definedNames: [], date1904: false };
    expect(resolveAnchor(wb, before.outputs.targetPrice)).toBeNull();
  });
});

describe('hostile content', () => {
  it('labels that look like object keys or HTML are plain text', () => {
    const d = detect([HEAD, ['__proto__', 1, 0, 2, 'x', '要'], ['constructor', 2, 1, 3, '<img src=x onerror=alert(1)>', '已定'], ['toString', 3, 1, 4, 'x', '要']]);
    expect(d.assumptions.map((a) => a.id)).toEqual(['M!__proto__#1', 'M!constructor#1', 'M!toString#1']);
    expect(d.assumptions[1].basis).toBe('<img src=x onerror=alert(1)>');
  });

  it('a sheet of nothing but header words does not blow up', () => {
    const rows: Entry[][] = Array.from({ length: 300 }, () => [...HEAD, ...HEAD, ...HEAD]);
    const d = detect(rows);
    expect(d.assumptions).toEqual([]);
    expect(d.tables).toHaveLength(300);
  });
});
