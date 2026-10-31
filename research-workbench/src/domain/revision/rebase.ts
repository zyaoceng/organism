/**
 * Three-way merge of draft edits. When the server's draft moved on (an AI or another window wrote
 * it) while this tab still had unsaved edits, the tab's changes since the last state both sides
 * shared (`base`) are replayed onto the server's version (`remote`).
 *
 * Each local change touches one field (changeKey). It is applied only when the remote field still
 * equals the base (nobody else touched it) or already equals the local value. Anything else is a
 * conflict and is left out; nothing is guessed. The caller keeps the whole local state ("my version")
 * so a conflict never loses work.
 */
import { findCycleWith } from '../calc/graph';
import { deleteNode, formulaRefIds, moveNode, removePeriod, updatePeriod } from '../model/ops';
import { parseState } from '../model/schema';
import { cellStatus, childrenOf, descendants, indexModel } from '../model/tree';
import { SCALAR_KEY, type EvidenceLink, type ModelNode, type ModelState, type Peer, type Thesis } from '../model/types';
import { describeChange } from './describe';
import { diffStates, type ModelChange } from './diff';

export interface RebaseConflict {
  change: ModelChange;
  text: string;
}

export interface RebaseResult {
  /** `remote` with every applicable local change. Always passes parseState. */
  state: ModelState;
  applied: ModelChange[];
  conflicts: RebaseConflict[];
}

export interface RebaseOptions {
  /** Language of the conflict texts (default zh-TW). */
  lang?: 'en' | 'zh-TW';
}

/** Deep equality of JSON-like data; a key holding undefined counts as absent. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameValue(x, bb[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue(ra[k], rb[k]));
}

/** A field that does not exist in a state (its node, period, link… is missing). */
const MISSING = Symbol('missing');
type Got = unknown | typeof MISSING;

// Order of replay: structure first, so later changes find their nodes and periods.
const PHASE: Record<ModelChange['type'], number> = {
  period_added: 0,
  period_removed: 0,
  period_changed: 0,
  node_added: 1,
  node_moved: 2,
  node_renamed: 2,
  node_unit: 2,
  node_role: 2,
  node_time_mode: 2,
  notes_changed: 2,
  value_changed: 3,
  cell_status_changed: 3,
  node_removed: 4,
  formula_changed: 5,
  link_added: 6,
  link_removed: 6,
  link_changed: 6,
  thesis_added: 6,
  thesis_removed: 6,
  thesis_changed: 6,
  valuation_changed: 7,
  children_reordered: 8,
};

const blank = (x: unknown) => (x === undefined || x === '' ? null : x);

