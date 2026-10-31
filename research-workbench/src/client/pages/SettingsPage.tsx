import { useEffect, useRef, useState } from 'react';
import { CLIENT_LABEL } from '../../shared/actors';
import { PASTE_INSTRUCTIONS } from '../../shared/aiInstructions';
import type { AiClientStatusDTO, AiSessionDTO, DiagnosticsDTO, ProjectSummaryDTO, VaultStatusDTO } from '../../shared/api';
import { AiSessionList, hhmm } from '../components/AiSessions';
import { conflictLabel } from '../components/ReflectionCard';
import { Advanced, AdvancedToggle } from '../components/ui';
import { api } from '../lib/api';
import { getLang, t, tm, useLang } from '../lib/i18n';
import { useWorkspace } from '../lib/store';
import { cls, fmtDateTime } from '../lib/util';

const REFRESH_MS = 15_000;
/** A client seen this recently counts as connected (the adapter sends a heartbeat every 10 minutes). */
const CONNECTED_MS = 15 * 60_000;

const mmddhhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hhmm(iso)}`;
};

/** Settings: AI connections, the text to paste into Claude / ChatGPT, recent AI activity, Obsidian sync, system status. */
export function SettingsPage() {
  const [diag, setDiag] = useState<DiagnosticsDTO | null>(null);
  const [sessions, setSessions] = useState<AiSessionDTO[]>([]);
  const [projects, setProjects] = useState<ProjectSummaryDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  useLang();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [d, s, p] = await Promise.all([api.diagnostics(), api.aiSessions({ limit: 20 }), api.projects()]);
        if (!alive) return;
        setDiag(d);
        setSessions(s);
        setProjects(p);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="projects" data-testid="settings-page">
        <div className="page-head">
          <div>
            <h1>{t('Settings')}</h1>
            <div className="sub">
              <a href="#/">{t('← All companies')}</a>
            </div>
          </div>
          <span className="right row">
            <AdvancedToggle />
          </span>
        </div>
        {error && <div className="msg err">{tm(error)}</div>}

        <div className="card" data-testid="ai-clients">
          <h2>{t('AI connections')}</h2>
          <table className="grid">
            <tbody>
              {(diag?.clients ?? []).map((c) => (
                <ClientRow key={c.client} c={c} />
              ))}
            </tbody>
          </table>
          <ul className="small sub" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>{t('Claude Desktop: use the Chat tab (Cowork does not see this connection).')}</li>
            <li>{t('ChatGPT desktop: only in Work mode, in chats outside a project.')}</li>
            <li>{t('While the Mac sleeps or is off, the AI cannot reach the Research Workbench.')}</li>
          </ul>
        </div>

        <div className="card" data-testid="ai-instructions" style={{ marginTop: 14 }}>
          <h2>{t('Instructions to paste into the AI')}</h2>
          <div className="small sub" style={{ marginBottom: 6 }}>
            {t('Claude: Project → Project instructions. ChatGPT: Settings → Personalization → Custom instructions.')}
          </div>
          <PasteBox />
          <div className="small sub" style={{ marginTop: 8 }}>
            {t('This records who did each step; it is not a security measure. Programs on this Mac can read the connection keys.')}
          </div>
        </div>

        <div className="card" data-testid="ai-activity" style={{ marginTop: 14 }}>
          <h2>{t('Recent AI activity')}</h2>
          {sessions.length === 0 && <div className="small sub">{t('No AI activity yet.')}</div>}
          <AiSessionList sessions={sessions} projectName={projectName} />
        </div>

        <ObsidianSection vault={diag ? diag.vault : undefined} />

        <div className="card" style={{ marginTop: 14 }} data-testid="system-status">
          <h2>{t('System')}</h2>
          {diag && (
            <div className="small">
              {t('Version {commit}', { commit: diag.version.commit.slice(0, 12) })} · {t('last backup {time}', { time: diag.backups.lastBackupAt ? fmtDateTime(diag.backups.lastBackupAt) : t('never') })}
              {diag.backups.lastError && <div className="msg err" style={{ marginTop: 6 }}>{t('The last backup failed: {msg}', { msg: diag.backups.lastError })}</div>}
            </div>
          )}
          <Advanced>
            {diag && (
              <table className="grid" style={{ marginTop: 8 }}>
                <tbody>
                  {(
                    [
                      ['Data folder', diag.dataDir],
                      ['Database file', diag.dbFile],
                      ['Database schema version', String(diag.schemaVersion)],
                      ['Backups', t('{n} in {dir}', { n: diag.backups.count, dir: diag.backups.dir })],
                      ['Installed', diag.version.installedAt ? fmtDateTime(diag.version.installedAt) : '—'],
                      ['Node.js', `${diag.node} · ${diag.platform}`],
                      ['Running for', t('{n} min', { n: Math.round(diag.uptimeSec / 60) })],
                    ] as const
                  ).map(([label, value]) => (
                    <tr key={label}>
                      <td className="l sub">{t(label)}</td>
                      <td className="l" style={{ wordBreak: 'break-all' }}>
                        {value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Advanced>
        </div>
      </div>
    </div>
  );
}

function ClientRow({ c }: { c: AiClientStatusDTO }) {
  const label = CLIENT_LABEL[getLang()][c.client];
  const connected = !!c.lastSeenAt && Date.now() - Date.parse(c.lastSeenAt) < CONNECTED_MS;
  const status = !c.lastSeenAt ? t('never connected') : connected ? t('connected ({time})', { time: hhmm(c.lastSeenAt) }) : t('last connected {time}', { time: mmddhhmm(c.lastSeenAt) });
  const details = [
    c.clientName && `${c.clientName}${c.clientVersion ? ` ${c.clientVersion}` : ''}`,
    c.adapterVersion && t('adapter {version}', { version: c.adapterVersion.slice(0, 12) }),
    c.lastWriteAt && t('last write {time}', { time: fmtDateTime(c.lastWriteAt) }),
  ].filter(Boolean);
  return (
    <tr data-testid={`ai-client-${c.client}`}>
      <td className="l">
        <b>{label}</b>
      </td>
      <td className="l">
        <span className={cls('save-dot', connected ? 'saved' : c.lastSeenAt ? 'pending' : 'never')} /> {status}
      </td>
      <td className="l small sub">{details.join(' · ')}</td>
    </tr>
  );
}

function PasteBox() {
  const ref = useRef<HTMLTextAreaElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(PASTE_INSTRUCTIONS);
    } catch {
      // no clipboard permission (or not a secure context): select the text and copy it the old way
      ref.current?.select();
      document.execCommand('copy');
    }
    useWorkspace.getState().toast(t('Copied. Paste it into the AI’s instructions.'), 'success');
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea ref={ref} readOnly rows={9} value={PASTE_INSTRUCTIONS} style={{ width: '100%', fontSize: 12.5 }} onFocus={(e) => e.target.select()} />
      <div>
        <button className="btn primary" onClick={() => void copy()} data-testid="copy-ai-instructions">
          {t('Copy')}
        </button>
      </div>
    </div>
  );
}

const obsidianLink = (vault: string, file: string) => `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;

