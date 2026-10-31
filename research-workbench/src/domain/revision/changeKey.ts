import type { ModelChange } from './diff';

/**
 * The field a change touches, as a stable key. Two changes with the same key edit the same thing,
 * so the later writer owns it (draft attribution) and a concurrent edit of it is a conflict (rebase).
 */
export function changeKey(c: ModelChange): string {
  switch (c.type) {
    case 'value_changed':
      return `v:${c.nodeId}:${c.periodKey}:${c.scenario}`;
    case 'formula_changed':
      return `f:${c.nodeId}`;
    case 'node_added':
    case 'node_removed':
      return `n:${c.nodeId}`;
    case 'node_renamed':
      return `name:${c.nodeId}`;
    case 'node_moved':
      return `parent:${c.nodeId}`;
    case 'node_unit':
      return `unit:${c.nodeId}`;
    case 'node_role':
      return `role:${c.nodeId}`;
    case 'node_time_mode':
      return `tm:${c.nodeId}`;
    case 'cell_status_changed':
      return `cs:${c.nodeId}:${c.periodKey}`;
    case 'notes_changed':
      return `notes:${c.nodeId}`;
    case 'period_added':
    case 'period_removed':
      return `p:${c.periodId}`;
    case 'period_changed':
      return `p:${c.periodId}:${c.field}`;
    case 'link_added':
    case 'link_removed':
    case 'link_changed':
      return `l:${c.linkId}`;
    case 'thesis_added':
    case 'thesis_removed':
    case 'thesis_changed':
      return `t:${c.thesisId}`;
    case 'valuation_changed':
      return `val:${c.path}`;
    case 'children_reordered':
      return `order:${c.parentId ?? 'root'}`;
  }
}
