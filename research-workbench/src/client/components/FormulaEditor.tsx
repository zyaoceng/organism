import { useEffect, useMemo, useRef, useState } from 'react';
import { findCycleWith } from '../../domain/calc/graph';
import { FUNCTIONS } from '../../domain/formula/parser';
import { formatPath, toDisplay, toStored } from '../../domain/formula/refs';
import { setFormula } from '../../domain/model/ops';
import type { ModelNode, ModelState } from '../../domain/model/types';
import { indexOf } from '../lib/derived';
import { t, tm, useLang } from '../lib/i18n';
import { useWorkspace } from '../lib/store';

interface Suggestion {
  id: string;
  name: string;
  path: string;
}

/** Formula editing with name autocomplete, live validation and cycle prevention. */
export function FormulaEditor({ node, state, readOnly }: { node: ModelNode; state: ModelState; readOnly: boolean }) {
  const ix = indexOf(state);
  const display = toDisplay(node.formula, ix, node.id);
  const [text, setText] = useState(display);
  const [dirty, setDirty] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { edit, toast, select } = useWorkspace.getState();
  const lang = useLang();

  useEffect(() => {
    if (!dirty) setText(display);
  }, [display, dirty, node.id]);
  useEffect(() => setDirty(false), [node.id]);

  const trimmed = text.trim();
  const check = useMemo(() => {
    if (!trimmed) return { ok: true as const, stored: undefined as string | undefined, refIds: [] as string[], cycle: null as string[] | null };
    const r = toStored(trimmed, ix, node.id);
    if (!r.ok) return { ok: false as const, message: tm(r.error.message) };
    const cycle = findCycleWith(state, node.id, r.stored);
    return { ok: true as const, stored: r.stored, refIds: r.refIds, cycle };
  }, [trimmed, ix, node.id, state, lang]);

  // autocomplete: the partial reference being typed at the caret
  const partial = useMemo(() => {
    const before = text.slice(0, caret);
    const b = before.match(/\[([^\]]*)$/);
    if (b) return { start: before.length - b[1].length - 1, query: b[1], bracket: true };
    const w = before.match(/([\p{L}_][\p{L}\p{N}_ ]*)$/u);
    if (w && w[1].trim().length >= 2 && !/\s$/.test(w[1])) return { start: before.length - w[1].length, query: w[1], bracket: false };
    return null;
  }, [text, caret]);

  const suggestions: Suggestion[] = useMemo(() => {
    if (!partial || readOnly) return [];
    const q = partial.query.trim().toLowerCase();
    if (!partial.bracket && FUNCTIONS.some((f) => f.name.toLowerCase().startsWith(q) && q.length < 4)) return [];
    return state.nodes
      .filter((n) => !q || n.name.toLowerCase().includes(q))
      .slice(0, 12)
      .map((n) => ({ id: n.id, name: n.name, path: formatPath(ix, n.id) }));
  }, [partial, state.nodes, ix, node.id, readOnly]);

  const pick = (s: Suggestion) => {
    if (!partial) return;
    const refText = toDisplay(`{${s.id}}`, ix, node.id);
    const after = partial.bracket ? text.slice(caret).replace(/^[^\][+\-*/(),]*\]/, '') : text.slice(caret);
    const next = text.slice(0, partial.start) + refText + after;
    setText(next);
    setDirty(true);
    const pos = partial.start + refText.length;
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = document.getElementById(`fx-${node.id}`) as HTMLTextAreaElement | null;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const apply = () => {
    if (!check.ok) return toast(check.message, 'error');
    if (check.cycle) return toast(t('Not applied: {reason}', { reason: cycleText(check.cycle) }), 'error');
    edit((s) => setFormula(s, node.id, check.stored));
    setDirty(false);
    toast(check.stored ? t('Formula for {name} applied', { name: node.name }) : t('Formula removed from {name}', { name: node.name }), 'success');
  };

  const cycleText = (c: string[]) => t('circular dependency {path}. Use PREV() to refer to an earlier period.', { path: c.map((id) => ix.byId.get(id)?.name ?? id).join(' → ') });

  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea
        id={`fx-${node.id}`}
        ref={ref}
        className="formula-box"
        value={text}
        readOnly={readOnly}
        placeholder={readOnly ? t('No formula') : t('e.g. [TAM] * [Market Share] * [ASP]   ·   PREV([Revenue]) * (1 + [Growth])   ·   SUM(CHILDREN())')}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          setCaret(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (suggestions.length && partial) {
            if (e.key === 'ArrowDown') return e.preventDefault(), setActive((a) => Math.min(a + 1, suggestions.length - 1));
            if (e.key === 'ArrowUp') return e.preventDefault(), setActive((a) => Math.max(a - 1, 0));
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) return e.preventDefault(), pick(suggestions[active]);
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            apply();
          }
          if (e.key === 'Escape') {
            setText(display);
            setDirty(false);
          }
        }}
      />
      {suggestions.length > 0 && dirty && (
        <div className="suggest">
          {suggestions.map((s, i) => (
            <div key={s.id} className={i === active ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), pick(s))}>
              <b>{s.name}</b>
              <span className="faint small ellipsis">{s.path}</span>
            </div>
          ))}
        </div>
      )}
      {!check.ok && trimmed && <div className="msg err">{check.message}</div>}
      {check.ok && check.cycle && <div className="msg err">{t('Would create a {reason}', { reason: cycleText(check.cycle) })}</div>}
      {check.ok && !check.cycle && trimmed && check.refIds.length > 0 && (
        <div className="chips">
          <span className="small sub">{t('References:')}</span>
          {check.refIds.map((id) => (
            <span key={id} className="chip in" title={formatPath(ix, id)} onClick={() => select(id)}>
              {ix.byId.get(id)?.name}
            </span>
          ))}
        </div>
      )}
      {!readOnly && (
        <div className="row">
          <button className="btn sm primary" disabled={!dirty || !check.ok || !!check.cycle} onClick={apply}>
            {t('Apply')} <span className="kbd" style={{ color: 'inherit', background: 'transparent' }}>Ctrl+Enter</span>
          </button>
          {dirty && (
            <button className="btn sm ghost" onClick={() => (setText(display), setDirty(false))}>
              {t('Revert')}
            </button>
          )}
          {node.formula && !dirty && (
            <button
              className="btn sm ghost"
              onClick={() => {
                edit((s) => setFormula(s, node.id, undefined));
                setText('');
              }}
            >
              {t('Remove formula')}
            </button>
          )}
        </div>
      )}
      <details>
        <summary>{t('Functions and syntax')}</summary>
        <div className="small" style={{ marginTop: 6, lineHeight: 1.6 }}>
          <div>
            {t('Names in')} <code>[brackets]</code> {t('(bare single words also work). Paths disambiguate:')} <code>[Business A/Growth]</code>{t('. A specific period:')} <code>[EPS]@FY2028</code>{t('. Percent literal:')}{' '}
            <code>15%</code> {t('= 0.15. Operators')} <code>+ - * / ^</code>{t(', comparisons for IF.')}
          </div>
          {FUNCTIONS.map((f) => (
            <div key={f.name}>
              <code>{f.signature}</code> <span className="sub">— {t(f.help)}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