/** Obsidian sync: the plugin's last report, the notes it could not update, and how to install it. `undefined` while loading. */
function ObsidianSection({ vault: v }: { vault: VaultStatusDTO | null | undefined }) {
  const status = !v ? t('never connected') : v.connected ? t('connected ({time})', { time: hhmm(v.lastSeenAt) }) : t('last connected {time}', { time: mmddhhmm(v.lastSeenAt) });
  const counts = v
    ? [
        v.behind > 0 && t('{n} changes not fetched yet', { n: v.behind }),
        v.pending > 0 && t('{n} notes waiting to be written', { n: v.pending }),
        v.skippedOpen > 0 && t('{n} notes skipped while open in an editor', { n: v.skippedOpen }),
        v.missing > 0 && t('{n} notes no longer in the vault', { n: v.missing }),
      ].filter((x): x is string => !!x)
    : [];
  return (
    <div className="card" data-testid="settings-obsidian" style={{ marginTop: 14 }}>
      <h2>{t('Obsidian')}</h2>
      {v !== undefined && (
        <table className="grid">
          <tbody>
            <tr data-testid="obsidian-status">
              <td className="l">
                <b>{t('Obsidian plugin')}</b>
              </td>
              <td className="l">
                <span className={cls('save-dot', v?.connected ? 'saved' : v ? 'pending' : 'never')} /> {status}
              </td>
              <td className="l small sub">{v && [v.vaultName && t('vault “{name}”', { name: v.vaultName }), v.pluginVersion && t('plugin {version}', { version: v.pluginVersion })].filter(Boolean).join(' · ')}</td>
            </tr>
          </tbody>
        </table>
      )}
      {v && (
        <div className="small" style={{ marginTop: 6 }} data-testid="obsidian-sync">
          {counts.length ? counts.join(' · ') : t('Up to date')}
        </div>
      )}
      {v && v.errors.length > 0 && (
        <div className="msg err" style={{ marginTop: 6 }} data-testid="obsidian-errors">
          {v.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
      {v && v.conflicts.length > 0 && (
        <div style={{ marginTop: 8 }} data-testid="obsidian-conflicts">
          <b className="small">{t('Notes the plugin left alone ({n})', { n: v.conflicts.length })}</b>
          <div className="tiny sub">{t('Your text in these files was not changed. Fix the file in Obsidian, or open it and run the plugin command that rebuilds the generated section of the current note.')}</div>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {v.conflicts.map((c) => (
              <li key={c.wbId} className="small" data-testid="obsidian-conflict">
                <b>{c.title || c.wbId}</b> — {conflictLabel(c.reason)}
                {c.paths.map((p) => (
                  <div key={p} className="tiny">
                    <a href={obsidianLink(v.vaultName, p)}>{p}</a>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="small sub" style={{ marginTop: 10 }}>
        {t('The plugin writes each company, Research Update and trade as a note, and sends back what you write under “## 反思”. It never changes text you wrote.')}
      </div>
      <div className="small" style={{ marginTop: 8 }}>
        {t('The Mac installer sets up the plugin in your vault. To install it by hand:')}
        <ol style={{ margin: '4px 0', paddingLeft: 20 }}>
          <li>{t('Download the zip below and unzip it.')}</li>
          <li>{t('In Obsidian: Settings → Community plugins → turn off Restricted mode.')}</li>
          <li>{t('Click the folder icon next to “Installed plugins” and drag the unzipped folder research-workbench-sync into it.')}</li>
          <li>{t('Reload the plugins, then turn on “Research Workbench Sync”.')}</li>
        </ol>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <a className="btn" href="/api/vault/plugin.zip" download data-testid="obsidian-zip">
          {t('Download the Obsidian plugin (zip)')}
        </a>
      </div>
      <div className="msg warn" style={{ marginTop: 8 }}>
        {t('The zip contains the plugin’s connection key. Do not share it or put it in a synced folder other than your vault.')}
      </div>
    </div>
  );
}
