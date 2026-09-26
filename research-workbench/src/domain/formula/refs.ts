import { ancestors, childrenOf, type ModelIndex } from '../model/tree';
import type { ModelNode } from '../model/types';
import { FormulaSyntaxError, tokenize } from './lexer';
import { parseFormula, walk, type Ast } from './parser';

export type ResolveResult =
  | { ok: true; id: string }
  | { ok: false; code: 'UNKNOWN_NAME' | 'AMBIGUOUS_NAME' | 'DELETED_REF'; message: string; candidates: string[] };

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();

export function formatPath(ix: ModelIndex, id: string): string {
  const n = ix.byId.get(id);
  if (!n) return id;
  return [...ancestors(ix, id).map((a) => a.name), n.name].join(' › ');
}

function matchesPath(ix: ModelIndex, node: ModelNode, segs: string[]): boolean {
  if (norm(node.name) !== norm(segs[segs.length - 1])) return false;
  const anc = ancestors(ix, node.id);
  for (let k = 2; k <= segs.length; k++) {
    const a = anc[anc.length - (k - 1)];
    if (!a || norm(a.name) !== norm(segs[segs.length - k])) return false;
  }
  return true;
}

/**
 * Resolve a user-typed name to a node ID. Exact names first, then `Parent/Child` paths.
 * Ties are broken by scope: the node itself, its children, its siblings, its parent.
 */
export function resolveName(ix: ModelIndex, name: string, contextId: string | null): ResolveResult {
  if (name.startsWith('#deleted')) {
    return { ok: false, code: 'DELETED_REF', message: 'This reference points to a node that was deleted. Replace it with an existing node.', candidates: [] };
  }
  const all = [...ix.byId.values()];
  let candidates = all.filter((n) => norm(n.name) === norm(name));
  if (candidates.length === 0 && name.includes('/')) {
    const segs = name.split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length > 1) candidates = all.filter((n) => matchesPath(ix, n, segs));
  }
  if (candidates.length === 0) {
    const q = norm(name);
    const similar = all.filter((n) => norm(n.name).includes(q) || q.includes(norm(n.name))).slice(0, 5);
    const hint = similar.length ? ` Did you mean ${similar.map((s) => `[${s.name}]`).join(', ')}?` : '';
    return { ok: false, code: 'UNKNOWN_NAME', message: `No node named "${name}".${hint}`, candidates: [] };
  }
  if (candidates.length === 1) return { ok: true, id: candidates[0].id };

  const ctx = contextId ? ix.byId.get(contextId) : undefined;
  if (ctx) {
    const levels: ((n: ModelNode) => boolean)[] = [
      (n) => n.id === ctx.id,
      (n) => n.parentId === ctx.id,
      (n) => n.parentId === ctx.parentId,
      (n) => n.id === ctx.parentId,
    ];
    for (const level of levels) {
      const hit = candidates.filter(level);
      if (hit.length === 1) return { ok: true, id: hit[0].id };
      if (hit.length > 1) {
        candidates = hit;
        break;
      }
    }
  }
  const paths = candidates.map((c) => formatPath(ix, c.id));
  const example = candidates[0].parentId ? `[${ix.byId.get(candidates[0].parentId)?.name}/${candidates[0].name}]` : `[${candidates[0].name}]`;
  return {
    ok: false,
    code: 'AMBIGUOUS_NAME',
    message: `"${name}" matches ${candidates.length} nodes: ${paths.join('; ')}. Use a path such as ${example}.`,
    candidates: candidates.map((c) => c.id),
  };
}

const escapeBracket = (s: string) => s.replace(/\\/g, '\\\\').replace(/]/g, '\\]');

/** Shortest unambiguous display form of a reference, always in brackets. */
export function displayRef(ix: ModelIndex, id: string, contextId: string | null): string {
  const n = ix.byId.get(id);
  if (!n) return `[#deleted ${id}]`;
  const resolvesTo = (text: string) => {
    const r = resolveName(ix, text, contextId);
    return r.ok && r.id === id;
  };
  if (resolvesTo(n.name)) return `[${escapeBracket(n.name)}]`;
  const anc = ancestors(ix, id);
  for (let k = 1; k <= anc.length; k++) {
    const path = [...anc.slice(anc.length - k).map((a) => a.name), n.name].join('/');
    if (resolvesTo(path)) return `[${escapeBracket(path)}]`;
  }
  return `[${escapeBracket([...anc.map((a) => a.name), n.name].join('/'))}]`;
}

export interface FormulaError {
  code: 'PARSE' | 'UNKNOWN_NAME' | 'AMBIGUOUS_NAME' | 'DELETED_REF' | 'NO_PERIOD';
  message: string;
  pos?: number;
}

export type ToStoredResult = { ok: true; stored: string; refIds: string[] } | { ok: false; error: FormulaError };

