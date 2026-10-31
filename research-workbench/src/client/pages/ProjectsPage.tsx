import { useEffect, useState } from 'react';
import type { DashboardDTO, ProviderDTO, SymbolMatchDTO, TemplateDTO } from '../../shared/api';
import { CompanySwitcher } from '../components/CompanySwitcher';
import { DashboardTable } from '../components/DashboardTable';
import { RefreshAllButton, RefreshStatus, useRefreshRun } from '../components/RefreshAll';
import { SymbolPicker } from '../components/SymbolPicker';
import { Advanced, AdvancedToggle, Field, LangToggle } from '../components/ui';
import { api } from '../lib/api';
import { dashboardCompany, rememberCompanies } from '../lib/companies';
import { useModK } from '../lib/hotkeys';
import { getLang, t, tm, useLang } from '../lib/i18n';
import { providerVisible, useAdvanced } from '../lib/prefs';
import { href, navigate } from '../lib/router';
import { useWorkspace } from '../lib/store';

const EXCHANGES = [
  { exchange: 'TWSE', suffix: '.TW', currency: 'TWD', source: 'finmind' },
  { exchange: 'TPEx', suffix: '.TWO', currency: 'TWD', source: 'finmind' },
  { exchange: 'Emerging', suffix: '.TWO', currency: 'TWD', source: 'finmind' },
  { exchange: 'NASDAQ', suffix: '', currency: 'USD', source: 'yahoo' },
  { exchange: 'NYSE', suffix: '', currency: 'USD', source: 'yahoo' },
];

