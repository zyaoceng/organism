import { useEffect, useMemo, useState } from 'react';
import { atr, type Bar } from '../../domain/market/indicators';
import type { BarsResponse, ProviderDTO } from '../../shared/api';
import { api } from '../lib/api';
import { t, tm } from '../lib/i18n';
import { providerVisible, useAdvanced } from '../lib/prefs';
import { useWorkspace } from '../lib/store';
import { cls, fmtDateTime, timeAgo } from '../lib/util';
import { SymbolPicker } from './SymbolPicker';
import { Advanced, Field } from './ui';

/** Chart ranges, counted back from the last bar. */
export const RANGES = [
  { id: '6M', days: 183 },
  { id: '1Y', days: 365 },
  { id: '3Y', days: 1095 },
  { id: 'All', days: 100000 },
];

/** Price, change vs the previous close, provider line, ATR and the 52-week range. */
export function QuoteCard({ bars, res, atrN }: { bars: Bar[]; res: BarsResponse | null; atrN: number }) {
  const sec = useWorkspace((s) => s.securities[0]);
  const quote = useWorkspace((s) => s.quote);
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const a = useMemo(() => atr(bars, atrN), [bars, atrN]).at(-1) ?? null;
  const yearBars = bars.filter((b) => last && b.date >= new Date(Date.parse(last.date) - 365 * 86400000).toISOString().slice(0, 10));
  return (
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
          {(last.close - prev.close).toFixed(2)} ({(((last.close - prev.close) / prev.close) * 100).toFixed(2)}%) {t('last bar {date}', { date: last.date })}
        </div>
      )}
      <div className="tiny sub" style={{ marginTop: 6 }}>
        {quote?.quote ? (
          <>
            {t('Provider')} <b>{quote.quote.provider}</b> · {t('market time {time}', { time: fmtDateTime(quote.quote.asOf) })} · {t('fetched {ago}', { ago: timeAgo(quote.quote.fetchedAt) })}
            {quote.stale && <span className="badge warn">{t('stale')}</span>}
          </>
        ) : (
          (quote?.error ? tm(quote.error) : t('No quote yet'))
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
            <td>{t('2 × ATR stop from last close')}</td>
            <td>{a === null || !last ? '—' : (last.close - 2 * a).toFixed(2)}</td>
          </tr>
          <tr>
            <td>{t('52-week high / low')}</td>
            <td>{yearBars.length ? `${Math.max(...yearBars.map((b) => b.high)).toFixed(2)} / ${Math.min(...yearBars.map((b) => b.low)).toFixed(2)}` : '—'}</td>
          </tr>
          <Advanced>
            <tr>
              <td>{t('Bars cached')}</td>
              <td>{bars.length}</td>
            </tr>
            <tr>
              <td>{t('Last fetched')}</td>
              <td>{timeAgo(res?.lastFetchedAt)}</td>
            </tr>
          </Advanced>
        </tbody>
      </table>
    </div>
  );
}

/** Price source, symbol search and (advanced) the manual identity fields and CSV import. */
export function SecurityCard({ providers, onSource, onImported }: { providers: ProviderDTO[]; onSource: (p: string) => void; onImported: () => void }) {
  const sec = useWorkspace((s) => s.securities[0]);
  const { refresh, toast } = useWorkspace.getState();
  const adv = useAdvanced();
  const [form, setForm] = useState({ ticker: sec.ticker, exchange: sec.exchange, apiSymbol: sec.apiSymbol, currency: sec.currency });
  const [finding, setFinding] = useState(false);
  useEffect(() => setForm({ ticker: sec.ticker, exchange: sec.exchange, apiSymbol: sec.apiSymbol, currency: sec.currency }), [sec]);
  const dirty = form.ticker !== sec.ticker || form.exchange !== sec.exchange || form.apiSymbol !== sec.apiSymbol || form.currency !== sec.currency;
  return (
    <div className="card">
      <h2>{t('Security & data source')}</h2>
      <div className="col">
        <Field label={t('Price source')}>
          <select value={sec.priceSource} onChange={(e) => onSource(e.target.value)} data-testid="price-source">
            {providers
              .filter((p) => providerVisible(p, adv, sec.priceSource))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {t(p.label)}
                </option>
              ))}
          </select>
        </Field>
        <div className="tiny sub">{t(providers.find((p) => p.id === sec.priceSource)?.description ?? '')}</div>
        {finding ? (
          <SymbolPicker
            autoFocus
            providerLabel={(id) => t(providers.find((p) => p.id === id)?.label ?? id)}
            onPick={async (m) => {
              const priceSource = providers.some((p) => p.id === m.suggestedProvider) ? m.suggestedProvider : sec.priceSource;
              try {
                await api.updateSecurity(sec.id, { name: m.name, ticker: m.ticker, exchange: m.exchange, apiSymbol: m.apiSymbol, currency: m.currency || sec.currency, priceSource });
                setFinding(false);
                await refresh('project');
                await refresh('quote');
                toast(t('Now using {symbol} ({name}) from {provider}', { symbol: m.apiSymbol, name: m.name, provider: t(providers.find((p) => p.id === priceSource)?.label ?? priceSource) }), 'success');
              } catch (e) {
                toast(tm((e as Error).message), 'error');
              }
            }}
          />
        ) : (
          <button type="button" className="btn sm" onClick={() => setFinding(true)} data-testid="find-symbol">
            {t('🔍 Find by code or name')}
          </button>
        )}
        <Advanced>
          <div className="two">
            <Field label={t('Ticker')}>
              <input value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} />
            </Field>
            <Field label={t('Exchange')}>
              <input value={form.exchange} onChange={(e) => setForm({ ...form, exchange: e.target.value })} />
            </Field>
            <Field label={t('Provider symbol')}>
              <input value={form.apiSymbol} onChange={(e) => setForm({ ...form, apiSymbol: e.target.value })} />
            </Field>
            <Field label={t('Currency')}>
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
              {t('Save identity')}
            </button>
          )}
          <div className="divider" />
          <label className="small">
            {t('Import daily OHLCV CSV (Date, Open, High, Low, Close, Adj Close, Volume)')}
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
                  toast(t('Imported {imported} bars ({first} → {last}); {skipped} rows skipped. Switch the price source to “CSV import” to use them.', { imported: r.imported, first: r.first, last: r.last, skipped: r.skipped }), 'success');
                  onImported();
                } catch (err) {
                  toast(tm((err as Error).message), 'error');
                }
              }}
            />
          </label>
        </Advanced>
      </div>
    </div>
  );
}
