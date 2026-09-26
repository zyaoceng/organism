import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/connection';
import type { AttachmentDTO } from '../../shared/api';
import { newId, nowIso } from '../util';

export interface AttachmentRow {
  id: string;
  sha256: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  created_at: string;
}

/** Types that may be displayed inline in the browser. Everything else is served as a download. */
export const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

export function toAttachmentDTO(r: AttachmentRow): AttachmentDTO {
  return {
    id: r.id,
    sha256: r.sha256,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    url: `/api/attachments/${r.id}/content`,
  };
}

/** Strip path components and control characters; keep the user's name otherwise. */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 255) || 'file';
}

/**
 * Content-addressed attachment storage: files live at <dir>/<aa>/<sha256>, are written once and never
 * modified. Each upload gets its own row (keeping its original filename) even when bytes are shared.
 */
export class AttachmentStore {
  constructor(
    private readonly db: DB,
    private readonly dir: string,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  save(data: Buffer, originalFilename: string, mimeType: string): AttachmentRow {
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const storageKey = `${sha256.slice(0, 2)}/${sha256}`;
    const target = path.join(this.dir, storageKey);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target);
    }
    const row: AttachmentRow = {
      id: newId('att'),
      sha256,
      original_filename: sanitizeFilename(originalFilename),
      mime_type: mimeType || 'application/octet-stream',
      size_bytes: data.length,
      storage_key: storageKey,
      created_at: nowIso(),
    };
    this.db
      .prepare('INSERT INTO attachments (id, sha256, original_filename, mime_type, size_bytes, storage_key, created_at) VALUES (@id, @sha256, @original_filename, @mime_type, @size_bytes, @storage_key, @created_at)')
      .run(row);
    return row;
  }

  get(id: string): AttachmentRow | undefined {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  }

  filePath(row: AttachmentRow): string {
    return path.join(this.dir, row.storage_key);
  }

  exists(row: AttachmentRow): boolean {
    return fs.existsSync(this.filePath(row));
  }
}
