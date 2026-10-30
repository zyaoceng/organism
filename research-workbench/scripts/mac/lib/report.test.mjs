import { describe, expect, it } from 'vitest';
import { layout } from './layout.mjs';
import { displayWidth, finalMessage, formatBytes, formatDoctorReport, formatImportSummary, lastJsonLine, padEnd, summarizeDiagnostics } from './report.mjs';

describe('widths and sizes', () => {
  it('counts CJK as two columns', () => {
    expect(displayWidth('macOS')).toBe(5);
    expect(displayWidth('晶片 / chip')).toBe(11);
    expect(padEnd('健康', 6)).toBe('健康  ');
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(-1)).toBe('?');
  });
});

describe('formatDoctorReport', () => {
  const at = new Date(2026, 9, 30, 19, 5);
  it('prints aligned OK/FAIL lines and a verdict', () => {
    const text = formatDoctorReport(
      [
        { status: 'ok', label: 'macOS', detail: '14.5' },
        { status: 'fail', label: '健康檢查 / health', detail: 'ECONNREFUSED' },
        { status: 'warn', label: '啟動 App / launcher', detail: '~/Applications/研究工作台.app' },
        { status: 'info', label: '記錄 / log', detail: 'server.err.log', lines: ['line 1', 'line 2'] },
      ],
      { now: at },
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('研究工作台 診斷 / Research Workbench doctor   2026-10-30 19:05');
    expect(lines).toContain('[ OK ] macOS                14.5');
    expect(lines).toContain('[FAIL] 健康檢查 / health    ECONNREFUSED');
    expect(lines).toContain('         line 2');
    expect(text).toContain('1 項失敗 FAIL, 1 項警告 WARN');
    // the detail column lines up whatever the label's script
    const col = (l) => displayWidth(l.slice(0, l.lastIndexOf('  ') + 2));
    expect(col(lines[2])).toBe(col(lines[3]));
  });
  it('says all OK when nothing failed', () => {
    expect(formatDoctorReport([{ status: 'ok', label: 'x', detail: 'y' }, { status: 'skip', label: 'launchd' }], { now: at })).toContain('全部正常 / all OK');
  });
});

describe('lastJsonLine', () => {
  it('takes the last JSON object printed', () => {
    expect(lastJsonLine('Imported 2 companies.\n{"projects":[],"attachments":0}\n')).toEqual({ projects: [], attachments: 0 });
    expect(lastJsonLine('{"a":1}\nnot json {\n{"b":2}')).toEqual({ b: 2 });
    expect(lastJsonLine('[1,2]\nnothing')).toBeNull();
    expect(lastJsonLine('')).toBeNull();
  });
});

describe('formatImportSummary', () => {
  // the shape of ImportSummary in src/server/services/dataImport.ts
  const summary = {
    projects: [
      { name: '台積電', ticker: '2330', revisions: 12, lastCommitAt: '2026-09-20T08:00:00.000Z', lastAsOfDate: '2026-09-19', trades: 3, evidence: 7 },
      { name: 'Broadcom', ticker: null, revisions: 0, lastCommitAt: null, lastAsOfDate: null, trades: 0, evidence: 1 },
    ],
    attachments: 5,
    schemaVersion: 1,
    hadWal: true,
  };
  it('totals companies, research updates, trades and attachments in Chinese', () => {
    const text = formatImportSummary(summary, 'wb-data.tgz');
    expect(text).toContain('要匯入的資料 / Data to import（wb-data.tgz）');
    expect(text).toMatch(/公司 \/ companies\s+2/);
    expect(text).toMatch(/研究更新 \/ research updates\s+12/);
    expect(text).toMatch(/交易 \/ trades\s+3/);
    expect(text).toMatch(/附件 \/ attachments\s+5/);
    expect(text).toContain('• 台積電 2330：研究更新 12 筆，最後提交 2026-09-20，交易 3 筆');
    expect(text).toContain('• Broadcom：研究更新 0 筆，交易 0 筆');
    expect(text).toContain('WAL');
  });
  it('falls back to the raw JSON for an unknown shape', () => {
    expect(formatImportSummary({ something: 1 })).toContain('{"something":1}');
  });
});

describe('summarizeDiagnostics', () => {
  it('shows commit, schema and the latest backup', () => {
    const s = summarizeDiagnostics({
      version: { commit: '8dacf8594aed836c1e3e2f662421d6037d6f845e', installedAt: '2026-10-30T10:00:00Z' },
      schemaVersion: 1,
      dataDir: '/Users/a/Library/Application Support/ResearchWorkbench',
      backups: { lastBackupAt: '2026-10-30T11:00:00.000Z', count: 3, dir: '/b', lastError: null },
    });
    expect(s.ok).toBe(true);
    expect(s.detail).toBe('commit 8dacf85，schema v1，最近備份 last backup 2026-10-30T11:00:00.000Z，3 份 / files');
    expect(s.lines).toContain('資料位置 / data: /Users/a/Library/Application Support/ResearchWorkbench');
  });
  it('flags a failing backup', () => {
    const s = summarizeDiagnostics({ backups: { lastBackupAt: null, count: 0, dir: '/b', lastError: 'disk full' } });
    expect(s.ok).toBe(false);
    expect(s.detail).toContain('尚無備份');
    expect(s.lines).toContain('備份錯誤 / backup error: disk full');
  });
});

describe('finalMessage', () => {
  it('explains how to open, where data lives, how to update and run the doctor', () => {
    const L = layout({ home: '/Users/a', platform: 'darwin' });
    const text = finalMessage({ L, port: 4310, launcher: true, launchd: true });
    expect(text).toContain('「研究工作台」');
    expect(text).toContain('Dock');
    expect(text).toContain('http://127.0.0.1:4310/');
    expect(text).toContain('~/Library/Application Support/ResearchWorkbench/backups');
    expect(text).toContain('-- --doctor');
    expect(text).toContain('curl -fsSL https://raw.githubusercontent.com/zyaoceng/organism/claude/vibrant-thompson-s3npyj/research-workbench/scripts/mac/install.sh');
    expect(finalMessage({ L, port: 4320, launcher: false, launchd: false })).toContain('沒有建立背景服務');
  });
});
