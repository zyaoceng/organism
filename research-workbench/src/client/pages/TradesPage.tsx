import { useEffect, useMemo, useState } from 'react';
import { atr, atrAsOf, indexAtOrBefore, trailingStop, type Bar } from '../../domain/market/indicators';
import { findByRole } from '../../domain/model/tree';
import { entryBarIndex, tradeMetrics } from '../../domain/trade/metrics';
import { actorLabel, isAgentActor } from '../../shared/actors';
import type { ProviderDTO, TradeDTO } from '../../shared/api';
import { QuoteCard, RANGES, SecurityCard } from '../components/MarketCards';
import { ReflectionCard } from '../components/ReflectionCard';
import { PriceChart, type ChartMarker, type ChartPriceLine, type Overlay } from '../components/PriceChart';
import { Advanced, AiBadge, Field } from '../components/ui';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useWorkspace } from '../lib/store';
import { getLang, t, tm, useLang } from '../lib/i18n';
import { useAdvanced } from '../lib/prefs';
import { useBars } from '../lib/useBars';
import { cls, pctText, today } from '../lib/util';

/** Basic mode draws a fixed chart: MA 20/50 (a module constant, so the chart keeps its zoom), ATR 14, one year. */
const BASIC_MA = [20, 50];

/**
 * Prices and the trade journal on one page: one chart with trades, catalysts and target lines; the quote and data source; entries and exits.
 * `param` selects a trade (links from the cross-company trade log).
 */
