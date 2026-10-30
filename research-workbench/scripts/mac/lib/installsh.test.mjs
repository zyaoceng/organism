/**
 * install.sh is plain bash, so these tests read it as text: the pieces that must agree with the Node
 * side (lib file list, checksums) and the structure that keeps a partial download from running.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NODE_RELEASES } from './system.mjs';

const shPath = new URL('../install.sh', import.meta.url);
const sh = fs.readFileSync(shPath, 'utf8');
const libDir = new URL('./', import.meta.url);

describe('install.sh', () => {
  it('downloads every helper install.mjs imports', () => {
    const listed = /^\s*LIB_FILES="([^"]+)"/m.exec(sh)[1].split(/\s+/).sort();
    const present = fs.readdirSync(libDir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).sort();
    expect(listed).toEqual(present);
    const imported = [...fs.readFileSync(new URL('../install.mjs', import.meta.url), 'utf8').matchAll(/from '\.\/lib\/([\w-]+\.mjs)'/g)].map((m) => m[1]);
    for (const f of imported) expect(listed).toContain(f);
  });

  it('braces every variable that is followed by non-ASCII text', () => {
    // macOS bash 3.2 reads the bytes of "，" or "（" as part of the variable name ("MACVER…: unbound variable").
    const bad = sh.split('\n').filter((line) => /\$[A-Za-z_]\w*[^\x00-\x7F]/.test(line));
    expect(bad).toEqual([]);
  });

  it('embeds the same Node checksums as lib/system.mjs', () => {
    const embedded = {};
    for (const m of sh.matchAll(/^\s*([\d.]+)-(darwin|linux)-(arm64|x64)\) NODE_SHA=([0-9a-f]{64}) ;;$/gm)) {
      (embedded[m[1]] ??= {})[`${m[2]}-${m[3]}`] = m[4];
    }
    expect(embedded).toEqual(NODE_RELEASES);
  });

  it('runs nothing until the last lines call main', () => {
    const code = sh.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(code[0]).toBe('main() {');
    const end = code.lastIndexOf('}');
    expect(code.slice(end + 1).join('\n')).toBe('case "$0" in\n  --?*) main "$0" ${1+"$@"} ;;\n  *) main ${1+"$@"} ;;\nesac');
  });

  it('reads prompts from /dev/tty only (stdin may be the piped script)', () => {
    const code = sh.split('\n').map((l) => l.replace(/"(\\.|[^"\\])*"|'[^']*'/g, '""').replace(/#.*$/, ''));
    for (const l of code.filter((x) => /(^|[\s;&|(])read\s/.test(x))) expect(l).toMatch(/<\s*\/dev\/tty/);
  });

  it('avoids bash 4 features (macOS ships bash 3.2)', () => {
    for (const re of [/declare -A/, /\bmapfile\b/, /\breadarray\b/, /\$\{\w+,,\}/, /\$\{\w+\^\^\}/, /\[\[ -v /, /&>>/, /\|&/, /\bcoproc\b/]) expect(sh).not.toMatch(re);
  });

  it('is valid bash and prints help without downloading anything', () => {
    expect(spawnSync('bash', ['-n', shPath.pathname]).status).toBe(0);
    const r = spawnSync('bash', [shPath.pathname, '--help'], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('--doctor');
  });

  it.skipIf(process.platform === 'linux' && process.arch !== 'x64')('refuses a pending release before downloading the installer', () => {
    const r = spawnSync('bash', ['-c', `${sh.replace(/\ncase "\$0" in[\s\S]*$/, '')}\nmain`], { encoding: 'utf8', env: { ...process.env, WB_NODE: process.execPath, WB_RELEASE_COMMIT: 'pending', HOME: '/tmp' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pending');
  });
});
