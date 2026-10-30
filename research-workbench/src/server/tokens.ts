import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { actorFor, TOKEN_NAMES, type Actor, type TokenName } from '../shared/actors';
import { fileStamp } from './services/backup';

/**
 * <dataDir>/tokens.json: one random token per caller (the browser user and each AI client).
 * The server creates it at startup and adds missing keys, so tests, dev mode and Linux need no
 * installer; the MCP adapter reads it through --data-dir. The tokens record who is acting; they are
 * not passwords (any program of this macOS user can read the file).
 */
export interface TokenSet {
  file: string;
  tokens: Record<TokenName, string>;
  /** The actor whose token this is, or null for an unknown token. */
  actorFor(token: string): Actor | null;
}

interface TokenFile {
  version: 1;
  createdAt: string;
  note: string;
  tokens: Partial<Record<string, string>>;
}

const NOTE = '研究工作台的連線憑證：只用來記錄是誰在操作，不是密碼。刪除後下次啟動會重新產生。';
const newToken = () => crypto.randomBytes(32).toString('base64url');
const valid = (t: unknown): t is string => typeof t === 'string' && t.length >= 32;

export function loadOrCreateTokens(file: string, now = new Date()): TokenSet {
  let doc: TokenFile | null = null;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TokenFile;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.tokens !== 'object' || parsed.tokens === null) throw new Error('no tokens');
      doc = parsed;
    } catch {
      // keep the broken file for inspection and start over
      fs.renameSync(file, `${file}.corrupt-${fileStamp(now)}`);
    }
  }
  let changed = !doc;
  doc ??= { version: 1, createdAt: now.toISOString(), note: NOTE, tokens: {} };
  for (const name of TOKEN_NAMES) {
    if (!valid(doc.tokens[name])) {
      doc.tokens[name] = newToken();
      changed = true;
    }
  }
  if (changed) write(file, doc);
  else {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* not ours to fix */
    }
  }
  const tokens = Object.fromEntries(TOKEN_NAMES.map((n) => [n, doc.tokens[n] as string])) as Record<TokenName, string>;
  const buffers = TOKEN_NAMES.map((n) => [n, Buffer.from(tokens[n])] as const);
  return {
    file,
    tokens,
    actorFor(token: string) {
      const b = Buffer.from(token);
      for (const [name, t] of buffers) if (t.length === b.length && crypto.timingSafeEqual(t, b)) return actorFor(name);
      return null;
    },
  };
}

function write(file: string, doc: TokenFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