/** The home page: every company in one sortable table, "Update all prices", the trade log and Ctrl+K. */
export function ProjectsPage() {
  const [dash, setDash] = useState<DashboardDTO | null>(null);
  const [templates, setTemplates] = useState<TemplateDTO[]>([]);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [switching, setSwitching] = useState(false);
  useLang();

  const reload = async () => {
    try {
      const [d, tpl, pr] = await Promise.all([api.dashboard(), api.templates(), api.providers()]);
      setDash(d);
      rememberCompanies(d.rows.map(dashboardCompany));
      setTemplates(tpl);
      setProviders(pr);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void reload();
    // back from another window or an AI conversation: show what changed meanwhile
    const on = () => document.visibilityState === 'visible' && void reload();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  const refresh = useRefreshRun(dash?.refresh, () => void reload());
  useModK(() => setSwitching(true));

  const rows = dash?.rows ?? [];
  const visible = rows.filter((p) => showArchived || !p.archivedAt);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="projects wide">
        <div className="page-head">
          <div>
            <h1>{t('Research Workbench')}</h1>
            <div className="sub">{t('One consistent process: evidence → assumptions → EPS → valuation → trades → calibration.')}</div>
          </div>
          <span className="right row">
            <Advanced>
              <LangToggle />
            </Advanced>
            <AdvancedToggle />
            <a className="btn" href={href({ page: 'journal' })} data-testid="nav-journal">
              {t('Trade log')}
            </a>
            <a className="btn" href={href({ page: 'settings' })} data-testid="open-settings" title={t('AI connections, backups and version')}>
              {t('Settings')}
            </a>
            <button className="btn primary" onClick={() => setCreating(!creating)} data-testid="new-project">
              {t('+ New company')}
            </button>
          </span>
        </div>
        {error && <div className="msg err">{tm(error)}</div>}
        {creating && <NewProjectForm templates={templates} providers={providers} onDone={() => setCreating(false)} />}
        {dash && visible.length === 0 && !creating && (
          <div className="empty">
            {t('No companies yet.')}{' '}
            <a onClick={() => setCreating(true)} style={{ cursor: 'pointer' }}>
              {t('Create the first one')}
            </a>{' '}
            {t('from the Standard Equity Research Template.')}
          </div>
        )}
        {rows.length > 0 && (
          <>
            <div className="dash-tools">
              <input className="dash-search" placeholder={t('Filter by name or code')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="dash-search" />
              <span className="small sub">
                <span className="kbd">Ctrl+K</span> {t('switch company')}
              </span>
              <label className="small sub row" style={{ gap: 4 }}>
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t('show archived')}
              </label>
              <span className="right">
                <RefreshAllButton refresh={refresh} />
              </span>
            </div>
            <RefreshStatus run={refresh.run} />
            {visible.length > 0 && <DashboardTable rows={visible} run={refresh.run} query={query} />}
          </>
        )}
        <Advanced>
          {templates.some((tp) => !tp.builtIn) && (
            <div className="card" style={{ marginTop: 24 }}>
              <h2>{t('Saved templates')}</h2>
              {templates
                .filter((tp) => !tp.builtIn)
                .map((tp) => (
                  <div key={tp.id} className="row small" style={{ padding: '4px 0' }}>
                    <b>{tp.name}</b>
                    <span className="sub grow">{tp.description}</span>
                    <button
                      className="btn xs danger"
                      onClick={async () => {
                        if (!window.confirm(t('Delete template {name}? Projects created from it are not affected.', { name: tp.name }))) return;
                        await api.deleteTemplate(tp.id);
                        void reload();
                      }}
                    >
                      {t('delete')}
                    </button>
                  </div>
                ))}
            </div>
          )}
        </Advanced>
      </div>
      {switching && <CompanySwitcher onClose={() => setSwitching(false)} />}
    </div>
  );
}

function NewProjectForm({ templates, providers, onDone }: { templates: TemplateDTO[]; providers: ProviderDTO[]; onDone: () => void }) {
  const adv = useAdvanced();
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [exchange, setExchange] = useState('TWSE');
  const [apiSymbol, setApiSymbol] = useState('');
  const [symbolTouched, setSymbolTouched] = useState(false);
  const [currency, setCurrency] = useState('TWD');
  const [priceSource, setPriceSource] = useState(() => (providers.some((p) => p.id === 'finmind') ? 'finmind' : 'yahoo'));
  const [templateId, setTemplateId] = useState('standard');
  const [year, setYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestSymbol = (tk: string, ex: string) => `${tk.trim().toUpperCase()}${EXCHANGES.find((e) => e.exchange === ex)?.suffix ?? ''}`;

  const hasProvider = (id: string) => providers.some((p) => p.id === id);
  const pick = (m: SymbolMatchDTO) => {
    if (!name.trim()) setName(m.name);
    setTicker(m.ticker);
    setExchange(EXCHANGES.some((e) => e.exchange === m.exchange) ? m.exchange : 'OTHER');
    setApiSymbol(m.apiSymbol);
    setSymbolTouched(true);
    if (m.currency) setCurrency(m.currency);
    if (hasProvider(m.suggestedProvider)) setPriceSource(m.suggestedProvider);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createProject({
        name,
        templateId,
        lang: getLang(),
        year,
        security: { name, ticker: ticker.trim(), exchange, apiSymbol: apiSymbol || suggestSymbol(ticker, exchange), currency, priceSource },
      });
      useWorkspace.getState().toast(t('{name} created from the template', { name }), 'success');
      onDone();
      navigate({ page: 'project', projectId: id, tab: 'model' });
    } catch (e) {
      setError(tm((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="new-project-form">
      <h2>{t('New company project')}</h2>
      <Field label={t('Find the company (fills code, exchange, symbol and price source)')}>
        <SymbolPicker autoFocus onPick={pick} providerLabel={(id) => t(providers.find((p) => p.id === id)?.label ?? id)} />
      </Field>
      <div className="three" style={{ marginTop: 10 }}>
        <Field label={t('Company name')}>
          <input value={name} placeholder="Lite-On Technology" onChange={(e) => setName(e.target.value)} data-testid="np-name" />
        </Field>
        <Field label={t('Ticker')}>
          <input
            value={ticker}
            placeholder="2301"
            onChange={(e) => {
              setTicker(e.target.value);
              if (!symbolTouched) setApiSymbol(suggestSymbol(e.target.value, exchange));
            }}
            data-testid="np-ticker"
          />
        </Field>
        <Field label={t('Exchange')}>
          <select
            value={exchange}
            onChange={(e) => {
              setExchange(e.target.value);
              const ex = EXCHANGES.find((x) => x.exchange === e.target.value);
              if (ex) {
                setCurrency(ex.currency);
                if (hasProvider(ex.source)) setPriceSource(ex.source);
              }
              if (!symbolTouched) setApiSymbol(suggestSymbol(ticker, e.target.value));
            }}
          >
            {EXCHANGES.map((e) => (
              <option key={e.exchange}>{e.exchange}</option>
            ))}
            <option value="OTHER">{t('Other')}</option>
          </select>
        </Field>
        <Field label={t('Provider symbol')}>
          <input
            value={apiSymbol}
            placeholder="2301.TW"
            onChange={(e) => {
              setApiSymbol(e.target.value);
              setSymbolTouched(true);
            }}
            data-testid="np-symbol"
          />
        </Field>
        <Field label={t('Currency')}>
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </Field>
        <Field label={t('Price source')}>
          <select value={priceSource} onChange={(e) => setPriceSource(e.target.value)} data-testid="np-source">
            {providers
              .filter((p) => providerVisible(p, adv, priceSource))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {t(p.label)}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t('Template')}>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((tp) => (
              <option key={tp.id} value={tp.id}>
                {tp.builtIn ? t(tp.name) : tp.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Current fiscal year (periods Y-2A … Y+2E)')}>
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} disabled={templateId !== 'standard'} />
        </Field>
      </div>
      <div className="small sub" style={{ marginTop: 8 }}>
        {templateId === 'standard'
          ? t('Standard template: EPS (Revenue with three segments → margins → tax → net income ÷ diluted shares), P/E evidence branch, Target Price = EPS FY{fy} × Target P/E. Amounts in {currency} {scale}.', {
              fy: year + 2,
              currency,
              scale: currency === 'TWD' || currency === 'CNY' ? '億' : t('million'),
            })
          : t('Saved template: structure and formulas are copied; the project is independent afterwards.')}
      </div>
      {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !name.trim() || !ticker.trim()} onClick={() => void submit()} data-testid="np-create">
          {busy ? t('Creating…') : t('Create from template')}
        </button>
        <button className="btn ghost" onClick={onDone}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}
