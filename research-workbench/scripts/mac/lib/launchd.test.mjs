import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchAgent, parseLaunchctlPrint, parseLsof, parsePrintDisabled, renderPlist, serviceTarget, xmlEscape } from './launchd.mjs';
import { layout } from './layout.mjs';

/** Strict reader for the plist subset renderPlist writes; throws on anything malformed. */
function parsePlist(xml) {
  const header =
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n';
  if (!xml.startsWith(header)) throw new Error('bad header');
  const tokens = xml.slice(header.length).match(/<[^>]*>|[^<]+/g);
  let i = 0;
  const skip = () => {
    while (i < tokens.length && /^\s+$/.test(tokens[i])) i++;
  };
  const next = () => (skip(), tokens[i++]);
  const peek = () => (skip(), tokens[i]);
  const text = (close) => {
    let t = '';
    if (!tokens[i].startsWith('<')) t = tokens[i++];
    if (tokens[i++] !== close) throw new Error(`expected ${close}`);
    if (/[<>]/.test(t) || /&(?!(amp|lt|gt|quot|apos);)/.test(t)) throw new Error(`unescaped text ${t}`);
    return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  };
  const value = () => {
    const t = next();
    if (t === '<string>') return text('</string>');
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<integer>') return Number(text('</integer>'));
    if (t === '<array>') {
      const a = [];
      while (peek() !== '</array>') a.push(value());
      next();
      return a;
    }
    if (t === '<dict>') {
      const o = {};
      while (peek() !== '</dict>') {
        if (next() !== '<key>') throw new Error('expected <key>');
        const k = text('</key>');
        o[k] = value();
      }
      next();
      return o;
    }
    throw new Error(`unexpected ${t}`);
  };
  const v = value();
  if (next() !== '</plist>') throw new Error('expected </plist>');
  if (peek() !== undefined) throw new Error('trailing content');
  return v;
}

