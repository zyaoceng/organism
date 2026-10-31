import { describe, expect, it } from 'vitest';
import { MSG_MISSING, asString, launcherScript, osacompileArgs } from './launcher.mjs';

const lines = launcherScript({ port: 4310, logsDir: '~/Library/Logs/ResearchWorkbench' });
const source = lines.join('\n');

describe('asString', () => {
  it('escapes quotes and backslashes for AppleScript', () => {
    expect(asString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
    expect(asString('研究工作台')).toBe('"研究工作台"');
  });
});

describe('launcherScript', () => {
  it('checks health with curl, kickstarts the job, then opens the browser', () => {
    expect(source).toContain('/usr/bin/curl -fs --max-time 2 -o /dev/null http://127.0.0.1:" & wbPort & "/api/health');
    expect(source).toContain('set wbPort to "4310"');
    expect(source).toContain('"/com.researchworkbench"');
    expect(source).toContain('/bin/launchctl kickstart " & quoted form of wbService');
    expect(source).toContain('/usr/bin/open " & quoted form of ("http://127.0.0.1:" & wbPort & "/")');
    expect(source.indexOf('kickstart')).toBeLessThan(source.indexOf('/usr/bin/open'));
  });

  it('explains Login Items in Chinese when the job is missing or switched off', () => {
    expect(MSG_MISSING.join('')).toContain('系統設定 → 一般 → 登入項目與延伸功能');
    expect(source).toContain('with title wbTitle');
    expect(source).toContain('set wbTitle to "研究工作台"');
    expect(source).toContain('~/Library/Logs/ResearchWorkbench');
  });

  it('waits about waitSeconds for the server', () => {
    expect(source).toContain('repeat 40 times');
    expect(launcherScript({ port: 4320, logsDir: '/l', waitSeconds: 5 }).join('\n')).toContain('repeat 10 times');
    expect(launcherScript({ port: 4320, logsDir: '/l' }).join('\n')).toContain('set wbPort to "4320"');
  });

  it('is balanced: handlers, blocks and string quotes', () => {
    const count = (re) => lines.filter((l) => re.test(l.trim())).length;
    expect(count(/^on (run|wbIsUp)\b/)).toBe(count(/^end (run|wbIsUp)$/));
    expect(count(/^try$/)).toBe(count(/^end try$/));
    expect(count(/^repeat\b/)).toBe(count(/^end repeat$/));
    expect(count(/^if .* then$/)).toBe(count(/^end if$/));
    for (const l of lines) expect(l.replace(/\\\\/g, '').replace(/\\"/g, '').split('"').length % 2, l).toBe(1);
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
  });

  it('becomes osacompile -e arguments, one per line', () => {
    const args = osacompileArgs('/Users/a/Applications/研究工作台.app', ['a', 'b']);
    expect(args).toEqual(['-o', '/Users/a/Applications/研究工作台.app', '-e', 'a', '-e', 'b']);
  });
});
