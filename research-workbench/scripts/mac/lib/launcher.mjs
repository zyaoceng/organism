/**
 * AppleScript source of ~/Applications/研究工作台.app, the thing the user clicks. It opens the browser
 * when /api/health answers; otherwise it kickstarts the LaunchAgent and waits, and explains in Chinese
 * what to do when the job is missing or switched off in Login Items.
 *
 * Returned as lines so install.mjs can pass each as `osacompile -e <line>` (argv is always read as
 * UTF-8, unlike a source file).
 */
import { APP_NAME, LABEL, ONE_LINER } from './layout.mjs';

/** An AppleScript string literal. */
export const asString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Paragraphs joined by blank lines, as an AppleScript expression. */
const paragraphs = (ps) => ps.map(asString).join(' & return & return & ');

export const MSG_MISSING = [
  '研究工作台的背景服務沒有載入，可能在登入項目裡被關閉了。',
  '請到「系統設定 → 一般 → 登入項目與延伸功能」，在「允許在背景執行」打開「node」（或 ResearchWorkbench），再點一次研究工作台。',
  `若仍然不行，請在「終端機」重新貼上安裝指令：${ONE_LINER}`,
];

export function msgTimeout(seconds, logsDir) {
  return [
    `研究工作台的背景服務已經啟動，但 ${seconds} 秒內沒有回應。`,
    '請稍等一下再點一次。若一直如此，請重新貼上安裝指令，或在指令最後加上「 -- --doctor」執行診斷並截圖。',
    `記錄檔在：${logsDir}`,
  ];
}

/** @param {{ port: number, logsDir: string, waitSeconds?: number }} o */
export function launcherScript({ port, logsDir, waitSeconds = 20 }) {
  const tries = Math.max(1, Math.round(waitSeconds * 2));
  return [
    'on wbIsUp(wbPort)',
    '\ttry',
    '\t\tdo shell script "/usr/bin/curl -fs --max-time 2 -o /dev/null http://127.0.0.1:" & wbPort & "/api/health"',
    '\t\treturn true',
    '\ton error',
    '\t\treturn false',
    '\tend try',
    'end wbIsUp',
    '',
    'on run',
    `\tset wbPort to ${asString(String(port))}`,
    `\tset wbTitle to ${asString(APP_NAME)}`,
    '\tif not wbIsUp(wbPort) then',
    `\t\tset wbService to "gui/" & (do shell script "/usr/bin/id -u") & ${asString(`/${LABEL}`)}`,
    '\t\ttry',
    '\t\t\tdo shell script "/bin/launchctl kickstart " & quoted form of wbService',
    '\t\ton error',
    `\t\t\tdisplay dialog (${paragraphs(MSG_MISSING)}) with title wbTitle buttons {"好"} default button 1 with icon caution`,
    '\t\t\treturn',
    '\t\tend try',
    `\t\trepeat ${tries} times`,
    '\t\t\tif wbIsUp(wbPort) then exit repeat',
    '\t\t\tdelay 0.5',
    '\t\tend repeat',
    '\t\tif not wbIsUp(wbPort) then',
    `\t\t\tdisplay dialog (${paragraphs(msgTimeout(waitSeconds, logsDir))}) with title wbTitle buttons {"好"} default button 1 with icon caution`,
    '\t\t\treturn',
    '\t\tend if',
    '\tend if',
    '\tdo shell script "/usr/bin/open " & quoted form of ("http://127.0.0.1:" & wbPort & "/")',
    'end run',
  ];
}

/** `osacompile` arguments that build the app at `appPath` from the script lines. */
export const osacompileArgs = (appPath, lines) => ['-o', appPath, ...lines.flatMap((l) => ['-e', l])];
