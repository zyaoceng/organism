/**
 * Formula text helpers that need no evaluation: expanding a shared formula to another cell,
 * quoting sheet names the formula engine cannot read bare (Excel writes 營收模型!B5 without quotes),
 * and listing the functions and cell references a formula uses.
 */

export const colToNumber = (col: string): number => {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};

export const numberToCol = (n: number): string => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

export const cellAddress = (col: number, row: number) => `${numberToCol(col)}${row}`;

export function parseAddress(address: string): { col: number; row: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(address);
  if (!m) throw new Error(`Not a cell address: ${address}`);
  return { col: colToNumber(m[1]), row: Number(m[2]) };
}

const MAX_COL = 16384;
const MAX_ROW = 1048576;

type Token =
  | { kind: 'text'; text: string } // operators, numbers, strings, whitespace: copied as is
  | { kind: 'sheet'; name: string; quoted: boolean } // followed by `!` in the source
  | { kind: 'function'; name: string } // followed by `(`
  | { kind: 'word'; text: string }; // a cell reference, a column or row of a range, a name, TRUE/FALSE

const WORD_CHAR = /[A-Za-z0-9_.$\\?\u0080-￿]/;

function tokenize(formula: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = formula.length;
  while (i < n) {
    const ch = formula[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && (formula[j] !== '"' || formula[j + 1] === '"')) j += formula[j] === '"' ? 2 : 1;
      out.push({ kind: 'text', text: formula.slice(i, j + 1) });
      i = j + 1;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < n && (formula[j] !== "'" || formula[j + 1] === "'")) j += formula[j] === "'" ? 2 : 1;
      const name = formula.slice(i + 1, j).replace(/''/g, "'");
      if (formula[j + 1] === '!') {
        out.push({ kind: 'sheet', name, quoted: true });
        i = j + 2;
      } else {
        out.push({ kind: 'text', text: formula.slice(i, j + 1) });
        i = j + 1;
      }
    } else if (ch === '#') {
      // an error literal: #REF! must not read as a sheet named REF
      const m = /^#(REF!|DIV\/0!|N\/A|NAME\?|NULL!|NUM!|VALUE!|[A-Z_]+[!?]?)/.exec(formula.slice(i));
      const text = m ? m[0] : ch;
      out.push({ kind: 'text', text });
      i += text.length;
    } else if (ch === '[') {
      // a structured or external reference: copied untouched
      let depth = 0;
      let j = i;
      do {
        if (formula[j] === '[') depth++;
        else if (formula[j] === ']') depth--;
        j++;
      } while (j < n && depth > 0);
      out.push({ kind: 'text', text: formula.slice(i, j) });
      i = j;
    } else if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < n && WORD_CHAR.test(formula[j])) j++;
      const word = formula.slice(i, j);
      if (formula[j] === '!') {
        out.push({ kind: 'sheet', name: word, quoted: false });
        i = j + 1;
      } else if (formula[j] === '(') {
        out.push({ kind: 'function', name: word });
        i = j;
      } else if (/^\d/.test(word) && /^[0-9.]+[eE]$/.test(word) && (formula[j] === '+' || formula[j] === '-')) {
        // 1.5E+3: the exponent sign belongs to the number
        let k = j + 1;
        while (k < n && /\d/.test(formula[k])) k++;
        out.push({ kind: 'text', text: formula.slice(i, k) });
        i = k;
      } else {
        out.push({ kind: 'word', text: word });
        i = j;
      }
    } else {
      out.push({ kind: 'text', text: ch });
      i++;
    }
  }
  return out;
}

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;
const COL_RE = /^(\$?)([A-Za-z]{1,3})$/;
const ROW_RE = /^(\$?)(\d{1,7})$/;

const isColon = (t: Token | undefined) => t?.kind === 'text' && t.text === ':';

function isCell(word: string): boolean {
  const m = CELL_RE.exec(word);
  return !!m && colToNumber(m[2]) <= MAX_COL && Number(m[4]) >= 1 && Number(m[4]) <= MAX_ROW;
}

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

function render(tokens: Token[], quoteAll: boolean): string {
  return tokens
    .map((t) => {
      if (t.kind === 'sheet') return `${t.quoted || quoteAll ? quoteSheet(t.name) : t.name}!`;
      if (t.kind === 'function') return t.name;
      return t.text;
    })
    .join('');
}

