# 投資決策沙盤（回測與情境對比工具）

把「如果我這樣進場、這樣加碼、停損停利放這裡」的每一種想法攤在同一張桌上比較。
三個功能：交易計畫情境對比（含夏普值）、組合風險與穩定度動態計算、共識盈餘×自訂本益比區間的盈利對照。

**用法**：直接開 `index.html`（資料已內嵌，不用伺服器、不用網路）。

## 檔案分工表

| 檔案 | 負責什麼 |
|---|---|
| `index.html` | 互動工具本體（自包含網頁，價格資料已內嵌） |
| `engine/config.py` | 全部固定參數：0.05% 成本、夏普級距、穩定度錨點、風險級距 |
| `engine/data.py` | 讀日線 CSV、清資料源瑕疵（高低價鉗到包含開收盤）、多檔對齊 |
| `engine/simulator.py` | 交易計畫模擬器：九條成交規則的正本（網頁 JS 鏡射同一套） |
| `engine/metrics.py` | 夏普（只給級距）、回檔、波動、相關性、集中度、穩定度 |
| `engine/valuation.py` | 價格＝每股盈餘×本益比 的矩陣計算 |
| `engine/report.py` | 跑一個情境、整理成可比較的結果；「買了就抱」對照組 |
| `explain_trade.py` | 逐筆追蹤器：四階段重播單一計畫並逐筆對帳（驗引擎用） |
| `tests/test_engine.py` | 13 個單元測試，含「改掉未來 K 棒、前半段決定必須一字不差」 |
| `embed_data.py` | 把 `data/*.csv` 重新內嵌進 `index.html`（更新資料後跑一次） |
| `data/*.csv` | 券商真實日線快取（date,open,high,low,close,volume） |

## 成交規則（九條，兩個引擎共用）

1. 逐日往後走，任何決定只用當天和更早的資料（有專門測試擋著）。
2. 進場三種：起點開盤買進／跌到觸發價買／漲到觸發價買；跳空用開盤價成交。
3. 停損停利跳空一樣用開盤價；同日雙觸發預設當作先停損（保守，可切樂觀做敏感度）。
4. 進場當天就觸發出場：停損用 min(進場價, 停損價)、停利用 max(進場價, 停利價)。
5. 交易成本單邊 0.05%。
6. 不開槓桿、現金不得為負：現金不夠的加碼直接跳過並記違規。
7. 股數允許小數。
8. 同一天先出場後進場，釋放的現金當天可用。
9. 期末用最後收盤平倉，標「期末平倉」。

## 跑測試與逐筆追蹤

```bash
cd backtest-tool
python3 -m unittest discover -s tests -v
python3 explain_trade.py --symbol MU --start 2026-01-02 --capital 101000 --plan <計畫.json>
```

計畫 JSON 格式：

```json
{"tranches": [
  {"label": "首筆",  "trigger": "open",        "capital": 40000, "stop_loss": 280, "take_profit": 420},
  {"label": "加碼一", "trigger": "limit_below", "trigger_price": 300, "capital": 30000, "stop_loss": 275},
  {"label": "加碼二", "trigger": "stop_above",  "trigger_price": 340, "capital": 30000, "stop_loss": 320}
]}
```

## 更新資料

用券商行情抓日線存成 `data/<代號>.csv`（date,open,high,low,close,volume、日期升冪），
然後 `python3 embed_data.py`。網頁「說明與假設」分頁也可以臨時貼上自訂 CSV（只存在瀏覽器分頁裡）。

## 誠實解讀（寫死在輸出裡，不是口號）

- 夏普值只給級距，原始數字放括號。
- 進出筆數 < 30 自動加註「統計上幾乎沒有意義，只能當沙盤推演」。
- 「買了就抱」對照組永遠同場展示——輸給它是守紀律的代價，規則的價值在控制回檔。
- 本工具是計算器，不是投資建議。
