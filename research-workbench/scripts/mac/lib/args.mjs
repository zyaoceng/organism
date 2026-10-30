/**
 * Command-line flags of install.mjs (install.sh passes its arguments through unchanged).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ONE_LINER } from './layout.mjs';

export const HELP = `研究工作台 Mac 安裝程式 / Research Workbench Mac installer

  安裝或更新 / install or update:   ${ONE_LINER}
  加上選項 / with options:          ${ONE_LINER} -- --doctor

  --doctor            印出診斷（可截圖回報）/ print diagnostics and exit
  --dry-run           只檢查、不做任何修改 / check and print what would happen, change nothing
  --uninstall         移除背景服務與 App，保留資料 / remove the service and launcher, keep data
  --purge             與 --uninstall 一起用：連資料與記錄一起刪除 / with --uninstall: also delete data and logs
  --import <file>     匯入舊資料（預設 ~/Downloads/wb-data.tgz）/ import a data archive
  --port <n>          使用其他埠（預設 4310，之後會記住）/ serve on another port (remembered)
  --yes, -y           不詢問，使用預設答案 / no prompts, take the default answers
  --source-dir <dir>  從本機資料夾安裝（CI 用；也可設 WB_SOURCE_DIR）/ install from a local checkout
  --no-launchd        不建立背景服務與 App（CI／Linux）/ skip the LaunchAgent and launcher
`;

export class ArgsError extends Error {}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function parseInstallArgs(argv, env = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        'dry-run': { type: 'boolean' },
        doctor: { type: 'boolean' },
        uninstall: { type: 'boolean' },
        purge: { type: 'boolean' },
        import: { type: 'string' },
        port: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        'source-dir': { type: 'string' },
        'no-launchd': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    throw new ArgsError(e.message);
  }
  if (values.help) return { mode: 'help' };
  if (values.doctor && values.uninstall) throw new ArgsError('--doctor and --uninstall cannot be combined');
  if (values.doctor && values['dry-run']) throw new ArgsError('--doctor already changes nothing; drop --dry-run');
  if (values.purge && !values.uninstall) throw new ArgsError('--purge only works together with --uninstall');
  if (values.uninstall && values.import) throw new ArgsError('--import cannot be combined with --uninstall');
  let port = null;
  if (values.port !== undefined) {
    port = /^\d+$/.test(values.port) ? Number(values.port) : NaN;
    if (!(port >= 1024 && port <= 65535)) throw new ArgsError(`--port must be a number between 1024 and 65535, got ${values.port}`);
  }
  const src = values['source-dir'] ?? (env.WB_SOURCE_DIR || undefined);
  return {
    mode: values.doctor ? 'doctor' : values.uninstall ? 'uninstall' : 'install',
    dryRun: !!values['dry-run'],
    purge: !!values.purge,
    importFile: values.import ? path.resolve(values.import) : null,
    port,
    yes: !!values.yes,
    sourceDir: src ? path.resolve(src) : null,
    noLaunchd: !!values['no-launchd'],
  };
}
