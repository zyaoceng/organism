import { formatValue } from '../format';
import { NODE_ROLES, scenarioName } from '../model/types';
import { unitLabel } from '../units';
import type { ModelChange } from './diff';

export interface DescribeContext {
  periodLabel?: (key: string) => string;
  evidenceTitle?: (id: string) => string;
}

const q = (s: string | null | undefined) => (s ? `“${s.length > 80 ? `${s.slice(0, 77)}…` : s}”` : '(empty)');

export function describeChange(c: ModelChange, ctx: DescribeContext = {}): string {
  const pl = (k: string) => (k === '_' ? 'value' : ctx.periodLabel?.(k) ?? k);
  const ev = (id: string) => ctx.evidenceTitle?.(id) ?? 'evidence';
  switch (c.type) {
    case 'node_added':
      return `Added ${c.name}${c.parentName ? ` under ${c.parentName}` : ''}`;
    case 'node_removed':
      return `Removed ${c.name}`;
    case 'node_renamed':
      return `Renamed ${c.from} → ${c.to}`;
    case 'node_moved':
      return `Moved ${c.name}: ${c.fromParent ?? 'top level'} → ${c.toParent ?? 'top level'}`;
    case 'children_reordered':
      return `Reordered items under ${c.parentName ?? 'top level'}`;
    case 'node_unit':
      return `${c.name} unit: ${unitLabel(c.from) || 'none'} → ${unitLabel(c.to) || 'none'}`;
    case 'node_role': {
      const label = (r: string | null) => NODE_ROLES.find((x) => x.value === r)?.label ?? 'none';
      return `${c.name} role: ${label(c.from)} → ${label(c.to)}`;
    }
    case 'node_time_mode':
      return `${c.name}: ${c.from === 'scalar' ? 'single value' : 'time series'} → ${c.to === 'scalar' ? 'single value' : 'time series'}`;
    case 'formula_changed':
      if (!c.from) return `${c.name} formula set: ${c.to}`;
      if (!c.to) return `${c.name} formula removed (was ${c.from})`;
      return `${c.name} formula: ${c.from} → ${c.to}`;
    case 'value_changed': {
      const sc = c.scenario === 'base' ? '' : ` (${scenarioName(c.scenario)})`;
      const f = c.from === null ? (c.scenario === 'base' ? 'empty' : 'inherits Base') : formatValue(c.from, c.unit);
      const t = c.to === null ? (c.scenario === 'base' ? 'empty' : 'inherits Base') : formatValue(c.to, c.unit);
      return `${c.name} ${pl(c.periodKey)}${sc}: ${f} → ${t}`;
    }
    case 'cell_status_changed':
      return `${c.name} ${pl(c.periodKey)} marked ${c.to === 'A' ? 'actual' : c.to === 'E' ? 'estimate' : 'as its period'}`;
    case 'notes_changed':
      return `${c.name} notes edited`;
    case 'period_added':
      return `Period ${c.label}${c.status} added`;
    case 'period_removed':
      return `Period ${c.label} removed`;
    case 'period_changed':
      if (c.field === 'status') return `Period ${pl(c.periodId)} is now ${c.to === 'A' ? 'Actual' : 'Estimate'}`;
      return `Period ${c.periodId} ${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`;
    case 'link_added':
      return `Evidence ${q(ev(c.evidenceId))} linked to ${c.name} (${c.relation}${c.locator ? `, ${c.locator}` : ''})`;
    case 'link_removed':
      return `Evidence ${q(ev(c.evidenceId))} unlinked from ${c.name}`;
    case 'link_changed':
      return `Evidence ${q(ev(c.evidenceId))} on ${c.name}: ${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`;
    case 'thesis_added':
      return `Thesis added: ${q(c.statement)}`;
    case 'thesis_removed':
      return `Thesis removed: ${q(c.statement)}`;
    case 'thesis_changed':
      if (c.field === 'status') return `Thesis ${q(c.statement)} → ${c.to}`;
      return `Thesis ${q(c.statement)}: ${c.field} changed`;
    case 'valuation_changed':
      if (typeof c.from === 'number' || typeof c.to === 'number') {
        return `${c.label}: ${c.from ?? '—'} → ${c.to ?? '—'}`;
      }
      return c.label.startsWith('Peer added') || c.label.startsWith('Peer removed') ? c.label : `${c.label} edited`;
  }
}
