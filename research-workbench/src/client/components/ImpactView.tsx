import { useState } from 'react';
import { formatValue } from '../../domain/format';
import type { ModelState, ScenarioId } from '../../domain/model/types';
import { SCALAR_KEY, SCENARIOS } from '../../domain/model/types';
import type { Impact } from '../../domain/revision/impact';
import { findByRole } from '../../domain/model/tree';
import { cls, periodLabelFn } from '../lib/util';
import { Delta, ScenarioSwitch } from './ui';

/** What changed downstream: headline EPS/target price, the causal chain, and attribution. */
export function ImpactView({ impact, state, initialScenario = 'base', compact }: { impact: Impact; state: ModelState; initialScenario?: ScenarioId; compact?: boolean }) {
  const [scenario, setScenario] = useState<ScenarioId>(initialScenario);
  const pl = periodLabelFn(state);
  const eps = findByRole(state, 'eps');
  const tp = findByRole(state, 'target_price');
  const tm = findByRole(state, 'target_multiple');
  const basis = impact.basisPeriodId;
  const nodes = impact.nodes
    .map((n) => ({ ...n, cells: n.cells.filter((c) => c.scenario === scenario) }))
    .filter((n) => n.cells.length > 0);
  const unitOf = (id: string) => state.nodes.find((n) => n.id === id)?.unit ?? null;
  const epsPeriods = [...new Set(impact.headline.eps.map((h) => h.periodKey))];

  return (
    <div className="col" style={{ gap: 12 }} data-testid="impact">
      <table className="grid impact-table">
        <thead>
          <tr>
            <th>Headline</th>
            {SCENARIOS.map((s) => (
              <th key={s.id}>
                <span className={cls('badge', s.id)}>{s.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              EPS {basis ? pl(basis) : ''}
              {eps && <span className="faint small"> ({eps.name})</span>}
            </td>
            {SCENARIOS.map((s) => {
              const h = impact.headline.eps.find((x) => x.scenario === s.id && x.periodKey === basis);
              return (
                <td key={s.id} className="num">
                  {formatValue(h?.before, eps?.unit)} → <b>{formatValue(h?.after, eps?.unit)}</b> <Delta before={h?.before} after={h?.after} />
                </td>
              );
            })}
          </tr>
          <tr>
            <td>Target multiple</td>
            {SCENARIOS.map((s) => {
              const h = impact.headline.targetMultiple.find((x) => x.scenario === s.id);
              return (
                <td key={s.id} className="num">
                  {formatValue(h?.before, tm?.unit)} → <b>{formatValue(h?.after, tm?.unit)}</b>
                </td>
              );
            })}
          </tr>
          <tr>
            <td>
              <b>Target price</b>
            </td>
            {SCENARIOS.map((s) => {
              const h = impact.headline.targetPrice.find((x) => x.scenario === s.id);
              return (
                <td key={s.id} className="num delta" data-testid={`tp-${s.id}`}>
                  {formatValue(h?.before, tp?.unit)} → <b>{formatValue(h?.after, tp?.unit)}</b> <Delta before={h?.before} after={h?.after} />
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>

      {!compact && epsPeriods.length > 1 && (
        <table className="grid">
          <thead>
            <tr>
              <th>EPS path ({SCENARIOS.find((s) => s.id === scenario)?.name})</th>
              {epsPeriods.map((p) => (
                <th key={p}>{pl(p)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Before → after</td>
              {epsPeriods.map((p) => {
                const h = impact.headline.eps.find((x) => x.scenario === scenario && x.periodKey === p);
                return (
                  <td key={p} className="num">
                    {formatValue(h?.before, eps?.unit)} → {formatValue(h?.after, eps?.unit)} <Delta before={h?.before} after={h?.after} />
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      )}

      <div>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>Causal chain</h3>
          <span className="small sub">changed values in dependency order</span>
          <span className="right">
            <ScenarioSwitch value={scenario} onChange={setScenario} />
          </span>
        </div>
        {nodes.length === 0 ? (
          <div className="small sub">No calculated values changed in this scenario.</div>
        ) : (
          <ul className="impact-chain">
            {nodes.slice(0, compact ? 12 : 200).map((n) => {
              const unit = unitOf(n.nodeId);
              const pick = n.cells.find((c) => c.periodKey === basis) ?? n.cells.find((c) => c.periodKey === SCALAR_KEY) ?? n.cells[n.cells.length - 1];
              return (
                <li key={n.nodeId} className={cls(n.direct && 'direct')} title={n.cells.map((c) => `${pl(c.periodKey)}: ${formatValue(c.before, unit)} → ${formatValue(c.after, unit)}`).join('\n')}>
                  <span className="nm">
                    {n.direct ? '✎ ' : '↳ '}
                    {n.name}
                    {n.cells.length > 1 && <span className="faint small"> · {n.cells.length} cells</span>}
                  </span>
                  <span className="num sub">{pl(pick.periodKey)}</span>
                  <span className="num">
                    {formatValue(pick.before, unit)} → <b>{formatValue(pick.after, unit)}</b>
                  </span>
                  <span style={{ width: 64, textAlign: 'right' }}>
                    <Delta before={pick.before} after={pick.after} unit={unit} />
                  </span>
                </li>
              );
            })}
            {compact && nodes.length > 12 && <li className="sub small">…{nodes.length - 12} more</li>}
          </ul>
        )}
      </div>

      {impact.attribution.length > 0 && (
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <h3>Attribution</h3>
            <span className="small sub">each changed assumption applied alone to the previous model</span>
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th>Assumption</th>
                <th>Δ EPS {basis ? pl(basis) : ''}</th>
                <th>Δ Target price</th>
              </tr>
            </thead>
            <tbody>
              {impact.attribution.map((a) => (
                <tr key={a.nodeId}>
                  <td title={a.note}>
                    {a.name}
                    {a.note && <span className="faint small"> *</span>}
                  </td>
                  <td className="num">{a.eps[scenario] === null ? '—' : signedFmt(a.eps[scenario]!, 2)}</td>
                  <td className="num">{a.targetPrice[scenario] === null ? '—' : signedFmt(a.targetPrice[scenario]!, 1)}</td>
                </tr>
              ))}
              <tr>
                <td className="sub" title="Total change minus the sum of single-assumption effects: interactions between changes and structural changes (new nodes, periods)">
                  Interaction & structural
                </td>
                <td className="num sub">{impact.residual.eps[scenario] === null ? '—' : signedFmt(impact.residual.eps[scenario]!, 2)}</td>
                <td className="num sub">{impact.residual.targetPrice[scenario] === null ? '—' : signedFmt(impact.residual.targetPrice[scenario]!, 1)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const signedFmt = (v: number, d: number) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