export function TradesPage({ param }: { param?: string } = {}) {
  const trades = useWorkspace((s) => s.trades);
  const revisions = useWorkspace((s) => s.revisions);
  const projectId = useWorkspace((s) => s.projectId)!;
  const catalysts = useWorkspace((s) => s.catalysts);
  const head = useWorkspace((s) => s.head);
  const sec = useWorkspace((s) => s.securities[0]);
  const quote = useWorkspace((s) => s.quote);
  const { toast, refresh } = useWorkspace.getState();
  const { bars, res, loading, reload } = useBars();
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [range, setRange] = useState('1Y');
  const [ma, setMa] = useState('20,60');
  const [atrN, setAtrN] = useState(14);
  const [showTrades, setShowTrades] = useState(true);
  const [showCatalysts, setShowCatalysts] = useState(true);
  const [showTargets, setShowTargets] = useState(true);
  const [sel, setSel] = useState<string | null>(trades.find((x) => x.id === param)?.id ?? trades[0]?.id ?? null);
  const [creating, setCreating] = useState(trades.length === 0);
  const lang = useLang();
  const adv = useAdvanced();
  useEffect(() => {
    void api.providers().then(setProviders);
  }, []);
  // another trade of this company opened from the trade log
  useEffect(() => {
    if (param && trades.some((x) => x.id === param)) setSel(param);
  }, [param]);
  // the cached quote marks open trades on the primary security when it is newer than the last bar
  const markQuote = (tr: TradeDTO) => (tr.securityId === sec?.id ? (quote?.quote ?? null) : null);

  const selected = trades.find((x) => x.id === sel) ?? null;
  const selectedEntry = selected?.entryDate ?? null;
  const revSeq = (id: string | null) => revisions.find((r) => r.id === id);

  // Basic mode has no chart controls: fixed settings, everything drawn.
  const parsedMa = useMemo(() => ma.split(/[ ,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 1 && n < 400).slice(0, 4), [ma]);
  const maPeriods = adv ? parsedMa : BASIC_MA;
  const atrPeriod = adv ? atrN : 14;
  const rangeId = adv ? range : '1Y';
  const withTrades = !adv || showTrades;
  const withCatalysts = !adv || showCatalysts;
  const withTargets = !adv || showTargets;

  const shown = useMemo(() => {
    const days = RANGES.find((r) => r.id === rangeId)?.days ?? 365;
    const last = bars.at(-1)?.date;
    if (!last) return bars;
    let cutoff = new Date(Date.parse(last) - days * 86400000).toISOString().slice(0, 10);
    // Without range buttons, widen the window so an older selected trade stays on the chart.
    if (!adv && selectedEntry && selectedEntry < cutoff) cutoff = selectedEntry;
    return bars.filter((b) => b.date >= cutoff);
  }, [bars, rangeId, adv, selectedEntry]);

  const chart = useMemo(() => {
    const markers: ChartMarker[] = [];
    if (withTrades) {
      for (const tr of trades) {
        markers.push({ time: tr.entryDate, position: tr.side === 'long' ? 'belowBar' : 'aboveBar', color: tr.id === sel ? '#0b6e63' : '#8aa9a4', shape: tr.side === 'long' ? 'arrowUp' : 'arrowDown', text: t('Buy {price}', { price: tr.entryPrice }) });
        if (tr.exitDate && tr.exitPrice) markers.push({ time: tr.exitDate, position: tr.side === 'long' ? 'aboveBar' : 'belowBar', color: tr.id === sel ? '#c0392b' : '#d9a39d', shape: tr.side === 'long' ? 'arrowDown' : 'arrowUp', text: t('Sell {price}', { price: tr.exitPrice }) });
      }
    }
    if (withCatalysts) {
      for (const c of catalysts) {
        const d = c.actualDate ?? c.expectedDate;
        if (d) markers.push({ time: d, position: 'aboveBar', color: c.status === 'occurred' ? '#6a4fc4' : '#a8a8c8', shape: 'circle', text: c.title.slice(0, 24) });
      }
    }
    const lines: ChartPriceLine[] = [];
    if (withTargets) {
      const tp = head ? findByRole(head.state, 'target_price') : undefined;
      if (head && tp) {
        const colors = { bear: '#b5473a', base: '#35598f', bull: '#2f7d4f' } as const;
        for (const s of ['bear', 'base', 'bull'] as const) {
          const v = head.computed.values[s][tp.id]?._;
          if (v) lines.push({ price: v, color: colors[s], title: t(`${s} TP #{seq}`, { seq: head.seq }), dashed: true });
        }
      }
      for (const tr of trades.filter((x) => !x.exitDate && x.stopAtEntry && x.id !== sel)) lines.push({ price: tr.stopAtEntry!, color: '#c0392b', title: t('stop {date}', { date: tr.entryDate }) });
      if (selected?.stopAtEntry) lines.push({ price: selected.stopAtEntry, color: '#c0392b', title: t('stop at entry') });
      if (selected?.targetPriceAtEntry) lines.push({ price: selected.targetPriceAtEntry, color: '#35598f', title: t('target at entry'), dashed: true });
    }
    const overlays: Overlay[] = [];
    if (adv && selected) {
      // no overlay when the cached bars start after the entry
      const i = entryBarIndex(bars, selected.entryDate);
      if (i >= 0) {
        const ts = trailingStop(bars, atr(bars, 14), i, selected.atrMultiple ?? 2, selected.side, selected.stopAtEntry ?? undefined);
        const end = ts.exit ? ts.exit.index : bars.length - 1;
        // Overlay values are index-aligned to the bars the chart gets; `shown` is a suffix of `bars`.
        const values = ts.stops.map((v, k) => (k <= end ? v : null)).slice(bars.length - shown.length);
        overlays.push({ name: t('{k}×ATR trail', { k: selected.atrMultiple ?? 2 }), color: '#c0392b', dashed: true, values });
      }
    }
    return { markers, lines, overlays };
  }, [trades, catalysts, head, sel, selected, bars, shown, withTrades, withCatalysts, withTargets, adv, lang]);

  const provider = providers.find((p) => p.id === (res?.provider ?? sec?.priceSource));
  const setSource = async (priceSource: string) => {
    if (!sec) return;
    try {
      await api.updateSecurity(sec.id, { priceSource });
      await refresh('project');
      await refresh('quote');
    } catch (e) {
      toast(tm((e as Error).message), 'error');
    }
  };
  const cols = adv ? 14 : 12;

  return (
    <div className="page" style={{ maxWidth: 1500 }} data-testid="trades-page">
      <div className="page-head">
        <h1>{t('Trades')}</h1>
        {provider?.synthetic && <span className="badge synthetic">{t('SYNTHETIC DEMO DATA — not real prices')}</span>}
        <Advanced>
          <span className="sub">{t('Trading is separate from valuation: each trade points to the research snapshot that was valid on its entry date.')}</span>
        </Advanced>
        <span className="right row">
          <button
            className="btn"
            disabled={loading}
            onClick={async () => {
              await reload(true);
              if (sec) useWorkspace.setState({ quote: await api.quote(sec.id, undefined, true) });
            }}
            data-testid="refresh-market"
          >
            {loading ? t('Loading…') : t('↻ Refresh prices')}
          </button>
          <button className="btn primary" onClick={() => setCreating(!creating)} data-testid="new-trade">
            {t('+ Record entry')}
          </button>
        </span>
      </div>
      {res?.error && <div className="msg err" style={{ marginBottom: 10 }}>{t('Provider error: {error}', { error: tm(res.error) })}{bars.length ? t(' — showing cached data.') : t(' Use “Find by code or name” on the right to pick the correct code or another price source.')}</div>}
      <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', marginBottom: 14 }}>
        <div className="card" style={{ padding: 10 }}>
          <Advanced>
            <div className="row wrap" style={{ marginBottom: 8 }}>
              <div className="seg">
                {RANGES.map((r) => (
                  <button key={r.id} className={cls(range === r.id && 'on plain')} onClick={() => setRange(r.id)}>
                    {r.id === 'All' ? t('All') : r.id}
                  </button>
                ))}
              </div>
              <label className="small sub row" style={{ gap: 4 }}>
                MA <input style={{ width: 70 }} value={ma} onChange={(e) => setMa(e.target.value)} />
              </label>
              <label className="small sub row" style={{ gap: 4 }}>
                ATR <input type="number" style={{ width: 56 }} value={atrN} min={2} max={100} onChange={(e) => setAtrN(Math.max(2, Number(e.target.value) || 14))} />
              </label>
              <label className="small row" style={{ gap: 4 }}>
                <input type="checkbox" checked={showTrades} onChange={(e) => setShowTrades(e.target.checked)} /> {t('trades')}
              </label>
              <label className="small row" style={{ gap: 4 }}>
                <input type="checkbox" checked={showCatalysts} onChange={(e) => setShowCatalysts(e.target.checked)} /> {t('catalysts')}
              </label>
              <label className="small row" style={{ gap: 4 }}>
                <input type="checkbox" checked={showTargets} onChange={(e) => setShowTargets(e.target.checked)} /> {t('target prices & stops')}
              </label>
            </div>
          </Advanced>
          {bars.length ? (
            <PriceChart bars={shown} maPeriods={maPeriods} atrPeriod={atrPeriod} markers={chart.markers} priceLines={chart.lines} overlays={chart.overlays} height={460} />
          ) : (
            <div className="empty" style={{ height: 300 }}>
              {loading ? t('Loading prices…') : t('No price data. Refresh from the provider, switch the price source, or import a CSV.')}
            </div>
          )}
          <Advanced>
            <div className="tiny sub" style={{ marginTop: 6 }}>
              {t('Target price lines come from the latest committed Research Update (#{seq}); they do not move when you edit the draft.', { seq: head?.seq })}
            </div>
          </Advanced>
        </div>
        <div className="col" style={{ gap: 14 }}>
          <QuoteCard bars={bars} res={res} atrN={atrPeriod} />
          {sec && <SecurityCard providers={providers} onSource={setSource} onImported={() => void reload(false)} />}
        </div>
      </div>
      {creating && <NewTrade bars={bars} onDone={(tr) => (setCreating(false), tr && setSel(tr.id))} />}
      <div className="card" style={{ padding: 0, marginBottom: 14, overflowX: 'auto' }}>
        <table className="grid" data-testid="trade-table">
          <thead>
            <tr>
              <th className="l">{t('Entry')}</th>
              <th>{t('Side')}</th>
              <th>{t('Price')}</th>
              <th>{t('Size')}</th>
              <th>{t('Stop')}</th>
              <th>ATR</th>
              <th>{t('Target at entry')}</th>
              <th className="l">{t('Research snapshot')}</th>
              <th className="l">{t('Exit')}</th>
              <th>{t('Return')}</th>
              <th>R</th>
              <th>P&L</th>
              {adv && <th>MFE / MAE</th>}
              {adv && <th className="l">{t('Trail-stop exit')}</th>}
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && (
              <tr>
                <td colSpan={cols} className="l sub">
                  {t('No trades yet.')}
                </td>
              </tr>
            )}
            {trades.map((tr) => {
              const m = tradeMetrics(tr, bars, { quote: markQuote(tr) });
              const rev = revSeq(tr.revisionId);
              return (
                <tr key={tr.id} className={cls(sel === tr.id && 'sel')} onClick={() => setSel(tr.id)} style={{ cursor: 'pointer' }}>
                  <td className="l">
                    {tr.entryDate} <AiBadge actor={tr.createdBy} />
                    {tr.source === 'import' && <span className="badge" title={t('Copied from an old trade journal')}> {t('imported')}</span>}
                  </td>
                  <td>{t(tr.side)}</td>
                  <td>{tr.entryPrice}</td>
                  <td>{tr.quantity}</td>
                  <td>{tr.stopAtEntry?.toFixed(2) ?? '—'}</td>
                  <td>{tr.atrAtEntry?.toFixed(2) ?? '—'}</td>
                  <td>{tr.targetPriceAtEntry?.toFixed(1) ?? '—'}</td>
                  <td className="l">
                    {rev ? (
                      <a href={`#/p/${projectId}/history/${rev.id}`} onClick={(e) => e.stopPropagation()}>
                        #{rev.seq} ({rev.asOfDate})
                      </a>
                    ) : (
                      <span className="sub">{t('none before entry')}</span>
                    )}
                  </td>
                  <td className="l">{tr.exitDate ? `${tr.exitDate} @ ${tr.exitPrice}` : <span className="badge accent">{t('open')}</span>}</td>
                  <td className={cls((m.returnPct ?? 0) >= 0 ? 'pos' : 'neg')}>{pctText(m.returnPct)}</td>
                  <td>{m.rMultiple === null ? '—' : m.rMultiple.toFixed(2)}</td>
                  <td>{m.pnl === null ? '—' : m.pnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  {adv && (
                    <td>
                      {pctText(m.mfe)} / {pctText(m.mae)}
                    </td>
                  )}
                  {adv && <td className="l small">{m.trailingExit ? `${m.trailingExit.date} @ ${m.trailingExit.price.toFixed(2)} (${pctText(m.trailingExit.returnPct)})` : m.open ? t('not hit') : '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selected ? <TradeDetail key={selected.id} t={selected} bars={bars} quote={markQuote(selected)} /> : trades.length > 0 && <div className="empty">{t('Select a trade.')}</div>}
    </div>
  );
}

function NewTrade({ bars, onDone }: { bars: Bar[]; onDone: (t: TradeDTO | null) => void }) {
  const projectId = useWorkspace((s) => s.projectId)!;
  const revisions = useWorkspace((s) => s.revisions);
  const lastBar = bars.at(-1);
  const [f, setF] = useState({ entryDate: lastBar?.date ?? today(), entryPrice: lastBar ? String(lastBar.close) : '', quantity: '', side: 'long' as 'long' | 'short', entryReason: '', stopAtEntry: '', atrMultiple: '2', targetPriceAtEntry: '' });
  const [error, setError] = useState<string | null>(null);
  const [priceTouched, setPriceTouched] = useState(false);
  const [dateTouched, setDateTouched] = useState(false);
  const atrV = bars.length ? atrAsOf(bars, f.entryDate, 14) : null;
  const k = Number(f.atrMultiple) || 2;
  const price = Number(f.entryPrice);
  const suggestedStop = atrV !== null && price > 0 ? (f.side === 'long' ? price - k * atrV : price + k * atrV) : null;
  const rev = [...revisions].reverse().find((r) => r.asOfDate && r.asOfDate <= f.entryDate);
  const barOnDate = bars[indexAtOrBefore(bars, f.entryDate)];
  // Prefill from prices once they load: last bar's date, and the close on the chosen date.
  useEffect(() => {
    if (!dateTouched && lastBar && f.entryDate !== lastBar.date && !f.entryPrice) setF((x) => ({ ...x, entryDate: lastBar.date }));
  }, [lastBar, dateTouched]);
  useEffect(() => {
    if (!priceTouched && barOnDate) setF((x) => ({ ...x, entryPrice: String(barOnDate.close) }));
  }, [barOnDate, priceTouched]);
  const save = async () => {
    setError(null);
    try {
      const created = await api.createTrade(projectId, {
        entryDate: f.entryDate,
        entryPrice: Number(f.entryPrice),
        quantity: Number(f.quantity),
        side: f.side,
        entryReason: f.entryReason,
        atrMultiple: k,
        ...(f.stopAtEntry ? { stopAtEntry: Number(f.stopAtEntry) } : {}),
        ...(f.targetPriceAtEntry ? { targetPriceAtEntry: Number(f.targetPriceAtEntry) } : {}),
      });
      await useWorkspace.getState().refresh('trades');
      onDone(created);
    } catch (e) {
      setError(tm((e as Error).message));
    }
  };
  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="new-trade-form">
      <h2>{t('Record entry')}</h2>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label={t('Entry date')}>
          <input type="date" value={f.entryDate} onChange={(e) => (setDateTouched(true), setF({ ...f, entryDate: e.target.value }))} data-testid="tr-date" />
        </Field>
        <Field label={t('Side')}>
          <select value={f.side} onChange={(e) => setF({ ...f, side: e.target.value as 'long' | 'short' })}>
            <option value="long">{t('long')}</option>
            <option value="short">{t('short')}</option>
          </select>
        </Field>
        <Field label={barOnDate ? t('Entry price (close {date}: {close})', { date: barOnDate.date, close: barOnDate.close }) : t('Entry price')}>
          <input type="number" value={f.entryPrice} onChange={(e) => (setPriceTouched(true), setF({ ...f, entryPrice: e.target.value }))} data-testid="tr-price" />
        </Field>
        <Field label={t('Position size (shares)')}>
          <input type="number" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} data-testid="tr-qty" />
        </Field>
        <Field label={t('ATR multiple')}>
          <input type="number" style={{ width: 70 }} value={f.atrMultiple} onChange={(e) => setF({ ...f, atrMultiple: e.target.value })} />
        </Field>
        <Field label={t('Stop (suggested {price})', { price: suggestedStop?.toFixed(2) ?? '—' })}>
          <input type="number" value={f.stopAtEntry} placeholder={suggestedStop?.toFixed(2) ?? ''} onChange={(e) => setF({ ...f, stopAtEntry: e.target.value })} />
        </Field>
        <Field label={t('Target at entry (default: snapshot base)')}>
          <input type="number" value={f.targetPriceAtEntry} placeholder={t('from snapshot')} onChange={(e) => setF({ ...f, targetPriceAtEntry: e.target.value })} />
        </Field>
      </div>
      <Field label={t('Entry reason')} style={{ marginTop: 8 }}>
        <textarea rows={2} value={f.entryReason} onChange={(e) => setF({ ...f, entryReason: e.target.value })} placeholder={t('Setup, catalyst, why now')} data-testid="tr-reason" />
      </Field>
      <div className="small sub" style={{ marginTop: 6 }}>
        {t('ATR(14) as of entry date:')} <b>{atrV?.toFixed(2) ?? '—'}</b> {t('(only bars up to that date). Research snapshot:')}{' '}
        <b>{rev ? t('#{seq} “{title}” (knowledge date {date})', { seq: rev.seq, title: rev.title, date: rev.asOfDate }) : t('none — no Research Update dated on or before the entry')}</b>.
      </div>
      {error && <div className="msg err" style={{ marginTop: 6 }}>{error}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!f.entryPrice || !f.quantity} onClick={() => void save()} data-testid="tr-save">
          {t('Save entry')}
        </button>
        <button className="btn ghost" onClick={() => onDone(null)}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}

function TradeDetail({ t: tr, bars, quote }: { t: TradeDTO; bars: Bar[]; quote: { price: number; asOf: string } | null }) {
  const projectId = useWorkspace((s) => s.projectId)!;
  const { refresh, toast } = useWorkspace.getState();
  const last = bars.at(-1);
  const [exit, setExit] = useState({ exitDate: tr.exitDate ?? last?.date ?? today(), exitPrice: tr.exitPrice ? String(tr.exitPrice) : last ? String(last.close) : '', exitReason: tr.exitReason });
  const [exitPriceTouched, setExitPriceTouched] = useState(!!tr.exitPrice);
  const exitBar = bars[indexAtOrBefore(bars, exit.exitDate)];
  useEffect(() => {
    if (!exitPriceTouched && exitBar) setExit((x) => ({ ...x, exitPrice: String(exitBar.close) }));
  }, [exitBar, exitPriceTouched]);
  const m = tradeMetrics(tr, bars, { quote });
  const save = async (patch: Partial<TradeDTO>) => {
    try {
      await api.updateTrade(tr.id, patch);
      await refresh('trades');
    } catch (e) {
      toast(tm((e as Error).message), 'error');
    }
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
      <div className="card">
        <h2>
          {t('{side} {qty} @ {price} on {date}', { side: t(tr.side), qty: tr.quantity, price: tr.entryPrice, date: tr.entryDate })}
        </h2>
        {isAgentActor(tr.createdBy) && (
          <div className="small sub">
            {t('Recorded by {who}', { who: actorLabel(tr.createdBy, getLang()) })}
            {tr.source === 'import' && ` · ${t('imported from an old journal')}`}
          </div>
        )}
        <div className="small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>
          <b>{t('Reason: ')}</b>
          {tr.entryReason || <span className="sub">—</span>}
        </div>
        {tr.sourceText && (
          <details className="small" style={{ margin: '6px 0' }}>
            <summary>{t('Journal excerpt it was imported from')}</summary>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }} data-testid="trade-source-text">
              {tr.sourceText}
            </div>
          </details>
        )}
        <table className="grid">
          <tbody>
            <tr>
              <td>{t('Initial risk (entry − stop)')}</td>
              <td>{tr.stopAtEntry ? Math.abs(tr.entryPrice - tr.stopAtEntry).toFixed(2) : '—'}</td>
            </tr>
            <tr>
              <td>{m.open ? t('Unrealized return') : t('Realized return')}</td>
              <td>{pctText(m.returnPct)}</td>
            </tr>
            <tr>
              <td>{t('R multiple')}</td>
              <td>{m.rMultiple?.toFixed(2) ?? '—'}</td>
            </tr>
            <Advanced>
              <tr>
                <td>{t('Max favourable / adverse excursion')}</td>
                <td>
                  {pctText(m.mfe)} / {pctText(m.mae)}
                </td>
              </tr>
              <tr>
                <td>{t('{k}×ATR trailing stop would have exited', { k: tr.atrMultiple ?? 2 })}</td>
                <td>{m.trailingExit ? `${m.trailingExit.date} @ ${m.trailingExit.price.toFixed(2)} (${pctText(m.trailingExit.returnPct)})` : t('not triggered')}</td>
              </tr>
            </Advanced>
          </tbody>
        </table>
        <Advanced>
          <div className="tiny sub" style={{ marginTop: 6 }}>
            {t('Compare the actual exit with the trailing-stop counterfactual and MFE to separate “thesis wrong” from “execution poor”.')}
          </div>
        </Advanced>
      </div>
      <div className="col" style={{ gap: 12 }}>
        <div className="card" data-testid="exit-form">
          <h2>{tr.exitDate ? t('Exit') : t('Record exit')}</h2>
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label={t('Exit date')}>
              <input type="date" value={exit.exitDate} onChange={(e) => setExit({ ...exit, exitDate: e.target.value })} data-testid="exit-date" />
            </Field>
            <Field label={t('Exit price')}>
              <input type="number" value={exit.exitPrice} onChange={(e) => (setExitPriceTouched(true), setExit({ ...exit, exitPrice: e.target.value }))} data-testid="exit-price" />
            </Field>
          </div>
          <Field label={t('Exit reason')} style={{ marginTop: 6 }}>
            <textarea rows={2} value={exit.exitReason} onChange={(e) => setExit({ ...exit, exitReason: e.target.value })} data-testid="exit-reason" />
          </Field>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={!exit.exitDate || !exit.exitPrice} onClick={() => void save({ exitDate: exit.exitDate, exitPrice: Number(exit.exitPrice), exitReason: exit.exitReason })} data-testid="exit-save">
              {t('Save exit')}
            </button>
            {tr.exitDate && (
              <button className="btn ghost" onClick={() => void save({ exitDate: null, exitPrice: null })}>
                {t('Reopen')}
              </button>
            )}
            <Advanced>
              <button className="btn ghost right" onClick={() => navigate({ page: 'project', projectId, tab: 'history', param: 'reviews' })}>
                {t('Write a review →')}
              </button>
            </Advanced>
          </div>
        </div>
        <ReflectionCard noteId={tr.id} kind="trade" />
        <Advanced>
          <button
            className="btn danger"
            onClick={async () => {
              if (!window.confirm(t('Delete this trade? (kept in the audit log)'))) return;
              await api.deleteTrade(tr.id);
              await refresh('trades');
            }}
          >
            {t('Delete trade')}
          </button>
        </Advanced>
      </div>
    </div>
  );
}
