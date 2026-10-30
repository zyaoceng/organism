/** Find the node or period an AI means: by id, name, or a "Parent/Child" path. */
import { formatPath, resolveName } from '../formula/refs';
import type { ModelIndex } from '../model/tree';
import type { ModelState, Period } from '../model/types';

export type RefResult = { ok: true; id: string } | { ok: false; message: string; candidates: string[] };

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();

export function resolveNodeRef(ix: ModelIndex, ref: string): RefResult {
  const r = ref.trim();
  if (ix.byId.has(r)) return { ok: true, id: r };
  // paths as the tools print them ("EPS 分支 › 營收") or as formulas write them ("EPS 分支/營收")
  let text = r;
  let res = resolveName(ix, text, null);
  if (!res.ok && res.code === 'UNKNOWN_NAME' && /[›>]/.test(r)) {
    text = r.replace(/\s*[›>]\s*/g, '/');
    res = resolveName(ix, text, null);
  }
  if (res.ok) return res;
  if (res.code === 'AMBIGUOUS_NAME') {
    const paths = res.candidates.map((id) => formatPath(ix, id));
    return { ok: false, message: `「${ref}」符合 ${paths.length} 個節點，請改用路徑（父/子）或 id`, candidates: paths };
  }
  const q = norm(text.split('/').at(-1) ?? text);
  const similar = [...ix.byId.values()].filter((n) => q && (norm(n.name).includes(q) || q.includes(norm(n.name)))).slice(0, 8);
  return { ok: false, message: `找不到節點「${ref}」${similar.length ? '，是不是其中之一？' : '；請先用 get_model 看節點名稱'}`, candidates: similar.map((n) => formatPath(ix, n.id)) };
}

export type PeriodResult = { ok: true; period: Period } | { ok: false; message: string; candidates: string[] };

/** Exact id (FY2026), then a unique label (2026), then label + status (2026E). */
export function resolvePeriodRef(state: ModelState, ref: string): PeriodResult {
  const r = norm(ref);
  const byId = state.periods.find((p) => norm(p.id) === r);
  if (byId) return { ok: true, period: byId };
  const byLabel = state.periods.filter((p) => norm(p.label) === r);
  if (byLabel.length === 1) return { ok: true, period: byLabel[0] };
  const byLabelStatus = state.periods.filter((p) => norm(`${p.label}${p.status}`) === r);
  if (byLabelStatus.length === 1) return { ok: true, period: byLabelStatus[0] };
  const known = state.periods.map((p) => `${p.id}（${p.label}${p.status}）`);
  return { ok: false, message: `找不到期間「${ref}」。這個模型的期間有：${known.join('、') || '（沒有）'}`, candidates: state.periods.map((p) => p.id) };
}