/**
 * The formula a shared formula's master cell gives a cell `dRow` rows down and `dCol` columns
 * right: relative references move, `$` ones stay. A reference pushed off the sheet becomes #REF!.
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  const tokens = tokenize(formula);
  const shiftCol = (abs: string, col: string): string | null => {
    if (abs) return `$${col}`;
    const c = colToNumber(col) + dCol;
    return c >= 1 && c <= MAX_COL ? numberToCol(c) : null;
  };
  const shiftRow = (abs: string, row: string): string | null => {
    if (abs) return `$${row}`;
    const r = Number(row) + dRow;
    return r >= 1 && r <= MAX_ROW ? String(r) : null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    const cell = CELL_RE.exec(t.text);
    if (cell && isCell(t.text)) {
      const c = shiftCol(cell[1], cell[2]);
      const r = shiftRow(cell[3], cell[4]);
      t.text = c && r ? c + r : '#REF!';
      continue;
    }
    // whole columns (A:C) and whole rows (2:5) exist only as both ends of a range
    const next = tokens[i + 2];
    if (!isColon(tokens[i + 1]) || next?.kind !== 'word') continue;
    const colA = COL_RE.exec(t.text);
    const colB = COL_RE.exec(next.text);
    const rowA = ROW_RE.exec(t.text);
    const rowB = ROW_RE.exec(next.text);
    if (colA && colB) {
      const a = shiftCol(colA[1], colA[2]);
      const b = shiftCol(colB[1], colB[2]);
      t.text = a && b ? a : '#REF!';
      next.text = a && b ? b : '#REF!';
      i += 2;
    } else if (rowA && rowB) {
      const a = shiftRow(rowA[1], rowA[2]);
      const b = shiftRow(rowB[1], rowB[2]);
      t.text = a && b ? a : '#REF!';
      next.text = a && b ? b : '#REF!';
      i += 2;
    }
  }
  return render(tokens, false);
}

/**
 * The same formula in the form the engine reads: every sheet name quoted (a bare CJK name is not
 * accepted), the `_xlfn.` / `_xlws.` prefixes Excel stores on newer functions removed, and each
 * defined name replaced by what it stands for (the engine rejects CJK names). `definedName` returns
 * a name's formula, or undefined when the word is not a name.
 */
export function normalizeFormula(formula: string, definedName?: (name: string) => string | undefined, depth = 0): string {
  const tokens = tokenize(formula);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'function') t.name = t.name.replace(/^(_xlfn\.|_xlws\.|_xludf\.)+/i, '');
    if (t.kind !== 'word') continue;
    // the engine has no TRUE and FALSE constants, only the functions: VLOOKUP(x,r,2,FALSE) would give #NAME?
    if (/^(true|false)$/i.test(t.text) && tokens[i - 1]?.kind !== 'sheet') {
      tokens[i] = { kind: 'text', text: `${t.text.toUpperCase()}()` };
      continue;
    }
    // a name stands alone: not a cell, not either end of A:C
    if (!definedName || depth > 8 || isCell(t.text) || /^[\d.]/.test(t.text)) continue;
    if (isColon(tokens[i + 1]) || isColon(tokens[i - 1])) continue;
    const definition = definedName(t.text);
    if (definition === undefined) continue;
    tokens[i] = { kind: 'text', text: `(${normalizeFormula(definition, definedName, depth + 1)})` };
    // Sheet!name: the prefix only says where the name lives, the definition carries its own sheet
    if (tokens[i - 1]?.kind === 'sheet') tokens[i - 1] = { kind: 'text', text: '' };
  }
  return render(tokens, true);
}

/** Upper-case names of the functions called, without the `_xlfn.` prefix. */
export function formulaFunctions(formula: string): string[] {
  const names = new Set<string>();
  for (const t of tokenize(formula)) if (t.kind === 'function') names.add(t.name.replace(/^(_xlfn\.|_xlws\.|_xludf\.)+/i, '').toUpperCase());
  return [...names];
}

export interface FormulaRef {
  /** null: the formula's own sheet. */
  sheet: string | null;
  /** Without `$`. For a range, its top-left cell. */
  address: string;
  /** The range's bottom-right cell, when it is a range. */
  to?: string;
}

/** The single cells and ranges a formula points at, in order (whole rows and columns are left out). */
export function formulaRefs(formula: string): FormulaRef[] {
  const tokens = tokenize(formula);
  const refs: FormulaRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word' || !isCell(t.text)) continue;
    const prev = tokens[i - 1];
    const ref: FormulaRef = { sheet: prev?.kind === 'sheet' ? prev.name : null, address: t.text.replace(/\$/g, '').toUpperCase() };
    const next = tokens[i + 2];
    if (isColon(tokens[i + 1]) && next?.kind === 'word' && isCell(next.text)) {
      ref.to = next.text.replace(/\$/g, '').toUpperCase();
      i += 2;
    }
    refs.push(ref);
  }
  return refs;
}

/** True when the formula spans sheets with Sheet1:Sheet3!A1, which the engine does not support. */
export function hasThreeDReference(formula: string): boolean {
  const tokens = tokenize(formula);
  return tokens.some((t, i) => t.kind === 'sheet' && isColon(tokens[i - 1]) && tokens[i - 2]?.kind === 'word' && !isCell((tokens[i - 2] as { text: string }).text));
}