const has = (cmd) => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`]).status === 0;

const L = layout({ home: '/Users/王 小明', platform: 'darwin' });
const agent = launchAgent({ node: L.node, workingDirectory: L.current, dataDir: L.dataDir, port: 4310, stdoutLog: L.stdoutLog, stderrLog: L.stderrLog });

describe('renderPlist', () => {
  it('escapes XML text and rejects control characters', () => {
    expect(xmlEscape('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;');
    expect(() => xmlEscape('bell\u0007')).toThrow();
    expect(xmlEscape('tab\tnewline\n')).toBe('tab\tnewline\n');
  });

  it('round-trips nested values, including escapes and Chinese', () => {
    const v = { s: 'R&D <研究> "工作台"', t: true, f: false, n: 10, a: ['x', 'y z'], d: { e: {} , empty: [] } };
    expect(parsePlist(renderPlist(v))).toEqual(v);
  });

  it('refuses values a plist cannot hold', () => {
    expect(() => renderPlist({ x: 1.5 })).toThrow();
    expect(() => renderPlist({ x: null })).toThrow();
  });
});

describe('launchAgent', () => {
  it('describes the service with absolute paths (spaces and Chinese kept)', () => {
    const xml = renderPlist(agent);
    expect(parsePlist(xml)).toEqual({
      Label: 'com.researchworkbench',
      ProgramArguments: ['/Users/王 小明/ResearchWorkbench/runtime/current/bin/node', '--import', 'tsx', 'src/server/main.ts'],
      WorkingDirectory: '/Users/王 小明/ResearchWorkbench/current',
      EnvironmentVariables: {
        PATH: '/Users/王 小明/ResearchWorkbench/runtime/current/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        WORKBENCH_DATA_DIR: '/Users/王 小明/Library/Application Support/ResearchWorkbench',
        WORKBENCH_PORT: '4310',
        WORKBENCH_LOG_LEVEL: 'warn',
      },
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ThrottleInterval: 10,
      StandardOutPath: '/Users/王 小明/Library/Logs/ResearchWorkbench/server.out.log',
      StandardErrorPath: '/Users/王 小明/Library/Logs/ResearchWorkbench/server.err.log',
    });
    expect(xml).not.toContain('~');
  });

  it('refuses ~ and relative paths, and bad ports', () => {
    const base = { node: '/n/bin/node', workingDirectory: '/w', dataDir: '/d', port: 4310, stdoutLog: '/l/o', stderrLog: '/l/e' };
    expect(() => launchAgent({ ...base, dataDir: '~/Library/Application Support/ResearchWorkbench' })).toThrow(/absolute/);
    expect(() => launchAgent({ ...base, workingDirectory: 'ResearchWorkbench/current' })).toThrow(/absolute/);
    expect(() => launchAgent({ ...base, port: 70000 })).toThrow(/port/);
    expect(() => launchAgent(base)).not.toThrow();
  });

  it.skipIf(!has('xmllint'))('is well-formed XML (xmllint)', () => {
    const r = spawnSync('xmllint', ['--noout', '-'], { input: renderPlist(agent), encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it.skipIf(!has('python3'))('is a valid property list (Python plistlib)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plist-'));
    try {
      const file = path.join(dir, 'com.researchworkbench.plist');
      fs.writeFileSync(file, renderPlist(agent));
      const r = spawnSync('python3', ['-I', '-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb")), ensure_ascii=False))', file], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(agent);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!has('plutil'))('passes plutil -lint (macOS)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plist-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.plist'), renderPlist(agent));
      expect(spawnSync('plutil', ['-lint', path.join(dir, 'a.plist')]).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('launchctl and lsof output', () => {
  const printed = [
    'gui/501/com.researchworkbench = {',
    '\tactive count = 1',
    '\tpath = /Users/a/Library/LaunchAgents/com.researchworkbench.plist',
    '\ttype = LaunchAgent',
    '\tstate = running',
    '',
    '\tprogram = /Users/a/ResearchWorkbench/runtime/current/bin/node',
    '\targuments = {',
    '\t\t/Users/a/ResearchWorkbench/runtime/current/bin/node',
    '\t\t--import',
    '\t}',
    '\tenvironment = {',
    '\t\tWORKBENCH_PORT => 4310',
    '\t}',
    '\tevent triggers = {',
    '\t\tstate = 0',
    '\t}',
    '\truns = 3',
    '\tpid = 12345',
    '\tlast exit code = (never exited)',
    '}',
  ].join('\n');

  it('reads the top-level fields of launchctl print', () => {
    expect(parseLaunchctlPrint(printed)).toEqual({
      state: 'running',
      pid: 12345,
      lastExitCode: '(never exited)',
      runs: 3,
      path: '/Users/a/Library/LaunchAgents/com.researchworkbench.plist',
      program: '/Users/a/ResearchWorkbench/runtime/current/bin/node',
    });
    const stopped = parseLaunchctlPrint(printed.replace('state = running', 'state = not running').replace('\tpid = 12345\n', '').replace('(never exited)', '78: EX_CONFIG'));
    expect(stopped).toMatchObject({ state: 'not running', pid: undefined, lastExitCode: '78: EX_CONFIG' });
  });

  it('reads print-disabled in both the old and new spelling', () => {
    expect(parsePrintDisabled('disabled services = {\n\t"com.apple.x" => disabled\n\t"com.researchworkbench" => enabled\n}')).toBe(false);
    expect(parsePrintDisabled('disabled services = {\n\t"com.researchworkbench" => disabled\n}')).toBe(true);
    expect(parsePrintDisabled('disabled services = {\n\t"com.researchworkbench" => true\n}')).toBe(true);
    expect(parsePrintDisabled('disabled services = {\n\t"com.researchworkbenchX" => true\n}')).toBeNull();
  });

  it('reads lsof -F output', () => {
    expect(parseLsof('p123\ncnode\nf21\np456\ncPython\n')).toEqual([
      { pid: 123, command: 'node' },
      { pid: 456, command: 'Python' },
    ]);
    expect(parseLsof('')).toEqual([]);
  });

  it('targets the gui domain of the user', () => {
    expect(serviceTarget(501)).toBe('gui/501/com.researchworkbench');
  });
});
