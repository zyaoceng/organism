import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { OutputKey } from '../../domain/workbook/types';
import type { AssumptionDTO, PartyTableDTO, WorkbookFileDTO, WorkbookFilesDTO, WorkbookOutputDTO, WorkbookRecalcDTO, WorkbookSensitivityDTO, WorkbookViewDTO } from '../../shared/api';
import { api, ApiError } from '../lib/api';
import { t, tm } from '../lib/i18n';
import { useWorkspace } from '../lib/store';
import { cls, fmtDateTime } from '../lib/util';
import {
  afterWrite,
  applyChoice,
  barShare,
  candidateChoices,
  confirmOpen,
  currentCalc,
  deltaVsFile,
  editNum,
  emptyTrial,
  exactNum,
  fmtNum,
  isPercent,
  hasRange,
  loadTrial,
  mineFilled,
  orderAssumptions,
  OUTPUT_KEYS,
  parseNum,
  recalcPlan,
  refill,
  reloadAfter,
  saveTrial,
  signed,
  sizeText,
  sortTornado,
  writePlan,
  type RecalcPlan,
  type TrialCalc,
  type TrialState,
  type WritePlan,
} from '../lib/workbook';

/** Wait this long after the last keystroke before asking the server to recalculate. */
const RECALC_DELAY_MS = 250;
const REVENUE_FMT = '#,##0.0';
const PRICE_FMT = '#,##0.00';

/**
 * The assumptions of the company's linked Excel file. The file is the only copy: this page reads it,
 * shows what needs a decision first, and recalculates trial values on the server. Trial values stay in
 * this browser tab until the user presses “Write to Excel” and confirms the list of cells.
 */
export function AssumptionsPage() {
  const projectId = useWorkspace((s) => s.projectId)!;
  const [view, setView] = useState<WorkbookViewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);

  // a read that was asked for before a newer view arrived (another read, a link, a mapping) must not replace it
  const viewSeq = useRef(0);
  const showView = useCallback((v: WorkbookViewDTO | null) => {
    viewSeq.current++;
    setView(v);
  }, []);
  const reload = useCallback(
    async (quiet = false) => {
      const my = ++viewSeq.current;
      if (!quiet) setLoading(true);
      try {
        const v = await api.workbook(projectId);
        if (viewSeq.current !== my) return;
        setView(v);
        setError(null);
      } catch (e) {
        if (!quiet && viewSeq.current === my) setError((e as Error).message);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    showView(null);
    setPicking(false);
    void reload();
  }, [reload, showView]);
  // the file is edited outside this page (Excel, an AI client): read it again when the tab comes back
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === 'visible') void reload(true);
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [reload]);

  const unlink = async () => {
    if (!window.confirm(t('Unlink this Excel file? The file itself is not touched.'))) return;
    try {
      await api.unlinkWorkbook(projectId);
      await reload();
    } catch (e) {
      useWorkspace.getState().toast(tm((e as Error).message), 'error');
    }
  };

  return (
    <div className="page wb" data-testid="assumptions-page">
      <div className="page-head">
        <h1>{t('Assumptions')}</h1>
        <span className="sub">{t('Read from the linked Excel file. Numbers typed here are trial values; they go into Excel only when you press “Write to Excel”.')}</span>
      </div>
      {error && (
        <div className="msg err" style={{ marginBottom: 12 }}>
          {tm(error)}{' '}
          <button className="btn sm" onClick={() => void reload()}>
            {t('Reload')}
          </button>
        </div>
      )}
      {!view && loading && <div className="sub">{t('Reading the Excel file…')}</div>}
      {view && (!view.linked || picking) && (
        <FilePicker
          projectId={projectId}
          current={view.file?.path ?? null}
          onLinked={(v) => {
            showView(v);
            setPicking(false);
          }}
          onCancel={view.linked ? () => setPicking(false) : undefined}
        />
      )}
      {view && view.linked && !picking && !view.loaded && (
        <FileCard view={view} busy={loading} onReload={() => void reload()} onPick={() => setPicking(true)} onUnlink={() => void unlink()} projectId={projectId} onView={showView} />
      )}
      {view && view.linked && !picking && view.loaded && (
        <Loaded projectId={projectId} view={view} busy={loading} onReload={reload} onPick={() => setPicking(true)} onUnlink={() => void unlink()} onView={showView} />
      )}
    </div>
  );
}

// ------------------------------------------------------------ choosing the file

