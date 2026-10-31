/**
 * A ServerPort that plays the workbench's /api/vault/* contract from memory: notes with a change
 * log, reflections stored by the same rule as the server (shouldStoreReflection), status reports
 * kept for inspection. `fail` makes a method return a canned failure instead.
 */
import { reflectionHash } from '../../src/domain/vault/hash';
import { VAULT_PROTOCOL, shouldStoreReflection, type RenderedNote, type ReflectionUpload, type ServerReflectionState, type VaultNotesResponse, type VaultStatusReport } from '../../src/domain/vault/types';
import type { Failure, PingResponse, ReflectionResult, Result, ServerPort } from '../src/ports';

type Method = keyof ServerPort;

export class FakeServer implements ServerPort {
  protocol = VAULT_PROTOCOL;
  generation = 'gen-1';
  publicUrl = 'http://127.0.0.1:4310';
  notes = new Map<string, RenderedNote>();
  changes: { seq: number; id: string }[] = [];
  /** Default paths of notes that exist but are not in a page (VaultNotesResponse.names). */
  names: Record<string, string> = {};
  reflections: { wbId: string; text: string; path: string; hash: string }[] = [];
  statuses: VaultStatusReport[] = [];
  calls: { method: Method; arg?: unknown }[] = [];
  fail: Partial<Record<Method, Failure>> = {};

  put(...notes: RenderedNote[]) {
    for (const n of notes) {
      this.notes.set(n.wbId, n);
      this.changes.push({ seq: this.changes.length + 1, id: n.wbId });
    }
  }

  get latestSeq() {
    return this.changes.length ? this.changes[this.changes.length - 1].seq : 0;
  }

  lastStatus(): VaultStatusReport {
    const s = this.statuses[this.statuses.length - 1];
    if (!s) throw new Error('no status report');
    return s;
  }

  callsOf(m: Method) {
    return this.calls.filter((c) => c.method === m);
  }

  private answer<T>(method: Method, arg: unknown, value: () => T): Promise<Result<T>> {
    this.calls.push({ method, arg });
    const f = this.fail[method];
    return Promise.resolve(f ? f : { ok: true, value: value() });
  }

  private page(ids: string[]): Pick<VaultNotesResponse, 'notes' | 'names' | 'missing'> {
    const notes = ids.map((id) => this.notes.get(id)).filter((n): n is RenderedNote => !!n);
    const names = Object.fromEntries(
      [...this.notes.values()].filter((n) => !ids.includes(n.wbId)).map((n) => [n.wbId, n.path] as [string, string]),
    );
    return { notes, names: { ...this.names, ...names }, missing: ids.filter((id) => !this.notes.has(id)) };
  }

  ping() {
    return this.answer<PingResponse>('ping', undefined, () => ({
      ok: true,
      protocol: this.protocol,
      generation: this.generation,
      publicUrl: this.publicUrl,
      latestSeq: this.latestSeq,
      serverTime: new Date().toISOString(),
    }));
  }

  notesAfter(after: number, limit: number) {
    return this.answer<VaultNotesResponse>('notesAfter', { after, limit }, () => {
      const rows = this.changes.filter((c) => c.seq > after).slice(0, limit);
      const ids = [...new Set(rows.map((r) => r.id))];
      const nextAfter = rows.length ? rows[rows.length - 1].seq : after;
      return {
        protocol: this.protocol,
        generation: this.generation,
        publicUrl: this.publicUrl,
        latestSeq: this.latestSeq,
        nextAfter,
        more: this.changes.some((c) => c.seq > nextAfter),
        ...this.page(ids),
      };
    });
  }

  notesByIds(ids: string[]) {
    return this.answer<VaultNotesResponse>('notesByIds', ids, () => ({
      protocol: this.protocol,
      generation: this.generation,
      publicUrl: this.publicUrl,
      latestSeq: this.latestSeq,
      nextAfter: 0,
      more: false,
      ...this.page(ids),
    }));
  }

  states(): Record<string, ServerReflectionState> {
    const out: Record<string, ServerReflectionState> = {};
    for (const r of this.reflections) {
      const s = (out[r.wbId] ??= { latest: r.hash, byPath: {} });
      s.latest = r.hash;
      s.byPath[r.path] = r.hash;
    }
    return out;
  }

  reflectionStates() {
    return this.answer('reflectionStates', undefined, () => ({ notes: this.states() }));
  }

  postReflections(items: ReflectionUpload[]) {
    return this.answer<{ results: ReflectionResult[] }>('postReflections', items, () => ({
      results: items.map((it) => {
        if (!this.notes.has(it.wbId)) return { wbId: it.wbId, status: 'rejected', error: 'unknown note' };
        const text = it.text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
        const hash = reflectionHash(text);
        if (!shouldStoreReflection(hash, text === '', it.path, this.states()[it.wbId])) return { wbId: it.wbId, status: 'unchanged' };
        this.reflections.push({ wbId: it.wbId, text, path: it.path, hash });
        return { wbId: it.wbId, status: 'stored', versionId: this.reflections.length };
      }),
    }));
  }

  postStatus(r: VaultStatusReport) {
    return this.answer<{ ok: true }>('postStatus', r, () => {
      this.statuses.push(r);
      return { ok: true };
    });
  }
}
