/**
 * The plugin's settings tab. data.json holds these settings plus the sync state (`state`); the
 * workbench's plugin.zip ships a data.json with the server URL and the token already filled in.
 */
import { PluginSettingTab, Setting, type App } from 'obsidian';
import type { EngineStatus } from './engine';
import { DEFAULTS, MIN_INTERVAL_SEC, type SyncSettings } from './config';
import type { PersistedState } from './ports';

export { DEFAULTS, MIN_INTERVAL_SEC, normalizeSettings, type SyncSettings } from './config';

export interface PluginData extends SyncSettings {
  state?: PersistedState;
}

/** What the tab needs from the plugin (main.ts), so this file does not import it. */
export interface SettingsHost {
  settings: SyncSettings;
  saveSettings(): Promise<void>;
  testConnection(): Promise<void>;
  syncNow(): Promise<void>;
  showConflicts(): void;
  status(): EngineStatus;
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function statusLine(s: EngineStatus): string {
  const parts = [s.lastSyncAt ? `上次同步 ${hhmm(s.lastSyncAt)}` : '尚未同步'];
  parts.push(`待處理 ${s.pending}`, `衝突 ${s.conflicts.length}`);
  if (s.message) parts.push(s.message);
  return parts.join(' · ');
}

export class SyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: ConstructorParameters<typeof PluginSettingTab>[1],
    private readonly host: SettingsHost,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    const h = this.host;
    containerEl.empty();
    new Setting(containerEl).setName('研究工作台網址').setDesc('本機研究工作台的位址').addText((t) =>
      t
        .setPlaceholder(DEFAULTS.serverUrl)
        .setValue(h.settings.serverUrl)
        .onChange(async (v) => {
          h.settings.serverUrl = v.trim() || DEFAULTS.serverUrl;
          await h.saveSettings();
        }),
    );
    new Setting(containerEl).setName('權杖').setDesc('研究工作台設定頁「Obsidian」區塊下載的外掛已經填好').addText((t) => {
      t.inputEl.type = 'password';
      t.setValue(h.settings.token).onChange(async (v) => {
        h.settings.token = v.trim();
        await h.saveSettings();
      });
    });
    new Setting(containerEl).setName('筆記資料夾').setDesc('新筆記建立在這個資料夾下；已存在的筆記依 wb_id 找到，可以自由搬移').addText((t) =>
      t.setValue(h.settings.rootFolder).onChange(async (v) => {
        h.settings.rootFolder = v.trim().replace(/^\/+|\/+$/g, '');
        await h.saveSettings();
      }),
    );
    new Setting(containerEl).setName('同步間隔（秒）').setDesc(`最少 ${MIN_INTERVAL_SEC} 秒；重新啟動 Obsidian 後生效`).addText((t) =>
      t.setValue(String(h.settings.intervalSec)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n)) {
          h.settings.intervalSec = Math.max(MIN_INTERVAL_SEC, Math.round(n));
          await h.saveSettings();
        }
      }),
    );
    const status = new Setting(containerEl).setName('狀態').setDesc(statusLine(h.status()));
    new Setting(containerEl)
      .addButton((b) => b.setButtonText('測試連線').onClick(() => void h.testConnection()))
      .addButton((b) =>
        b
          .setButtonText('立即同步')
          .setCta()
          .onClick(async () => {
            await h.syncNow();
            status.setDesc(statusLine(h.status()));
          }),
      )
      .addButton((b) => b.setButtonText('顯示衝突').onClick(() => h.showConflicts()));
  }
}