function FilePicker(props: { projectId: string; current: string | null; onLinked: (v: WorkbookViewDTO) => void; onCancel?: () => void }) {
  const [list, setList] = useState<WorkbookFilesDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    api
      .workbookFiles(props.projectId)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, [props.projectId]);
  useEffect(load, [load]);

  const link = async (path: string) => {
    setBusy(path);
    try {
      props.onLinked(await api.linkWorkbook(props.projectId, path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const q = filter.trim().toLowerCase();
  const files = (list?.files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
  return (
    <div className="card" data-testid="wb-picker">
      <h2>{t('Choose the Excel file of this company')}</h2>
      {error && <div className="msg err">{tm(error)}</div>}
      {!list && !error && <div className="sub">{t('Loading…')}</div>}
      {list && <VaultProblem vault={list.vault} />}
      {list && list.vault.readable && (
        <>
          <div className="small sub" style={{ marginBottom: 8 }}>
            {t('{n} .xlsx files in the vault folder {dir}. Files whose name starts with this company’s code are listed first.', { n: list.files.length, dir: list.vault.dir ?? '' })}
            {list.truncated && ` ${t('More files exist than are listed; type part of the name to narrow it.')}`}
          </div>
          {(list.files.length > 8 || list.truncated) && <input style={{ width: '100%', marginBottom: 8 }} placeholder={t('Filter by file or folder name')} value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="wb-file-filter" />}
          {list.files.length === 0 && <div className="empty">{t('No .xlsx file was found in the vault folder.')}</div>}
          <div className="wb-files">
            {files.map((f) => (
              <div key={f.path} className="wb-file" data-testid="wb-file" data-path={f.path}>
                <div className="grow">
                  <b>{f.name}</b> {f.matchesTicker && <span className="badge accent">{t('matches the code')}</span>} {f.dataless && <span className="badge warn">{t('still in iCloud')}</span>}
                  {f.path === props.current && <span className="badge">{t('this file is linked now')}</span>}
                  <div className="small sub wb-wrap">
                    {f.path} · {fmtDateTime(f.modifiedAt)} · {sizeText(f.size)}
                  </div>
                </div>
                <button className="btn primary" disabled={busy !== null} onClick={() => void link(f.path)} data-testid="wb-link">
                  {busy === f.path ? t('Reading…') : t('Link')}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm" onClick={load}>
          {t('Reload')}
        </button>
        {props.onCancel && (
          <button className="btn sm ghost" onClick={props.onCancel}>
            {t('Cancel')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Why the vault folder cannot be used, and what to do about it. */
function VaultProblem({ vault }: { vault: WorkbookViewDTO['vault'] }) {
  if (vault.dir === null) {
    return (
      <div className="msg warn" data-testid="wb-vault-problem">
        {t('The vault folder is not set, so no Excel file can be listed. Run the Mac installer again; it asks where the vault is and tells this server.')}
      </div>
    );
  }
  if (vault.readable) return null;
  return (
    <div className="msg err" data-testid="wb-vault-problem">
      {t('The server cannot open the vault folder {dir} (reason: {reason}).', { dir: vault.dir, reason: vault.reason ?? '—' })}{' '}
      {vault.reason === 'ENOENT'
        ? t('The folder does not exist at this place. Run the Mac installer again and give it the folder’s current place.')
        : t('On a Mac: System Settings → Privacy & Security → Files and Folders, allow the Research Workbench service to read the folder, then press Reload.')}
    </div>
  );
}

// ------------------------------------------------------------ the file, the self-check, the diagnosis

/** What a file state means and what to do, in one sentence. */
function fileHelp(file: WorkbookFileDTO): string {
  switch (file.state) {
    case 'ok':
      return t('The file was read.');
    case 'missing':
      return t('The file is no longer at this place in the vault folder. If it was moved or renamed, press “Choose another file”.');
    case 'dataless':
      return t('The file is still in iCloud and did not finish downloading to this Mac within 15 seconds. Open its folder in Finder so it downloads, then press Reload.');
    case 'denied':
      return t('macOS did not let the Research Workbench service read the file. Allow it under System Settings → Privacy & Security → Files and Folders, then press Reload.');
    case 'locked':
      return t('The file was being written while it was read. Wait until the save or the iCloud sync finishes, then press Reload.');
    case 'unreadable':
      if (file.reason === 'too-large') return t('The file is too large to be read here (over 50 MB, or a sheet over 8 MB once unpacked). Link the workbook that holds only the model.');
      if (file.reason === 'outside-vault' || file.reason === 'not-a-file') return t('This place in the vault folder no longer holds a file of its own (it is a folder, or a shortcut that leads out of the vault folder). Press “Choose another file”.');
      return file.reason === 'not-zip'
        ? t('This is not an .xlsx workbook. A password-protected file or an old .xls looks like this; save it as .xlsx without a password.')
        : t('The file content could not be parsed. Press “Copy diagnosis” and paste the text to the AI that maintains the file.');
  }
}

function FileCard(props: { projectId: string; view: WorkbookViewDTO; busy: boolean; onReload: () => void; onPick: () => void; onUnlink: () => void; onView: (v: WorkbookViewDTO) => void }) {
  const { view } = props;
  const file = view.file;
  const sc = view.selfCheck;
  return (
    <div className="card" data-testid="wb-file-status">
      <h2>{t('Excel file')}</h2>
      <VaultProblem vault={view.vault} />
      {file && (
        <>
          <div className={cls('msg', file.state === 'ok' ? 'ok' : 'err')} data-testid="wb-file-state" data-state={file.state}>
            <b>{file.state === 'ok' ? t('Readable') : t('Cannot be read')}</b> · {fileHelp(file)}
            {file.state !== 'ok' && file.reason && ` ${t('Reason code: {reason}', { reason: file.reason })}`}
          </div>
          <div className="small wb-wrap" style={{ marginTop: 8 }}>
            <b>{file.name}</b>
            <div className="sub">
              {file.path} · {t('saved {time}', { time: fmtDateTime(file.modifiedAt) })} · {sizeText(file.size)}
            </div>
          </div>
          {file.excelOpen && <div className="msg warn" style={{ marginTop: 8 }}>{t('Excel has this file open. The numbers here are those of the last save.')}</div>}
        </>
      )}
      {sc && (
        <div className={cls('msg', sc.state === 'verified' ? 'ok' : 'warn')} style={{ marginTop: 8 }} data-testid="wb-selfcheck" data-state={sc.state}>
          {sc.state === 'verified' && t('Self-check: all {n} formula cells recalculate to the results Excel stored.', { n: sc.compared })}
          {sc.state === 'mismatch' && t('Self-check: {bad} of {n} formula cells do not recalculate to the results Excel stored. Trial results may be off.', { bad: sc.mismatchCount, n: sc.compared })}
          {sc.state === 'no-cached-values' && t('Self-check: cannot be verified. The file holds no stored results for its {n} formula cells; open and save it in Excel once.', { n: sc.formulaCells })}
          {sc.state !== 'no-cached-values' && sc.missingCached > 0 && ` ${t('{n} formula cells have no stored result and were not compared.', { n: sc.missingCached })}`}
          {sc.mismatches.length > 0 && (
            <ul className="wb-list">
              {sc.mismatches.slice(0, 5).map((m) => (
                <li key={`${m.sheet}!${m.address}`} className="wb-wrap">
                  {m.sheet}!{m.address}：{t('Excel {a}, recalculated {b}', { a: String(m.cached), b: String(m.computed) })}
                </li>
              ))}
            </ul>
          )}
          {sc.unsupportedFunctions.length > 0 && (
            <div>{t('Functions that cannot be recalculated: {list}', { list: sc.unsupportedFunctions.map((f) => t('{name} ({n} cells)', { name: f.name, n: f.count })).join(', ') })}</div>
          )}
          {sc.loadWarnings.map((w) => (
            <div key={w} className="wb-wrap">
              {w}
            </div>
          ))}
        </div>
      )}
      {view.loaded && view.mapping && <MappingControl projectId={props.projectId} view={view} onView={props.onView} />}
      <div className="row wrap" style={{ marginTop: 10 }}>
        <button className="btn" disabled={props.busy} onClick={props.onReload} data-testid="wb-reload">
          {props.busy ? t('Reading…') : t('Reload')}
        </button>
        <CopyDiagnosis projectId={props.projectId} />
        <button className="btn" onClick={props.onPick} data-testid="wb-pick">
          {t('Choose another file')}
        </button>
        <button className="btn ghost" onClick={props.onUnlink} data-testid="wb-unlink">
          {t('Unlink')}
        </button>
      </div>
    </div>
  );
}

/** Copies the diagnosis text (sheets, headers, labels and places; no figures). Shows it when the clipboard is not available. */
function CopyDiagnosis({ projectId }: { projectId: string }) {
  const [text, setText] = useState<string | null>(null);
  const copy = async () => {
    const toast = useWorkspace.getState().toast;
    let body: string;
    try {
      body = await api.workbookDiagnosis(projectId);
    } catch (e) {
      toast(tm((e as Error).message), 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(body);
      setText(null);
      toast(t('Diagnosis copied. It holds sheet names, headers, labels and cell places, and no figures.'), 'success');
    } catch {
      // no clipboard on a plain-http page (a phone): show the text to copy by hand
      setText(body);
    }
  };
  return (
    <>
      <button className="btn" onClick={() => void copy()} data-testid="wb-copy-diagnosis">
        {t('Copy diagnosis')}
      </button>
      {text !== null && (
        <div style={{ flexBasis: '100%' }}>
          <div className="small sub">{t('This browser did not allow copying. Select the text below and copy it.')}</div>
          <textarea readOnly rows={8} style={{ width: '100%' }} value={text} onFocus={(e) => e.target.select()} data-testid="wb-diagnosis-text" />
        </div>
      )}
    </>
  );
}

const OUTPUT_LABEL: Record<OutputKey, () => string> = {
  revenue: () => t('Next four quarters’ revenue'),
  eps: () => t('EPS'),
  targetPrice: () => t('Target price'),
  multiple: () => t('Valuation multiple'),
  shareCount: () => t('Share count'),
  netCash: () => t('Net cash'),
};

/** Which cell each result is read from; another place can be picked where detection found several. */
function MappingControl({ projectId, view, onView }: { projectId: string; view: WorkbookViewDTO; onView: (v: WorkbookViewDTO) => void }) {
  const mapping = view.mapping!;
  const [busy, setBusy] = useState(false);
  const save = async (next: Parameters<typeof api.saveWorkbookMapping>[1]) => {
    setBusy(true);
    try {
      onView(await api.saveWorkbookMapping(projectId, next));
    } catch (e) {
      useWorkspace.getState().toast(tm((e as Error).message), 'error');
    } finally {
      setBusy(false);
    }
  };
  const o = view.outputs;
  const cellOf: Record<OutputKey, WorkbookOutputDTO['cell'] | undefined> = {
    revenue: o?.revenueTotal.cell ?? o?.revenueQuarters[0]?.cell,
    eps: o?.eps.find((e) => e.period === o.epsPeriod)?.cell,
    targetPrice: o?.targetPrice.cell,
    multiple: o?.multiple.cell,
    shareCount: o?.shareCount.cell,
    netCash: o?.netCash.cell,
  };
  // open when a result was not found or was found in several places that disagree
  const unsure = view.warnings.some((w) => w.code === 'output-missing' || w.code === 'output-ambiguous' || w.code === 'mapping-unresolved') || !o?.targetPrice.cell || !o.revenueTotal.cell;
  return (
    <details className="wb-mapping" open={unsure || undefined} data-testid="wb-mapping">
      <summary>{t('Which cell each result is read from')}</summary>
      {OUTPUT_KEYS.map((key) => {
        const choices = candidateChoices(mapping.candidates, key);
        const cell = cellOf[key];
        return (
          <div key={key} className="wb-map-row" data-testid={`wb-map-${key}`}>
            <span className="wb-map-name">{OUTPUT_LABEL[key]()}</span>
            {choices.length > 1 ? (
              <select
                disabled={busy}
                value={choices.find((c) => c.chosen)?.id ?? ''}
                onChange={(e) => {
                  const pick = choices.find((c) => c.id === e.target.value);
                  if (pick) void save(applyChoice(mapping.outputs, key, pick));
                }}
              >
                {!choices.some((c) => c.chosen) && <option value="">{t('— not chosen —')}</option>}
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.sheet}!{c.address ?? '?'}「{c.labelText}」
                  </option>
                ))}
              </select>
            ) : (
              <span className={cls('wb-wrap', !cell && 'err-text')}>{cell ? `${cell.sheet}!${cell.address}` : t('not found')}</span>
            )}
          </div>
        );
      })}
      {mapping.saved && (
        <div className="row wrap small" style={{ marginTop: 6 }}>
          <span className="sub">{t('These places were chosen by hand and are remembered for this company.')}</span>
          <button className="btn sm" disabled={busy} onClick={() => void save(null)} data-testid="wb-map-auto">
            {t('Find them automatically again')}
          </button>
        </div>
      )}
    </details>
  );
}

// ------------------------------------------------------------ the loaded workbook

function Loaded(props: { projectId: string; view: WorkbookViewDTO; busy: boolean; onReload: (quiet?: boolean) => Promise<void>; onPick: () => void; onUnlink: () => void; onView: (v: WorkbookViewDTO) => void }) {
  const { projectId, view, onReload } = props;
  const sha = view.file?.sha256 ?? '';
  const [trial, setTrial] = useState<TrialState>(() => loadTrial(projectId));
  const [calc, setCalc] = useState<TrialCalc<WorkbookRecalcDTO> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [calcBusy, setCalcBusy] = useState(false);
  const [calcError, setCalcError] = useState<string | null>(null);
  const seq = useRef(0);
  const retried = useRef('');
  const [confirming, setConfirming] = useState(false);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  /** Shown above the assumptions until the file changes again: what the last write did, or why it did not happen. */
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string; sha: string } | null>(null);

  useEffect(() => saveTrial(projectId, trial), [projectId, trial]);
  const plan = useMemo(() => recalcPlan(view.assumptions, trial, sha), [view.assumptions, trial, sha]);
  const wplan = useMemo(() => writePlan(view.assumptions, plan, trial.decided, sha), [view.assumptions, plan, trial.decided, sha]);
  const toWrite = wplan.rows.length + wplan.statusRows.length;
  // the last change was taken back: the list is closed, and typing another number does not bring it back
  useEffect(() => {
    if (confirming && !confirmOpen(confirming, toWrite)) setConfirming(false);
  }, [confirming, toWrite]);
  const active = plan.changed.length > 0 || plan.ranged.length > 0;
  const requestKey = active ? JSON.stringify(plan.request) : '';
  useEffect(() => {
    const my = ++seq.current;
    if (!requestKey) {
      setCalc(null);
      setCalcBusy(false);
      setCalcError(null);
      return;
    }
    setCalcBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api.recalcWorkbook(projectId, JSON.parse(requestKey));
        if (seq.current !== my) return;
        setCalc({ key: requestKey, data: r });
        setCalcError(null);
      } catch (e) {
        if (seq.current !== my) return;
        const code = e instanceof ApiError ? e.code : null;
        // the file changed underneath (or went away): read it again once; the trial values are kept and reapplied
        if (reloadAfter(code, requestKey, retried.current)) {
          retried.current = requestKey;
          await onReload(true);
          // ask again even when the read brought nothing new (it failed, or the file is the same): the second failure is shown
          if (seq.current === my) setAttempt((n) => n + 1);
        } else setCalcError((e as Error).message);
      } finally {
        if (seq.current === my) setCalcBusy(false);
      }
    }, RECALC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [requestKey, projectId, onReload, attempt]);
  // the file changed underneath: say so once the new version is on the page
  const shownSha = useRef(sha);
  useEffect(() => {
    if (shownSha.current === sha) return;
    shownSha.current = sha;
    if (requestKey) useWorkspace.getState().toast(t('The Excel file changed. It was read again and your trial values were applied to the new version.'), 'info');
  }, [sha, requestKey]);

  const shown = currentCalc(requestKey, calc);
  const outputs = (shown.data ? shown.data.outputs : view.outputs)!;
  const sensitivity = (shown.data ? shown.data.sensitivity : view.sensitivity) ?? { rows: [], withoutRange: [] };
  const { needs, groups } = useMemo(() => orderAssumptions(view.assumptions), [view.assumptions]);
  const setValue = (id: string, text: string) => setTrial((s) => ({ ...s, values: { ...s.values, [id]: text } }));
  const toggleDecided = (id: string) => setTrial((s) => ({ ...s, decided: s.decided?.includes(id) ? s.decided.filter((x) => x !== id) : [...(s.decided ?? []), id] }));
  const picked = (id: string) => wplan.statusRows.some((r) => r.id === id);

  const write = async () => {
    setWriting(true);
    setWriteError(null);
    try {
      const v = await api.writeWorkbook(projectId, wplan.request);
      const text = t('Written to Excel: {n} cell(s). The file is now from {time}, {size}.', { n: toWrite, time: fmtDateTime(v.file?.modifiedAt ?? null), size: sizeText(v.file?.size) });
      // this change of the file is the page's own: not "the Excel file changed"
      shownSha.current = v.file?.sha256 ?? '';
      setTrial(afterWrite);
      setConfirming(false);
      setNotice({ kind: 'ok', text, sha: v.file?.sha256 ?? '' });
      props.onView(v);
      useWorkspace.getState().toast(text, 'success');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      if (code === 'FILE_LOCKED') setWriteError(t('Nothing was written: Excel has this file open. Close the file in Excel, then press “Write these cells” again.'));
      else if (code === 'WRITE_DENIED')
        setWriteError(t('Nothing was written: macOS does not let the Research Workbench service write in the folder of this file. On the Mac, allow it under System Settings → Privacy & Security → Files and Folders, then press “Write these cells” again.'));
      else if (code === 'FILE_CHANGED' || code === 'WORKBOOK_UNREADABLE' || code === 'NOT_AN_ASSUMPTION') {
        // the page's copy is out of date: read the file again and let the user look at the numbers before writing
        setConfirming(false);
        await onReload(true);
        setNotice({
          kind: 'warn',
          text:
            code === 'FILE_CHANGED'
              ? t('Nothing was written: the Excel file was changed after this page read it. It was read again and your trial values are kept. Check the numbers, then press “Write to Excel” again.')
              : t('Nothing was written: the Excel file could not be read as this page last saw it. It was read again; check the file status at the bottom of the page.'),
          sha: '',
        });
      } else if (code === 'WRITE_FAILED') {
        const restored = ((e as ApiError).details as { restored?: boolean } | null)?.restored === true;
        setWriteError(
          restored
            ? t('The write failed and the file was put back as it was before. Nothing changed in Excel. Press Reload and try again.')
            : t('The write failed and the file could not be put back. A copy from before the write is in the workbook-backups folder of the data folder on the Mac. Details: {msg}', { msg: tm((e as Error).message) }),
        );
        void onReload(true);
      } else setWriteError(tm((e as Error).message));
    } finally {
      setWriting(false);
    }
  };
  const openConfirm = () => {
    setWriteError(null);
    setConfirming(true);
  };
  const resetAll = () => {
    setTrial(emptyTrial());
    setConfirming(false);
  };
  const refillLost = () => {
    if (!view.revert) return;
    const r = refill(trial, view.revert, view.assumptions);
    setTrial(r.trial);
    useWorkspace.getState().toast(
      r.missing > 0
        ? t('Filled in again. {n} cell(s) can no longer be found in the file and were left out. Press “Write to Excel” to write them.', { n: r.missing })
        : t('Filled in again. Press “Write to Excel” to write them.'),
      'info',
    );
  };
  const setRange = (id: string, side: 'low' | 'high', text: string) => setTrial((s) => ({ ...s, ranges: { ...s.ranges, [id]: { ...(s.ranges[id] ?? { low: '', high: '' }), [side]: text } } }));
  const card = (a: AssumptionDTO) => (
    <AssumptionCard
      key={a.id}
      a={a}
      text={trial.values[a.id] ?? ''}
      range={trial.ranges[a.id]}
      plan={plan}
      decided={picked(a.id)}
      onDecided={() => toggleDecided(a.id)}
      onValue={(v) => setValue(a.id, v)}
      onRange={(side, v) => setRange(a.id, side, v)}
    />
  );
  const epsOut = outputs.eps.find((e) => e.period === outputs.epsPeriod) ?? null;
  const pending = calcBusy || shown.pending;

  return (
    <>
      <div className={cls('wb-results', pending && 'pending')} data-testid="wb-results" data-trial={active ? '1' : '0'} data-pending={pending ? '1' : '0'}>
        <div className="wb-results-row">
          <Result testid="wb-result-revenue" label={t('Next four quarters’ revenue')} out={outputs.revenueTotal} numFmt={REVENUE_FMT} trial={active} />
          <Result testid="wb-result-eps" label={`${t('EPS')}${outputs.epsPeriod ? ` ${outputs.epsPeriod}` : ''}`} out={epsOut} numFmt={PRICE_FMT} trial={active} />
          <Result testid="wb-result-tp" label={t('Target price')} out={outputs.targetPrice} numFmt={PRICE_FMT} trial={active} />
        </div>
        {outputs.revenueQuarters.length > 0 && (
          <div className="small sub num wb-quarters">
            {outputs.revenueQuarters.map((q) => (
              <span key={q.period}>
                {q.period} {fmtNum(q.value, REVENUE_FMT)}
              </span>
            ))}
          </div>
        )}
        <div className="wb-trial-note small" data-testid="wb-not-saved">
          {active || toWrite > 0 ? (
            <>
              <b>
                {plan.changed.length > 0
                  ? t('Trial: {n} assumption(s) changed, not saved to Excel.', { n: plan.changed.length })
                  : plan.ranged.length > 0
                    ? t('Trial: {n} trial range(s) typed, no assumption changed; nothing is saved to Excel.', { n: plan.ranged.length })
                    : t('{n} assumption(s) picked to become 已定, not saved to Excel yet.', { n: wplan.statusRows.length })}
              </b>
              {plan.changed.length > 0 && plan.ranged.length > 0 && ` ${t('{n} trial range(s).', { n: plan.ranged.length })}`}
              {(plan.changed.length > 0 || plan.ranged.length > 0) && wplan.statusRows.length > 0 && ` ${t('{n} picked to become 已定.', { n: wplan.statusRows.length })}`}
              {calcBusy && ` ${t('Recalculating…')}`}{' '}
              <button className="btn sm primary" disabled={toWrite === 0 || plan.invalid.length > 0 || writing} onClick={openConfirm} data-testid="wb-write">
                {t('Write to Excel')}
              </button>{' '}
              <button className="btn sm" disabled={writing} onClick={resetAll} data-testid="wb-reset-all">
                {t('Reset all')}
              </button>
              {plan.invalid.length > 0 && <div className="err-text">{t('{n} box(es) do not hold a number. Correct or clear them before writing.', { n: plan.invalid.length })}</div>}
            </>
          ) : (
            <span className="sub">{t('These are the file’s own numbers. Type a number in “Try” below to see them change; nothing is saved to Excel until you press “Write to Excel”.')}</span>
          )}
        </div>
        {calcError && <div className="msg err">{tm(calcError)}</div>}
      </div>

      {confirmOpen(confirming, toWrite) && (
        <WriteConfirm
          plan={wplan}
          invalid={plan.invalid.length}
          view={view}
          target={pending || !active ? null : outputs.targetPrice}
          busy={writing}
          error={writeError}
          onConfirm={() => void write()}
          onCancel={() => setConfirming(false)}
        />
      )}
      {notice && (notice.sha === '' || notice.sha === sha) && !confirming && (
        <div className={cls('msg', notice.kind)} style={{ marginBottom: 12 }} data-testid="wb-write-notice" data-kind={notice.kind}>
          {notice.text}{' '}
          {notice.kind === 'warn' && (
            <button className="btn sm" onClick={() => setNotice(null)}>
              {t('Got it')}
            </button>
          )}
        </div>
      )}
      {view.revert && (
        <div className="msg warn" style={{ marginBottom: 12 }} data-testid="wb-revert">
          <b>
            {t('An older version of the Excel file is back: the {n} cell(s) written on {time} are no longer in it.', {
              n: view.revert.changes.length + view.revert.statusChanges.length,
              time: fmtDateTime(view.revert.writtenAt),
            })}
          </b>{' '}
          {t('iCloud does this when two devices hold different versions. The numbers on this page are the older file’s.')}
          <ul className="wb-list">
            {view.revert.changes.map((c) => (
              <li key={`${c.sheet}!${c.address}`} className="wb-wrap">
                {c.label}（{c.sheet}!{c.address}）：{exactNum(c.value, view.assumptions.find((a) => a.id === c.id)?.numFmt)}
              </li>
            ))}
            {view.revert.statusChanges.map((c) => (
              <li key={`${c.sheet}!${c.address}`} className="wb-wrap">
                {c.label}（{c.sheet}!{c.address}）：要 → 已定
              </li>
            ))}
          </ul>
          <button className="btn sm" onClick={refillLost} data-testid="wb-revert-refill">
            {t('Fill these cells in again')}
          </button>{' '}
          <span className="small">{t('Nothing is written until you press “Write to Excel”.')}</span>
        </div>
      )}

      {view.warnings.length > 0 && (
        <div className="msg warn" style={{ marginBottom: 12 }} data-testid="wb-warnings">
          <b>{t('{n} thing(s) could not be found in the file:', { n: view.warnings.length })}</b>
          <ul className="wb-list">
            {view.warnings.map((w, i) => (
              <li key={i} className="wb-wrap">
                {w.sheet ? `${w.sheet}：` : ''}
                {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section data-testid="wb-needs">
        <h2 className="wb-h">{t('Waiting for your decision ({n})', { n: needs.length })}</h2>
        {needs.length === 0 && <div className="empty">{t('No assumption in the file is marked 要.')}</div>}
        {needs.map(card)}
      </section>

      <Tornado sensitivity={sensitivity} assumptions={view.assumptions} epsPeriod={outputs.epsPeriod} hasTarget={!!outputs.targetPrice.cell} />

      <section data-testid="wb-rest">
        <h2 className="wb-h">{t('Other assumptions ({n})', { n: view.assumptions.length - needs.length })}</h2>
        {groups.map((g) => (
          <Group key={g.key} title={g.section ?? (g.output ? t('Valuation') : t('No heading'))} count={g.items.length} open={g.output || g.items.some((a) => plan.changed.includes(a.id) || plan.ranged.includes(a.id))}>
            {g.items.map(card)}
          </Group>
        ))}
      </section>

      {view.parties.map((p, k) => (
        <Parties key={`${k}:${p.sheet}`} table={p} threshold={view.gapThreshold} />
      ))}

      <FileCard view={view} busy={props.busy} onReload={() => void onReload()} onPick={props.onPick} onUnlink={props.onUnlink} projectId={projectId} onView={props.onView} />
    </>
  );
}

/**
 * One step of the model, folded so a phone shows the list of steps first. A group opens from the start
 * when it holds the valuation multiple (it sits outside the tables and decides most of the target price)
 * or a trial value; after that only the user opens and closes it.
 */
function Group(props: { title: string; count: number; open: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(props.open);
  return (
    <details className="wb-group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="wb-group">
      <summary>
        {props.title}
        <span className="sub"> · {t('{n} assumption(s)', { n: props.count })}</span>
      </summary>
      {props.children}
    </details>
  );
}

function Result(props: { testid: string; label: string; out: WorkbookOutputDTO | null; numFmt: string; trial: boolean }) {
  const { out } = props;
  const d = out ? deltaVsFile(out.value, out.fileValue) : null;
  const digits = props.numFmt === REVENUE_FMT ? 1 : 2;
  return (
    <div className="wb-result" data-testid={props.testid} data-value={out?.value ?? ''}>
      <span>{props.label}</span>
      <b className="num">{fmtNum(out?.value, props.numFmt)}</b>
      <small className="num" data-testid={`${props.testid}-delta`}>
        {!out?.cell ? t('not found') : !props.trial || !d ? t('file value') : d.abs === 0 ? t('same as the file') : `${signed(d.abs, digits)}${d.pct !== null ? `（${signed(d.pct * 100, 1)}%）` : ''}`}
      </small>
    </div>
  );
}

/** Every cell the write will change, before it happens. Nothing is written until “Write these cells” is pressed. */
function WriteConfirm(props: { plan: WritePlan; invalid: number; view: WorkbookViewDTO; target: WorkbookOutputDTO | null; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const { plan, view, target } = props;
  const n = plan.rows.length + plan.statusRows.length;
  const formulas = plan.rows.filter((r) => r.wasFormula).length;
  const verified = view.selfCheck?.state === 'verified';
  // the button that opens this sits in the bar that stays on screen; the list itself may be far up the page
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // not returned: newer browsers answer scrollIntoView with a promise, which is not an effect cleanup
    box.current?.scrollIntoView({ block: 'start' });
  }, []);
  return (
    <div className="card wb-confirm" ref={box} style={{ scrollMarginTop: 190, marginBottom: 12 }} data-testid="wb-write-confirm">
      <h2>{t('Write {n} cell(s) to {file}?', { n, file: view.file?.name ?? '' })}</h2>
      {target && target.cell && target.value !== null && target.fileValue !== null && (
        <div className="wb-lead" data-testid="wb-write-target">
          <b className="num">{t('Target price {a} → {b}', { a: fmtNum(target.fileValue, PRICE_FMT), b: fmtNum(target.value, PRICE_FMT) })}</b>
        </div>
      )}
      <ul className="wb-list" data-testid="wb-write-cells">
        {plan.rows.map((r) => (
          <li key={r.id} className="wb-wrap" data-testid="wb-write-cell" data-cell={`${r.sheet}!${r.cell}`} data-formula={r.wasFormula ? '1' : '0'}>
            <b>{r.label}</b>
            <span className="num">
              ：{exactNum(r.from, r.numFmt)} → {exactNum(r.to, r.numFmt)}
            </span>{' '}
            <span className="tiny faint nowrap">
              {r.sheet}!{r.cell}
            </span>{' '}
            {r.wasFormula && <span className="badge warn">{t('a formula now; becomes a fixed number')}</span>}
          </li>
        ))}
        {plan.statusRows.map((r) => (
          <li key={`s:${r.id}`} className="wb-wrap" data-testid="wb-write-status" data-cell={`${r.sheet}!${r.cell}`}>
            <b>{r.label}</b>：要 → 已定{' '}
            <span className="tiny faint nowrap">
              {r.sheet}!{r.cell}
            </span>
          </li>
        ))}
      </ul>
      {formulas > 0 && <div className="msg warn">{t('{n} of these cells hold a formula. The formula is replaced by the number and no longer follows the cells it referred to.', { n: formulas })}</div>}
      {view.file?.excelOpen && <div className="msg warn">{t('Excel had this file open when it was last read. Close it in Excel first, or the write is refused.')}</div>}
      <div className="small sub" style={{ marginTop: 6 }}>
        {t('Only these cells change. A copy of the file as it is now is kept on the Mac first.')}{' '}
        {verified ? t('The results that depend on them are updated in the file as well.') : t('Other results in the file are updated when Excel next opens it.')}
      </div>
      {props.invalid > 0 && <div className="err-text small">{t('{n} box(es) do not hold a number. Correct or clear them before writing.', { n: props.invalid })}</div>}
      {props.error && (
        <div className="msg err" style={{ marginTop: 8 }} data-testid="wb-write-error">
          {props.error}
        </div>
      )}
      <div className="row wrap" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={props.busy || props.invalid > 0} onClick={props.onConfirm} data-testid="wb-write-go">
          {props.busy ? t('Writing…') : t('Write these cells')}
        </button>
        <button className="btn ghost" disabled={props.busy} onClick={props.onCancel} data-testid="wb-write-cancel">
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}

function AssumptionCard(props: {
  a: AssumptionDTO;
  text: string;
  range: { low: string; high: string } | undefined;
  plan: RecalcPlan;
  /** Picked to become 已定 with the next write. */
  decided: boolean;
  onDecided: () => void;
  onValue: (text: string) => void;
  onRange: (side: 'low' | 'high', text: string) => void;
}) {
  const { a, text, plan } = props;
  const changed = plan.changed.includes(a.id);
  const parsed = parseNum(text, a.numFmt);
  const pct = isPercent(a.numFmt);
  // the iOS number pad has no minus key
  const mode = a.value < 0 || (a.low ?? 0) < 0 ? 'text' : 'decimal';
  const rangeInput = (side: 'low' | 'high') => {
    const v = props.range?.[side] ?? '';
    return (
      <input
        className={cls('wb-in', !parseNum(v, a.numFmt).ok && 'bad')}
        inputMode={mode}
        value={v}
        placeholder={t('trial')}
        aria-label={side === 'low' ? t('Trial low for {label}', { label: a.label }) : t('Trial high for {label}', { label: a.label })}
        onChange={(e) => props.onRange(side, e.target.value)}
        data-testid={`wb-range-${side}`}
      />
    );
  };
  const ranged = hasRange(a);
  return (
    <div className={cls('wb-a', (changed || props.decided) && 'changed')} data-testid="wb-assumption" data-id={a.id} data-status={a.status ?? ''} data-decided={props.decided ? '1' : '0'}>
      <div className="wb-a-head">
        <b className="wb-wrap">{a.label}</b>
        {a.status === 'needs-decision' && <span className="badge warn">要</span>}
        {props.decided && <span className="badge accent">{t('becomes 已定 when written')}</span>}
        {a.status === 'decided' && <span className="badge">已定</span>}
        {a.valueIsFormula && <span className="badge">{t('formula')}</span>}
        <span className="tiny faint right nowrap">
          {a.sheet}!{a.cell}
        </span>
      </div>
      <div className="wb-a-nums">
        <div>
          <span>{t('Value in file')}</span>
          <b className="num" data-testid="wb-value">
            {fmtNum(a.value, a.numFmt)}
          </b>
        </div>
        <div>
          <span>{t('Low bound')}</span>
          {ranged ? <b className="num">{fmtNum(a.low, a.numFmt)}</b> : rangeInput('low')}
        </div>
        <div>
          <span>{t('High bound')}</span>
          {ranged ? <b className="num">{fmtNum(a.high, a.numFmt)}</b> : rangeInput('high')}
        </div>
        <div className="wb-a-try">
          <span>{pct ? t('Try (%)') : t('Try')}</span>
          <div className="row" style={{ gap: 4 }}>
            <input
              className={cls('wb-in', !parsed.ok && 'bad', changed && 'on')}
              inputMode={mode}
              value={text}
              placeholder={editNum(a.value, a.numFmt)}
              aria-label={t('Try a value for {label}', { label: a.label })}
              title={parsed.ok ? undefined : t('Not a number')}
              onChange={(e) => props.onValue(e.target.value)}
              data-testid="wb-trial"
            />
            {text && (
              <button className="btn sm" onClick={() => props.onValue('')} title={t('Back to the value in the file')} data-testid="wb-reset">
                {t('Reset')}
              </button>
            )}
          </div>
        </div>
      </div>
      {a.status === 'needs-decision' && a.statusCell && (
        <div className="row wrap" style={{ marginTop: 6 }}>
          <button className="btn sm" onClick={props.onDecided} aria-pressed={props.decided} data-testid="wb-decide">
            {props.decided ? t('Keep it 要') : t('Change to 已定')}
          </button>
          <span className="tiny sub">{props.decided ? t('Written together with “Write to Excel”.') : t('Excel is changed only when you press “Write to Excel”.')}</span>
        </div>
      )}
      {!ranged && <div className="tiny sub">{t('The file gives no range. A trial range typed here is used for the sensitivity list only and is not saved.')}</div>}
      {!parsed.ok && <div className="tiny err-text">{t('Not a number')}</div>}
      {(a.basis || a.note) && (
        <div className="small wb-a-basis wb-wrap">
          {a.basis && (
            <div>
              <span className="sub">{t('Basis in the file')}：</span>
              {a.basis}
            </div>
          )}
          {a.note && (
            <div>
              <span className="sub">{t('Cell note')}：</span>
              {a.note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Each assumption moved from its low to its high: how far the target price goes, longest bar first. */
function Tornado(props: { sensitivity: WorkbookSensitivityDTO; assumptions: AssumptionDTO[]; epsPeriod: string | null; hasTarget: boolean }) {
  const rows = useMemo(() => sortTornado(props.sensitivity.rows), [props.sensitivity.rows]);
  const fmtOf = (id: string) => props.assumptions.find((a) => a.id === id)?.numFmt ?? null;
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.targetPrice.delta ?? 0)));
  const top = rows[0];
  const abs = (v: number | null, numFmt: string) => (v === null ? '—' : fmtNum(Math.abs(v), numFmt));
  return (
    <section className="card wb-tornado" data-testid="wb-tornado">
      <h2>{t('Which assumption decides the target price')}</h2>
      {!props.hasTarget && <div className="msg warn">{t('The target price cell was not found, so the list cannot be ordered.')}</div>}
      {top && top.targetPrice.delta !== null && (
        <div className="wb-lead" data-testid="wb-tornado-lead">
          <b>
            {t('“{label}” moves the target price the most: from {low} to {high} it changes by {delta}.', {
              label: top.label,
              low: fmtNum(top.low, fmtOf(top.id)),
              high: fmtNum(top.high, fmtOf(top.id)),
              delta: abs(top.targetPrice.delta, PRICE_FMT),
            })}
          </b>
        </div>
      )}
      {rows.length === 0 && <div className="empty">{t('No assumption has a low and a high yet.')}</div>}
      {rows.map((r) => (
        <div key={r.id} className="wb-t-row" data-testid="wb-tornado-row" data-id={r.id} data-delta={r.targetPrice.delta ?? ''}>
          <div className="wb-t-label">
            <b className="wb-wrap">{r.label}</b>{' '}
            <span className="small sub num nowrap">
              {fmtNum(r.low, fmtOf(r.id))} → {fmtNum(r.high, fmtOf(r.id))}
            </span>{' '}
            {r.rangeSource === 'trial' && <span className="badge accent">{t('trial range')}</span>}
          </div>
          <div className="wb-t-bar">
            <i style={{ width: `${barShare(r.targetPrice.delta, max)}%` }} />
          </div>
          <div className="num wb-t-num">
            {t('Target price {a} → {b}, a difference of {d}', { a: fmtNum(r.targetPrice.atLow, PRICE_FMT), b: fmtNum(r.targetPrice.atHigh, PRICE_FMT), d: abs(r.targetPrice.delta, PRICE_FMT) })}
          </div>
          <div className="tiny sub num">
            {t('Four-quarter revenue differs by {rev}; EPS {period} by {eps}', { rev: abs(r.revenue.delta, REVENUE_FMT), period: props.epsPeriod ?? '', eps: abs(r.eps.delta, '0.000') })}
          </div>
        </div>
      ))}
      {props.sensitivity.withoutRange.length > 0 && (
        <div className="small sub" style={{ marginTop: 8 }} data-testid="wb-tornado-missing">
          {t('{n} assumption(s) have no low and high in the file and are not listed. Type a trial low and high on the assumption to add it here.', { n: props.sensitivity.withoutRange.length })}
        </div>
      )}
    </section>
  );
}

/** Our estimate next to the other parties, one period at a time so the table stays narrow. Figures are the file's, without trial values. */
function Parties({ table, threshold }: { table: PartyTableDTO; threshold: number }) {
  const [at, setAt] = useState(0);
  const i = Math.min(at, table.periods.length - 1);
  const period = table.periods[i];
  if (!period) return null;
  // a party with no figure in this period is left out and named below
  const filled = period.columns.map((_, j) => table.rows.some((r) => r.cells[i]?.[j] && (r.cells[i][j].value !== null || r.cells[i][j].text)));
  const flagged = table.rows.reduce((n, r) => n + (r.cells[i] ?? []).filter((c) => c.flagged).length, 0);
  const mine = mineFilled(period.columns, filled);
  const pct = Math.round(threshold * 100);
  return (
    <section className="card" data-testid="wb-parties" data-sheet={table.sheet}>
      <h2>{t('Side by side: {sheet}', { sheet: table.sheet })}</h2>
      <div className="wb-lead">
        <b data-testid="wb-parties-lead">
          {!mine
            ? t('{period}: 我的預估 has no figure in this period, so nothing is compared.', { period: period.period })
            : flagged > 0
              ? t('{period}: {n} figure(s) are more than {pct}% away from 我的預估.', { period: period.period, n: flagged, pct })
              : t('{period}: no figure is more than {pct}% away from 我的預估.', { period: period.period, pct })}
        </b>{' '}
        <span className="small sub">{t('File values, without trial values.')}</span>
      </div>
      <div className="seg wb-periods" role="group" aria-label={t('Period')}>
        {table.periods.map((p, k) => (
          <button key={k} className={cls(k === i && 'on plain')} onClick={() => setAt(k)}>
            {p.period}
          </button>
        ))}
      </div>
      <div className="wb-scroll">
        <table className="grid wb-party">
          <thead>
            <tr>
              <th />
              {period.columns.map((c, j) => filled[j] && <th key={j}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, k) => (
              <tr key={k}>
                <td>{r.label}</td>
                {period.columns.map((_, j) => {
                  const v = r.cells[i]?.[j];
                  if (!filled[j]) return null;
                  return (
                    <td key={j} className={cls(v?.flagged && 'wb-flag')} data-flagged={v?.flagged ? '1' : undefined}>
                      {v?.value !== null && v?.value !== undefined ? fmtNum(v.value, r.numFmt) : v?.text ?? '—'}
                      {v?.flagged && v.gap !== null && <div className="tiny">{signed(v.gap * 100, 1)}%</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filled.includes(false) && (
        <div className="tiny sub" style={{ marginTop: 6 }}>
          {t('No figure in this period, column not shown: {list}', { list: period.columns.filter((_, j) => !filled[j]).map((c) => c.label).join('、') })}
        </div>
      )}
    </section>
  );
}
