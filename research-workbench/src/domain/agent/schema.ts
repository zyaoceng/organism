/**
 * The draft operations an AI may send (POST /api/projects/:id/draft/ops, MCP tool edit_draft).
 * Shared by the server and the MCP adapter, so the tool schema and the server check are one thing.
 */
import { z } from 'zod';

const nodeRef = z.string().trim().min(1).max(400).describe('節點名稱、路徑「父/子」或 id（n_xxxxxxxx）');
const periodRef = z.string().trim().min(1).max(40).describe('期間 id（FY2026）或標籤（2026、2026E）；單一數值節點不填');
const scenario = z.enum(['base', 'bear', 'bull']);
const valueIn = z.union([z.string().max(60), z.number(), z.null()]).describe('數值要帶單位："18.5%"、"1,234 億"、"25x"、"12.3 元"、"3,000 股"；null 清空');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const unitSpec = z.object({
  kind: z.enum(['currency', 'per_share', 'percent', 'multiple', 'shares', 'count', 'number']),
  currency: z.string().length(3).optional(),
  scale: z.enum(['元', '千', '百萬', '億', '十億']).optional(),
  label: z.string().max(40).optional(),
});

export const DraftOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_value'), node: nodeRef, period: periodRef.optional(), scenario: scenario.optional(), value: valueIn, allow_override_formula: z.boolean().optional() }),
  z.object({ op: z.literal('set_values'), node: nodeRef, scenario: scenario.optional(), values: z.record(z.string(), valueIn), allow_override_formula: z.boolean().optional() }),
  z.object({ op: z.literal('set_formula'), node: nodeRef, formula: z.string().max(4000).nullable() }),
  z.object({
    op: z.literal('add_node'),
    parent: nodeRef.nullable(),
    name: z.string().trim().min(1).max(200),
    unit: unitSpec.nullable().optional(),
    time_mode: z.enum(['series', 'scalar']).optional(),
    position: z.number().int().min(0).optional(),
  }),
  z.object({ op: z.literal('rename_node'), node: nodeRef, name: z.string().trim().min(1).max(200) }),
  z.object({ op: z.literal('move_node'), node: nodeRef, parent: nodeRef.nullable(), position: z.number().int().min(0).optional() }),
  z.object({ op: z.literal('delete_node'), node: nodeRef }),
  z.object({ op: z.literal('set_notes'), node: nodeRef, notes: z.string().max(100_000) }),
  z.object({
    op: z.literal('link_evidence'),
    node: nodeRef,
    evidence_id: z.string().min(1),
    relation: z.enum(['supports', 'contradicts', 'context', 'triggered']).optional(),
    locator: z.string().max(200).optional(),
    note: z.string().max(10_000).optional(),
  }),
  z.object({
    op: z.literal('add_thesis'),
    statement: z.string().trim().min(1).max(10_000),
    invalidation: z.string().max(10_000).optional(),
    nodes: z.array(nodeRef).max(50).optional(),
    review_by: isoDate.optional(),
  }),
  z.object({
    op: z.literal('update_thesis'),
    thesis_id: z.string().min(1),
    statement: z.string().max(10_000).optional(),
    invalidation: z.string().max(10_000).optional(),
    status: z.enum(['active', 'confirmed', 'invalidated', 'retired']).optional(),
    review_by: isoDate.nullable().optional(),
    nodes: z.array(nodeRef).max(50).optional(),
  }),
  z.object({ op: z.literal('set_rationale'), scenario, text: z.string().max(20_000) }),
  z.object({
    op: z.literal('add_peer'),
    name: z.string().min(1).max(200),
    ticker: z.string().max(40).optional(),
    pe: valueIn.optional(),
    eps_growth: valueIn.optional(),
    roic: valueIn.optional(),
    gross_margin: valueIn.optional(),
    basis: z.string().max(40).optional(),
    source: z.string().max(1000).optional(),
    as_of: z.string().max(40).optional(),
    note: z.string().max(10_000).optional(),
  }),
]);
export type DraftOp = z.infer<typeof DraftOpSchema>;

export const DraftOpsRequestSchema = z.object({
  ops: z.array(DraftOpSchema).min(1).max(100),
  expectedVersion: z.number().int().positive().optional(),
  dryRun: z.boolean().default(false),
  rationale: z.string().max(2000).optional(),
  previewHash: z.string().max(64).optional(),
});
export type DraftOpsRequest = z.infer<typeof DraftOpsRequestSchema>;
