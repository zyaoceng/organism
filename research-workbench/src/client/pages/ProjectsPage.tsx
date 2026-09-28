import { useEffect, useState } from 'react';
import type { ProjectSummaryDTO, ProviderDTO, SymbolMatchDTO, TemplateDTO } from '../../shared/api';
import { SymbolPicker } from '../components/SymbolPicker';
import { Field, LangToggle } from '../components/ui';
import { api } from '../lib/api';
import { getLang, t, tm, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useWorkspace } from '../lib/store';
import { timeAgo } from '../lib/util';

const EXCHANGES = [
  { exchange: 'TWSE', suffix: '.TW', currency: 'TWD', source: 'finmind' },
  { exchange: 'TPEx', suffix: '.TWO', currency: 'TWD', source: 'finmind' },
  { exchange: 'Emerging', suffix: '.TWO', currency: 'TWD', source: 'finmind' },
  { exchange: 'NASDAQ', suffix: '', currency: 'USD', source: 'yahoo' },
  { exchange: 'NYSE', suffix: '', currency: 'USD', source: 'yahoo' },
];

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummaryDTO[] | null>(null);
  const [templates, setTemplates] = useState<TemplateDTO[]>([]);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  useLang();

  const reload = async () => {
    try {
      const [p, tpl, pr] = await Promise.all([api.projects(), api.templates(), api.providers()]);
      setProjects(p);
      setTemplates(tpl);
      setProviders(pr);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const visible = (projects ?? []).filter((p) => showArchived || !p.archivedAt);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="projects">
        <div className="page-head">
          <div>
            <h1>{t('Research Workbench')}</h1>
            <div className="sub">{t('One consistent process: evidence → assumptions → EPS → valuation → trades → calibration.')}</div>
          </div>
          <span className="right row">
            <LangToggle />
            <label className="small sub row" style={{ gap: 4 }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t('show archived')}
            </label>
            <button className="btn primary" onClick={() => setCreating(!creating)} data-testid="new-project">
              {t('+ New company')}
            </button>
          </span>
        </div>
        {error && <div className="msg err">{tm(error)}</div>}
        {creating && <NewProjectForm templates={templates} providers={providers} onDone={() => setCreating(false)} />}
        {projects && visible.length === 0 && !creating && (
          <div className="empty">
            {t('No companies yet.')}{' '}
            <a onClick={() => setCreating(true)} style={{ cursor: 'pointer' }}>
              {t('Create the first one')}
            </a>{' '}
            {t('from the Standard Equity Research Template.')}
          </div>
        )}
        <div className="proj-grid" style={{ marginTop: 14 }}>
          {visible.map((p) => (
            <div key={p.id} className="proj-card" onClick={() => navigate({ page: 'project', projectId: p.id, tab: 'overview' })} data-testid="project-card">
              <div className="row">
                <b style={{ fontSize: 15 }}>{p.name}</b>
                {p.archivedAt && <span className="badge">{t('archived')}</span>}
                {p.draftDirty && <span className="badge warn">{t('draft changes')}</span>}
              </div>
              <div className="small sub">
                {p.security ? `${p.security.ticker} · ${p.security.exchange || '—'} · ${p.security.apiSymbol} · ${p.security.currency}` : ''}
              </div>
              <div className="row small">
                <span className="sub">{t('Base target')}</span>
                <b className="num">{p.targetPrice?.base != null ? p.targetPrice.base.toFixed(1) : '—'}</b>
                <span className="sub">{t('price')}</span>
                <b className="num">{p.lastPrice ? p.lastPrice.price.toFixed(2) : '—'}</b>
                {p.lastPrice?.provider === 'demo' && <span className="badge synthetic">{t('SYNTHETIC')}</span>}
              </div>
              <div className="tiny sub">
                {p.head ? t('Update #{seq} · {title}', { seq: p.head.seq, title: p.head.title }) : ''} · {t('edited {ago}', { ago: timeAgo(p.updatedAt) })}
              </div>
            </div>
          ))}
        </div>
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
      </div>
    </div>
  );
}

function NewProjectForm({ templates, providers, onDone }: { templates: TemplateDTO[]; providers: ProviderDTO[]; onDone: () => void }) {
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
            {providers.map((p) => (
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
