import { useEffect, useMemo, useState } from 'react';
import { atr } from '../../domain/market/indicators';
import { findByRole } from '../../domain/model/tree';
import type { ProviderDTO } from '../../shared/api';
import { PriceChart, type ChartMarker, type ChartPriceLine } from '../components/PriceChart';
import { Field } from '../components/ui';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/store';
import { useBars } from '../lib/useBars';
import { cls, fmtDateTime, timeAgo } from '../lib/util';

const RANGES = [
  { id: '6M', days: 183 },
  { id: '1Y', days: 365 },
  { id: '3Y', days: 1095 },
  { id: 'All', days: 100000 },
];

export function MarketPage() {
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const securities = useWorkspace((s) => s.securities);
  const sec = securities[0];
  const quote = useWorkspace((s) => s.quote);
  const trades = useWorkspace((s) => s.trades);
  const catalysts = useWorkspace((s) => s.catalysts);
  const head = useWorkspace((s) => s.head);
  const { toast, refresh } = useWorkspace.getState();
  const { bars, res, loading, reload } = useBars();
  const [range, setRange] = useState('1Y');
  const [ma, setMa] = useState('20,60');
  const [atrN, setAtrN] = useState(14);
  const [showTrades, setShowTrades] = useState(true);
  const [showCatalysts, setShowCatalysts] = useState(true);
  const [showTargets, setShowTargets] = useState(true);
  useEffect(() => {
    void api.providers().then(setProviders);
  }, []);

  const shown = useMemo(() => {
    const days = RANGES.find((r) => r.id === range)?.days ?? 365;
    const last = bars.at(-1)?.date;
    if (!last) return bars;
    const cutoff = new Date(Date.parse(last) - days * 86400000).toISOString().slice(0, 10);
    return bars.filter((b) => b.date >= cutoff);
  }, [bars, range]);
  const maPeriods = useMemo(() => ma.split(/[ ,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 1 && n < 400).slice(0, 4), [ma]);

  const markers: ChartMarker[] = [];
  if (showTrades) {
    for (const t of trades) {
      markers.push({ time: t.entryDate, position: t.side === 'long' ? 'belowBar' : 'aboveBar', color: '#0b6e63', shape: t.side === 'long' ? 'arrowUp' : 'arrowDown', text: `Entry ${t.entryPrice}` });
      if (t.exitDate && t.exitPrice) markers.push({ time: t.exitDate, position: t.side === 'long' ? 'aboveBar' : 'belowBar', color: '#c0392b', shape: t.side === 'long' ? 'arrowDown' : 'arrowUp', text: `Exit ${t.exitPrice}` });
    }
  }
  if (showCatalysts) {
    for (const c of catalysts) {
      const d = c.actualDate ?? c.expectedDate;
      if (d) markers.push({ time: d, position: 'aboveBar', color: c.status === 'occurred' ? '#6a4fc4' : '#a8a8c8', shape: 'circle', text: c.title.slice(0, 24) });
    }
  }
  const priceLines: ChartPriceLine[] = [];
  if (showTargets && head) {
    const tp = findByRole(head.state, 'target_price');
    const colors = { bear: '#b5473a', base: '#35598f', bull: '#2f7d4f' } as const;
    if (tp) {
      for (const s of ['bear', 'base', 'bull'] as const) {
        const v = head.computed.values[s][tp.id]?._;
        if (v) priceLines.push({ price: v, color: colors[s], title: `${s} TP #${head.seq}`, dashed: true });
      }
    }
    for (const t of trades.filter((x) => !x.exitDate && x.stopAtEntry)) priceLines.push({ price: t.stopAtEntry!, color: '#c0392b', title: `stop ${t.entryDate}` });
  }

  const last = bars.at(-1);
  const prev = bars.at(-2);
  const a = useMemo(() => atr(bars, atrN), [bars, atrN]).at(-1) ?? null;
  const yearBars = bars.filter((b) => last && b.date >= new Date(Date.parse(last.date) - 365 * 86400000).toISOString().slice(0, 10));
  const provider = providers.find((p) => p.id === (res?.provider ?? sec?.priceSource));

  const setSource = async (priceSource: string) => {
    if (!sec) return;
    try {
      await api.updateSecurity(sec.id, { priceSource });
      await refresh('project');
      await refresh('quote');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1500 }} data-testid="market-page">
      <div className="page-head">
        <h1>Market</h1>
        {provider?.synthetic && <span className="badge synthetic">SYNTHETIC DEMO DATA — not real prices</span>}
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
            {loading ? 'Loading…' : '↻ Refresh prices'}
          </button>
        </span>
      </div>
      {res?.error && <div className="msg err" style={{ marginBottom: 10 }}>Provider error: {res.error}{bars.length ? ' — showing cached data.' : ''}</div>}
      <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
        <div className="card" style={{ padding: 10 }}>
          <div className="row wrap" style={{ marginBottom: 8 }}>
            <div className="seg">
              {RANGES.map((r) => (
                <button key={r.id} className={cls(range === r.id && 'on plain')} onClick={() => setRange(r.id)}>
                  {r.id}
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
              <input type="checkbox" checked={showTrades} onChange={(e) => setShowTrades(e.target.checked)} /> trades
            </label>
            <label className="small row" style={{ gap: 4 }}>
              <input type="checkbox" checked={showCatalysts} onChange={(e) => setShowCatalysts(e.target.checked)} /> catalysts
            </label>
            <label className="small row" style={{ gap: 4 }}>
              <input type="checkbox" checked={showTargets} onChange={(e) => setShowTargets(e.target.checked)} /> target prices & stops
            </label>
          </div>
          {bars.length ? (
            <PriceChart bars={shown} maPeriods={maPeriods} atrPeriod={atrN} markers={markers} priceLines={priceLines} />
          ) : (
            <div className="empty" style={{ height: 300 }}>
              {loading ? 'Loading prices…' : 'No price data. Refresh from the provider, switch the price source, or import a CSV.'}
            </div>
          )}
          <div className="tiny sub" style={{ marginTop: 6 }}>
            Target price lines come from the latest committed Research Update (#{head?.seq}); they do not move when you edit the draft.
          </div>
        </div>
        <div className="col" style={{ gap: 14 }}>
          <div className="card">
            <h2>
              {sec?.ticker} <span className="sub small">{sec?.exchange}</span>
            </h2>
            <div className="big">
              {quote?.quote ? quote.quote.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'} <span className="small sub">{quote?.quote?.currency ?? sec?.currency}</span>
            </div>
            {last && prev && (
              <div className={cls('small', last.close >= prev.close ? 'pos' : 'neg')}>
                {last.close >= prev.close ? '+' : ''}
                {(last.close - prev.close).toFixed(2)} ({(((last.close - prev.close) / prev.close) * 100).toFixed(2)}%) last bar {last.date}
              </div>
            )}
            <div className="tiny sub" style={{ marginTop: 6 }}>
              {quote?.quote ? (
                <>
                  Provider <b>{quote.quote.provider}</b> · market time {fmtDateTime(quote.quote.asOf)} · fetched {timeAgo(quote.quote.fetchedAt)}
                  {quote.stale && <span className="badge warn">stale</span>}
                </>
              ) : (
                quote?.error ?? 'No quote yet'
              )}
            </div>
            <div className="divider" />
            <table className="grid">
              <tbody>
                <tr>
                  <td>ATR({atrN})</td>
                  <td>{a === null ? '—' : a.toFixed(2)}</td>
                </tr>
                <tr>
                  <td>2 × ATR</td>
                  <td>{a === null ? '—' : (2 * a).toFixed(2)}</td>
                </tr>
                <tr>
                  <td>2 × ATR stop from last close</td>
                  <td>{a === null || !last ? '—' : (last.close - 2 * a).toFixed(2)}</td>
                </tr>
                <tr>
                  <td>52-week high / low</td>
                  <td>{yearBars.length ? `${Math.max(...yearBars.map((b) => b.high)).toFixed(2)} / ${Math.min(...yearBars.map((b) => b.low)).toFixed(2)}` : '—'}</td>
                </tr>
                <tr>
                  <td>Bars cached</td>
                  <td>{bars.length}</td>
                </tr>
                <tr>
                  <td>Last fetched</td>
                  <td>{timeAgo(res?.lastFetchedAt)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {sec && <SecurityCard providers={providers} onSource={setSource} onImported={() => void reload(false)} />}
        </div>
      </div>
    </div>
  );
}

function SecurityCard({ providers, onSource, onImported }: { providers: ProviderDTO[]; onSource: (p: string) => void; onImported: () => void }) {
  const sec = useWorkspace((s) => s.securities[0]);
  const { refresh, toast } = useWorkspace.getState();
  const [form, setForm] = useState({ ticker: sec.ticker, exchange: sec.exchange, apiSymbol: sec.apiSymbol, currency: sec.currency });
  const dirty = form.ticker !== sec.ticker || form.exchange !== sec.exchange || form.apiSymbol !== sec.apiSymbol || form.currency !== sec.currency;
  return (
    <div className="card">
      <h2>Security & data source</h2>
      <div className="col">
        <Field label="Price source">
          <select value={sec.priceSource} onChange={(e) => onSource(e.target.value)} data-testid="price-source">
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="tiny sub">{providers.find((p) => p.id === sec.priceSource)?.description}</div>
        <div className="two">
          <Field label="Ticker">
            <input value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} />
          </Field>
          <Field label="Exchange">
            <input value={form.exchange} onChange={(e) => setForm({ ...form, exchange: e.target.value })} />
          </Field>
          <Field label="Provider symbol">
            <input value={form.apiSymbol} onChange={(e) => setForm({ ...form, apiSymbol: e.target.value })} />
          </Field>
          <Field label="Currency">
            <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
          </Field>
        </div>
        {dirty && (
          <button
            className="btn sm primary"
            onClick={async () => {
              await api.updateSecurity(sec.id, form);
              await refresh('project');
            }}
          >
            Save identity
          </button>
        )}
        <div className="divider" />
        <label className="small">
          Import daily OHLCV CSV (Date, Open, High, Low, Close, Adj Close, Volume)
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const fd = new FormData();
              fd.append('file', f, f.name);
              try {
                const r = await api.importBars(sec.id, fd);
                toast(`Imported ${r.imported} bars (${r.first} → ${r.last}); ${r.skipped} rows skipped. Switch the price source to “CSV import” to use them.`, 'success');
                onImported();
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }}
          />
        </label>
      </div>
    </div>
  );
}
