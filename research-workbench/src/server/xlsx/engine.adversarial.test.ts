import { describe, expect, it } from 'vitest';
import { computeSensitivity } from '../../domain/workbook/sensitivity';
import { parseAddress } from '../../domain/workbook/shiftFormula';
import type { CellValue, WorkbookCell, WorkbookData } from '../../domain/workbook/types';
import { createEngine } from './engine';

/** Inputs chosen to break the engine: each formula carries the result Excel stores for it. */
type C = { v?: CellValue; f?: string; t?: WorkbookCell['type']; arrayRef?: string };
function wb(sheets: Record<string, Record<string, C>>, more: Partial<WorkbookData> = {}): WorkbookData {
  return {
    sharedStrings: [],
    definedNames: [],
    date1904: false,
    ...more,
    sheets: Object.entries(sheets).map(([name, cells]) => ({
      name,
      hidden: false,
      merges: [],
      cells: Object.fromEntries(
        Object.entries(cells).map(([address, c]) => {
          const { row, col } = parseAddress(address);
          const value = c.v ?? null;
          const type = c.t ?? (value === null ? 'empty' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string');
          const cell: WorkbookCell = { address, row, col, type, value };
          if (c.f !== undefined) Object.assign(cell, { formula: c.f, hasCached: type !== 'empty' });
          if (c.arrayRef) cell.arrayRef = c.arrayRef;
          return [address, cell];
        }),
      ),
    })),
  };
}
const err = (v: string): C => ({ v, t: 'error' });
const check = (data: WorkbookData) => {
  const engine = createEngine(data);
  const report = engine.selfCheck();
  engine.dispose();
  return report;
};
const bad = (data: WorkbookData) => check(data).mismatches.map((m) => `${m.address}: stored ${m.cached}, computed ${m.computed}`);
const at = (address: string, sheet = 'S') => ({ sheet, address });

describe('the engine against what Excel stores', () => {
  it('reads an empty cell as Excel does: 0 in arithmetic and when referenced, "" in text', () => {
    expect(
      bad(
        wb({
          S: {
            B1: { f: 'A1', v: 0 },
            B2: { f: 'A1+1', v: 1 },
            B3: { f: 'A1&"x"', v: 'x' },
            B4: { f: 'IF(A1="","e","n")', v: 'e' },
            B5: { f: 'SUM(A1:A3)', v: 0 },
            B6: { f: 'AVERAGE(A1:A3)', ...err('#DIV/0!') },
            B7: { f: 'IF(1>0,,5)', v: 0 },
            B8: { f: 'ISBLANK(A1)', v: true },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('knows TRUE and FALSE written without brackets, in any case', () => {
    expect(
      bad(
        wb({
          S: {
            A1: { v: 1 },
            A2: { v: 2 },
            A3: { v: 3 },
            B1: { f: 'VLOOKUP(2,A1:A3,1,FALSE)', v: 2 },
            B2: { f: '_xlfn.IFS(A1=2,"a",TRUE,"b")', v: 'b' },
            B3: { f: 'IF(true,1,2)', v: 1 },
            B4: { f: 'TRUE', v: true },
            B5: { f: 'FALSE()', v: false },
            B6: { f: '_xlfn.TEXTJOIN(",",TRUE,A1:A3)', v: '1,2,3' },
            B7: { f: 'AND(TRUE,A1=1)*1', v: 1 },
            B8: { f: '"TRUE"&"x"', v: 'TRUEx' },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('multiplies ranges cell by cell inside SUMPRODUCT and SUM', () => {
    expect(
      bad(
        wb({
          S: {
            A1: { v: 1 },
            A2: { v: 2 },
            A3: { v: 3 },
            B1: { f: 'SUMPRODUCT(A1:A3*A1:A3)', v: 14 },
            B2: { f: 'SUMPRODUCT((A1:A3>1)*A1:A3)', v: 5 },
            B3: { f: 'SUMPRODUCT(A1:A3,A1:A3)', v: 14 },
            B4: { f: 'SUM(A1:A3*2)', v: 12 },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('recalculates an array formula over its whole range, and checks the cells it fills', () => {
    const data = wb({
      S: {
        A1: { v: 1 },
        A2: { v: 2 },
        A3: { v: 3 },
        B1: { f: 'A1:A3*10', v: 10, arrayRef: 'B1:B3' },
        B2: { v: 20 },
        B3: { v: 30 },
        C1: { f: 'SUM(B1:B3)', v: 60 },
        D1: { f: 'SUM(A1:A3*A1:A3)', v: 14, arrayRef: 'D1' },
      },
    });
    const engine = createEngine(data);
    expect(engine.selfCheck()).toMatchObject({ state: 'verified', formulaCells: 5, compared: 5 });
    // B2 and B3 are results, not constants: they follow the trial value
    engine.set([{ ...at('A2'), value: 5 }]);
    expect(engine.get([at('B2'), at('C1'), at('D1')])).toEqual([50, 90, 35]);
    engine.set([]);
    expect(engine.get([at('B2'), at('C1')])).toEqual([20, 60]);

    // a stale stored result in the filled range is a mismatch, not silently kept
    data.sheets[0].cells.B3.value = 31;
    expect(bad(data)).toEqual(['B3: stored 31, computed 30']);
  });

  it('percent literals, fractions and text that looks like a number', () => {
    expect(
      bad(
        wb({
          S: {
            A1: { v: 0.18 },
            A2: { v: '18%' },
            A3: { v: '0050' },
            A4: { v: '=SUM(1)' },
            A5: { v: "'quoted" },
            B1: { f: 'A1*100', v: 18 },
            B2: { f: '5%+A1', v: 0.23 },
            B3: { f: '1000*(1+18%)', v: 1180 },
            B4: { f: 'ISNUMBER(A2)', v: false },
            B5: { f: 'A3&""', v: '0050' },
            B6: { f: 'A4', v: '=SUM(1)' },
            B7: { f: 'A5', v: "'quoted" },
            B8: { f: 'SUM(A1:A3)', v: 0.18 },
            B9: { f: '-A1^2', v: 0.0324 },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('dates: serial numbers, text dates, and the 1904 date system', () => {
    expect(
      bad(
        wb({
          S: {
            A1: { v: 46000 },
            B1: { f: 'DATE(2026,1,31)', v: 46053 },
            B2: { f: 'YEAR(A1)', v: 2025 },
            B3: { f: 'EDATE(A1,3)', v: 46090 },
            B4: { f: 'EOMONTH(A1,0)', v: 46022 },
            B5: { f: 'DATEVALUE("2026/1/31")', v: 46053 },
            B6: { f: '"2026-03-01"-"2026/1/1"', v: 59 },
            B7: { f: 'TEXT(A1,"yyyy-mm-dd")', v: '2025-12-09' },
          },
        }),
      ),
    ).toEqual([]);
    expect(bad(wb({ S: { A1: { v: 44591 }, B1: { f: 'DATE(2026,1,31)', v: 44591 }, B2: { f: 'YEAR(A1)', v: 2026 } } }, { date1904: true }))).toEqual([]);
  });

  it('errors: stored errors agree with computed ones, and a wrong stored number does not', () => {
    expect(
      bad(
        wb({
          S: {
            A1: err('#N/A'),
            B1: { f: '1/0', ...err('#DIV/0!') },
            B2: { f: 'IFERROR(A1,7)', v: 7 },
            B3: { f: 'ISNA(A1)', v: true },
            B4: { f: 'A1+1', ...err('#N/A') },
            B5: { f: 'IFERROR(1/0,"")', v: '', t: 'string' },
            B6: { f: 'Missing!A1', ...err('#REF!') },
          },
        }),
      ),
    ).toEqual([]);
    expect(bad(wb({ S: { B1: { f: '1/0', v: 0 }, B2: { f: '1+1', ...err('#DIV/0!') }, B3: { f: '"5"', v: 5 } } }))).toEqual([
      'B1: stored 0, computed #DIV/0!',
      'B2: stored #DIV/0!, computed 2',
      'B3: stored 5, computed 5',
    ]);
  });

  it('a circular reference is reported, never verified', () => {
    const report = check(wb({ S: { A1: { f: 'B1+1', v: 5 }, B1: { f: 'A1+1', v: 6 } } }));
    expect(report).toMatchObject({ state: 'mismatch', mismatchCount: 2 });
  });

  it('never says verified when nothing, or only stale values, could be compared', () => {
    expect(check(wb({ S: { A1: { v: 1 }, B1: { f: 'A1*2' }, B2: { f: 'A1*3' } } }))).toMatchObject({ state: 'no-cached-values', compared: 0, missingCached: 2 });
    // one stored result out of three: what was compared agrees, and the report says two were not
    expect(check(wb({ S: { A1: { v: 1 }, B1: { f: 'A1*2', v: 2 }, B2: { f: 'A1*3' }, B3: { f: 'A1*4' } } }))).toMatchObject({ state: 'verified', compared: 1, missingCached: 2 });
    // A1 was edited after the last save in Excel: the stored 2 is stale
    expect(check(wb({ S: { A1: { v: 5 }, B1: { f: 'A1*2', v: 2 } } }))).toMatchObject({ state: 'mismatch', mismatchCount: 1 });
    // within rounding, not within a real difference
    expect(check(wb({ S: { B1: { f: '1/3', v: 0.3333333333 }, B2: { f: '0.1+0.2-0.3', v: 5.5e-17 } } })).state).toBe('verified');
    expect(check(wb({ S: { B1: { f: '1/3', v: 0.33333 } } })).state).toBe('mismatch');
    expect(check(wb({ S: { B1: { f: '1000000+2', v: 1000000 } } })).state).toBe('mismatch');
  });

  it('names the functions it lacks, and the cell is a mismatch', () => {
    const report = check(wb({ S: { A1: { v: 1 }, B1: { f: 'AVERAGEIFS(A1:A3,A1:A3,">0")', v: 1 }, B2: { f: '_xlfn.LET(x,1,x+1)', v: 2 }, B3: { f: 'INDIRECT("A1")', v: 1 } } }));
    expect(report.state).toBe('mismatch');
    expect(report.unsupportedFunctions.map((u) => u.name)).toEqual(['AVERAGEIFS', 'INDIRECT', 'LET']);
  });

  it('sheet names with quotes, spaces, digits and dots; whole rows and columns', () => {
    expect(
      bad(
        wb({
          "it's 1": { A1: { v: 2 } },
          '營收 模型': { A1: { v: 3 } },
          '2027E': { A1: { v: 4 } },
          'S.x': { A1: { v: 5 } },
          S: {
            A1: { v: 1 },
            A2: { v: 2 },
            B1: { f: "'it''s 1'!A1+'營收 模型'!$A$1+2027E!A1+S.x!A1", v: 14 },
            B2: { f: "SUM('營收 模型'!A1:A2)", v: 3 },
            B3: { f: 'SUM(A:A)', v: 3 },
            B4: { f: 'SUM($2:$2)-B4', ...err('#CYCLE!') },
            B5: { f: "SUM('2027E'!1:1)", v: 4 },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('defined names: CJK, ranges, constants, nested, sheet-local and behind a sheet prefix', () => {
    const data = wb(
      {
        S: {
          A1: { v: 2 },
          A2: { v: 3 },
          B1: { f: '成長率*2', v: 4 },
          B2: { f: 'SUM(rng)', v: 5 },
          B3: { f: 'tax+1', v: 1.2 },
          B4: { f: 'S!成長率+1', v: 3 },
          B5: { f: 'nest', v: 4 },
          B6: { f: 'unknownName', ...err('#NAME?') },
          B7: { f: 'local', v: 3 },
        },
        T: { A1: { v: 100 }, B1: { f: 'local', v: 100 }, B2: { f: 'S!local', v: 3 } },
      },
      {
        definedNames: [
          { name: '成長率', formula: 'S!$A$1' },
          { name: 'rng', formula: 'S!$A$1:$A$2' },
          { name: 'tax', formula: '0.2' },
          { name: 'nest', formula: '成長率*2' },
          { name: 'local', formula: 'S!$A$2' },
          { name: 'local', formula: 'T!$A$1', sheet: 'T' },
        ],
      },
    );
    // S!local read from sheet T means the workbook's (or S's) name: the engine resolves it from T, so it is reported
    expect(bad(data)).toEqual(['B2: stored 3, computed 100']);
  });

  it('one stray cell at the bottom and one at the far right of the sheet load without filling the rectangle between', () => {
    expect(bad(wb({ S: { A1048576: { v: 2 }, XFD1: { v: 3 }, B1: { f: 'A1048576+XFD1', v: 5 }, B2: { f: 'SUM(A:A)', v: 2 } } }))).toEqual([]);
  });
});

describe('trial values', () => {
  const model = () =>
    wb({
      S: {
        A1: { v: 10 },
        A2: { v: 0.2 },
        B1: { f: 'A1*2', v: 20 },
        C1: { f: 'B1*(1+A2)', v: 24 },
      },
    });

  it('an override on a formula cell replaces the formula, and dropping it brings the formula back', () => {
    const engine = createEngine(model());
    engine.set([{ ...at('B1'), value: 5 }]);
    expect(engine.get([at('C1')])).toEqual([6]);
    // B1 is not named again: it follows A1 once more
    engine.set([{ ...at('A1'), value: 1 }]);
    expect(engine.get([at('B1'), at('C1')])).toEqual([2, 2.4]);
    // a cell the file does not have goes back to empty
    engine.set([{ ...at('Z9'), value: 1 }]);
    engine.set([]);
    expect(engine.get([at('A1'), at('B1'), at('C1'), at('Z9')])).toEqual([10, 20, 24, null]);
    expect(engine.selfCheck().state).toBe('verified');
  });

  it('sensitivity moves one assumption at a time from the same base, and leaves the base in place', () => {
    const engine = createEngine(model());
    const assumptions = [
      { id: 'a', label: 'a', section: null, sheet: 'S', valueCell: 'A1', low: 5, high: 20 },
      { id: 'g', label: 'g', section: null, sheet: 'S', valueCell: 'A2', low: 0, high: 0.5 },
      // B1 is a formula: moving it must not leak into the rows after it
      { id: 'b', label: 'b', section: null, sheet: 'S', valueCell: 'B1', low: 10, high: 40 },
    ];
    const outputs = { targetPrice: at('C1'), revenue: at('B1'), eps: null };
    const forward = computeSensitivity(engine, { assumptions, outputs });
    const backward = computeSensitivity(engine, { assumptions: [...assumptions].reverse(), outputs });
    const byId = (rows: typeof forward.rows) => Object.fromEntries(rows.map((r) => [r.id, [r.targetPrice.atLow, r.targetPrice.atHigh, r.revenue.atLow, r.revenue.atHigh]]));
    expect(byId(forward.rows)).toEqual({ a: [12, 48, 10, 40], g: [20, 30, 20, 20], b: [12, 48, 10, 40] });
    expect(byId(backward.rows)).toEqual(byId(forward.rows));
    expect(forward.base).toEqual({ targetPrice: 24, revenue: 20, eps: null });
    expect(engine.get([at('C1')])).toEqual([24]);

    // with a trial value on A2, every row keeps it except A2's own
    const base = [{ ...at('A2'), value: 0.5 }];
    const trial = computeSensitivity(engine, { assumptions, outputs, baseOverrides: base });
    expect(trial.base.targetPrice).toBe(30);
    expect(byId(trial.rows)).toEqual({ a: [15, 60, 10, 40], g: [20, 30, 20, 20], b: [15, 60, 10, 40] });
    expect(engine.get([at('A2'), at('C1')])).toEqual([0.5, 30]);
  });
});
