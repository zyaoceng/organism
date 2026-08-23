#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""從 Yahoo Finance 抓日線，寫成 data/<代號>.csv，順便重新內嵌進 index.html。

用法（在 backtest-tool/ 目錄下）：
    python3 fetch_yahoo.py NVDA AMD          # 抓這幾檔，預設五年
    python3 fetch_yahoo.py 2330.TW           # 台股上市加 .TW、上櫃加 .TWO
    python3 fetch_yahoo.py --update          # 把 data/ 裡已有的全部更新到最新
    python3 fetch_yahoo.py MU --years 10     # 指定年數
    python3 fetch_yahoo.py MU --no-embed     # 只寫 CSV，不動 index.html

抓完就能用：index.html 的標的選單會自動出現新代號。

幾個講清楚的取捨：
- 用 Yahoo 的 chart 端點，取「還原過分割、沒還原股利」的開高低收。
  這和券商給的日線同一種口徑，也和回測引擎的假設一致（引擎不計股利）。
- 日期用交易所自己的時區換算。Yahoo 給的時間戳是開盤時刻的 UTC 秒數，
  直接用 UTC 轉會讓亞洲市場整批差一天。
- 開高低收任一個是空值的那天（停牌、資料缺漏）整列丟掉，並回報丟了幾天。
- 高低價鉗到至少包含開收盤，與 engine/data.py 同一個清洗規則。
"""
import argparse
import csv
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
META_PATH = os.path.join(DATA_DIR, "_meta.json")

DEFAULT_BASE = "https://query1.finance.yahoo.com"
# Yahoo 對沒帶瀏覽器標頭的請求會回 429 或 403，這行是必要的。
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")


class FetchError(Exception):
    pass


def _http_error_text(e):
    """把 HTTP 錯誤變成一句看得懂的話，不要把整頁 HTML 吐出來。"""
    detail = ""
    try:
        raw = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(raw)
            err = ((j.get("finance") or j.get("chart") or {}).get("error")) or {}
            detail = err.get("description") or err.get("code") or ""
        except ValueError:
            pass
    except Exception:
        pass
    if e.code == 404:
        return f"HTTP 404：查無此代號{'（' + detail + '）' if detail else ''}"
    if e.code == 429:
        return "HTTP 429：Yahoo 限流，等幾分鐘再試"
    if e.code in (401, 403):
        return f"HTTP {e.code}：Yahoo 拒絕這個請求{'（' + detail + '）' if detail else ''}"
    return f"HTTP {e.code}：{detail or e.reason}"


def _http_get(url, timeout=30, retries=3):
    """抓網址，回傳解析好的 JSON。429 與 5xx 會退避重試。"""
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = FetchError(_http_error_text(e))
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                wait = 2 ** attempt
                print(f"    （{e.code}，{wait} 秒後重試）", file=sys.stderr)
                time.sleep(wait)
                continue
            raise last
        except (urllib.error.URLError, ssl.SSLError, TimeoutError) as e:
            last = FetchError(f"連線失敗：{e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise last
    raise last or FetchError("未知錯誤")


def _local_date(ts, tzname, gmtoffset):
    """把 Yahoo 的 UTC 秒數換成交易所當地日期（YYYY-MM-DD）。"""
    if tzname:
        try:
            from zoneinfo import ZoneInfo
            return datetime.fromtimestamp(ts, ZoneInfo(tzname)).strftime("%Y-%m-%d")
        except Exception:
            pass   # 系統沒有時區資料庫就退回用固定時差
    return datetime.fromtimestamp(ts + (gmtoffset or 0), timezone.utc).strftime("%Y-%m-%d")


def fetch_symbol(symbol, years=5, base_url=DEFAULT_BASE, timeout=30):
    """抓一檔的日線。回傳 (rows, meta)。rows 是 dict 串列、日期升冪。"""
    now = int(time.time())
    p1 = int((datetime.now(timezone.utc) - timedelta(days=int(years * 366))).timestamp())
    url = (f"{base_url}/v8/finance/chart/{urllib.parse.quote(symbol)}"
           f"?period1={p1}&period2={now}&interval=1d&events=split&includePrePost=false")
    payload = _http_get(url, timeout=timeout)

    chart = (payload or {}).get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        raise FetchError(f"{err.get('code', '')}：{err.get('description', err)}")
    results = chart.get("result") or []
    if not results:
        raise FetchError("回應裡沒有資料——代號可能打錯了")
    r = results[0]
    meta = r.get("meta") or {}
    stamps = r.get("timestamp") or []
    quote = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    if not stamps or not quote.get("close"):
        raise FetchError("這個代號抓不到日線（可能已下市，或代號要加交易所後綴）")

    tzname = meta.get("exchangeTimezoneName")
    gmtoff = meta.get("gmtoffset")
    o, h, l, c = (quote.get("open") or [], quote.get("high") or [],
                  quote.get("low") or [], quote.get("close") or [])
    v = quote.get("volume") or []

    rows, dropped, seen = [], 0, {}
    for i, ts in enumerate(stamps):
        vals = [o[i] if i < len(o) else None, h[i] if i < len(h) else None,
                l[i] if i < len(l) else None, c[i] if i < len(c) else None]
        if any(x is None for x in vals):
            dropped += 1
            continue
        oo, hh, ll, cc = (float(x) for x in vals)
        if oo <= 0 or cc <= 0:
            dropped += 1
            continue
        vol = v[i] if i < len(v) and v[i] is not None else 0
        d = _local_date(ts, tzname, gmtoff)
        # 同一天出現兩筆（Yahoo 偶爾把最新盤中價另外附一列）：後者覆蓋前者。
        seen[d] = {"date": d, "open": oo,
                   "high": max(hh, oo, cc), "low": min(ll, oo, cc),
                   "close": cc, "volume": float(vol)}
    rows = [seen[d] for d in sorted(seen)]
    if len(rows) < 2:
        raise FetchError(f"只抓到 {len(rows)} 天，資料不夠用")

    info = {
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "currency": meta.get("currency") or "?",
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        "timezone": tzname or "",
        "source": "Yahoo Finance",
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "dropped_rows": dropped,
    }
    return rows, info


def write_csv(symbol, rows, data_dir=DATA_DIR):
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, f"{symbol}.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "open", "high", "low", "close", "volume"])
        for r in rows:
            w.writerow([r["date"], repr(r["open"]), repr(r["high"]),
                        repr(r["low"]), repr(r["close"]), repr(r["volume"])])
    return path


def update_meta(symbol, info, meta_path=META_PATH):
    store = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as f:
                store = json.load(f)
        except Exception:
            store = {}
    store[symbol] = info
    os.makedirs(os.path.dirname(meta_path), exist_ok=True)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2, sort_keys=True)
    return store


def existing_symbols(data_dir=DATA_DIR):
    if not os.path.isdir(data_dir):
        return []
    return sorted(fn[:-4] for fn in os.listdir(data_dir)
                  if fn.endswith(".csv") and not fn.startswith("_"))


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="從 Yahoo Finance 抓日線並更新這個工具的資料")
    ap.add_argument("symbols", nargs="*", help="股票代號，例如 NVDA 2330.TW")
    ap.add_argument("--update", action="store_true",
                    help="更新 data/ 裡已有的全部代號")
    ap.add_argument("--years", type=float, default=5, help="要抓幾年（預設 5）")
    ap.add_argument("--no-embed", action="store_true",
                    help="只寫 CSV，不重新內嵌進 index.html")
    ap.add_argument("--base-url", default=DEFAULT_BASE, help="改抓別的來源（測試用）")
    ap.add_argument("--data-dir", default=DATA_DIR)
    args = ap.parse_args(argv)

    syms = list(dict.fromkeys(args.symbols))
    if args.update:
        syms = list(dict.fromkeys(syms + existing_symbols(args.data_dir)))
    if not syms:
        ap.error("請給至少一個代號，或用 --update 更新現有的")

    ok, failed = [], []
    for i, sym in enumerate(syms):
        print(f"抓 {sym} …", end=" ", flush=True)
        try:
            rows, info = fetch_symbol(sym, years=args.years, base_url=args.base_url)
        except FetchError as e:
            print(f"失敗：{e}")
            failed.append((sym, str(e)))
            continue
        write_csv(sym, rows, args.data_dir)
        update_meta(sym, info, os.path.join(args.data_dir, "_meta.json"))
        extra = f"，丟掉 {info['dropped_rows']} 天空值" if info["dropped_rows"] else ""
        print(f"{len(rows)} 天（{rows[0]['date']} ～ {rows[-1]['date']}），"
              f"{info['currency']}{extra}")
        ok.append(sym)
        if i < len(syms) - 1:
            time.sleep(0.6)      # 對 Yahoo 客氣一點，免得被限流

    if ok and not args.no_embed:
        print()
        sys.path.insert(0, HERE)
        import embed_data
        embed_data.main()

    if failed:
        print("\n以下沒抓到：", file=sys.stderr)
        for sym, why in failed:
            print(f"  {sym}：{why}", file=sys.stderr)
        print("  台股上市要加 .TW、上櫃加 .TWO；指數要加 ^（例如 ^GSPC）。", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
