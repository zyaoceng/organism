import { addLink } from '../../domain/model/ops';
import type { LinkRelation } from '../../domain/model/types';
import type { EvidenceDTO } from '../../shared/api';
import { api } from './api';
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
    ws.toast(`${created.length === 1 ? `“${created[0].title}”` : `${created.length} items`} added to evidence${nodeName ? ` and linked to ${nodeName} (${relation})` : ''}`, 'success');
    return created;
  } catch (e) {
    ws.toast((e as Error).message, 'error');
    return [];
  }
}

export const KIND_ICON: Record<string, string> = { url: '🔗', file: '📄', image: '🖼', note: '📝' };
