import { useState } from 'react';
import { formatValue } from '../../domain/format';
import { addPeer, removePeer, setNotes, setValue, updatePeer, updateValuation } from '../../domain/model/ops';
import { findByRole } from '../../domain/model/tree';
import { SCALAR_KEY, SCENARIOS, type HistoricalPE, type ModelState, type Peer, type ScenarioId } from '../../domain/model/types';
import { basisPeriodId } from '../../domain/revision/impact';
import type { Unit } from '../../domain/units';
import { FormulaEditor } from '../components/FormulaEditor';
import { Field, InlineText, NumberField, ScenarioSwitch } from '../components/ui';
import { calcOf } from '../lib/derived';
import { t } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useActiveState, useWorkspace } from '../lib/store';
import { cls, periodLabelFn } from '../lib/util';

const PCT: Unit = { kind: 'percent', scale: 1 };
const MULT: Unit = { kind: 'multiple', scale: 1 };

export function ValuationPage() {
  const { state, readOnly } = useActiveState();
  const scenario = useWorkspace((s) => s.scenario);
  const setScenario = useWorkspace((s) => s.setScenario);
  const quote = useWorkspace((s) => s.quote);
  const projectId = useWorkspace((s) => s.projectId)!;
  const { edit, select } = useWorkspace.getState();
  const [peerPeriod, setPeerPeriod] = useState<string | null>(null);
  if (!state) return null;
  const calc = calcOf(state);
  const pl = periodLabelFn(state);
  const basis = basisPeriodId(state);
  const role = (r: Parameters<typeof findByRole>[1]) => findByRole(state, r);
  const eps = role('eps');
  const tm = role('target_multiple');
  const tp = role('target_price');
  const rerating = role('rerating');
  const price = quote?.quote?.price ?? null;
  const v = (id: string | undefined, key: string | null, s: ScenarioId = scenario) => (id && key ? calc.cells[s][id]?.[key]?.v ?? null : null);
  const tmKey = tm?.timeMode === 'scalar' ? SCALAR_KEY : basis;
  const tpKey = tp?.timeMode === 'scalar' ? SCALAR_KEY : basis;
  const firstE = state.periods.find((p) => p.status === 'E')?.id ?? null;
  const cmpPeriod = peerPeriod ?? state.periods.find((p) => p.status === 'E' && p.id !== firstE)?.id ?? firstE;
  const metrics = (['eps', 'eps_growth', 'revenue', 'gross_margin', 'roic', 'reinvestment_roi'] as const).map((r) => role(r)).filter(Boolean);
  const currentPE = (key: string | null) => (price && key && v(eps?.id, key) ? price / v(eps?.id, key)! : null);
  const hist = state.valuation.historicalPE;
  const probs = state.valuation.probabilities;
  const probSum = SCENARIOS.reduce((s, x) => s + (probs[x.id] ?? 0), 0);
  const weighted = probSum > 0 ? SCENARIOS.reduce((s, x) => s + (probs[x.id] ?? 0) * (v(tp?.id, tpKey, x.id) ?? 0), 0) / probSum : null;
  const peers = state.valuation.peers;
  const median = (xs: (number | undefined)[]) => {
    const a = xs.filter((x): x is number => typeof x === 'number').sort((p, q) => p - q);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  return (
    <div className="page" style={{ maxWidth: 1500 }} data-testid="valuation-page">
      <div className="page-head">
        <h1>{t('Valuation · P/E workspace')}</h1>
        <span className="sub">{t('The multiple is your judgment. This page organizes the evidence for it; nothing here decides it for you.')}</span>
        <span className="right">
          <ScenarioSwitch value={scenario} onChange={setScenario} />
        </span>
      </div>

      <div className="three" style={{ marginBottom: 14 }}>
        {SCENARIOS.map((s) => {
          const e = v(eps?.id, basis, s.id);
          const m = v(tm?.id, tmKey, s.id);
          const tpv = v(tp?.id, tpKey, s.id);
          return (
            <div key={s.id} className={cls('card scen-card', s.id)} data-testid={`val-${s.id}`}>
              <div className="row">
                <span className={cls('badge', s.id)}>{t(s.name)}</span>
                {probs[s.id] !== null && <span className="small sub">p = {((probs[s.id] ?? 0) * 100).toFixed(0)}%</span>}
              </div>
              <div className="row" style={{ marginTop: 6, alignItems: 'baseline' }}>
                <span className="small sub">{t('EPS {period}', { period: basis ? pl(basis) : '' })}</span>
                <b className="num">{formatValue(e, eps?.unit)}</b>
                <span className="sub">×</span>
                <span className="small sub">P/E</span>
                <b className="num">{formatValue(m, tm?.unit ?? MULT)}</b>
                <span className="sub">=</span>
              </div>
              <div className="big" data-testid={`tp-value-${s.id}`}>
                {formatValue(tpv, tp?.unit)} <span className="small sub">{tp?.unit?.currency}</span>
              </div>
              <div className="small">
                {price && tpv ? (
                  <>
                    {t('vs price {price}:', { price: price.toFixed(2) })} <b className={tpv >= price ? 'pos' : 'neg'}>{`${tpv >= price ? '+' : ''}${((tpv / price - 1) * 100).toFixed(1)}%`}</b>
                  </>
                ) : (
                  <span className="sub">{t('no market price')}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {weighted !== null && (
        <div className="msg info" style={{ marginBottom: 14 }}>
          {t('Probability-weighted target price:')} <b>{formatValue(weighted, tp?.unit)}</b>
          {Math.abs(probSum - 1) > 1e-6 && t(' (weights sum to {pct}%; normalized)', { pct: (probSum * 100).toFixed(0) })}
        </div>
      )}

      <div className="two">
        <div className="col" style={{ gap: 14 }}>
          <div className="card">
            <h2>{t('1 · Target multiple decision')}</h2>
            {!tm ? (
              <div className="msg warn">{t('No node has the role “Target multiple”. Assign it in the Model inspector.')}</div>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>{t('Scenario')}</th>
                    <th>{t('Target P/E')}</th>
                    <th className="l">{t('Rationale (why this multiple)')}</th>
                    <th>{t('Probability')}</th>
                  </tr>
                </thead>
                <tbody>
                  {SCENARIOS.map((s) => {
                    const own = s.id === 'base' ? tm.values[tmKey ?? SCALAR_KEY] : tm.overrides[s.id]?.[tmKey ?? SCALAR_KEY];
                    return (
                      <tr key={s.id}>
                        <td>
                          <span className={cls('badge', s.id)}>{t(s.name)}</span>
                        </td>
                        <td style={{ width: 90 }}>
                          {readOnly ? (
                            formatValue(v(tm.id, tmKey, s.id), tm.unit)
                          ) : (
                            <NumberField key={`${s.id}${own}`} value={own ?? null} unit={tm.unit ?? MULT} placeholder={s.id === 'base' ? '' : t('inherit')} onCommit={(x) => edit((st) => setValue(st, tm.id, tmKey ?? SCALAR_KEY, s.id, x))} />
                          )}
                        </td>
                        <td className="l" style={{ whiteSpace: 'normal', minWidth: 220 }}>
                          <InlineText
                            multiline
                            rows={3}
                            readOnly={readOnly}
                            value={state.valuation.rationale[s.id]}
                            placeholder={t('Growth duration, returns, mix, peer anchor, history…')}
                            onCommit={(x) => edit((st) => updateValuation(st, { rationale: { ...st.valuation.rationale, [s.id]: x } }))}
                          />
                        </td>
                        <td style={{ width: 80 }}>
                          {readOnly ? (
                            probs[s.id] === null ? '—' : `${((probs[s.id] ?? 0) * 100).toFixed(0)}%`
                          ) : (
                            <NumberField
                              key={`p${s.id}${probs[s.id]}`}
                              value={probs[s.id]}
                              unit={PCT}
                              placeholder="—"
                              onCommit={(x) => edit((st) => updateValuation(st, { probabilities: { ...st.valuation.probabilities, [s.id]: x } }))}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h2>{t('2 · Target price formula')}</h2>
            {tp ? (
              <>
                <div className="small sub" style={{ marginBottom: 6 }}>
                  {t('Basis EPS period:')} <b>{basis ? pl(basis) : '—'}</b>{t('. Rolling the basis year is a formula change and is recorded in history.')}
                </div>
                <FormulaEditor node={tp} state={state} readOnly={readOnly} />
              </>
            ) : (
              <div className="msg warn">{t('No node has the role “Target price”.')}</div>
            )}
          </div>

          <div className="card">
            <div className="row">
              <h2>{t('3 · Re-rating thesis')}</h2>
              {rerating && (
                <button
                  className="btn xs right"
                  onClick={() => {
                    select(rerating.id);
                    navigate({ page: 'project', projectId, tab: 'model' });
                  }}
                >
                  {t('evidence & theses in the model →')}
                </button>
              )}
            </div>
            {rerating ? (
              <>
                <InlineText multiline rows={6} readOnly={readOnly} value={rerating.notes} placeholder={t('Why should the market pay a different multiple? (business mix, growth duration, returns on capital…)')} onCommit={(x) => edit((st) => setNotes(st, rerating.id, x))} />
                <div className="tiny sub" style={{ marginTop: 4 }}>
                  {t('{links} evidence link(s) · {theses} thesis(es)', { links: state.links.filter((l) => l.nodeId === rerating.id).length, theses: state.theses.filter((th) => th.nodeIds.includes(rerating.id)).length })}
                </div>
              </>
            ) : (
              <div className="small sub">{t('Assign the role “Re-rating thesis” to a node to write it here.')}</div>
            )}
          </div>
        </div>

        <div className="col" style={{ gap: 14 }}>
          <div className="card">
            <h2>{t('4 · Growth and returns ({scenario})', { scenario: t(SCENARIOS.find((s) => s.id === scenario)?.name ?? '') })}</h2>
            <table className="grid">
              <thead>
                <tr>
                  <th>{t('Metric')}</th>
                  {state.periods.map((p) => (
                    <th key={p.id}>{pl(p.id)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((n) => (
                  <tr key={n!.id}>
                    <td>{n!.name}</td>
                    {state.periods.map((p) => (
                      <td key={p.id}>{formatValue(v(n!.id, p.id), n!.unit)}</td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td>{t('P/E at current price')}</td>
                  {state.periods.map((p) => (
                    <td key={p.id}>{formatValue(currentPE(p.id), MULT)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
            <div className="tiny sub" style={{ marginTop: 4 }}>
              {quote?.quote
                ? t('Current P/E uses the latest quote ({provider}) and is display-only: it never enters the model or snapshots.', { provider: quote.quote.provider === 'demo' ? t('{provider}, synthetic', { provider: quote.quote.provider }) : quote.quote.provider })
                : t('Current P/E uses the latest quote and is display-only: it never enters the model or snapshots.')}
            </div>
          </div>

          <div className="card">
            <h2>{t('5 · Historical P/E band')}</h2>
            <div className="three">
              {(['low', 'median', 'high'] as const).map((k) => (
                <Field key={k} label={t(k[0].toUpperCase() + k.slice(1))}>
                  {readOnly ? (
                    <span>{formatValue(hist[k], MULT)}</span>
                  ) : (
                    <NumberField key={`${k}${hist[k]}`} value={hist[k] ?? null} unit={MULT} onCommit={(x) => edit((st) => updateValuation(st, { historicalPE: clean({ ...st.valuation.historicalPE, [k]: x ?? undefined }) }))} />
                  )}
                </Field>
              ))}
            </div>
            <div className="three" style={{ marginTop: 6 }}>
              {(['window', 'source', 'asOf'] as const).map((k) => (
                <Field key={k} label={t(k === 'asOf' ? 'As of' : k[0].toUpperCase() + k.slice(1))}>
                  <input
                    disabled={readOnly}
                    defaultValue={hist[k] ?? ''}
                    key={hist[k] ?? ''}
                    placeholder={k === 'window' ? t('2021/09–2026/08 monthly') : k === 'source' ? t('e.g. broker database') : 'YYYY-MM-DD'}
                    onBlur={(e) => e.target.value !== (hist[k] ?? '') && edit((st) => updateValuation(st, { historicalPE: clean({ ...st.valuation.historicalPE, [k]: e.target.value || undefined }) }))}
                  />
                </Field>
              ))}
            </div>
            <PEBand state={state} hist={hist} current={currentPE(firstE)} currentLabel={firstE ? pl(firstE) : ''} targets={SCENARIOS.map((s) => ({ id: s.id, v: v(tm?.id, tmKey, s.id) }))} />
          </div>

          <div className="card">
            <div className="row">
              <h2>{t('6 · Peer comparison')}</h2>
              <span className="right row small sub">
                {t('Company at')}
                <select value={cmpPeriod ?? ''} onChange={(e) => setPeerPeriod(e.target.value)}>
                  {state.periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {pl(p.id)}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="grid" data-testid="peer-table">
                <thead>
                  <tr>
                    <th className="l">{t('Company')}</th>
                    <th>P/E</th>
                    <th>{t('EPS growth')}</th>
                    <th>ROIC</th>
                    <th>{t('Gross margin')}</th>
                    <th className="l">{t('Basis')}</th>
                    <th className="l">{t('Source · as of')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <tr className="sel">
                    <td className="l">
                      <b>{t('This company')}</b>
                    </td>
                    <td>{formatValue(currentPE(cmpPeriod), MULT)}</td>
                    <td>{formatValue(v(role('eps_growth')?.id, cmpPeriod), PCT)}</td>
                    <td>{formatValue(v(role('roic')?.id, cmpPeriod), PCT)}</td>
                    <td>{formatValue(v(role('gross_margin')?.id, cmpPeriod), PCT)}</td>
                    <td className="l">{cmpPeriod ? pl(cmpPeriod) : ''}</td>
                    <td className="l sub small">{t('model + current price')}</td>
                    <td />
                  </tr>
                  {peers.map((p) => (
                    <PeerRow key={p.id} peer={p} readOnly={readOnly} />
                  ))}
                  {peers.length > 0 && (
                    <tr>
                      <td className="l sub">{t('Peer median')}</td>
                      <td>{formatValue(median(peers.map((p) => p.pe)), MULT)}</td>
                      <td>{formatValue(median(peers.map((p) => p.epsGrowth)), PCT)}</td>
                      <td>{formatValue(median(peers.map((p) => p.roic)), PCT)}</td>
                      <td>{formatValue(median(peers.map((p) => p.grossMargin)), PCT)}</td>
                      <td colSpan={3} />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {!readOnly && (
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => edit((st) => addPeer(st, { name: t('New peer') }))} data-testid="add-peer">
                {t('+ Peer')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function clean(h: HistoricalPE): HistoricalPE {
  const out: HistoricalPE = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && v !== '') (out as Record<string, unknown>)[k] = v;
  return out;
}

function PeerRow({ peer, readOnly }: { peer: Peer; readOnly: boolean }) {
  const { edit } = useWorkspace.getState();
  const num = (k: 'pe' | 'epsGrowth' | 'roic' | 'grossMargin', unit: Unit) =>
    readOnly ? (
      formatValue(peer[k], unit)
    ) : (
      <NumberField key={`${k}${peer[k]}`} value={peer[k] ?? null} unit={unit} onCommit={(x) => edit((st) => updatePeer(st, peer.id, { [k]: x ?? undefined }))} />
    );
  const text = (k: 'name' | 'basis' | 'source' | 'asOf', ph: string, width?: number) =>
    readOnly ? (
      peer[k] ?? ''
    ) : (
      <input className="l" style={{ width }} key={`${k}${peer[k]}`} defaultValue={peer[k] ?? ''} placeholder={ph} onBlur={(e) => e.target.value !== (peer[k] ?? '') && edit((st) => updatePeer(st, peer.id, { [k]: e.target.value || undefined }))} />
    );
  return (
    <tr>
      <td className="l">{text('name', t('Peer name'), 130)}</td>
      <td style={{ width: 70 }}>{num('pe', MULT)}</td>
      <td style={{ width: 80 }}>{num('epsGrowth', PCT)}</td>
      <td style={{ width: 70 }}>{num('roic', PCT)}</td>
      <td style={{ width: 70 }}>{num('grossMargin', PCT)}</td>
      <td className="l">{text('basis', 'FY2027E', 70)}</td>
      <td className="l">
        <div className="row" style={{ gap: 4 }}>
          {text('source', t('source'), 110)}
          {text('asOf', t('as of'), 90)}
        </div>
      </td>
      <td>
        {!readOnly && (
          <button className="icon-btn" title={t('Remove peer')} onClick={() => edit((st) => removePeer(st, peer.id))}>
            ✕
          </button>
        )}
      </td>
    </tr>
  );
}

/** Visual band: historical low–high, median, current P/E and the three target multiples. */
function PEBand({ hist, current, currentLabel, targets }: { state: ModelState; hist: HistoricalPE; current: number | null; currentLabel: string; targets: { id: ScenarioId; v: number | null }[] }) {
  const vals = [hist.low, hist.high, hist.median, current, ...targets.map((tg) => tg.v)].filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (vals.length < 2) return <div className="tiny sub" style={{ marginTop: 8 }}>{t('Enter the band to compare it with the current and target multiples.')}</div>;
  const lo = Math.min(...vals) * 0.9;
  const hi = Math.max(...vals) * 1.08;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const colors: Record<ScenarioId, string> = { bear: 'var(--bear)', base: 'var(--base)', bull: 'var(--bull)' };
  return (
    <div style={{ position: 'relative', height: 58, marginTop: 14 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 22, height: 6, background: 'var(--act-bg)', borderRadius: 3 }} />
      {hist.low !== undefined && hist.high !== undefined && (
        <div style={{ position: 'absolute', left: x(hist.low), width: `calc(${x(hist.high)} - ${x(hist.low)})`, top: 20, height: 10, background: '#cfd8e3', borderRadius: 3 }} title={t('Historical {low}x–{high}x', { low: hist.low, high: hist.high })} />
      )}
      {hist.median !== undefined && <Tick left={x(hist.median)} color="#6b7682" label={t('median {v}x', { v: hist.median.toFixed(1) })} top />}
      {current !== null && <Tick left={x(current)} color="#111" label={t('now {v}x ({period})', { v: current.toFixed(1), period: currentLabel })} top={false} />}
      {targets.map((tg) => (tg.v !== null ? <Tick key={tg.id} left={x(tg.v)} color={colors[tg.id]} label={`${t(tg.id)} ${tg.v.toFixed(1)}x`} top={tg.id !== 'base'} /> : null))}
    </div>
  );
}

function Tick({ left, color, label, top }: { left: string; color: string; label: string; top: boolean }) {
  return (
    <>
      <div style={{ position: 'absolute', left, top: 14, width: 2, height: 22, background: color, transform: 'translateX(-1px)' }} />
      <div className="tiny" style={{ position: 'absolute', left, top: top ? 0 : 40, transform: 'translateX(-50%)', color, whiteSpace: 'nowrap', fontWeight: 600 }}>
        {label}
      </div>
    </>
  );
}
