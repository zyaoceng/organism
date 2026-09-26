import { additiveMismatch, isDimensionless, unitLabel, type Unit } from '../units';
import type { Ast } from './parser';

/** 'dimensionless' = a pure number (literal, percent, multiple); 'unknown' = cannot be inferred. */
export type InferredUnit = Unit | 'dimensionless' | 'unknown';

const DIMLESS: InferredUnit = 'dimensionless';

function norm(u: Unit | null | undefined): InferredUnit {
  if (!u) return 'unknown';
  return isDimensionless(u) ? DIMLESS : u;
}

/**
 * Light unit inference. Produces warnings for additive mixing of different currencies,
 * scales or kinds. Multiplication and division are only tracked through dimensionless
 * factors; anything else becomes 'unknown' (no dimensional-analysis engine in V1).
 */
export function inferUnit(
  ast: Ast,
  unitOf: (id: string) => Unit | null | undefined,
  childUnits: () => (Unit | null)[],
): { unit: InferredUnit; warnings: string[] } {
  const warnings: string[] = [];

  const combineAdditive = (items: InferredUnit[], what: string): InferredUnit => {
    const concrete = items.filter((u): u is Unit => typeof u === 'object');
    for (let i = 1; i < concrete.length; i++) {
      const m = additiveMismatch(concrete[0], concrete[i]);
      if (m) warnings.push(`${what}: ${m}`);
    }
    if (concrete.length) return concrete[0];
    if (items.every((u) => u === DIMLESS)) return DIMLESS;
    return 'unknown';
  };

  const visit = (a: Ast): InferredUnit => {
    switch (a.k) {
      case 'num':
      case 'cmp':
        return DIMLESS;
      case 'pct':
        visit(a.a);
        return DIMLESS;
      case 'ref':
        return a.target.kind === 'id' ? norm(unitOf(a.target.id)) : 'unknown';
      case 'neg':
        return visit(a.a);
      case 'bin': {
        const l = visit(a.a);
        const r = visit(a.b);
        if (a.op === '+' || a.op === '-') return combineAdditive([l, r], a.op === '+' ? 'Addition' : 'Subtraction');
        if (a.op === '*') {
          if (l === DIMLESS) return r;
          if (r === DIMLESS) return l;
          return 'unknown';
        }
        if (a.op === '/') {
          if (r === DIMLESS) return l;
          if (typeof l === 'object' && typeof r === 'object' && l.kind === 'currency' && r.kind === 'shares') {
            if (l.scale !== r.scale) {
              warnings.push(`Per-share division: amount is in ${unitLabel(l)} but shares are in ${unitLabel(r)}; the result is off by a factor of ${l.scale / r.scale}`);
              return 'unknown';
            }
            return { kind: 'per_share', currency: l.currency, scale: 1 };
          }
          if (typeof l === 'object' && typeof r === 'object' && !additiveMismatch(l, r)) return DIMLESS;
          return 'unknown';
        }
        return l === DIMLESS && r === DIMLESS ? DIMLESS : 'unknown';
      }
      case 'call': {
        switch (a.fn) {
          case 'SUM':
          case 'MIN':
          case 'MAX':
          case 'AVERAGE': {
            const items: InferredUnit[] = [];
            for (const x of a.args) {
              if (x.k === 'call' && x.fn === 'CHILDREN') items.push(...childUnits().map(norm));
              else items.push(visit(x));
            }
            return combineAdditive(items, a.fn);
          }
          case 'IF': {
            visit(a.args[0]);
            const t = visit(a.args[1]);
            const f = visit(a.args[2]);
            combineAdditive([t, f], 'IF branches');
            return t;
          }
          case 'PREV':
          case 'ABS':
          case 'ROUND':
            a.args.slice(1).forEach(visit);
            return visit(a.args[0]);
          case 'CAGR':
            a.args.forEach(visit);
            return DIMLESS;
          default:
            a.args.forEach(visit);
            return DIMLESS;
        }
      }
    }
  };
  const unit = visit(ast);
  return { unit, warnings };
}

/** Warning when the inferred unit clearly contradicts the node's declared unit. */
export function declaredUnitMismatch(inferred: InferredUnit, declared: Unit | null): string | null {
  if (!declared || typeof inferred !== 'object') return null;
  if (isDimensionless(declared)) return null;
  const m = additiveMismatch(inferred, declared);
  return m ? `Formula produces ${unitLabel(inferred)} but the node is declared as ${unitLabel(declared)}` : null;
}
