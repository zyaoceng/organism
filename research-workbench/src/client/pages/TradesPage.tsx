import { useEffect, useMemo, useState } from 'react';
import { atr, atrAsOf, indexAtOrBefore, trailingStop, type Bar } from '../../domain/market/indicators';
import { tradeMetrics } from '../../domain/trade/metrics';
import type { TradeDTO } from '../../shared/api';
import { PriceChart, type ChartMarker, type ChartPriceLine, type Overlay } from '../components/PriceChart';
import { Field } from '../components/ui';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useWorkspace } from '../lib/store';
import { useBars } from '../lib/useBars';
import { cls, pctText, today } from '../lib/util';

export function TradesPage() {
  const trades = useWorkspace((s) => s.trades);
  const revisions = useWorkspace((s) => s.revisions);
  const projectId = useWorkspace((s) => s.projectId)!;
  const { bars } = useBars();
  const [sel, setSel] = useState<string | null>(trades[0]?.id ?? null);
  const [creating, setCreating] = useState(trades.length === 0);
  const selected = trades.find((t) => t.id === sel) ?? null;
  const revSeq = (id: string | null) => revisions.find((r) => r.id === id);

  const chart = useMemo(() => {
    const markers: ChartMarker[] = [];
    for (const t of trades) {
      markers.push({ time: t.entryDate, position: t.side === 'long' ? 'belowBar' : 'aboveBar', color: t.id === sel ? '#0b6e63' : '#8aa9a4', shape: t.side === 'long' ? 'arrowUp' : 'arrowDown', text: `Buy ${t.entryPrice}` });
      if (t.exitDate && t.exitPrice) markers.push({ time: t.exitDate, position: t.side === 'long' ? 'aboveBar' : 'belowBar', color: t.id === sel ? '#c0392b' : '#d9a39d', shape: t.side === 'long' ? 'arrowDown' : 'arrowUp', text: `Sell ${t.exitPrice}` });
    }
    const lines: ChartPriceLine[] = [];
    const overlays: Overlay[] = [];
    if (selected) {
      if (selected.stopAtEntry) lines.push({ price: selected.stopAtEntry, color: '#c0392b', title: 'stop at entry' });
      if (selected.targetPriceAtEntry) lines.push({ price: selected.targetPriceAtEntry, color: '#35598f', title: 'target at entry', dashed: true });
      const i = bars.findIndex((b) => b.date >= selected.entryDate);
      if (i >= 0) {
        const ts = trailingStop(bars, atr(bars, 14), i, selected.atrMultiple ?? 2, selected.side, selected.stopAtEntry ?? undefined);
        const end = ts.exit ? ts.exit.index : bars.length - 1;
        overlays.push({ name: `${selected.atrMultiple ?? 2}×ATR trail`, color: '#c0392b', dashed: true, values: ts.stops.map((v, k) => (k <= end ? v : null)) });
      }
    }
    return { markers, lines, overlays };
  }, [trades, sel, selected, bars]);

  return (
    <div className="page" style={{ maxWidth: 1500 }} data-testid="trades-page">
      <div className="page-head">
        <h1>Trade journal</h1>
        <span className="sub">Trading is separate from valuation: each trade points to the research snapshot that was valid on its entry date.</span>
        <button className="btn primary right" onClick={() => setCreating(!creating)} data-testid="new-trade">
          + Record entry
        </button>
      </div>
      {creating && <NewTrade bars={bars} onDone={(t) => (setCreating(false), t && setSel(t.id))} />}
      <div className="card" style={{ padding: 0, marginBottom: 14, overflowX: 'auto' }}>
        <table className="grid" data-testid="trade-table">
          <thead>
            <tr>
              <th className="l">Entry</th>
              <th>Side</th>
              <th>Price</th>
              <th>Size</th>
              <th>Stop</th>
              <th>ATR</th>
              <th>Target at entry</th>
              <th className="l">Research snapshot</th>
              <th className="l">Exit</th>
              <th>Return</th>
              <th>R</th>
              <th>P&L</th>
              <th>MFE / MAE</th>
              <th className="l">Trail-stop exit</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && (
              <tr>
                <td colSpan={14} className="l sub">
                  No trades yet.
                </td>
              </tr>
            )}
            {trades.map((t) => {
              const m = tradeMetrics(t, bars);
              const rev = revSeq(t.revisionId);
              return (
                <tr key={t.id} className={cls(sel === t.id && 'sel')} onClick={() => setSel(t.id)} style={{ cursor: 'pointer' }}>
                  <td className="l">{t.entryDate}</td>
                  <td>{t.side}</td>
                  <td>{t.entryPrice}</td>
                  <td>{t.quantity}</td>
                  <td>{t.stopAtEntry?.toFixed(2) ?? '—'}</td>
                  <td>{t.atrAtEntry?.toFixed(2) ?? '—'}</td>
                  <td>{t.targetPriceAtEntry?.toFixed(1) ?? '—'}</td>
                  <td className="l">
                    {rev ? (
                      <a href={`#/p/${projectId}/history/${rev.id}`} onClick={(e) => e.stopPropagation()}>
                        #{rev.seq} ({rev.asOfDate})
                      </a>
                    ) : (
                      <span className="sub">none before entry</span>
                    )}
                  </td>
                  <td className="l">{t.exitDate ? `${t.exitDate} @ ${t.exitPrice}` : <span className="badge accent">open</span>}</td>
                  <td className={cls((m.returnPct ?? 0) >= 0 ? 'pos' : 'neg')}>{pctText(m.returnPct)}</td>
                  <td>{m.rMultiple === null ? '—' : m.rMultiple.toFixed(2)}</td>
                  <td>{m.pnl === null ? '—' : m.pnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  <td>
                    {pctText(m.mfe)} / {pctText(m.mae)}
                  </td>
                  <td className="l small">{m.trailingExit ? `${m.trailingExit.date} @ ${m.trailingExit.price.toFixed(2)} (${pctText(m.trailingExit.returnPct)})` : m.open ? 'not hit' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="split">
        <div className="card" style={{ padding: 10 }}>
          {bars.length ? <PriceChart bars={bars} maPeriods={[20]} atrPeriod={14} markers={chart.markers} priceLines={chart.lines} overlays={chart.overlays} height={460} /> : <div className="empty">No price data (see Market).</div>}
        </div>
        <div>{selected ? <TradeDetail key={selected.id} t={selected} bars={bars} /> : <div className="empty">Select a trade.</div>}</div>
      </div>
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
      const t = await api.createTrade(projectId, {
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
      onDone(t);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="new-trade-form">
      <h2>Record entry</h2>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Entry date">
          <input type="date" value={f.entryDate} onChange={(e) => (setDateTouched(true), setF({ ...f, entryDate: e.target.value }))} data-testid="tr-date" />
        </Field>
        <Field label="Side">
          <select value={f.side} onChange={(e) => setF({ ...f, side: e.target.value as 'long' | 'short' })}>
            <option value="long">long</option>
            <option value="short">short</option>
          </select>
        </Field>
        <Field label={`Entry price${barOnDate ? ` (close ${barOnDate.date}: ${barOnDate.close})` : ''}`}>
          <input type="number" value={f.entryPrice} onChange={(e) => (setPriceTouched(true), setF({ ...f, entryPrice: e.target.value }))} data-testid="tr-price" />
        </Field>
        <Field label="Position size (shares)">
          <input type="number" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} data-testid="tr-qty" />
        </Field>
        <Field label="ATR multiple">
          <input type="number" style={{ width: 70 }} value={f.atrMultiple} onChange={(e) => setF({ ...f, atrMultiple: e.target.value })} />
        </Field>
        <Field label={`Stop (suggested ${suggestedStop?.toFixed(2) ?? '—'})`}>
          <input type="number" value={f.stopAtEntry} placeholder={suggestedStop?.toFixed(2) ?? ''} onChange={(e) => setF({ ...f, stopAtEntry: e.target.value })} />
        </Field>
        <Field label="Target at entry (default: snapshot base)">
          <input type="number" value={f.targetPriceAtEntry} placeholder="from snapshot" onChange={(e) => setF({ ...f, targetPriceAtEntry: e.target.value })} />
        </Field>
      </div>
      <Field label="Entry reason" style={{ marginTop: 8 }}>
        <textarea rows={2} value={f.entryReason} onChange={(e) => setF({ ...f, entryReason: e.target.value })} placeholder="Setup, catalyst, why now" data-testid="tr-reason" />
      </Field>
      <div className="small sub" style={{ marginTop: 6 }}>
        ATR(14) as of entry date: <b>{atrV?.toFixed(2) ?? '—'}</b> (only bars up to that date). Research snapshot:{' '}
        <b>{rev ? `#${rev.seq} “${rev.title}” (knowledge date ${rev.asOfDate})` : 'none — no Research Update dated on or before the entry'}</b>.
      </div>
      {error && <div className="msg err" style={{ marginTop: 6 }}>{error}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!f.entryPrice || !f.quantity} onClick={() => void save()} data-testid="tr-save">
          Save entry
        </button>
        <button className="btn ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TradeDetail({ t, bars }: { t: TradeDTO; bars: Bar[] }) {
  const projectId = useWorkspace((s) => s.projectId)!;
  const { refresh, toast } = useWorkspace.getState();
  const last = bars.at(-1);
  const [exit, setExit] = useState({ exitDate: t.exitDate ?? last?.date ?? today(), exitPrice: t.exitPrice ? String(t.exitPrice) : last ? String(last.close) : '', exitReason: t.exitReason });
  const [exitPriceTouched, setExitPriceTouched] = useState(!!t.exitPrice);
  const exitBar = bars[indexAtOrBefore(bars, exit.exitDate)];
  useEffect(() => {
    if (!exitPriceTouched && exitBar) setExit((x) => ({ ...x, exitPrice: String(exitBar.close) }));
  }, [exitBar, exitPriceTouched]);
  const m = tradeMetrics(t, bars);
  const save = async (patch: Partial<TradeDTO>) => {
    try {
      await api.updateTrade(t.id, patch);
      await refresh('trades');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card">
        <h2>
          {t.side} {t.quantity} @ {t.entryPrice} on {t.entryDate}
        </h2>
        <div className="small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>
          <b>Reason: </b>
          {t.entryReason || <span className="sub">—</span>}
        </div>
        <table className="grid">
          <tbody>
            <tr>
              <td>Initial risk (entry − stop)</td>
              <td>{t.stopAtEntry ? Math.abs(t.entryPrice - t.stopAtEntry).toFixed(2) : '—'}</td>
            </tr>
            <tr>
              <td>{m.open ? 'Unrealized' : 'Realized'} return</td>
              <td>{pctText(m.returnPct)}</td>
            </tr>
            <tr>
              <td>R multiple</td>
              <td>{m.rMultiple?.toFixed(2) ?? '—'}</td>
            </tr>
            <tr>
              <td>Max favourable / adverse excursion</td>
              <td>
                {pctText(m.mfe)} / {pctText(m.mae)}
              </td>
            </tr>
            <tr>
              <td>{t.atrMultiple ?? 2}×ATR trailing stop would have exited</td>
              <td>{m.trailingExit ? `${m.trailingExit.date} @ ${m.trailingExit.price.toFixed(2)} (${pctText(m.trailingExit.returnPct)})` : 'not triggered'}</td>
            </tr>
          </tbody>
        </table>
        <div className="tiny sub" style={{ marginTop: 6 }}>
          Compare the actual exit with the trailing-stop counterfactual and MFE to separate “thesis wrong” from “execution poor”.
        </div>
      </div>
      <div className="card" data-testid="exit-form">
        <h2>{t.exitDate ? 'Exit' : 'Record exit'}</h2>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Exit date">
            <input type="date" value={exit.exitDate} onChange={(e) => setExit({ ...exit, exitDate: e.target.value })} data-testid="exit-date" />
          </Field>
          <Field label="Exit price">
            <input type="number" value={exit.exitPrice} onChange={(e) => (setExitPriceTouched(true), setExit({ ...exit, exitPrice: e.target.value }))} data-testid="exit-price" />
          </Field>
        </div>
        <Field label="Exit reason" style={{ marginTop: 6 }}>
          <textarea rows={2} value={exit.exitReason} onChange={(e) => setExit({ ...exit, exitReason: e.target.value })} data-testid="exit-reason" />
        </Field>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={!exit.exitDate || !exit.exitPrice} onClick={() => void save({ exitDate: exit.exitDate, exitPrice: Number(exit.exitPrice), exitReason: exit.exitReason })} data-testid="exit-save">
            Save exit
          </button>
          {t.exitDate && (
            <button className="btn ghost" onClick={() => void save({ exitDate: null, exitPrice: null })}>
              Reopen
            </button>
          )}
          <button className="btn ghost right" onClick={() => navigate({ page: 'project', projectId, tab: 'history', param: 'reviews' })}>
            Write a review →
          </button>
        </div>
      </div>
      <button
        className="btn danger"
        onClick={async () => {
          if (!window.confirm('Delete this trade? (kept in the audit log)')) return;
          await api.deleteTrade(t.id);
          await refresh('trades');
        }}
      >
        Delete trade
      </button>
    </div>
  );
}
