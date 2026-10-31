import { useEffect, useState } from 'react';
import type { ConflictReason, ReflectionKind } from '../../domain/vault/types';
import { actorLabel } from '../../shared/actors';
import type { ReflectionVersionDTO } from '../../shared/api';
import { api } from '../lib/api';
import { getLang, t, tm } from '../lib/i18n';
import { useWorkspace } from '../lib/store';
import { cls, fmtDateTime } from '../lib/util';

/** Why the plugin could not update a note (settings conflict list and the reflection card). */
export function conflictLabel(reason: ConflictReason): string {
  switch (reason) {
    case 'hand-edited':
      return t('The generated section was edited by hand');
    case 'missing-markers':
      return t('The generated section markers were removed');
    case 'invalid-markers':
      return t('The generated section markers are duplicated or unpaired');
    case 'invalid-frontmatter':
      return t('The note’s properties (frontmatter) are not closed');
    case 'duplicate-id':
      return t('Several files share this note’s wb_id (sync conflict copies?)');
    case 'id-mismatch':
      return t('The file’s wb_id does not match');
    case 'write-failed':
      return t('Obsidian could not write the file');
    case 'unavailable':
      return t('The file is not downloaded (iCloud)');
    default:
      return String(reason);
  }
}

/** Only links the server built for Obsidian are rendered as links. */
const safeObsidianUrl = (u: string | null) => (u && u.startsWith('obsidian://') ? u : null);

/**
 * The `## 反思` section the user wrote in this note's Obsidian file, read back by the plugin. Read
 * only here: the text belongs to the vault. Nothing is shown for a note the vault has never seen.
 */
export function ReflectionCard({ noteId, kind, compact }: { noteId: string; kind: ReflectionKind; compact?: boolean }) {
  const r = useWorkspace((s) => s.reflections.find((x) => x.noteId === noteId));
  const [versions, setVersions] = useState<ReflectionVersionDTO[] | null>(null);
  const [open, setOpen] = useState(false);
  const count = r?.versionCount ?? 0;
  // a new version arrived while the list is open: load it again
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .reflectionVersions(noteId)
      .then((v) => alive && setVersions(v))
      .catch((e) => alive && useWorkspace.getState().toast(tm((e as Error).message), 'error'));
    return () => {
      alive = false;
    };
  }, [open, noteId, count]);
  if (!r) return null;
  const url = safeObsidianUrl(r.obsidianUrl);
  return (
    <div className={cls('card reflection-card', compact && 'compact')} data-testid="reflection-card" data-note-id={noteId} data-kind={kind}>
      <div className="row wrap">
        <h2 style={{ margin: 0 }}>{t('Reflection (from Obsidian)')}</h2>
        {r.cleared && <span className="badge warn">{t('Cleared in Obsidian on {date}; showing the previous version', { date: fmtDateTime(r.cleared.at) })}</span>}
        {r.conflict && (
          <span className="badge err" data-testid="reflection-conflict">
            {conflictLabel(r.conflict)}
          </span>
        )}
        {url && (
          <a className="right small" href={url} data-testid="reflection-open">
            {t('Open in Obsidian')}
          </a>
        )}
      </div>
      {r.text ? (
        <div className="reflection-text" data-testid="reflection-text">
          {r.text}
        </div>
      ) : (
        <div className="small sub" style={{ marginTop: 6 }}>
          {t('No reflection yet. Write under the “## 反思” heading of this note in Obsidian; the plugin sends it back.')}
        </div>
      )}
      {(r.receivedAt || count > 0) && (
        <div className="row tiny sub" style={{ marginTop: 6 }}>
          {r.receivedAt && <span>{t('Received {time}', { time: fmtDateTime(r.receivedAt) })}</span>}
          {count > 0 && (
            <button className="btn sm ghost right" onClick={() => setOpen(!open)} data-testid="reflection-versions-toggle">
              {t('Versions ({n})', { n: count })}
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="reflection-versions" data-testid="reflection-versions">
          {!versions && <div className="tiny sub">{t('Loading…')}</div>}
          {versions?.map((v) => (
            <div key={v.id} className="hist-item">
              <div className="tiny sub">
                {fmtDateTime(v.receivedAt)} · {v.sourcePath}
                {v.actor && v.actor !== 'obsidian' && ` · ${actorLabel(v.actor, getLang())}`}
              </div>
              {v.text ? <div className="reflection-text">{v.text}</div> : <div className="small sub">{t('(cleared)')}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
