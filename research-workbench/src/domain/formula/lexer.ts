/**
 * Formula lexer. Accepts both the UI form (`[Gross Margin]`, bare `EPS`) and the stored
 * form (`{n_ab12cd34}`), optionally followed by `@PERIOD`.
 */

export type Token =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '^' | '%'; s: number; e: number }
  | { t: 'cmp'; v: '<' | '>' | '<=' | '>=' | '=' | '<>'; s: number; e: number }
  | { t: '(' | ')' | ','; s: number; e: number }
  | { t: 'ident'; v: string; s: number; e: number }
  | { t: 'bracket'; v: string; s: number; e: number }
  | { t: 'idref'; v: string; s: number; e: number }
  | { t: 'at'; v: string; s: number; e: number }
  | { t: 'eof'; s: number; e: number };

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(message);
    this.name = 'FormulaSyntaxError';
  }
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;
const PERIOD_CHAR = /[A-Za-z0-9_]/;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const s = i;
    // numbers: 12, 1.5, .5, 1e6, 1,000 is NOT supported (comma is the argument separator)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') {
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      if ((src[j] === 'e' || src[j] === 'E') && /[-+0-9]/.test(src[j + 1] ?? '')) {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] ?? '')) {
          while (k < n && /[0-9]/.test(src[k])) k++;
          j = k;
        }
      }
      const text = src.slice(i, j);
      const v = Number(text);
      if (!Number.isFinite(v)) throw new FormulaSyntaxError(`Invalid number "${text}"`, i);
      out.push({ t: 'num', v, s, e: j });
      i = j;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let name = '';
      while (j < n && src[j] !== ']') {
        if (src[j] === '\\' && j + 1 < n) {
          name += src[j + 1];
          j += 2;
          continue;
        }
        name += src[j];
        j++;
      }
      if (j >= n) throw new FormulaSyntaxError('Missing closing "]" for a name in brackets', i);
      const trimmed = name.trim();
      if (!trimmed) throw new FormulaSyntaxError('Empty name in brackets "[]"', i);
      out.push({ t: 'bracket', v: trimmed, s, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new FormulaSyntaxError('Missing closing "}" in a stored reference', i);
      out.push({ t: 'idref', v: src.slice(i + 1, j).trim(), s, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '@') {
      let j = i + 1;
      while (j < n && PERIOD_CHAR.test(src[j])) j++;
      if (j === i + 1) throw new FormulaSyntaxError('Expected a period after "@", e.g. @FY2028', i);
      out.push({ t: 'at', v: src.slice(i + 1, j), s, e: j });
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) j++;
      out.push({ t: 'ident', v: src.slice(i, j), s, e: j });
      i = j;
      continue;
    }
    if (c === '<' || c === '>' || c === '=' || c === '!') {
      const two = src.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>') {
        out.push({ t: 'cmp', v: two, s, e: i + 2 });
        i += 2;
        continue;
      }
      if (two === '!=') {
        out.push({ t: 'cmp', v: '<>', s, e: i + 2 });
        i += 2;
        continue;
      }
      if (two === '==') {
        out.push({ t: 'cmp', v: '=', s, e: i + 2 });
        i += 2;
        continue;
      }
      if (c === '!') throw new FormulaSyntaxError('Unexpected "!". Use NOT(...) or <> for "not equal"', i);
      out.push({ t: 'cmp', v: c as '<' | '>' | '=', s, e: i + 1 });
      i++;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^' || c === '%') {
      out.push({ t: 'op', v: c, s, e: i + 1 });
      i++;
      continue;
    }
    if (c === '×') {
      out.push({ t: 'op', v: '*', s, e: i + 1 });
      i++;
      continue;
    }
    if (c === '÷') {
      out.push({ t: 'op', v: '/', s, e: i + 1 });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c, s, e: i + 1 });
      i++;
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected character "${c}"`, i);
  }
  out.push({ t: 'eof', s: n, e: n });
  return out;
}