export function rebaseChanges(base: ModelState, local: ModelState, remote: ModelState, opts: RebaseOptions = {}): RebaseResult {
  const lang = opts.lang ?? 'zh-TW';
  const changes = diffStates(base, local);
  if (!changes.length) return { state: remote, applied: [], conflicts: [] };
  const periodLabel = (k: string) => {
    const p = local.periods.find((x) => x.id === k) ?? remote.periods.find((x) => x.id === k);
    return p ? `${p.label}${p.status}` : k;
  };
  const suffix = lang === 'zh-TW' ? '（另一邊也改了）' : ' (also changed elsewhere)';
  const text = (c: ModelChange) => describeChange(c, { lang, periodLabel }) + suffix;

  const ixBase = indexModel(base);
  const ixLocal = indexModel(local);
  const ixRemote = indexModel(remote);
  const baseNode = (id: string) => ixBase.byId.get(id);
  const localNode = (id: string) => ixLocal.byId.get(id);

  let cur = remote;
  const applied: ModelChange[] = [];
  const conflicts: RebaseConflict[] = [];
  // Nodes and periods whose own change conflicted: their dependent changes are dropped silently.
  const skippedNodes = new Set<string>();
  const skippedPeriods = new Set<string>();

  const curNode = (id: string) => cur.nodes.find((n) => n.id === id);
  const mapNode = (id: string, fn: (n: ModelNode) => ModelNode) => {
    cur = { ...cur, nodes: cur.nodes.map((n) => (n.id === id ? fn(n) : n)) };
  };
  const conflict = (c: ModelChange) => conflicts.push({ change: c, text: text(c) });

  /** The usual three-way rule on one field. */
  function merge(c: ModelChange, get: (s: ModelState) => Got, set: (localValue: unknown) => void | false) {
    // a field of something only this side created (a copied new node) starts out empty
    const gb = get(base);
    const b = gb === MISSING ? null : gb;
    const l = get(local);
    const r = get(cur);
    if (r !== MISSING && sameValue(r, l)) return void applied.push(c);
    if (r === MISSING || l === MISSING || !sameValue(r, b)) return conflict(c);
    if (set(l) === false) return conflict(c);
    applied.push(c);
  }

  /** Sibling position in `cur` that keeps the node after the local sibling before it. */
  function positionFor(id: string, parentId: string | null): number {
    const localSibs = childrenOf(ixLocal, parentId).map((n) => n.id);
    const curSibs = childrenOf(indexModel(cur), parentId)
      .map((n) => n.id)
      .filter((x) => x !== id);
    for (let k = localSibs.indexOf(id) - 1; k >= 0; k--) {
      const p = curSibs.indexOf(localSibs[k]);
      if (p >= 0) return p + 1;
    }
    return 0;
  }

  const nodeField = <K extends keyof ModelNode>(id: string, key: K) => (s: ModelState): Got => {
    const n = s.nodes.find((x) => x.id === id);
    return n ? (n[key] ?? null) : MISSING;
  };

  // added nodes: parents before children, whatever the order of the nodes array
  const depth = (c: ModelChange) => {
    let d = 0;
    if (c.type === 'node_added') for (let n = localNode(c.nodeId); n?.parentId && d < 1000; n = localNode(n.parentId)) d++;
    return d;
  };
  const ordered = changes.map((c, i) => ({ c, i, d: depth(c) })).sort((a, b) => PHASE[a.c.type] - PHASE[b.c.type] || a.d - b.d || a.i - b.i);

  for (const { c } of ordered) {
    switch (c.type) {
      // ------------------------------------------------------------ periods
      case 'period_added': {
        const p = local.periods.find((x) => x.id === c.periodId)!;
        const existing = cur.periods.find((x) => x.id === c.periodId);
        if (existing) {
          if (sameValue(existing, p)) applied.push(c);
          else (conflict(c), skippedPeriods.add(c.periodId));
          break;
        }
        const li = local.periods.findIndex((x) => x.id === c.periodId);
        let at = 0;
        for (let k = li - 1; k >= 0; k--) {
          const j = cur.periods.findIndex((x) => x.id === local.periods[k].id);
          if (j >= 0) {
            at = j + 1;
            break;
          }
        }
        const periods = [...cur.periods];
        periods.splice(at, 0, { ...p });
        cur = { ...cur, periods };
        applied.push(c);
        break;
      }
      case 'period_removed': {
        const r = cur.periods.find((x) => x.id === c.periodId);
        if (!r) {
          applied.push(c);
          break;
        }
        const b = base.periods.find((x) => x.id === c.periodId);
        // nobody else may have changed the period or written data into it
        const untouched =
          sameValue(r, b) &&
          cur.nodes.every((n) => {
            const bn = baseNode(n.id);
            const pick = (x: ModelNode | undefined) => [x?.values[c.periodId] ?? null, x?.overrides.bear?.[c.periodId] ?? null, x?.overrides.bull?.[c.periodId] ?? null, x?.cellStatus[c.periodId] ?? null];
            return sameValue(pick(n), pick(bn));
          });
        if (!untouched) {
          conflict(c);
          skippedPeriods.add(c.periodId);
          break;
        }
        try {
          cur = removePeriod(cur, c.periodId);
          applied.push(c);
        } catch {
          conflict(c);
          skippedPeriods.add(c.periodId);
        }
        break;
      }
      case 'period_changed': {
        if (skippedPeriods.has(c.periodId)) break;
        merge(
          c,
          (s) => {
            const p = s.periods.find((x) => x.id === c.periodId);
            return p ? (p[c.field] ?? null) : MISSING;
          },
          (v) => {
            if (c.field === 'status') cur = updatePeriod(cur, c.periodId, { status: v as 'A' | 'E' });
            else cur = { ...cur, periods: cur.periods.map((p) => (p.id === c.periodId ? withField(p, c.field, v) : p)) };
          },
        );
        break;
      }

      // ------------------------------------------------------------ nodes
      case 'node_added': {
        const n = localNode(c.nodeId)!;
        const existing = curNode(c.nodeId);
        if (existing) {
          if (sameValue(existing, n)) applied.push(c);
          else (conflict(c), skippedNodes.add(c.nodeId));
          break;
        }
        if (n.parentId !== null && skippedNodes.has(n.parentId)) {
          skippedNodes.add(c.nodeId);
          break;
        }
        const roleTaken = n.role && cur.nodes.some((x) => x.role === n.role);
        if ((n.parentId !== null && !curNode(n.parentId)) || roleTaken) {
          conflict(c);
          skippedNodes.add(c.nodeId);
          break;
        }
        // the formula is replayed later (formula_changed), once every node it refers to exists
        const { formula: _f, ...copy } = n;
        cur = { ...cur, nodes: [...cur.nodes, copy] };
        cur = moveNode(cur, n.id, n.parentId, positionFor(n.id, n.parentId));
        applied.push(c);
        break;
      }
      case 'node_moved': {
        if (skippedNodes.has(c.nodeId)) break;
        const to = localNode(c.nodeId)!.parentId;
        merge(c, nodeField(c.nodeId, 'parentId'), () => {
          if (to !== null && !curNode(to)) return false;
          try {
            cur = moveNode(cur, c.nodeId, to, positionFor(c.nodeId, to));
          } catch {
            return false;
          }
        });
        break;
      }
      case 'node_renamed':
        if (!skippedNodes.has(c.nodeId)) merge(c, nodeField(c.nodeId, 'name'), (v) => mapNode(c.nodeId, (n) => ({ ...n, name: v as string })));
        break;
      case 'node_unit':
        if (!skippedNodes.has(c.nodeId)) merge(c, nodeField(c.nodeId, 'unit'), (v) => mapNode(c.nodeId, (n) => ({ ...n, unit: (v as ModelNode['unit']) ?? null })));
        break;
      case 'notes_changed':
        if (!skippedNodes.has(c.nodeId)) merge(c, nodeField(c.nodeId, 'notes'), (v) => mapNode(c.nodeId, (n) => ({ ...n, notes: v as string })));
        break;
      case 'node_role':
        if (skippedNodes.has(c.nodeId)) break;
        merge(c, nodeField(c.nodeId, 'role'), (v) => {
          if (v !== null && cur.nodes.some((x) => x.id !== c.nodeId && x.role === v)) return false;
          mapNode(c.nodeId, (n) => {
            const { role: _r, ...rest } = n;
            return v === null ? rest : { ...rest, role: v as ModelNode['role'] };
          });
        });
        break;
      case 'node_time_mode': {
        if (skippedNodes.has(c.nodeId)) break;
        // the mode and the cells it keys are one field: values cannot be merged across modes
        const cells = (s: ModelState): Got => {
          const n = s.nodes.find((x) => x.id === c.nodeId);
          return n ? { timeMode: n.timeMode, values: n.values, overrides: n.overrides, cellStatus: n.cellStatus } : MISSING;
        };
        const l = localNode(c.nodeId)!;
        merge(c, cells, () => mapNode(c.nodeId, (n) => ({ ...n, timeMode: l.timeMode, values: { ...l.values }, overrides: structuredCopy(l.overrides), cellStatus: { ...l.cellStatus } })));
        break;
      }
      case 'value_changed': {
        if (skippedNodes.has(c.nodeId) || skippedPeriods.has(c.periodKey)) break;
        const n = curNode(c.nodeId);
        if (!n) {
          conflict(c);
          break;
        }
        const get = (s: ModelState): Got => {
          const x = s.nodes.find((y) => y.id === c.nodeId);
          if (!x) return MISSING;
          return (c.scenario === 'base' ? x.values[c.periodKey] : x.overrides[c.scenario]?.[c.periodKey]) ?? null;
        };
        const write = (v: number | null) =>
          mapNode(c.nodeId, (x) => {
            if (c.scenario === 'base') return { ...x, values: withKey(x.values, c.periodKey, v) };
            const rec = withKey(x.overrides[c.scenario] ?? {}, c.periodKey, v);
            const overrides = { ...x.overrides };
            if (Object.keys(rec).length) overrides[c.scenario] = rec;
            else delete overrides[c.scenario];
            return { ...x, overrides };
          });
        // the other side removed the period or changed the node to the other time mode
        if (!(n.timeMode === 'scalar' ? c.periodKey === SCALAR_KEY : cur.periods.some((p) => p.id === c.periodKey))) {
          write(null);
          conflict(c);
          break;
        }
        const before = conflicts.length;
        merge(c, get, (v) => write(v as number | null));
        // a Bear/Bull value cannot sit on a cell the other side made Actual
        const after = curNode(c.nodeId)!;
        if (conflicts.length === before && c.scenario !== 'base' && c.to !== null && cellStatus(indexModel(cur), after, c.periodKey) === 'A') {
          write(null);
          applied.pop();
          conflict(c);
        }
        break;
      }
      case 'cell_status_changed': {
        if (skippedNodes.has(c.nodeId) || skippedPeriods.has(c.periodKey)) break;
        if (!cur.periods.some((p) => p.id === c.periodKey)) {
          if (curNode(c.nodeId)) mapNode(c.nodeId, (n) => ({ ...n, cellStatus: withKey(n.cellStatus, c.periodKey, null) }));
          conflict(c);
          break;
        }
        merge(
          c,
          (s) => {
            const n = s.nodes.find((x) => x.id === c.nodeId);
            return n ? (n.cellStatus[c.periodKey] ?? null) : MISSING;
          },
          (v) =>
            mapNode(c.nodeId, (n) => {
              const cs = withKey(n.cellStatus, c.periodKey, v as 'A' | 'E' | null);
              const status = cs[c.periodKey] ?? cur.periods.find((p) => p.id === c.periodKey)!.status;
              return { ...n, cellStatus: cs, overrides: status === 'A' ? dropOverride(n.overrides, c.periodKey) : n.overrides };
            }),
        );
        break;
      }
      case 'node_removed': {
        if (!curNode(c.nodeId)) {
          applied.push(c);
          break;
        }
        // a descendant of a node whose removal conflicted stays with it
        let inSkipped = false;
        for (let p = baseNode(c.nodeId)?.parentId ?? null; p; p = baseNode(p)?.parentId ?? null) if (skippedNodes.has(p)) inSkipped = true;
        if (inSkipped) break;
        // Removable only if the other side left the whole branch alone and did not start referring
        // to it. Nodes this side moved out of the branch before deleting it are not part of it.
        const gone = (ids: string[]) => ids.filter((id) => !ixLocal.byId.has(id));
        const baseGone = gone([c.nodeId, ...(baseNode(c.nodeId) ? descendants(ixBase, c.nodeId) : [])]);
        const remoteGone = gone([c.nodeId, ...descendants(ixRemote, c.nodeId)]);
        const curSubtree = [c.nodeId, ...descendants(indexModel(cur), c.nodeId)];
        const removed = new Set(curSubtree);
        const untouched =
          sameValue([...baseGone].sort(), [...remoteGone].sort()) &&
          remoteGone.every((id) => sameValue(ixRemote.byId.get(id), baseNode(id))) &&
          curSubtree.every((id) => !ixLocal.byId.has(id)) &&
          cur.nodes.every((n) => removed.has(n.id) || !n.formula || !formulaRefIds(n.formula).some((r) => removed.has(r)) || n.formula === baseNode(n.id)?.formula);
        if (!untouched) {
          conflict(c);
          skippedNodes.add(c.nodeId);
          break;
        }
        cur = deleteNode(cur, c.nodeId).state;
        applied.push(c);
        break;
      }
      case 'formula_changed': {
        if (skippedNodes.has(c.nodeId)) break;
        const to = localNode(c.nodeId)?.formula;
        merge(c, nodeField(c.nodeId, 'formula'), () => {
          if (to) {
            const ids = new Set(cur.nodes.map((n) => n.id));
            if (formulaRefIds(to).some((r) => !ids.has(r))) return false;
            if (findCycleWith(cur, c.nodeId, to)) return false;
          }
          mapNode(c.nodeId, (n) => {
            const { formula: _f, ...rest } = n;
            return to ? { ...rest, formula: to } : rest;
          });
        });
        break;
      }

      // ------------------------------------------------------------ links and theses
      case 'link_added': {
        const l = local.links.find((x) => x.id === c.linkId)!;
        const existing = cur.links.find((x) => x.id === c.linkId);
        if (existing) {
          if (sameValue(existing, l)) applied.push(c);
          else conflict(c);
        } else if (!curNode(l.nodeId)) conflict(c);
        else if (cur.links.some((x) => x.nodeId === l.nodeId && x.evidenceId === l.evidenceId)) applied.push(c);
        else {
          cur = { ...cur, links: [...cur.links, { ...l }] };
          applied.push(c);
        }
        break;
      }
      case 'link_removed': {
        const r = cur.links.find((x) => x.id === c.linkId);
        if (!r) applied.push(c);
        else if (sameValue(r, base.links.find((x) => x.id === c.linkId))) {
          cur = { ...cur, links: cur.links.filter((x) => x.id !== c.linkId) };
          applied.push(c);
        } else conflict(c);
        break;
      }
      case 'link_changed': {
        const field = c.field as 'relation' | 'locator' | 'note';
        merge(
          c,
          (s) => {
            const l = s.links.find((x) => x.id === c.linkId);
            return l ? blank(l[field]) : MISSING;
          },
          (v) => {
            cur = { ...cur, links: cur.links.map((l) => (l.id === c.linkId ? (withField(l, field, v) as EvidenceLink) : l)) };
          },
        );
        break;
      }
      case 'thesis_added': {
        const t = local.theses.find((x) => x.id === c.thesisId)!;
        const existing = cur.theses.find((x) => x.id === c.thesisId);
        if (existing) {
          if (sameValue(existing, t)) applied.push(c);
          else conflict(c);
          break;
        }
        const ids = new Set(cur.nodes.map((n) => n.id));
        cur = { ...cur, theses: [...cur.theses, { ...t, nodeIds: t.nodeIds.filter((id) => ids.has(id)) }] };
        applied.push(c);
        break;
      }
      case 'thesis_removed': {
        const r = cur.theses.find((x) => x.id === c.thesisId);
        if (!r) applied.push(c);
        else if (sameValue(r, base.theses.find((x) => x.id === c.thesisId))) {
          cur = { ...cur, theses: cur.theses.filter((x) => x.id !== c.thesisId) };
          applied.push(c);
        } else conflict(c);
        break;
      }
      case 'thesis_changed': {
        const key = (c.field === 'nodes' ? 'nodeIds' : c.field) as keyof Thesis;
        merge(
          c,
          (s) => {
            const t = s.theses.find((x) => x.id === c.thesisId);
            return t ? blank(t[key]) : MISSING;
          },
          (v) => {
            const ids = new Set(cur.nodes.map((n) => n.id));
            const set = (t: Thesis): Thesis => {
              if (key === 'nodeIds') return { ...t, nodeIds: (v as string[]).filter((id) => ids.has(id)) };
              if (key === 'reviewBy') return withField(t, key, v);
              return { ...t, [key]: v ?? '' };
            };
            cur = { ...cur, theses: cur.theses.map((t) => (t.id === c.thesisId ? set(t) : t)) };
          },
        );
        break;
      }

      // ------------------------------------------------------------ valuation context
      case 'valuation_changed': {
        const [head, id, field] = c.path.split('.');
        if (head === 'peers' && !field) {
          const lp = local.valuation.peers.find((p) => p.id === id);
          const rp = cur.valuation.peers.find((p) => p.id === id);
          if (lp) {
            if (rp) sameValue(rp, lp) ? applied.push(c) : conflict(c);
            else {
              cur = { ...cur, valuation: { ...cur.valuation, peers: [...cur.valuation.peers, { ...lp }] } };
              applied.push(c);
            }
          } else if (!rp) applied.push(c);
          else if (sameValue(rp, base.valuation.peers.find((p) => p.id === id))) {
            cur = { ...cur, valuation: { ...cur.valuation, peers: cur.valuation.peers.filter((p) => p.id !== id) } };
            applied.push(c);
          } else conflict(c);
          break;
        }
        if (head === 'peers') {
          const f = field as keyof Peer;
          merge(
            c,
            (s) => {
              const p = s.valuation.peers.find((x) => x.id === id);
              return p ? blank(p[f]) : MISSING;
            },
            (v) => {
              cur = { ...cur, valuation: { ...cur.valuation, peers: cur.valuation.peers.map((p) => (p.id === id ? (withField(p, f, v) as Peer) : p)) } };
            },
          );
          break;
        }
        if (head === 'historicalPE' || head === 'rationale' || head === 'probabilities') {
          const sect = head;
          merge(
            c,
            (s) => blank((s.valuation[sect] as Record<string, unknown>)[id]),
            (v) => {
              const next = { ...(cur.valuation[sect] as Record<string, unknown>) };
              if (sect === 'historicalPE' && v === null) delete next[id];
              else next[id] = sect === 'rationale' ? (v ?? '') : v;
              cur = { ...cur, valuation: { ...cur.valuation, [sect]: next } };
            },
          );
          break;
        }
        conflict(c);
        break;
      }

      // ------------------------------------------------------------ sibling order
      case 'children_reordered': {
        const pid = c.parentId;
        if (pid !== null && !curNode(pid)) {
          conflict(c);
          break;
        }
        const curKids = childrenOf(indexModel(cur), pid).map((n) => n.id);
        const baseKids = childrenOf(ixBase, pid).map((n) => n.id);
        const localKids = childrenOf(ixLocal, pid).map((n) => n.id);
        // children that this side moved in or created were placed already; compare the rest
        const shared = new Set(curKids.filter((id) => localKids.includes(id) && baseKids.includes(id)));
        const seq = (list: string[]) => list.filter((id) => shared.has(id)).join();
        if (seq(curKids) === seq(localKids)) {
          applied.push(c);
          break;
        }
        if (seq(curKids) !== seq(baseKids)) {
          conflict(c);
          break;
        }
        // put the shared children in local order, keeping the other side's new children in their slots
        const wanted = localKids.filter((id) => shared.has(id));
        let k = 0;
        const final = curKids.map((id) => (shared.has(id) ? wanted[k++] : id));
        final.forEach((id, i) => (cur = moveNode(cur, id, pid, i)));
        applied.push(c);
        break;
      }
    }
  }

  const check = parseState(cur);
  if (!check.ok) {
    const whole = lang === 'zh-TW' ? `合併後的模型無效（${check.errors.slice(0, 3).join('；')}），沒有重套任何修改` : `The merged model is invalid (${check.errors.slice(0, 3).join('; ')}); nothing was re-applied`;
    return { state: remote, applied: [], conflicts: [{ change: changes[0], text: whole }] };
  }
  return { state: cur, applied, conflicts };
}

function withKey<V>(rec: Record<string, V>, key: string, v: V | null): Record<string, V> {
  const next = { ...rec };
  if (v === null) delete next[key];
  else next[key] = v;
  return next;
}

/** Copy of an object with one optional field set, or removed when the value is empty. */
function withField<T extends object>(obj: T, key: PropertyKey, v: unknown): T {
  const next = { ...obj } as Record<PropertyKey, unknown>;
  if (v === null || v === undefined || v === '') delete next[key];
  else next[key] = v;
  return next as T;
}

function dropOverride(ov: ModelNode['overrides'], key: string): ModelNode['overrides'] {
  const out: ModelNode['overrides'] = {};
  for (const s of ['bear', 'bull'] as const) {
    const rec = ov[s];
    if (!rec) continue;
    const rest = withKey(rec, key, null);
    if (Object.keys(rest).length) out[s] = rest;
  }
  return out;
}

const structuredCopy = (ov: ModelNode['overrides']): ModelNode['overrides'] => Object.fromEntries(Object.entries(ov).map(([k, v]) => [k, { ...v }]));
