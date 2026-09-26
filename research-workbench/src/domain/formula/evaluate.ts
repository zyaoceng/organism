import type { ModelIndex } from '../model/tree';
import { printAst } from './refs';
import type { Ast } from './parser';

export type CalcErrorCode =
  | 'PARSE'
  | 'UNKNOWN_NAME'
  | 'AMBIGUOUS_NAME'
  | 'DELETED_REF'
  | 'MISSING'
  | 'DIV0'
  | 'CYCLE'
  | 'NEEDS_PERIOD'
  | 'NO_PERIOD'
  | 'BAD_ARG'
  | 'UPSTREAM';

export interface CalcError {
  err: true;
  code: CalcErrorCode;
  message: string;
  nodeId?: string;
  periodKey?: string;
  /** For UPSTREAM: the originating error. */
  root?: CalcError;
}

export type Value = number | CalcError;
export const isErr = (v: Value | number[] | undefined | null): v is CalcError =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (v as CalcError).err === true;

export function calcError(code: CalcErrorCode, message: string, extra: Partial<CalcError> = {}): CalcError {
  return { err: true, code, message, ...extra };
}

export interface EvalContext {
  ix: ModelIndex;
  /** Node whose formula is evaluated. */
  nodeId: string;
  /** Index into ix.periods, or null when evaluating a scalar node. */
  periodIndex: number | null;
  /** Read another node's value. periodKey is a period ID or '_' (scalar). */
  read(id: string, periodKey: string): Value;
  /** CHILDREN() expansion for the evaluated node. */
  children(): string[];
  isScalar(id: string): boolean;
}

type ListValue = number[] | CalcError;

function evalList(ast: Ast, ctx: EvalContext): ListValue {
  if (ast.k === 'call' && ast.fn === 'CHILDREN') {
    const out: number[] = [];
    for (const id of ctx.children()) {
      const v = readRef(id, undefined, ctx);
      if (isErr(v)) return v;
      out.push(v);
    }
    return out;
  }
  const v = evaluate(ast, ctx);
  return isErr(v) ? v : [v];
}

function readRef(id: string, period: string | undefined, ctx: EvalContext): Value {
  const { ix } = ctx;
  if (!ix.byId.has(id)) return calcError('DELETED_REF', 'Formula references a node that was deleted', { nodeId: ctx.nodeId });
  if (ctx.isScalar(id)) return ctx.read(id, '_');
  if (period !== undefined) {
    if (!ix.periodIndex.has(period)) return calcError('NO_PERIOD', `Period ${period} does not exist`, { nodeId: ctx.nodeId });
    return ctx.read(id, period);
  }
  if (ctx.periodIndex === null) {
    const name = ix.byId.get(id)?.name ?? id;
    return calcError('NEEDS_PERIOD', `[${name}] is a time series; a single-value formula must pick a period, e.g. [${name}]@${ix.periods.at(-1)?.id ?? 'FY2028'}`, { nodeId: ctx.nodeId });
  }
  if (ctx.periodIndex < 0) {
    const first = ix.periods[0];
    const name = ix.byId.get(id)?.name ?? id;
    return calcError('NO_PERIOD', `Missing starting value for ${name}: PREV() reaches before the first period${first ? ` (${first.label})` : ''}. Type ${name} in an actual period.`, { nodeId: ctx.nodeId });
  }
  return ctx.read(id, ix.periods[ctx.periodIndex].id);
}

const finite = (v: number, ctx: EvalContext, what: string): Value =>
  Number.isFinite(v) ? v : calcError('BAD_ARG', `${what} is not a finite number`, { nodeId: ctx.nodeId });

