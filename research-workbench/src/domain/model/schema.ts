import { z } from 'zod';
import { indexModel, ancestors } from './tree';
import { SCALAR_KEY, type ModelState } from './types';
import { PERIOD_ID_RE } from './ops';

const finite = z.number().refine(Number.isFinite, 'must be a finite number');
const numRecord = z.record(z.string(), finite);
const scenarioRecord = <T extends z.ZodTypeAny>(t: T) => z.object({ bear: t, base: t, bull: t });

export const unitSchema = z.object({
  kind: z.enum(['currency', 'per_share', 'percent', 'multiple', 'shares', 'count', 'number']),
  currency: z.string().min(1).max(8).optional(),
  scale: z.union([z.literal(1), z.literal(1e3), z.literal(1e6), z.literal(1e8), z.literal(1e9)]),
  label: z.string().max(40).optional(),
});

export const nodeSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  parentId: z.string().nullable(),
  timeMode: z.enum(['series', 'scalar']),
  unit: unitSchema.nullable(),
  role: z
    .enum(['eps', 'revenue', 'gross_margin', 'operating_income', 'net_income', 'diluted_shares', 'eps_growth', 'roic', 'reinvestment_roi', 'target_multiple', 'target_price', 'rerating'])
    .optional(),
  formula: z.string().max(4000).optional(),
  values: numRecord,
  overrides: z.object({ bear: numRecord.optional(), bull: numRecord.optional() }),
  cellStatus: z.record(z.string(), z.enum(['A', 'E'])),
  notes: z.string().max(100_000),
});

export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  periods: z.array(
    z.object({
      id: z.string().regex(PERIOD_ID_RE),
      label: z.string().min(1).max(40),
      status: z.enum(['A', 'E']),
      endDate: z.string().optional(),
    }),
  ),
  nodes: z.array(nodeSchema),
  links: z.array(
    z.object({
      id: z.string().min(1),
      evidenceId: z.string().min(1),
      nodeId: z.string().min(1),
      relation: z.enum(['supports', 'contradicts', 'context', 'triggered']),
      locator: z.string().max(200).optional(),
      note: z.string().max(10_000).optional(),
    }),
  ),
  theses: z.array(
    z.object({
      id: z.string().min(1),
      statement: z.string().max(10_000),
      invalidation: z.string().max(10_000),
      nodeIds: z.array(z.string()),
      status: z.enum(['active', 'confirmed', 'invalidated', 'retired']),
      reviewBy: z.string().optional(),
    }),
  ),
  valuation: z.object({
    peers: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().max(200),
        ticker: z.string().max(40).optional(),
        pe: finite.optional(),
        epsGrowth: finite.optional(),
        roic: finite.optional(),
        grossMargin: finite.optional(),
        basis: z.string().max(40).optional(),
        source: z.string().max(1000).optional(),
        asOf: z.string().max(40).optional(),
        note: z.string().max(10_000).optional(),
      }),
    ),
    historicalPE: z.object({
      low: finite.optional(),
      median: finite.optional(),
      high: finite.optional(),
      window: z.string().max(200).optional(),
      source: z.string().max(1000).optional(),
      asOf: z.string().max(40).optional(),
      note: z.string().max(10_000).optional(),
    }),
    rationale: scenarioRecord(z.string().max(20_000)),
    probabilities: scenarioRecord(finite.nullable()),
  }),
});

/** Structural invariants beyond the shape. Returns human-readable problems (empty = valid). */
export function validateState(state: ModelState): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const n of state.nodes) {
    if (ids.has(n.id)) problems.push(`Duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  const pids = new Set<string>();
  for (const p of state.periods) {
    if (pids.has(p.id)) problems.push(`Duplicate period ${p.id}`);
    pids.add(p.id);
  }
  const ix = indexModel(state);
  const roles = new Set<string>();
  for (const n of state.nodes) {
    if (n.parentId !== null && !ids.has(n.parentId)) problems.push(`${n.name}: parent ${n.parentId} does not exist`);
    if (n.parentId !== null) {
      const anc = ancestors(ix, n.id);
      if (anc.some((a) => a.id === n.id) || n.parentId === n.id) problems.push(`${n.name}: hierarchy cycle`);
    }
    if (n.role) {
      if (roles.has(n.role)) problems.push(`Role ${n.role} is assigned to more than one node`);
      roles.add(n.role);
    }
    const validKeys = n.timeMode === 'scalar' ? new Set([SCALAR_KEY]) : pids;
    for (const k of Object.keys(n.values)) if (!validKeys.has(k)) problems.push(`${n.name}: value for unknown period ${k}`);
    for (const s of ['bear', 'bull'] as const) {
      for (const k of Object.keys(n.overrides[s] ?? {})) {
        if (!validKeys.has(k)) problems.push(`${n.name}: ${s} override for unknown period ${k}`);
        else if (k !== SCALAR_KEY) {
          const p = state.periods.find((x) => x.id === k)!;
          if ((n.cellStatus[k] ?? p.status) === 'A') problems.push(`${n.name}: ${s} override on actual period ${k}`);
        }
      }
    }
    for (const k of Object.keys(n.cellStatus)) if (!pids.has(k)) problems.push(`${n.name}: status for unknown period ${k}`);
  }
  for (const l of state.links) if (!ids.has(l.nodeId)) problems.push(`Evidence link ${l.id} points to a missing node`);
  return problems;
}

export type ParseStateResult = { ok: true; state: ModelState } | { ok: false; errors: string[] };

export function parseState(input: unknown): ParseStateResult {
  const r = stateSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, errors: r.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const state = r.data as ModelState;
  const problems = validateState(state);
  return problems.length ? { ok: false, errors: problems } : { ok: true, state };
}
