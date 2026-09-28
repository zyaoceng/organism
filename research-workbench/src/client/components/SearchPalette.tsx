import { useMemo, useState } from 'react';
import { formatPath } from '../../domain/formula/refs';
import { indexOf } from '../lib/derived';
import { t, useLang } from '../lib/i18n';
import { navigate, type Tab } from '../lib/router';
import { useWorkspace } from '../lib/store';
import { cls } from '../lib/util';

interface Hit {
  kind: string;
  title: string;
  detail: string;
  go: () => void;
}

/** Project-wide search across nodes, notes, evidence, catalysts, theses and Research Updates. */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const draft = useWorkspace((s) => s.draft);
  const evidence = useWorkspace((s) => s.evidence);
  const catalysts = useWorkspace((s) => s.catalysts);
  const revisions = useWorkspace((s) => s.revisions);
  const notes = useWorkspace((s) => s.notes);
  const projectId = useWorkspace((s) => s.projectId)!;
  const { select } = useWorkspace.getState();
  const lang = useLang();

  const hits = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query || !draft) return [];
    const ix = indexOf(draft);
    const go = (tab: Tab, param?: string) => () => navigate({ page: 'project', projectId, tab, param });
    const snippet = (text: string) => {
      const i = text.toLowerCase().indexOf(query);
      if (i < 0) return text.slice(0, 90);
      return `${i > 30 ? '…' : ''}${text.slice(Math.max(0, i - 30), i + 60)}`;
    };
    const has = (...xs: (string | null | undefined)[]) => xs.some((x) => x && x.toLowerCase().includes(query));
    const out: Hit[] = [];
    for (const n of draft.nodes) {
      if (has(n.name, n.notes)) {
        out.push({
          kind: t('Node'),
          title: n.name,
          detail: has(n.name) ? formatPath(ix, n.id) : snippet(n.notes),
          go: () => {
            select(n.id);
            navigate({ page: 'project', projectId, tab: 'model' });
          },
        });
      }
    }
    for (const th of draft.theses) if (has(th.statement, th.invalidation)) out.push({ kind: t('Thesis'), title: th.statement, detail: snippet(th.invalidation || th.statement), go: go('overview') });
    for (const e of evidence) if (has(e.title, e.sourceName, e.notes, e.url)) out.push({ kind: t('Evidence'), title: e.title, detail: [e.sourceName, e.publishedAt, has(e.notes) ? snippet(e.notes) : ''].filter(Boolean).join(' · '), go: go('evidence', e.id) });
    for (const c of catalysts) if (has(c.title, c.expectedOutcome, c.actualOutcome, c.notes)) out.push({ kind: t('Catalyst'), title: c.title, detail: c.expectedDate ?? '', go: go('catalysts') });
    for (const r of revisions) if (has(r.title, r.reason, r.notes)) out.push({ kind: t('Update #{seq}', { seq: r.seq }), title: r.title, detail: snippet(r.reason), go: go('history', r.id) });
    for (const n of notes) if (has(n.body)) out.push({ kind: t('Note'), title: n.body.split('\n')[0].slice(0, 80), detail: n.createdAt.slice(0, 10), go: go('overview') });
    return out.slice(0, 60);
  }, [q, draft, evidence, catalysts, revisions, notes, projectId, select, lang]);

  const choose = (h: Hit | undefined) => {
    if (!h) return;
    h.go();
    onClose();
  };

  return (
    <div className="search-pop" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={t('Search nodes, notes, evidence, catalysts, theses, updates…')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            if (e.key === 'Enter') choose(hits[active]);
          }}
          data-testid="search-input"
        />
        <div className="res">
          {q && hits.length === 0 && <div className="sub">{t('No matches')}</div>}
          {hits.map((h, i) => (
            <div key={i} className={cls(i === active && 'on')} onMouseEnter={() => setActive(i)} onClick={() => choose(h)}>
              <span className="badge">{h.kind}</span>
              <b className="ellipsis" style={{ maxWidth: 260 }}>
                {h.title}
              </b>
              <span className="small sub ellipsis grow">{h.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
