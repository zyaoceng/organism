import { formatValue } from '../format';
import { NODE_ROLES, scenarioName } from '../model/types';
import { unitLabel } from '../units';
import type { ModelChange } from './diff';

export interface DescribeContext {
  periodLabel?: (key: string) => string;
  evidenceTitle?: (id: string) => string;
  /** Output language; defaults to English. */
  lang?: 'en' | 'zh-TW';
}

const q = (s: string | null | undefined) => (s ? `“${s.length > 80 ? `${s.slice(0, 77)}…` : s}”` : '(empty)');

export function describeChange(c: ModelChange, ctx: DescribeContext = {}): string {
  if (ctx.lang === 'zh-TW') return describeZh(c, ctx);
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

const ROLE_ZH: Record<string, string> = {
  eps: 'EPS',
  revenue: '營收',
  gross_margin: '毛利率',
  operating_income: '營業利益',
  net_income: '淨利',
  diluted_shares: '稀釋後股數',
  eps_growth: 'EPS 成長率',
  roic: 'ROIC',
  reinvestment_roi: '再投資報酬率',
  target_multiple: '目標倍數（本益比）',
  target_price: '目標價',
  rerating: '評價重估論點',
};
const SCENARIO_ZH: Record<string, string> = { bear: '空頭', base: '基準', bull: '多頭' };
const RELATION_ZH: Record<string, string> = { supports: '支持', contradicts: '反駁', context: '背景', triggered: '觸發修改' };
const THESIS_STATUS_ZH: Record<string, string> = { active: '有效', confirmed: '已證實', invalidated: '已推翻', retired: '已停用' };
const PEER_FIELD_ZH: Record<string, string> = {
  name: '名稱',
  ticker: '代號',
  pe: '本益比',
  epsGrowth: 'EPS 成長率',
  roic: 'ROIC',
  grossMargin: '毛利率',
  basis: '基準',
  source: '來源',
  asOf: '資料日期',
  note: '備註',
};
const HIST_FIELD_ZH: Record<string, string> = { low: '低點', median: '中位數', high: '高點', window: '期間', source: '來源', asOf: '資料日期', note: '備註' };

const qz = (s: string | null | undefined) => (s ? `「${s.length > 80 ? `${s.slice(0, 77)}…` : s}」` : '（空白）');

function valuationLabelZh(c: Extract<ModelChange, { type: 'valuation_changed' }>): string {
  const [head, id, field] = c.path.split('.');
  if (head === 'peers') {
    const name = /^Peer (?:added: |removed: )?(.*?)(?:: \w+)?$/.exec(c.label)?.[1] ?? '';
    if (!field) return c.to === null ? `刪除同業：${name}` : `新增同業：${name}`;
    return `同業 ${name}：${PEER_FIELD_ZH[field] ?? field}`;
  }
  if (head === 'historicalPE') return `歷史本益比${HIST_FIELD_ZH[id] ?? id}`;
  if (head === 'rationale') return `${SCENARIO_ZH[id] ?? id}本益比理由`;
  if (head === 'probabilities') return `${SCENARIO_ZH[id] ?? id}機率`;
  return c.label;
}

function describeZh(c: ModelChange, ctx: DescribeContext): string {
  const pl = (k: string) => (k === '_' ? '數值' : ctx.periodLabel?.(k) ?? k);
  const ev = (id: string) => ctx.evidenceTitle?.(id) ?? '證據';
  const top = (x: string | null | undefined) => x ?? '最上層';
  switch (c.type) {
    case 'node_added':
      return c.parentName ? `在 ${c.parentName} 底下新增 ${c.name}` : `新增 ${c.name}`;
    case 'node_removed':
      return `刪除 ${c.name}`;
    case 'node_renamed':
      return `改名 ${c.from} → ${c.to}`;
    case 'node_moved':
      return `移動 ${c.name}：${top(c.fromParent)} → ${top(c.toParent)}`;
    case 'children_reordered':
      return `調整 ${top(c.parentName)} 底下的順序`;
    case 'node_unit':
      return `${c.name} 單位：${unitLabel(c.from) || '無'} → ${unitLabel(c.to) || '無'}`;
    case 'node_role': {
      const label = (r: string | null) => (r ? ROLE_ZH[r] ?? r : '無');
      return `${c.name} 角色：${label(c.from)} → ${label(c.to)}`;
    }
    case 'node_time_mode': {
      const m = (x: string) => (x === 'scalar' ? '單一數值' : '時間序列');
      return `${c.name}：${m(c.from)} → ${m(c.to)}`;
    }
    case 'formula_changed':
      if (!c.from) return `${c.name} 設定公式：${c.to}`;
      if (!c.to) return `${c.name} 移除公式（原本是 ${c.from}）`;
      return `${c.name} 公式：${c.from} → ${c.to}`;
    case 'value_changed': {
      const sc = c.scenario === 'base' ? '' : `（${SCENARIO_ZH[c.scenario]}）`;
      const blank = c.scenario === 'base' ? '空白' : '沿用基準';
      const f = c.from === null ? blank : formatValue(c.from, c.unit);
      const t = c.to === null ? blank : formatValue(c.to, c.unit);
      return `${c.name} ${pl(c.periodKey)}${sc}：${f} → ${t}`;
    }
    case 'cell_status_changed':
      return `${c.name} ${pl(c.periodKey)} 標為${c.to === 'A' ? '實際' : c.to === 'E' ? '預估' : '跟隨期間'}`;
    case 'notes_changed':
      return `${c.name} 的筆記已修改`;
    case 'period_added':
      return `新增期間 ${c.label}${c.status}`;
    case 'period_removed':
      return `刪除期間 ${c.label}`;
    case 'period_changed':
      if (c.field === 'status') return `期間 ${pl(c.periodId)} 改為${c.to === 'A' ? '實際' : '預估'}`;
      return `期間 ${c.periodId} ${c.field === 'label' ? '名稱' : '結束日'}：${c.from ?? '—'} → ${c.to ?? '—'}`;
    case 'link_added':
      return `證據 ${qz(ev(c.evidenceId))} 連結到 ${c.name}（${RELATION_ZH[c.relation] ?? c.relation}${c.locator ? `，${c.locator}` : ''}）`;
    case 'link_removed':
      return `證據 ${qz(ev(c.evidenceId))} 已從 ${c.name} 取消連結`;
    case 'link_changed': {
      const field = c.field === 'relation' ? '關係' : c.field === 'locator' ? '位置' : c.field === 'note' ? '備註' : c.field;
      const v = (x: string | null) => (x === null ? '—' : c.field === 'relation' ? RELATION_ZH[x] ?? x : x);
      return `${c.name} 上的證據 ${qz(ev(c.evidenceId))}：${field} ${v(c.from)} → ${v(c.to)}`;
    }
    case 'thesis_added':
      return `新增論點：${qz(c.statement)}`;
    case 'thesis_removed':
      return `刪除論點：${qz(c.statement)}`;
    case 'thesis_changed':
      if (c.field === 'status') return `論點 ${qz(c.statement)} → ${THESIS_STATUS_ZH[String(c.to)] ?? c.to}`;
      return `論點 ${qz(c.statement)} 已修改`;
    case 'valuation_changed': {
      const label = valuationLabelZh(c);
      if (typeof c.from === 'number' || typeof c.to === 'number') return `${label}：${c.from ?? '—'} → ${c.to ?? '—'}`;
      return c.path.split('.').length === 2 && c.path.startsWith('peers.') ? label : `${label} 已修改`;
    }
  }
}
