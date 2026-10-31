import { FormulaSyntaxError, tokenize, type Token } from './lexer';

export type RefTarget =
  | { kind: 'id'; id: string }
  | { kind: 'name'; name: string; bracketed: boolean };

export type Ast =
  | { k: 'num'; v: number }
  | { k: 'ref'; target: RefTarget; period?: string; s: number; e: number }
  | { k: 'neg'; a: Ast }
  | { k: 'pct'; a: Ast }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Ast; b: Ast }
  | { k: 'cmp'; op: '<' | '>' | '<=' | '>=' | '=' | '<>'; a: Ast; b: Ast }
  | { k: 'call'; fn: string; args: Ast[]; s: number; e: number };

export interface FunctionSpec {
  name: string;
  min: number;
  max: number;
  signature: string;
  help: string;
}

export const FUNCTIONS: FunctionSpec[] = [
  { name: 'SUM', min: 1, max: 99, signature: 'SUM(a, b, …)', help: 'Sum of the arguments. SUM(CHILDREN()) sums the direct child nodes that share this node’s unit kind.' },
  { name: 'MIN', min: 1, max: 99, signature: 'MIN(a, b, …)', help: 'Smallest argument, e.g. MIN([Demand], [Capacity]).' },
  { name: 'MAX', min: 1, max: 99, signature: 'MAX(a, b, …)', help: 'Largest argument.' },
  { name: 'AVERAGE', min: 1, max: 99, signature: 'AVERAGE(a, b, …)', help: 'Arithmetic mean of the arguments.' },
  { name: 'CAGR', min: 3, max: 3, signature: 'CAGR(begin, end, years)', help: '(end / begin)^(1 / years) − 1.' },
  { name: 'IF', min: 3, max: 3, signature: 'IF(condition, then, else)', help: 'Only the chosen branch is evaluated.' },
  { name: 'ABS', min: 1, max: 1, signature: 'ABS(x)', help: 'Absolute value.' },
  { name: 'ROUND', min: 1, max: 2, signature: 'ROUND(x, digits)', help: 'Round to the given number of decimals (default 0).' },
  { name: 'AND', min: 1, max: 99, signature: 'AND(a, b, …)', help: '1 if every argument is non-zero, else 0.' },
  { name: 'OR', min: 1, max: 99, signature: 'OR(a, b, …)', help: '1 if any argument is non-zero, else 0.' },
  { name: 'NOT', min: 1, max: 1, signature: 'NOT(x)', help: '1 if x is zero, else 0.' },
  { name: 'PREV', min: 1, max: 2, signature: 'PREV(x, n)', help: 'Value of x in the period n steps earlier (default 1). Not a circular reference.' },
  { name: 'CHILDREN', min: 0, max: 0, signature: 'CHILDREN()', help: 'The direct children of this node with the same unit kind. Only inside SUM/MIN/MAX/AVERAGE.' },
];

