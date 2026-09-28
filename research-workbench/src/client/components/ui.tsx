import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatValue, parseValueInput, editText } from '../../domain/format';
import type { Unit } from '../../domain/units';
import { cls } from '../lib/util';
import { LANGS, setLang, t, tm, useLang } from '../lib/i18n';

/** Text that becomes an input on click; commits on blur/Enter, cancels on Escape. */
export function InlineText(props: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  readOnly?: boolean;
  rows?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  if (!editing || props.readOnly) {
    return (
      <div
        className={cls(props.className, 'inline-text', !props.value && 'faint')}
        style={{ cursor: props.readOnly ? 'default' : 'text', whiteSpace: props.multiline ? 'pre-wrap' : undefined, minHeight: 18 }}
        onClick={() => !props.readOnly && setEditing(true)}
        title={props.readOnly ? undefined : t('Click to edit')}
      >
        {props.value || props.placeholder || '—'}
      </div>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft !== props.value) props.onCommit(draft);
  };
  const common = {
    autoFocus: true,
    value: draft,
    placeholder: props.placeholder,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    style: { width: '100%' },
  };
  return props.multiline ? (
    <textarea
      {...common}
      rows={props.rows ?? 4}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setDraft(props.value);
          setEditing(false);
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
      }}
    />
  ) : (
    <input
      {...common}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(props.value);
          setEditing(false);
        }
      }}
    />
  );
}

/** Numeric input that understands units (percent typed as 40 = 40%). */
export function NumberField(props: {
  value: number | null | undefined;
  unit: Unit | null;
  onCommit: (v: number | null) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onDone?: (how: 'enter' | 'tab' | 'escape' | 'blur', shift: boolean) => void;
  initialText?: string;
}) {
  const [text, setText] = useState(props.initialText ?? editText(props.value, props.unit));
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const finish = (how: 'enter' | 'tab' | 'escape' | 'blur', shift = false) => {
    if (done.current) return;
    if (how !== 'escape') {
      const r = parseValueInput(text, props.unit);
      if (!r.ok) {
        setError(tm(r.message));
        if (how === 'blur') {
          done.current = true;
          props.onDone?.(how, shift);
        }
        return;
      }
      if (r.value !== (props.value ?? null)) props.onCommit(r.value);
    }
    done.current = true;
    props.onDone?.(how, shift);
  };
  return (
    <input
      className={cls(props.className, error && 'err')}
      title={error ?? undefined}
      autoFocus={props.autoFocus}
      value={text}
      placeholder={props.placeholder}
      style={error ? { borderColor: 'var(--err)' } : undefined}
      onChange={(e) => {
        setText(e.target.value);
        setError(null);
      }}
      onFocus={(e) => props.initialText === undefined && e.target.select()}
      onBlur={() => finish('blur')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish('enter', e.shiftKey);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish('tab', e.shiftKey);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish('escape');
        }
        e.stopPropagation();
      }}
    />
  );
}

export function Value({ v, unit, withUnit }: { v: number | null | undefined; unit: Unit | null | undefined; withUnit?: boolean }) {
  return <span className="num">{formatValue(v, unit, { withUnit })}</span>;
}

export function Delta({ before, after, unit }: { before: number | null | undefined; after: number | null | undefined; unit?: Unit | null }) {
  if (before === null || before === undefined || after === null || after === undefined) return <span className="faint">—</span>;
  const d = after - before;
  if (Math.abs(d) < 1e-12) return <span className="faint">0</span>;
  let txt: string;
  if (unit?.kind === 'percent') txt = `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pp`;
  else if (before !== 0) txt = `${d >= 0 ? '+' : ''}${((d / Math.abs(before)) * 100).toFixed(1)}%`;
  else txt = `${d >= 0 ? '+' : ''}${formatValue(d, unit ?? null)}`;
  return <span className={cls('num', d > 0 ? 'pos' : 'neg')}>{txt}</span>;
}

export function Section(props: { title: string; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="section" id={props.id}>
      <div className="shead">
        <h3>{props.title}</h3>
        <div className="right row">{props.right}</div>
      </div>
      {props.children}
    </div>
  );
}

export function Field(props: { label: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <label className="field" style={props.style}>
      {props.label}
      {props.children}
    </label>
  );
}

export function ScenarioSwitch(props: { value: string; onChange: (s: 'bear' | 'base' | 'bull') => void }) {
  return (
    <div className="seg" role="group" aria-label={t('Scenario')}>
      {(['bear', 'base', 'bull'] as const).map((s, i) => {
        const name = t(s[0].toUpperCase() + s.slice(1));
        return (
          <button key={s} className={cls(props.value === s && `on ${s}`)} onClick={() => props.onChange(s)} title={t('{name} scenario ({n})', { name, n: i + 1 })}>
            {name}
          </button>
        );
      })}
    </div>
  );
}

/** 中文 / English switch. The choice is remembered in this browser. */
export function LangToggle(props: { dark?: boolean }) {
  const lang = useLang();
  return (
    <div className={cls('seg', 'lang-toggle', props.dark && 'dark')} role="group" aria-label="Language / 語言" data-testid="lang-toggle">
      {LANGS.map((l) => (
        <button key={l.value} className={cls(lang === l.value && 'on')} onClick={() => setLang(l.value)} lang={l.value}>
          {l.label}
        </button>
      ))}
    </div>
  );
}
