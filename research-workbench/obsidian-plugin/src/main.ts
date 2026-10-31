/**
 * Research Workbench Sync: writes the workbench's companies, research updates, trades and AI
 * sessions as notes in this vault and sends the `## 反思` sections back. Nothing runs until the
 * workspace layout is ready and the metadata cache has indexed the vault, because files are found
 * by their frontmatter wb_id. The work itself is in engine.ts.
 */
import { MarkdownView, Modal, Notice, Plugin, debounce, type App } from 'obsidian';
import manifest from '../manifest.json';
import { SyncEngine, conflictText, type ConflictEntry, type EngineStatus, type SyncState } from './engine';
import { HttpServer } from './httpServer';
import { ObsidianVault } from './obsidianVault';
import { DEFAULT_STATE, type PersistedState } from './ports';
import { DEFAULTS, SyncSettingTab, normalizeSettings, type PluginData, type SyncSettings } from './settings';

/** A save while a write is still settling waits this long after the last change. */
const MODIFY_DEBOUNCE_MS = 35_000;

class ConflictModal extends Modal {
  constructor(
    app: App,
    private readonly conflicts: ConflictEntry[],
  ) {
    super(app);
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '同步衝突' });
    if (!this.conflicts.length) {
      contentEl.createEl('p', { text: '沒有衝突。' });
      return;
    }
    contentEl.createEl('p', {
      text: '這些筆記沒有被更新，你寫的內容都還在。修正後下次同步會自動更新；自動產生區被改過的話，可以在筆記裡執行「重建目前筆記的自動產生區」。',
    });
    for (const c of this.conflicts) {
      const row = contentEl.createDiv();
      row.createEl('strong', { text: c.title });
      row.createEl('div', { text: conflictText(c.reason) });
      for (const p of c.paths) {
        const line = row.createDiv();
        line.createSpan({ text: `${p} ` });
        const btn = line.createEl('button', { text: '開啟' });
        btn.onclick = () => {
          void this.app.workspace.openLinkText(p, '', true);
          this.close();
        };
      }
    }
  }

  override onClose() {
    this.contentEl.empty();
  }
}

export default class ResearchWorkbenchSync extends Plugin {
  override settings: SyncSettings = { ...DEFAULTS };
  private syncState: PersistedState = { ...DEFAULT_STATE };
  private vaultPort!: ObsidianVault;
  private engine!: SyncEngine;
  private statusEl!: HTMLElement;
  private lastState: SyncState | null = null;

  override async onload() {
    const loaded: unknown = await this.loadData();
    const data = (loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {}) as Partial<PluginData>;
    const { state, ...settings } = data;
    this.settings = normalizeSettings(settings);
    this.syncState = { ...DEFAULT_STATE, ...(state ?? {}) };

    this.vaultPort = new ObsidianVault(this.app);
    this.engine = new SyncEngine({
      vault: this.vaultPort,
      server: new HttpServer(() => this.settings),
      rootFolder: () => this.settings.rootFolder,
      state: this.syncState,
      save: async (s) => {
        this.syncState = s;
        await this.persist();
      },
      pluginVersion: manifest.version,
      vaultName: this.app.vault.getName(),
      onStatus: (s) => this.onStatus(s),
    });

    this.addSettingTab(
      new SyncSettingTab(this.app, this, {
        settings: this.settings,
        saveSettings: () => this.persist(),
        testConnection: () => this.testConnection(),
        syncNow: () => this.syncNow(),
        showConflicts: () => this.showConflicts(),
        status: () => this.engine.getStatus(),
      }),
    );
    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText('研究工作台：等待中');

    this.registerEvent(
      this.app.metadataCache.on('resolved', () => {
        this.vaultPort.markResolved();
        if (this.engine.getStatus().state === 'waiting-index') void this.engine.runOnce();
      }),
    );

    this.addCommand({ id: 'sync-now', name: '立即同步', callback: () => void this.syncNow() });
    this.addCommand({ id: 'rebuild-current-note', name: '重建目前筆記的自動產生區', callback: () => void this.rebuildCurrent() });
    this.addCommand({ id: 'show-conflicts', name: '顯示同步衝突', callback: () => this.showConflicts() });
    this.addCommand({ id: 'recreate-deleted', name: '重新建立被刪除的筆記', callback: () => void this.recreateDeleted() });

    this.app.workspace.onLayoutReady(() => {
      void this.engine.runOnce();
      const every = normalizeSettings({ ...this.settings }).intervalSec * 1000;
      this.registerInterval(window.setInterval(() => void this.engine.runOnce(), every));
      // a saved edit (a new reflection) is picked up once the file has been quiet for a while
      const soon = debounce(() => void this.engine.runOnce(), MODIFY_DEBOUNCE_MS, true);
      this.register(() => soon.cancel());
      this.registerEvent(this.app.vault.on('modify', () => soon()));
    });
  }

  override onunload() {
    this.engine?.stop();
  }

  private async persist() {
    const data: PluginData = { ...this.settings, state: this.syncState };
    await this.saveData(data);
  }

  private onStatus(s: EngineStatus) {
    this.statusEl?.setText(statusBarText(s));
    // a notice only when it changes into a state the user has to act on
    if (s.state !== this.lastState && (s.state === 'auth' || s.state === 'outdated')) {
      new Notice(s.state === 'auth' ? `研究工作台：權杖不正確（${s.message ?? ''}）` : '研究工作台：外掛版本太舊，請從研究工作台的設定頁重新下載');
    }
    if (s.state !== 'syncing') this.lastState = s.state;
  }

  private async syncNow() {
    const s = await this.engine.runOnce();
    new Notice(`研究工作台：${statusBarText(s).replace(/^研究工作台：/, '')}`);
  }

  private async testConnection() {
    const r = await new HttpServer(() => this.settings).ping();
    if (r.ok) new Notice(`研究工作台：連線成功（第 ${r.value.latestSeq} 筆變更）`);
    else new Notice(`研究工作台：連線失敗（${r.message}）`);
  }

  private showConflicts() {
    new ConflictModal(this.app, this.engine.getStatus().conflicts).open();
  }

  private async rebuildCurrent() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!file) return void new Notice('研究工作台：請先開啟一則筆記');
    // anything typed but not yet saved goes to disk first, so the rebuild works on it
    if (view) await view.save();
    const r = await this.engine.rebuild(file.path);
    new Notice(`研究工作台：${r.message}`);
  }

  private async recreateDeleted() {
    const n = await this.engine.recreateDeleted();
    new Notice(n ? `研究工作台：將重新建立 ${n} 則被刪除的筆記` : '研究工作台：沒有被刪除的筆記');
    if (n) await this.engine.runOnce();
  }
}

function statusBarText(s: EngineStatus): string {
  const conflicts = s.conflicts.length ? ` · ${s.conflicts.length} 個衝突` : '';
  switch (s.state) {
    case 'synced': {
      const d = new Date(s.lastSyncAt ?? Date.now());
      return `研究工作台：已同步 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${conflicts}`;
    }
    case 'syncing':
      return `研究工作台：同步中…${conflicts}`;
    case 'waiting-index':
      return '研究工作台：等待 Obsidian 建立索引';
    case 'offline':
      return '研究工作台：離線';
    case 'auth':
      return '研究工作台：權杖不正確';
    case 'outdated':
      return '研究工作台：需要更新外掛';
    case 'error':
      return `研究工作台：錯誤（${s.message ?? ''}）`;
    case 'stopped':
      return '研究工作台：已停止';
    default:
      return '研究工作台：等待中';
  }
}
