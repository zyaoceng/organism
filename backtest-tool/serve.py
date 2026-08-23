#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本機伺服器：一邊開網頁，一邊幫網頁去 Yahoo 抓資料。

跑法（在 backtest-tool/ 目錄下）：
    python3 serve.py
然後瀏覽器開 http://127.0.0.1:8765/ ——網頁裡就會出現「抓 Yahoo 資料」的欄位，
打代號按一下，資料直接進來，不用自己貼任何東西。

為什麼要這支伺服器：瀏覽器不准網頁去抓別的網站的資料（跨網域限制），
Yahoo 也不是為了被網頁直接呼叫而設計的。這支伺服器和網頁是同一個來源，
由它代為去抓就沒有這個問題。它只聽本機、不對外開放。

端點：
    GET /api/yahoo?symbol=NVDA&years=5&save=1
        save=1 會順便寫進 data/NVDA.csv 並重新內嵌進 index.html（重開也還在）。
        save=0 只回傳資料，這個分頁關掉就沒了。
    GET /api/symbols     現有的代號清單
"""
import argparse
import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import fetch_yahoo          # noqa: E402

_save_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    upstream = fetch_yahoo.DEFAULT_BASE

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def _json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parts = urlparse(self.path)
        if parts.path == "/api/symbols":
            return self._json(200, {"symbols": fetch_yahoo.existing_symbols()})
        if parts.path == "/api/yahoo":
            return self._yahoo(parse_qs(parts.query))
        if parts.path == "/favicon.ico":
            self.send_response(204)          # 瀏覽器會自己來要，回個空的免得畫面出現紅字
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return super().do_GET()

    def _yahoo(self, q):
        symbol = (q.get("symbol") or [""])[0].strip().upper()
        if not symbol:
            return self._json(400, {"error": "沒有給代號"})
        try:
            years = float((q.get("years") or ["5"])[0])
        except ValueError:
            years = 5.0
        years = max(0.1, min(years, 30.0))
        save = (q.get("save") or ["1"])[0] not in ("0", "false", "no")

        try:
            rows, info = fetch_yahoo.fetch_symbol(
                symbol, years=years, base_url=self.upstream)
        except fetch_yahoo.FetchError as e:
            return self._json(502, {"error": str(e), "symbol": symbol})
        except Exception as e:                      # 意外狀況也要回 JSON，別讓網頁看到 500 HTML
            return self._json(500, {"error": f"抓取時發生意外：{e}", "symbol": symbol})

        saved = False
        if save:
            try:
                with _save_lock:                    # 兩個分頁同時按不要打架
                    fetch_yahoo.write_csv(symbol, rows)
                    fetch_yahoo.update_meta(symbol, info)
                    import embed_data
                    import importlib
                    importlib.reload(embed_data)
                    embed_data.main()
                saved = True
            except Exception as e:
                info["save_error"] = f"抓到了但存檔失敗：{e}"

        return self._json(200, {
            "symbol": symbol, "saved": saved,
            "meta": {"name": info["name"], "currency": info["currency"],
                     "source": "Yahoo Finance", "note": "",
                     "fetched": info["fetched_at"], "exchange": info["exchange"],
                     "save_error": info.get("save_error", "")},
            "dropped": info["dropped_rows"],
            "d": [r["date"] for r in rows], "o": [r["open"] for r in rows],
            "h": [r["high"] for r in rows], "l": [r["low"] for r in rows],
            "c": [r["close"] for r in rows],
        })

    def log_message(self, fmt, *args):
        # 基底類別記錯誤時第一個參數是狀態碼不是字串，先安全組成整行再判斷，
        # 否則任何 404（例如瀏覽器自動要 favicon）都會讓這條連線的執行緒掛掉。
        try:
            line = fmt % args
        except Exception:
            line = str(fmt)
        if "/api/" in line:
            sys.stderr.write("  %s\n" % line)


def main(argv=None):
    ap = argparse.ArgumentParser(description="開網頁並代為抓 Yahoo 資料")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--upstream", default=fetch_yahoo.DEFAULT_BASE,
                    help="改抓別的來源（測試用）")
    args = ap.parse_args(argv)

    Handler.upstream = args.upstream
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"網頁開這裡： http://{args.host}:{args.port}/")
    print("按 Ctrl+C 結束。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n結束。")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