export function evaluate(ast: Ast, ctx: EvalContext): Value {
  switch (ast.k) {
    case 'num':
      return ast.v;
    case 'ref':
      if (ast.target.kind !== 'id') return calcError('UNKNOWN_NAME', `Unresolved name "${ast.target.name}"`, { nodeId: ctx.nodeId });
      return readRef(ast.target.id, ast.period, ctx);
    case 'neg': {
      const a = evaluate(ast.a, ctx);
      return isErr(a) ? a : -a;
    }
    case 'pct': {
      const a = evaluate(ast.a, ctx);
      return isErr(a) ? a : a / 100;
    }
    case 'bin': {
      const a = evaluate(ast.a, ctx);
      if (isErr(a)) return a;
      const b = evaluate(ast.b, ctx);
      if (isErr(b)) return b;
      switch (ast.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          if (b === 0) {
            return calcError('DIV0', `Division by zero: ${printAst(ast.b, ctx.ix, ctx.nodeId)} is 0`, { nodeId: ctx.nodeId });
          }
          return a / b;
        case '^':
          return finite(a ** b, ctx, `${printAst(ast, ctx.ix, ctx.nodeId)}`);
      }
      break;
    }
    case 'cmp': {
      const a = evaluate(ast.a, ctx);
      if (isErr(a)) return a;
      const b = evaluate(ast.b, ctx);
      if (isErr(b)) return b;
      const eps = 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
      switch (ast.op) {
        case '<':
          return a < b ? 1 : 0;
        case '>':
          return a > b ? 1 : 0;
        case '<=':
          return a <= b ? 1 : 0;
        case '>=':
          return a >= b ? 1 : 0;
        case '=':
          return Math.abs(a - b) <= eps ? 1 : 0;
        case '<>':
          return Math.abs(a - b) > eps ? 1 : 0;
      }
      break;
    }
    case 'call':
      return evalCall(ast, ctx);
  }
  return calcError('BAD_ARG', 'Unsupported expression', { nodeId: ctx.nodeId });
}

function evalCall(ast: Extract<Ast, { k: 'call' }>, ctx: EvalContext): Value {
  const args = ast.args;
  switch (ast.fn) {
    case 'SUM':
    case 'MIN':
    case 'MAX':
    case 'AVERAGE': {
      const nums: number[] = [];
      for (const a of args) {
        const l = evalList(a, ctx);
        if (isErr(l)) return l;
        nums.push(...l);
      }
      if (ast.fn === 'SUM') return nums.reduce((s, x) => s + x, 0);
      if (nums.length === 0) return calcError('BAD_ARG', `${ast.fn} has no values (CHILDREN() found no matching child nodes)`, { nodeId: ctx.nodeId });
      if (ast.fn === 'MIN') return Math.min(...nums);
      if (ast.fn === 'MAX') return Math.max(...nums);
      return nums.reduce((s, x) => s + x, 0) / nums.length;
    }
    case 'CAGR': {
      const vals: number[] = [];
      for (const a of args) {
        const v = evaluate(a, ctx);
        if (isErr(v)) return v;
        vals.push(v);
      }
      const [begin, end, years] = vals;
      if (begin <= 0 || end < 0) return calcError('BAD_ARG', `CAGR needs a positive begin value and a non-negative end value (got ${begin} → ${end})`, { nodeId: ctx.nodeId });
      if (years <= 0) return calcError('BAD_ARG', `CAGR needs years > 0 (got ${years})`, { nodeId: ctx.nodeId });
      return (end / begin) ** (1 / years) - 1;
    }
    case 'IF': {
      const c = evaluate(args[0], ctx);
      if (isErr(c)) return c;
      return evaluate(c !== 0 ? args[1] : args[2], ctx);
    }
    case 'ABS': {
      const v = evaluate(args[0], ctx);
      return isErr(v) ? v : Math.abs(v);
    }
    case 'ROUND': {
      const v = evaluate(args[0], ctx);
      if (isErr(v)) return v;
      const d = args[1] ? evaluate(args[1], ctx) : 0;
      if (isErr(d)) return d;
      const f = 10 ** Math.round(d);
      return Math.round(v * f) / f;
    }
    case 'AND':
    case 'OR': {
      const vals: number[] = [];
      for (const a of args) {
        const v = evaluate(a, ctx);
        if (isErr(v)) return v;
        vals.push(v);
      }
      return (ast.fn === 'AND' ? vals.every((x) => x !== 0) : vals.some((x) => x !== 0)) ? 1 : 0;
    }
    case 'NOT': {
      const v = evaluate(args[0], ctx);
      return isErr(v) ? v : v === 0 ? 1 : 0;
    }
    case 'PREV': {
      if (ctx.periodIndex === null) return calcError('NEEDS_PERIOD', 'PREV() only works in time-series formulas', { nodeId: ctx.nodeId });
      const n = args[1]?.k === 'num' ? args[1].v : 1;
      return evaluate(args[0], { ...ctx, periodIndex: ctx.periodIndex - n });
    }
    case 'CHILDREN':
      return calcError('BAD_ARG', 'CHILDREN() can only be used inside SUM, MIN, MAX or AVERAGE', { nodeId: ctx.nodeId });
  }
  return calcError('BAD_ARG', `Unknown function ${ast.fn}`, { nodeId: ctx.nodeId });
}
