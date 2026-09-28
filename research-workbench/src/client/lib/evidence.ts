import { addLink } from '../../domain/model/ops';
import { LINK_RELATIONS, type LinkRelation } from '../../domain/model/types';
import type { EvidenceDTO } from '../../shared/api';
import { api } from './api';
import { getLang, t, tm } from './i18n';
import { useWorkspace } from './store';

/** Create evidence from files (one evidence item per file) and return them. */
export async function uploadEvidenceFiles(projectId: string, files: File[], fields: Record<string, string> = {}): Promise<EvidenceDTO[]> {
  const out: EvidenceDTO[] = [];
  for (const f of files) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
    fd.append('file', f, f.name);
    out.push(await api.createEvidence(projectId, fd));
  }
  return out;
}

/** Screenshot from the clipboard: keep a readable, timestamped filename. */
export function namedScreenshot(file: File): File {
  if (file.name && file.name !== 'image.png') return file;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}.${String(d.getSeconds()).padStart(2, '0')}`;
  const ext = file.type.split('/')[1] || 'png';
  return new File([file], `Screenshot ${stamp}.${ext}`, { type: file.type });
}

/** English keeps the raw relation id (e.g. "supports"); Chinese shows the translated label. */
function relationText(relation: LinkRelation): string {
  if (getLang() !== 'zh-TW') return relation;
  return t(LINK_RELATIONS.find((r) => r.value === relation)?.label ?? relation);
}

/** Add evidence to the library and link it to a node in the draft. */
export async function createAndLink(
  create: () => Promise<EvidenceDTO[]>,
  nodeId: string | null,
  relation: LinkRelation = 'supports',
): Promise<EvidenceDTO[]> {
  const ws = useWorkspace.getState();
  try {
    const created = await create();
    created.forEach((e) => ws.upsertEvidence(e));
    if (nodeId) {
      ws.edit((s) => created.reduce((acc, e) => addLink(acc, { evidenceId: e.id, nodeId, relation }).state, s));
    }
    const nodeName = nodeId ? ws.draft?.nodes.find((n) => n.id === nodeId)?.name : null;
    const what = created.length === 1 ? `“${created[0].title}”` : t('{n} items', { n: created.length });
    ws.toast(
      nodeName ? t('{what} added to evidence and linked to {node} ({relation})', { what, node: nodeName, relation: relationText(relation) }) : t('{what} added to evidence', { what }),
      'success',
    );
    return created;
  } catch (e) {
    ws.toast(tm((e as Error).message), 'error');
    return [];
  }
}

export const KIND_ICON: Record<string, string> = { url: '🔗', file: '📄', image: '🖼', note: '📝' };
