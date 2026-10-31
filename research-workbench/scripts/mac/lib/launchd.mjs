/**
 * The LaunchAgent that keeps the server running (~/Library/LaunchAgents/com.researchworkbench.plist),
 * plus parsers for what launchctl and lsof print. Pure; install.mjs runs the commands.
 */
import path from 'node:path';
import { LABEL } from './layout.mjs';

const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

export function xmlEscape(s) {
  const str = String(s);
  if (XML_INVALID.test(str)) throw new Error(`character not allowed in a plist: ${JSON.stringify(str)}`);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Serialise strings, booleans, integers, arrays and plain objects (key order kept) as an XML property list. */
export function renderPlist(value) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ];
  const emit = (v, depth) => {
    const pad = '\t'.repeat(depth);
    if (typeof v === 'string') out.push(`${pad}<string>${xmlEscape(v)}</string>`);
    else if (typeof v === 'boolean') out.push(`${pad}<${v}/>`);
    else if (Number.isInteger(v)) out.push(`${pad}<integer>${v}</integer>`);
    else if (Array.isArray(v)) {
      out.push(`${pad}<array>`);
      for (const x of v) emit(x, depth + 1);
      out.push(`${pad}</array>`);
    } else if (v && typeof v === 'object') {
      out.push(`${pad}<dict>`);
      for (const [k, x] of Object.entries(v)) {
        out.push(`${pad}\t<key>${xmlEscape(k)}</key>`);
        emit(x, depth + 1);
      }
      out.push(`${pad}</dict>`);
    } else throw new Error(`cannot write ${typeof v} to a plist`);
  };
  emit(value, 0);
  out.push('</plist>');
  return `${out.join('\n')}\n`;
}

/**
 * The LaunchAgent definition. Every path must be absolute: launchd does not expand `~` or $HOME.
 * @param {{ node: string, workingDirectory: string, dataDir: string, port: number, stdoutLog: string, stderrLog: string }} o
 */
export function launchAgent({ node, workingDirectory, dataDir, port, stdoutLog, stderrLog }) {
  for (const [k, p] of Object.entries({ node, workingDirectory, dataDir, stdoutLog, stderrLog })) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('~')) throw new Error(`${k} must be an absolute path without ~: ${p}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port: ${port}`);
  return {
    Label: LABEL,
    ProgramArguments: [node, '--import', 'tsx', 'src/server/main.ts'],
    WorkingDirectory: workingDirectory,
    EnvironmentVariables: {
      PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_PORT: String(port),
      WORKBENCH_LOG_LEVEL: 'warn',
    },
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 10,
    StandardOutPath: stdoutLog,
    StandardErrorPath: stderrLog,
  };
}

export const serviceTarget = (uid) => `gui/${uid}/${LABEL}`;

/**
 * Top-level fields of `launchctl print gui/<uid>/<label>` (one tab deep; nested blocks are skipped).
 * @returns {{ state?: string, pid?: number, lastExitCode?: string, runs?: number, path?: string, program?: string }}
 */
export function parseLaunchctlPrint(text) {
  const fields = {};
  for (const line of String(text).split('\n')) {
    const m = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
  }
  const int = (s) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined);
  return {
    state: fields.state,
    pid: int(fields.pid),
    lastExitCode: fields['last exit code'],
    runs: int(fields.runs),
    path: fields.path,
    program: fields.program,
  };
}

/** From `launchctl print-disabled gui/<uid>`: true when the job is disabled (Login Items switch off), false when enabled, null when not listed. */
export function parsePrintDisabled(text, label = LABEL) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`"${esc}"\\s*=>\\s*(\\w+)`).exec(String(text));
  if (!m) return null;
  return m[1] === 'disabled' || m[1] === 'true';
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` → [{ pid, command }]. */
export function parseLsof(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('p')) {
      cur = { pid: Number(line.slice(1)), command: '' };
      out.push(cur);
    } else if (line.startsWith('c') && cur) cur.command = line.slice(1);
  }
  return out.filter((x) => Number.isInteger(x.pid) && x.pid > 0);
}