/** Convert UI text (names) into stored text (IDs), preserving the user's spacing. */
export function toStored(text: string, ix: ModelIndex, contextId: string | null): ToStoredResult {
  let ast: Ast;
  try {
    ast = parseFormula(text);
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return { ok: false, error: { code: 'PARSE', message: e.message, pos: e.pos } };
    throw e;
  }
  const refs: Extract<Ast, { k: 'ref' }>[] = [];
  walk(ast, (a) => {
    if (a.k === 'ref') refs.push(a);
  });
  const replacements: { s: number; e: number; id: string }[] = [];
  for (const r of refs) {
    let id: string;
    if (r.target.kind === 'id') {
      if (!ix.byId.has(r.target.id)) {
        return { ok: false, error: { code: 'DELETED_REF', message: 'This reference points to a node that was deleted.', pos: r.s } };
      }
      id = r.target.id;
    } else {
      const res = resolveName(ix, r.target.name, contextId);
      if (!res.ok) return { ok: false, error: { code: res.code, message: res.message, pos: r.s } };
      id = res.id;
    }
    if (r.period !== undefined && !ix.periodIndex.has(r.period)) {
      const known = ix.periods.map((p) => p.id).join(', ') || 'none';
      return { ok: false, error: { code: 'NO_PERIOD', message: `Unknown period @${r.period}. Periods in this model: ${known}.`, pos: r.e } };
    }
    replacements.push({ s: r.s, e: r.e, id });
  }
  const refIds = [...new Set(replacements.map((r) => r.id))];
  replacements.sort((a, b) => b.s - a.s);
  let out = text;
  for (const r of replacements) out = out.slice(0, r.s) + `{${r.id}}` + out.slice(r.e);
  return { ok: true, stored: out.trim(), refIds };
}

/** Convert stored text (IDs) into display text (names). */
export function toDisplay(stored: string | undefined, ix: ModelIndex, contextId: string | null): string {
  if (!stored) return '';
  let toks;
  try {
    toks = tokenize(stored);
  } catch {
    return stored;
  }
  let out = stored;
  for (const t of [...toks].reverse()) {
    if (t.t === 'idref') out = out.slice(0, t.s) + displayRef(ix, t.v, contextId) + out.slice(t.e);
  }
  return out;
}

/** Stored-form formula text with IDs replaced via a mapping (used when duplicating branches). */
export function remapIds(stored: string, map: ReadonlyMap<string, string>): string {
  let toks;
  try {
    toks = tokenize(stored);
  } catch {
    return stored;
  }
  let out = stored;
  for (const t of [...toks].reverse()) {
    if (t.t === 'idref' && map.has(t.v)) out = out.slice(0, t.s) + `{${map.get(t.v)}}` + out.slice(t.e);
  }
  return out;
}

export interface RefInfo {
  /** Same-period or absolute-period references: these form the DAG that must be acyclic. */
  direct: Set<string>;
  /** References under PREV(): always point to earlier periods. */
  lagged: Set<string>;
  /** Absolute period references (`@FY2028`) by node. */
  periods: { id: string; period: string }[];
  childrenDirect: boolean;
  childrenLagged: boolean;
}

export function extractRefs(ast: Ast): RefInfo {
  const info: RefInfo = { direct: new Set(), lagged: new Set(), periods: [], childrenDirect: false, childrenLagged: false };
  const visit = (a: Ast, lag: number) => {
    switch (a.k) {
      case 'ref':
        if (a.target.kind === 'id') {
          if (a.period !== undefined) {
            info.direct.add(a.target.id);
            info.periods.push({ id: a.target.id, period: a.period });
          } else (lag === 0 ? info.direct : info.lagged).add(a.target.id);
        }
        return;
      case 'call':
        if (a.fn === 'PREV') {
          const n = a.args[1]?.k === 'num' ? a.args[1].v : 1;
          visit(a.args[0], lag + n);
          return;
        }
        if (a.fn === 'CHILDREN') {
          if (lag === 0) info.childrenDirect = true;
          else info.childrenLagged = true;
          return;
        }
        a.args.forEach((x) => visit(x, lag));
        return;
      case 'neg':
      case 'pct':
        visit(a.a, lag);
        return;
      case 'bin':
      case 'cmp':
        visit(a.a, lag);
        visit(a.b, lag);
        return;
      default:
        return;
    }
  };
  visit(ast, 0);
  return info;
}

/** Children included by CHILDREN(): direct children with a unit of the same kind as the parent. */
export function childrenForAggregate(ix: ModelIndex, nodeId: string): ModelNode[] {
  const parent = ix.byId.get(nodeId);
  return childrenOf(ix, nodeId).filter((c) => c.unit && (!parent?.unit || c.unit.kind === parent.unit.kind));
}

const PREC: Record<string, number> = { cmp: 1, '+': 2, '-': 2, '*': 3, '/': 3, '^': 5 };

/** Print an AST using display names; used in error messages. */
export function printAst(ast: Ast, ix: ModelIndex, contextId: string | null): string {
  const p = (a: Ast, parentPrec: number): string => {
    switch (a.k) {
      case 'num':
        return String(a.v);
      case 'ref': {
        const base = a.target.kind === 'id' ? displayRef(ix, a.target.id, contextId) : `[${a.target.name}]`;
        return a.period ? `${base}@${a.period}` : base;
      }
      case 'neg':
        return `-${p(a.a, 4)}`;
      case 'pct':
        return `${p(a.a, 6)}%`;
      case 'bin': {
        const prec = PREC[a.op];
        const s = `${p(a.a, prec)} ${a.op} ${p(a.b, prec + (a.op === '^' ? 0 : 1))}`;
        return prec < parentPrec ? `(${s})` : s;
      }
      case 'cmp': {
        const s = `${p(a.a, 2)} ${a.op} ${p(a.b, 2)}`;
        return parentPrec > 1 ? `(${s})` : s;
      }
      case 'call':
        return `${a.fn}(${a.args.map((x) => p(x, 0)).join(', ')})`;
    }
  };
  return p(ast, 0);
}
