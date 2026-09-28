import { useEffect, useRef, useState } from 'react';
import type { SymbolMatchDTO, SymbolSearchDTO } from '../../shared/api';
import { api } from '../lib/api';
import { t, tm } from '../lib/i18n';

const BOARD_LABEL: Record<SymbolMatchDTO['board'], string> = { listed: 'Listed (上市)', otc: 'OTC (上櫃)', emerging: 'Emerging (興櫃)', other: '' };

/** Search a security by code or company name and pick the identifiers a price source needs. */
export function SymbolPicker(props: { onPick: (m: SymbolMatchDTO) => void; providerLabel: (id: string) => string; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SymbolSearchDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = async (query: string) => {
    const my = ++seq.current;
    if (!query.trim()) {
      setRes(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.searchSymbols(query);
      if (my === seq.current) setRes(r);
    } catch (e) {
      if (my === seq.current) setError(tm((e as Error).message));
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (q.trim().length < 2) return;
    const h = setTimeout(() => void run(q), 400);
    return () => clearTimeout(h);
  }, [q]);

  return (
    <div className="symbol-picker" data-testid="symbol-picker">
      <div className="row">
        <input
          className="grow"
          value={q}
          autoFocus={props.autoFocus}
          placeholder={t('Search by code or company name, e.g. 7899, 景美, NVIDIA')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void run(q);
            }
          }}
          data-testid="symbol-query"
        />
        <button type="button" className="btn sm" disabled={busy || !q.trim()} onClick={() => void run(q)}>
          {busy ? t('Searching…') : t('Search')}
        </button>
      </div>
      {error && <div className="msg err">{error}</div>}
      {res && (
        <div className="symbol-results">
          {res.results.length === 0 && <div className="tiny sub">{t('No match for “{q}”. Check the code, or try the company name.', { q: res.query })}</div>}
          {res.results.map((m) => (
            <button type="button" key={`${m.apiSymbol}-${m.source}`} className="symbol-hit" onClick={() => props.onPick(m)} data-testid="symbol-hit">
              <b>{m.ticker}</b> <span>{m.name}</span>
              <span className="tiny sub grow">
                {[m.exchange, t(BOARD_LABEL[m.board]), m.currency, m.industry].filter(Boolean).join(' · ')}
              </span>
              <span className="tiny sub">{t('{symbol} via {provider}', { symbol: m.apiSymbol, provider: props.providerLabel(m.suggestedProvider) })}</span>
            </button>
          ))}
          {res.errors.map((e) => (
            <div key={e} className="tiny sub">
              {t('Not searched: {error}', { error: tm(e) })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
