import { describe, expect, it } from 'vitest';
import { cellAddress, colToNumber, formulaFunctions, formulaRefs, hasThreeDReference, normalizeFormula, numberToCol, parseAddress, shiftFormula } from './shiftFormula';

describe('addresses', () => {
  it('column letters and numbers convert both ways', () => {
    for (const [letters, n] of [['A', 1], ['Z', 26], ['AA', 27], ['AF', 32], ['XFD', 16384]] as const) {
      expect(colToNumber(letters)).toBe(n);
      expect(numberToCol(n)).toBe(letters);
    }
    expect(parseAddress('$AB$12')).toEqual({ col: 28, row: 12 });
    expect(cellAddress(28, 12)).toBe('AB12');
    expect(() => parseAddress('12')).toThrow();
  });
});

describe('shiftFormula', () => {
  it('moves relative references and leaves $ ones', () => {
    expect(shiftFormula('A1*$B$1+B$2-$C3', 2, 1)).toBe('B3*$B$1+C$2-$C5');
    expect(shiftFormula('SUM(B$2:B2)', 3, 0)).toBe('SUM(B$2:B5)');
  });

  it('leaves text, function names, sheet names and numbers alone', () => {
    expect(shiftFormula('IF(A1>0,"A1 is ""big""",LOG10(A1))', 1, 0)).toBe('IF(A2>0,"A1 is ""big""",LOG10(A2))');
    expect(shiftFormula("'CRWD 簡明損益表'!D6*(1+0.258)", 0, 1)).toBe("'CRWD 簡明損益表'!E6*(1+0.258)");
    expect(shiftFormula('營收模型!B5+Q3!A1+1.5E+3', 1, 1)).toBe('營收模型!C6+Q3!B2+1.5E+3');
    expect(shiftFormula("'It''s'!A1", 1, 0)).toBe("'It''s'!A2");
  });

  it('whole columns and rows of a range move together', () => {
    expect(shiftFormula('SUM(A:B)+SUM($A:C)+SUM(2:3)', 1, 2)).toBe('SUM(C:D)+SUM($A:E)+SUM(3:4)');
  });

  it('a reference pushed off the sheet becomes #REF!', () => {
    expect(shiftFormula('A1+B2', -1, 0)).toBe('#REF!+B1');
    expect(shiftFormula('#REF!+A1', 1, 0)).toBe('#REF!+A2');
  });
});

describe('normalizeFormula', () => {
  it('quotes every sheet name, bare CJK ones included', () => {
    expect(normalizeFormula('未來四季營收!C6+Sheet1!A1')).toBe("'未來四季營收'!C6+'Sheet1'!A1");
    expect(normalizeFormula("B67/'CRWD 簡明損益表'!D6-1")).toBe("B67/'CRWD 簡明損益表'!D6-1");
    expect(normalizeFormula('IF(A1="營收模型!B5",#N/A,1)')).toBe('IF(A1="營收模型!B5",#N/A,1)');
  });

  it('drops the prefixes Excel stores on newer functions', () => {
    expect(normalizeFormula('_xlfn.IFS(A1>1,1,TRUE,0)+_xlfn._xlws.FILTER(A1:A3,B1:B3)')).toBe('IFS(A1>1,1,TRUE(),0)+FILTER(A1:A3,B1:B3)');
  });

  it('writes TRUE and FALSE as the functions the engine has', () => {
    expect(normalizeFormula('VLOOKUP(A1,B:C,2,false)+IF(True,1,0)')).toBe('VLOOKUP(A1,B:C,2,FALSE())+IF(TRUE(),1,0)');
    // already a call, text, a sheet's cell and a longer word are left alone
    expect(normalizeFormula('TRUE()&"FALSE"&TRUE!A1&TRUEUP')).toBe("TRUE()&\"FALSE\"&'TRUE'!A1&TRUEUP");
  });

  it('replaces defined names by what they stand for', () => {
    const names: Record<string, string> = { 稅率: '資料!$B$2', 含稅: '1+稅率' };
    const lookup = (n: string) => names[n];
    expect(normalizeFormula('SUM(C2:C6)*(1+稅率)', lookup)).toBe("SUM(C2:C6)*(1+('資料'!$B$2))");
    expect(normalizeFormula('A1*含稅', lookup)).toBe("A1*(1+('資料'!$B$2))");
    // a sheet, a function and a string of the same spelling are not the name
    expect(normalizeFormula('稅率!A1+"稅率"', lookup)).toBe("'稅率'!A1+\"稅率\"");
    // behind a sheet prefix the name is still the name, and the prefix goes
    expect(normalizeFormula('資料!稅率*2+資料!B2', lookup)).toBe("('資料'!$B$2)*2+'資料'!B2");
  });
});

describe('reading a formula', () => {
  it('lists the functions it calls', () => {
    expect(formulaFunctions('IF(SUM(A1:A3)>0,_xlfn.XLOOKUP(A1,B:B,C:C),sum(B1))').sort()).toEqual(['IF', 'SUM', 'XLOOKUP']);
  });

  it('lists the cells and ranges it points at', () => {
    expect(formulaRefs("(B82*$B$83+'營收 模型'!B84)/未來四季營收!C6+SUM(A1:B2)")).toEqual([
      { sheet: null, address: 'B82' },
      { sheet: null, address: 'B83' },
      { sheet: '營收 模型', address: 'B84' },
      { sheet: '未來四季營收', address: 'C6' },
      { sheet: null, address: 'A1', to: 'B2' },
    ]);
  });

  it('spots a reference across several sheets', () => {
    expect(hasThreeDReference('SUM(Jan:Mar!A1)')).toBe(true);
    expect(hasThreeDReference('SUM(A1:B2)+Jan!A1')).toBe(false);
  });
});
