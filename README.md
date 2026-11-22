# 有機體｜研究報告集

祖曜筬的個股研究，以及台大控股同學間定期線上交流會的講義與產業研究存檔。

**線上閱讀：https://zyaoceng.github.io/organism/**

一個主題一個資料夾，命名「編號_主題」；編號只是主題代號，實際日期看檔名。

| 編號 | 主題 | 日期 | 內容 |
|---|---|---|---|
| 01 | 功率半導體 | 2026-07-11 | 社團投影版、講者完整版、進階 QA 四題 |
| 02 | ASIC | 2026-07-19 | 產業講解投影片（PDF／PPTX）、主講者講稿 |
| 03 | 光通訊 | 2026-07-25 → 07-31 | 產業深度報告 PDF、對內完整版 v1／v2、故事線 |
| 04 | 記憶體 | 2026-08-15 → 08-16 | 社團版兩版 |
| 05 | 800VDC | 2026-08-16 → 08-20 | 社團版、第二批個股、對內報告、七檔採信度盤 |
| 06 | IC 載板 | 2026-07 | 四雄解析 PDF |
| 07 | CPU | 2026-08-08 | 五家解析 PDF |
| 08 | 資料中心散熱 | 2026-07 | 主題投資投影片 PDF |
| 09 | AVGO 博通 | 2026-08-22 | 個股研究報告 PDF |

## 網站架構

| 分頁 | 路徑 | 內容 | 文章清單 |
|---|---|---|---|
| Home | `index.html` | 兩個入口 | — |
| Research | `research/` | 祖曜筬個人的 Deep／Preview／Review | `research/reports.json` |
| 台大控股 | `ntu/` | 讀書會的產業研究與講義（上表九個主題） | `reports.js` |
| Tools | `tools/` | 小工具 | — |

共用樣式與程式在 `assets/`（`site.css`、`site.js`、文章頁的 `article.css`）。

## 發一篇個人文章

```
pip install markdown
python3 scripts/publish.py --type deep --ticker CRWD --name CrowdStrike \
    --title "文章標題" --date 2026-11-23 --source 文章.md
git add research && git commit -m "發文：CRWD Deep" && git push
```

- `--type` 是 deep、preview 或 review；`--source` 可以是 Obsidian 的 .md（圖片會一起複製）或排好版的 .html。
- 文章存到 `research/<代號>/<日期>-<類型>.html`，清單自動更新；同一篇重跑會覆蓋。
- `research/reports.js` 由腳本產生，不要手改；要改標題或刪文章，改 `research/reports.json` 後重跑任一篇，或直接請 Claude 處理。

## 台大控股的文章

在 `reports.js` 的 REPORTS 最上面加一行（類型、日期、標題、標的、檔案路徑）。檔案仍放在根目錄的主題資料夾，舊連結不變。

`800vdc/`、`memory-2026-08/` 與根目錄的三個功率半導體檔案是早期上傳的舊路徑，內容與對應主題資料夾相同，保留給已分享出去的連結。

研究與判斷：祖曜筬。本站為內部研究紀錄與教材，非投資建議。