const FN_BY_NAME = new Map(FUNCTIONS.map((f) => [f.name, f]));
export const isFunctionName = (name: string) => FN_BY_NAME.has(name.toUpperCase());
const LIST_FUNCTIONS = new Set(['SUM', 'MIN', 'MAX', 'AVERAGE']);

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.i];
  }
  private next(): Token {
    return this.toks[this.i++];
  }

  parse(): Ast {
    if (this.peek().t === 'eof') throw new FormulaSyntaxError('The formula is empty', 0);
    const ast = this.compare();
    const t = this.peek();
    if (t.t !== 'eof') throw new FormulaSyntaxError(`Unexpected ${describe(t)} — is an operator missing?`, t.s);
    return ast;
  }

  private compare(): Ast {
    const a = this.additive();
    const t = this.peek();
    if (t.t === 'cmp') {
      this.next();
      const b = this.additive();
      return { k: 'cmp', op: t.v, a, b };
    }
    return a;
  }

  private additive(): Ast {
    let a = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.next();
        const b = this.multiplicative();
        a = { k: 'bin', op: t.v, a, b };
      } else return a;
    }
  }

  private multiplicative(): Ast {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '*' || t.v === '/')) {
        this.next();
        const b = this.unary();
        a = { k: 'bin', op: t.v, a, b };
      } else return a;
    }
  }

  private unary(): Ast {
    const t = this.peek();
    if (t.t === 'op' && t.v === '-') {
      this.next();
      return { k: 'neg', a: this.unary() };
    }
    if (t.t === 'op' && t.v === '+') {
      this.next();
      return this.unary();
    }
    return this.power();
  }

  private power(): Ast {
    const base = this.postfix();
    const t = this.peek();
    if (t.t === 'op' && t.v === '^') {
      this.next();
      return { k: 'bin', op: '^', a: base, b: this.unary() };
    }
    return base;
  }

  private postfix(): Ast {
    let a = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && t.v === '%') {
        this.next();
        a = { k: 'pct', a };
      } else return a;
    }
  }

  private period(): string | undefined {
    const t = this.peek();
    if (t.t === 'at') {
      this.next();
      return t.v;
    }
    return undefined;
  }

  private primary(): Ast {
    const t = this.next();
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v };
      case '(': {
        const inner = this.compare();
        const close = this.next();
        if (close.t !== ')') throw new FormulaSyntaxError('Missing closing ")"', close.s);
        return inner;
      }
      case 'idref': {
        const period = this.period();
        return { k: 'ref', target: { kind: 'id', id: t.v }, period, s: t.s, e: t.e };
      }
      case 'bracket': {
        const period = this.period();
        return { k: 'ref', target: { kind: 'name', name: t.v, bracketed: true }, period, s: t.s, e: t.e };
      }
      case 'ident': {
        if (this.peek().t === '(') {
          this.next();
          const fn = t.v.toUpperCase();
          const spec = FN_BY_NAME.get(fn);
          if (!spec) {
            throw new FormulaSyntaxError(
              `Unknown function ${t.v}(). Available: ${FUNCTIONS.map((f) => f.name).join(', ')}`,
              t.s,
            );
          }
          const args: Ast[] = [];
          if (this.peek().t !== ')') {
            for (;;) {
              args.push(this.compare());
              const sep = this.peek();
              if (sep.t === ',') {
                this.next();
                continue;
              }
              break;
            }
          }
          const close = this.next();
          if (close.t !== ')') throw new FormulaSyntaxError(`Missing ")" to close ${fn}(`, close.s);
          if (args.length < spec.min || args.length > spec.max) {
            const expected = spec.min === spec.max ? `${spec.min}` : spec.max >= 99 ? `at least ${spec.min}` : `${spec.min}–${spec.max}`;
            throw new FormulaSyntaxError(`${fn} takes ${expected} argument(s): ${spec.signature}`, t.s);
          }
          return { k: 'call', fn, args, s: t.s, e: close.e };
        }
        const period = this.period();
        return { k: 'ref', target: { kind: 'name', name: t.v, bracketed: false }, period, s: t.s, e: t.e };
      }
      case 'eof':
        throw new FormulaSyntaxError('The formula ends unexpectedly', t.s);
      default:
        throw new FormulaSyntaxError(`Unexpected ${describe(t)}`, t.s);
    }
  }
}

function describe(t: Token): string {
  switch (t.t) {
    case 'num':
      return `number ${t.v}`;
    case 'ident':
      return `name "${t.v}"`;
    case 'bracket':
      return `[${t.v}]`;
    case 'idref':
      return 'reference';
    case 'op':
    case 'cmp':
      return `"${t.v}"`;
    case 'at':
      return `@${t.v}`;
    case 'eof':
      return 'end of formula';
    default:
      return `"${t.t}"`;
  }
}

/** Structural checks that need the whole tree (CHILDREN placement, PREV lag literal). */
function validate(ast: Ast, parentFn: string | null): void {
  switch (ast.k) {
    case 'call': {
      if (ast.fn === 'CHILDREN' && !(parentFn && LIST_FUNCTIONS.has(parentFn))) {
        throw new FormulaSyntaxError('CHILDREN() can only be used inside SUM, MIN, MAX or AVERAGE', ast.s);
      }
      if (ast.fn === 'PREV' && ast.args.length === 2) {
        const lag = ast.args[1];
        if (lag.k !== 'num' || !Number.isInteger(lag.v) || lag.v < 1) {
          throw new FormulaSyntaxError('PREV(x, n): n must be a whole number ≥ 1', ast.s);
        }
      }
      for (const a of ast.args) validate(a, ast.fn);
      return;
    }
    case 'neg':
    case 'pct':
      validate(ast.a, null);
      return;
    case 'bin':
    case 'cmp':
      validate(ast.a, null);
      validate(ast.b, null);
      return;
    default:
      return;
  }
}

export function parseFormula(src: string): Ast {
  const ast = new Parser(tokenize(src)).parse();
  validate(ast, null);
  return ast;
}

export function walk(ast: Ast, visit: (node: Ast) => void): void {
  visit(ast);
  switch (ast.k) {
    case 'neg':
    case 'pct':
      walk(ast.a, visit);
      break;
    case 'bin':
    case 'cmp':
      walk(ast.a, visit);
      walk(ast.b, visit);
      break;
    case 'call':
      ast.args.forEach((a) => walk(a, visit));
      break;
    default:
      break;
  }
}
