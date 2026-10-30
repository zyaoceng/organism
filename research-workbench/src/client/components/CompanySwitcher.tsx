import { useEffect, useMemo, useState } from 'react';
import { isComposing } from '../lib/hotkeys';
import { loadCompanies, matchCompanies, peekCompanies, type CompanyEntry } from '../lib/companies';
import { t, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { cls } from '../lib/util';

/** Ctrl+K outside a company: jump to a company's model by name or code. */
export function CompanySwitcher({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [list, setList] = useState<CompanyEntry[]>(peekCompanies);
  useLang();
  useEffect(() => {
    void loadCompanies()
      .then(setList)
      .catch(() => undefined);
  }, []);
  const hits = useMemo(() => matchCompanies(list, q), [list, q]);
  const choose = (c: CompanyEntry | undefined) => {
    if (!c) return;
    onClose();
    navigate({ page: 'project', projectId: c.id, tab: 'model' });
  };
  return (
    <div className="search-pop" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={t('Switch to a company: name or code')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            if (e.key === 'Enter') choose(hits[Math.min(active, hits.length - 1)]);
          }}
          data-testid="company-switcher-input"
        />
        <div className="res">
          {q && hits.length === 0 && <div className="sub">{t('No matches')}</div>}
          {hits.map((c, i) => (
            <div key={c.id} className={cls(i === active && 'on')} onMouseEnter={() => setActive(i)} onClick={() => choose(c)} data-testid="company-hit">
              <span className="badge">{c.ticker || '—'}</span>
              <b className="ellipsis" style={{ maxWidth: 320 }}>
                {c.name}
              </b>
              <span className="small sub ellipsis grow">{[c.exchange, c.apiSymbol].filter(Boolean).join(' · ')}</span>
              {c.archived && <span className="badge">{t('archived')}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
