import { CLIENT_LABEL } from '../../shared/actors';
import type { AiSessionDTO } from '../../shared/api';
import { getLang, t, tn } from '../lib/i18n';
import { fmtDateTime } from '../lib/util';

export const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** AI sessions (writes of one AI client grouped until 30 minutes idle) with their saved summaries. */
export function AiSessionList({ sessions, projectName, limitActions = 30 }: { sessions: AiSessionDTO[]; projectName?: (id: string) => string; limitActions?: number }) {
  const lang = getLang();
  return (
    <div className="col" style={{ gap: 10 }}>
      {sessions.map((s) => (
        <div key={s.id} className="ai-session" data-testid="ai-session">
          <div className="row">
            <b>{CLIENT_LABEL[lang][s.client]}</b>
            <span className="small sub">
              {fmtDateTime(s.startedAt)} – {hhmm(s.lastAt)}
            </span>
            {projectName && s.projectIds.length > 0 && <span className="small sub">· {s.projectIds.map(projectName).join(', ')}</span>}
            <span className="right tiny sub">{tn(s.actions.length, '{n} action', '{n} actions')}</span>
          </div>
          {s.summary ? (
            <div className="col" style={{ gap: 4, marginTop: 4 }}>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                <b>{t('Summary')}</b> {s.summary}
              </div>
              {s.decisions && (
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  <b>{t('Decisions')}</b> {s.decisions}
                </div>
              )}
              {s.todo && (
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  <b>{t('To do')}</b> {s.todo}
                </div>
              )}
            </div>
          ) : (
            <div className="tiny sub" style={{ marginTop: 2 }}>
              {t('No summary saved for this session (the server still recorded every write below).')}
            </div>
          )}
          {s.actions.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary className="small">{t('What it did')}</summary>
              <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
                {s.actions.slice(-limitActions).map((a, i) => (
                  <li key={i}>
                    <span className="sub">{hhmm(a.at)}</span> {a.tool && <code className="tiny">{a.tool}</code>} {a.summary}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
