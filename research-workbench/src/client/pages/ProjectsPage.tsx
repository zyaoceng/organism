import { useEffect, useState } from 'react';
import type { ProjectSummaryDTO, ProviderDTO, TemplateDTO } from '../../shared/api';
import { Field } from '../components/ui';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useWorkspace } from '../lib/store';
import { timeAgo } from '../lib/util';

const EXCHANGES = [
  { exchange: 'TWSE', suffix: '.TW', currency: 'TWD' },
  { exchange: 'TPEx', suffix: '.TWO', currency: 'TWD' },
  { exchange: 'NASDAQ', suffix: '', currency: 'USD' },
  { exchange: 'NYSE', suffix: '', currency: 'USD' },
];

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummaryDTO[] | null>(null);
  const [templates, setTemplates] = useState<TemplateDTO[]>([]);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const reload = async () => {
    try {
      const [p, t, pr] = await Promise.all([api.projects(), api.templates(), api.providers()]);
      setProjects(p);
      setTemplates(t);
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
            <h1>Research Workbench</h1>
            <div className="sub">One consistent process: evidence → assumptions → EPS → valuation → trades → calibration.</div>
          </div>
          <span className="right row">
            <label className="small sub row" style={{ gap: 4 }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived
            </label>
            <button className="btn primary" onClick={() => setCreating(!creating)} data-testid="new-project">
              + New company
            </button>
          </span>
        </div>
        {error && <div className="msg err">{error}</div>}
        {creating && <NewProjectForm templates={templates} providers={providers} onDone={() => setCreating(false)} />}
        {projects && visible.length === 0 && !creating && (
          <div className="empty">
            No companies yet. <a onClick={() => setCreating(true)} style={{ cursor: 'pointer' }}>Create the first one</a> from the Standard Equity Research Template.
          </div>
        )}
        <div className="proj-grid" style={{ marginTop: 14 }}>
          {visible.map((p) => (
            <div key={p.id} className="proj-card" onClick={() => navigate({ page: 'project', projectId: p.id, tab: 'overview' })} data-testid="project-card">
              <div className="row">
                <b style={{ fontSize: 15 }}>{p.name}</b>
                {p.archivedAt && <span className="badge">archived</span>}
                {p.draftDirty && <span className="badge warn">draft changes</span>}
              </div>
              <div className="small sub">
                {p.security ? `${p.security.ticker} · ${p.security.exchange || '—'} · ${p.security.apiSymbol} · ${p.security.currency}` : ''}
              </div>
              <div className="row small">
                <span className="sub">Base target</span>
                <b className="num">{p.targetPrice?.base != null ? p.targetPrice.base.toFixed(1) : '—'}</b>
                <span className="sub">price</span>
                <b className="num">{p.lastPrice ? p.lastPrice.price.toFixed(2) : '—'}</b>
                {p.lastPrice?.provider === 'demo' && <span className="badge synthetic">SYNTHETIC</span>}
              </div>
              <div className="tiny sub">
                {p.head ? `Update #${p.head.seq} · ${p.head.title}` : ''} · edited {timeAgo(p.updatedAt)}
              </div>
            </div>
          ))}
        </div>
        {templates.some((t) => !t.builtIn) && (
          <div className="card" style={{ marginTop: 24 }}>
            <h2>Saved templates</h2>
            {templates
              .filter((t) => !t.builtIn)
              .map((t) => (
                <div key={t.id} className="row small" style={{ padding: '4px 0' }}>
                  <b>{t.name}</b>
                  <span className="sub grow">{t.description}</span>
                  <button
                    className="btn xs danger"
                    onClick={async () => {
                      if (!window.confirm(`Delete template ${t.name}? Projects created from it are not affected.`)) return;
                      await api.deleteTemplate(t.id);
                      void reload();
                    }}
                  >
                    delete
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
  const [priceSource, setPriceSource] = useState('yahoo');
  const [templateId, setTemplateId] = useState('standard');
  const [year, setYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestSymbol = (t: string, ex: string) => `${t.trim().toUpperCase()}${EXCHANGES.find((e) => e.exchange === ex)?.suffix ?? ''}`;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createProject({
        name,
        templateId,
        year,
        security: { name, ticker: ticker.trim(), exchange, apiSymbol: apiSymbol || suggestSymbol(ticker, exchange), currency, priceSource },
      });
      useWorkspace.getState().toast(`${name} created from the template`, 'success');
      onDone();
      navigate({ page: 'project', projectId: id, tab: 'model' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="new-project-form">
      <h2>New company project</h2>
      <div className="three">
        <Field label="Company name">
          <input value={name} autoFocus placeholder="Lite-On Technology" onChange={(e) => setName(e.target.value)} data-testid="np-name" />
        </Field>
        <Field label="Ticker">
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
        <Field label="Exchange">
          <select
            value={exchange}
            onChange={(e) => {
              setExchange(e.target.value);
              const ex = EXCHANGES.find((x) => x.exchange === e.target.value);
              if (ex) setCurrency(ex.currency);
              if (!symbolTouched) setApiSymbol(suggestSymbol(ticker, e.target.value));
            }}
          >
            {EXCHANGES.map((e) => (
              <option key={e.exchange}>{e.exchange}</option>
            ))}
            <option value="OTHER">Other</option>
          </select>
        </Field>
        <Field label="Provider symbol">
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
        <Field label="Currency">
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Price source">
          <select value={priceSource} onChange={(e) => setPriceSource(e.target.value)} data-testid="np-source">
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Template">
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Current fiscal year (periods Y-2A … Y+2E)">
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} disabled={templateId !== 'standard'} />
        </Field>
      </div>
      <div className="small sub" style={{ marginTop: 8 }}>
        {templateId === 'standard'
          ? `Standard template: EPS (Revenue with three segments → margins → tax → net income ÷ diluted shares), P/E evidence branch, Target Price = EPS FY${year + 2} × Target P/E. Amounts in ${currency} ${currency === 'TWD' || currency === 'CNY' ? '億' : 'million'}.`
          : 'Saved template: structure and formulas are copied; the project is independent afterwards.'}
      </div>
      {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !name.trim() || !ticker.trim()} onClick={() => void submit()} data-testid="np-create">
          {busy ? 'Creating…' : 'Create from template'}
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
