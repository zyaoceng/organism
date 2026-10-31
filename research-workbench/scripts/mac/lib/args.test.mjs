import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArgsError, HELP, parseInstallArgs } from './args.mjs';

describe('parseInstallArgs', () => {
  it('defaults to a plain install', () => {
    expect(parseInstallArgs([], {})).toEqual({ mode: 'install', dryRun: false, purge: false, importFile: null, port: null, yes: false, sourceDir: null, noLaunchd: false, noRegister: false, obsidian: false, obsidianVault: null, noObsidian: false });
  });

  it('reads every flag', () => {
    const o = parseInstallArgs(['--dry-run', '-y', '--port', '4320', '--import', 'wb.tgz', '--source-dir', '/src/rw', '--no-launchd', '--no-register'], {});
    expect(o).toEqual({ mode: 'install', dryRun: true, purge: false, importFile: path.resolve('wb.tgz'), port: 4320, yes: true, sourceDir: '/src/rw', noLaunchd: true, noRegister: true, obsidian: false, obsidianVault: null, noObsidian: false });
    expect(parseInstallArgs(['--doctor'], {}).mode).toBe('doctor');
    expect(parseInstallArgs(['--uninstall', '--purge'], {})).toMatchObject({ mode: 'uninstall', purge: true });
    expect(parseInstallArgs(['--port=5000'], {}).port).toBe(5000);
    expect(parseInstallArgs(['-h'], {}).mode).toBe('help');
  });

  it('reads the Obsidian flags; the vault becomes an absolute path', () => {
    expect(parseInstallArgs(['--obsidian'], {})).toMatchObject({ obsidian: true, obsidianVault: null, noObsidian: false });
    expect(parseInstallArgs(['--obsidian-vault', 'notes/投資筆記'], {}).obsidianVault).toBe(path.resolve('notes/投資筆記'));
    expect(parseInstallArgs(['--obsidian', '--obsidian-vault=/v'], {})).toMatchObject({ obsidian: true, obsidianVault: '/v' });
    expect(parseInstallArgs(['--no-obsidian', '--yes'], {})).toMatchObject({ noObsidian: true, yes: true });
  });

  it('takes the source folder from WB_SOURCE_DIR unless the flag is given', () => {
    expect(parseInstallArgs([], { WB_SOURCE_DIR: '/ci/research-workbench' }).sourceDir).toBe('/ci/research-workbench');
    expect(parseInstallArgs(['--source-dir', '/x'], { WB_SOURCE_DIR: '/y' }).sourceDir).toBe('/x');
    expect(parseInstallArgs([], { WB_SOURCE_DIR: '' }).sourceDir).toBeNull();
  });

  it('rejects unknown flags and impossible combinations', () => {
    for (const argv of [['--frobnicate'], ['extra'], ['--doctor', '--uninstall'], ['--purge'], ['--doctor', '--dry-run'], ['--port', 'abc'], ['--port', '80'], ['--port', '99999'], ['--uninstall', '--import', 'x.tgz'],
      ['--obsidian', '--no-obsidian'], ['--obsidian-vault', '/v', '--no-obsidian'], ['--obsidian-vault', ''], ['--obsidian-vault'],
      ['--uninstall', '--obsidian'], ['--uninstall', '--obsidian-vault', '/v'], ['--uninstall', '--no-obsidian']]) {
      expect(() => parseInstallArgs(argv, {}), argv.join(' ')).toThrow(ArgsError);
    }
  });

  it('documents every flag in the help', () => {
    for (const f of ['--doctor', '--dry-run', '--uninstall', '--purge', '--import', '--port', '--yes', '--source-dir', '--no-launchd', '--no-register', '--obsidian', '--obsidian-vault', '--no-obsidian']) expect(HELP).toContain(f);
  });
});
