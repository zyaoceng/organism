# -*- coding: utf-8 -*-
"""fetch_yahoo.py 的測試。不連外網——起一個假的 Yahoo 伺服器在本機，
把真實回應的結構（含空值、亞洲時區、錯誤回應、429）重放一遍。
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fetch_yahoo
from fetch_yahoo import FetchError, fetch_symbol, write_csv


def chart_payload(symbol, stamps, o, h, l, c, v,
                  tzname="America/New_York", gmtoffset=-14400,
                  currency="USD", name="Test Corp"):
    return {"chart": {"error": None, "result": [{
        "meta": {"symbol": symbol, "currency": currency, "longName": name,
                 "exchangeTimezoneName": tzname, "gmtoffset": gmtoffset,
                 "fullExchangeName": "TestEx"},
        "timestamp": stamps,
        "indicators": {"quote": [{"open": o, "high": h, "low": l,
                                  "close": c, "volume": v}]}}]}}


# 2026-01-02 09:30 紐約（UTC-5）＝ 1767364200；每天加 86400。
NY_OPEN = 1767364200
# 2026-01-02 09:00 台北（UTC+8）＝ 1767315600。用 UTC 轉會變成 1/1，是這個測試的重點。
TPE_OPEN = 1767315600


class FakeYahoo(BaseHTTPRequestHandler):
    routes = {}
    hits = {}

    def do_GET(self):
        sym = self.path.split("/chart/")[1].split("?")[0]
        FakeYahoo.hits[sym] = FakeYahoo.hits.get(sym, 0) + 1
        entry = FakeYahoo.routes.get(sym)
        if entry is None:
            self.send_error(404, "Not Found")
            return
        status, body = entry
        if callable(body):
            status, body = body(FakeYahoo.hits[sym])
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


class TestFetchYahoo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), FakeYahoo)
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"
        cls.t = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.t.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        FakeYahoo.routes = {}
        FakeYahoo.hits = {}
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_01_basic_parse_and_dates(self):
        """基本解析：日期、開高低收、成交量都對得上。"""
        st = [NY_OPEN, NY_OPEN + 86400, NY_OPEN + 2 * 86400]
        FakeYahoo.routes["MU"] = (200, chart_payload(
            "MU", st, [100, 101, 102], [105, 106, 107], [99, 100, 101],
            [104, 105, 106], [1e6, 2e6, 3e6]))
        rows, info = fetch_symbol("MU", base_url=self.base)
        self.assertEqual([r["date"] for r in rows],
                         ["2026-01-02", "2026-01-03", "2026-01-04"])
        self.assertEqual(rows[0]["open"], 100.0)
        self.assertEqual(rows[2]["close"], 106.0)
        self.assertEqual(rows[1]["volume"], 2e6)
        self.assertEqual(info["currency"], "USD")
        self.assertEqual(info["name"], "Test Corp")

    def test_02_asia_timezone_not_shifted_a_day(self):
        """台北時間 09:00 開盤，用 UTC 直接轉會少一天——必須用交易所時區。"""
        FakeYahoo.routes["2330.TW"] = (200, chart_payload(
            "2330.TW", [TPE_OPEN, TPE_OPEN + 86400], [1000, 1010], [1020, 1030],
            [990, 1000], [1015, 1025], [1e7, 1e7],
            tzname="Asia/Taipei", gmtoffset=28800, currency="TWD", name="台積電"))
        rows, info = fetch_symbol("2330.TW", base_url=self.base)
        self.assertEqual([r["date"] for r in rows], ["2026-01-02", "2026-01-03"])
        self.assertEqual(info["currency"], "TWD")

    def test_03_null_rows_dropped_and_counted(self):
        """停牌日的空值整列丟掉，並回報丟了幾天。"""
        st = [NY_OPEN + i * 86400 for i in range(4)]
        FakeYahoo.routes["X"] = (200, chart_payload(
            "X", st, [100, None, 102, 103], [105, None, 107, 108],
            [99, None, 101, 102], [104, None, 106, None], [1, 2, 3, 4]))
        rows, info = fetch_symbol("X", base_url=self.base)
        self.assertEqual(len(rows), 2)
        self.assertEqual(info["dropped_rows"], 2)
        self.assertEqual([r["date"] for r in rows], ["2026-01-02", "2026-01-04"])

    def test_04_high_low_clamped_like_engine(self):
        """高低價鉗到包含開收盤，和 engine/data.py 同一個規則。"""
        FakeYahoo.routes["Y"] = (200, chart_payload(
            "Y", [NY_OPEN, NY_OPEN + 86400], [100, 100], [99, 100], [101, 100],
            [102, 100], [1, 1]))          # 第一根的高低價顛倒
        rows, _ = fetch_symbol("Y", base_url=self.base)
        r = rows[0]
        self.assertEqual(r["high"], 102.0)   # max(99, 100, 102)
        self.assertEqual(r["low"], 100.0)    # min(101, 100, 102)
        self.assertGreaterEqual(r["high"], max(r["open"], r["close"]))
        self.assertLessEqual(r["low"], min(r["open"], r["close"]))

    def test_05_duplicate_day_last_wins(self):
        """同一天兩筆（Yahoo 偶爾附盤中價）只留後面那筆，日期不重複。"""
        FakeYahoo.routes["D"] = (200, chart_payload(
            "D", [NY_OPEN, NY_OPEN + 3600, NY_OPEN + 86400],
            [100, 100, 110], [105, 108, 115], [99, 99, 109],
            [104, 107, 114], [1, 2, 3]))
        rows, _ = fetch_symbol("D", base_url=self.base)
        self.assertEqual([r["date"] for r in rows], ["2026-01-02", "2026-01-03"])
        self.assertEqual(rows[0]["close"], 107.0)

    def test_06_bad_symbol_raises_clear_error(self):
        """代號打錯要給看得懂的錯誤，不是丟出堆疊。"""
        FakeYahoo.routes["NOPE"] = (200, {"chart": {"result": None, "error": {
            "code": "Not Found", "description": "No data found, symbol may be delisted"}}})
        with self.assertRaises(FetchError) as cm:
            fetch_symbol("NOPE", base_url=self.base)
        self.assertIn("Not Found", str(cm.exception))

    def test_07_retries_then_succeeds_on_429(self):
        """被限流會退避重試，第二次成功就算成功。"""
        st = [NY_OPEN, NY_OPEN + 86400]
        good = chart_payload("R", st, [1, 2], [3, 4], [0.5, 1], [2, 3], [1, 1])

        def flaky(hit):
            return (200, good) if hit >= 2 else (429, {"error": "rate limited"})
        FakeYahoo.routes["R"] = (200, flaky)
        rows, _ = fetch_symbol("R", base_url=self.base)
        self.assertEqual(len(rows), 2)
        self.assertGreaterEqual(FakeYahoo.hits["R"], 2)

    def test_08_csv_roundtrip_matches_engine_loader(self):
        """寫出的 CSV 要能被 engine/data.py 原封不動讀回來（逐位元一致）。"""
        st = [NY_OPEN + i * 86400 for i in range(5)]
        FakeYahoo.routes["Z"] = (200, chart_payload(
            "Z", st, [10.123456789, 11, 12, 13, 14], [10.5, 11.5, 12.5, 13.5, 14.5],
            [9.9, 10.9, 11.9, 12.9, 13.9], [10.3, 11.3, 12.3, 13.3, 14.3],
            [100, 200, 300, 400, 500]))
        rows, _ = fetch_symbol("Z", base_url=self.base)
        write_csv("Z", rows, self.tmp)
        from engine.data import load_bars
        bars = load_bars("Z", data_dir=self.tmp)
        self.assertEqual(len(bars), 5)
        self.assertEqual(bars[0].open, rows[0]["open"])      # 精度沒有掉
        self.assertEqual(bars[0].open, 10.123456789)
        self.assertEqual([b.date for b in bars], [r["date"] for r in rows])

    def test_09_meta_sidecar_written(self):
        """抓完要留下 _meta.json，讓內嵌腳本自動帶出名稱與幣別。"""
        FakeYahoo.routes["M"] = (200, chart_payload(
            "M", [NY_OPEN, NY_OPEN + 86400], [1, 2], [3, 4], [0.5, 1], [2, 3], [1, 1],
            currency="EUR", name="Meta Test"))
        rows, info = fetch_symbol("M", base_url=self.base)
        path = os.path.join(self.tmp, "_meta.json")
        fetch_yahoo.update_meta("M", info, path)
        with open(path, encoding="utf-8") as f:
            store = json.load(f)
        self.assertEqual(store["M"]["currency"], "EUR")
        self.assertEqual(store["M"]["name"], "Meta Test")
        self.assertEqual(store["M"]["source"], "Yahoo Finance")

    def test_10_cli_writes_files(self):
        """命令列跑完，CSV 與 _meta.json 都要出現（--no-embed 不動 HTML）。"""
        st = [NY_OPEN + i * 86400 for i in range(3)]
        FakeYahoo.routes["CLI"] = (200, chart_payload(
            "CLI", st, [1, 2, 3], [4, 5, 6], [0.5, 1, 2], [3, 4, 5], [1, 1, 1]))
        rc = fetch_yahoo.main(["CLI", "--no-embed", "--base-url", self.base,
                               "--data-dir", self.tmp])
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "CLI.csv")))
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "_meta.json")))

    def test_11_cli_reports_failure_without_crashing(self):
        """抓不到的代號要回非零離開碼，不是丟出例外。"""
        rc = fetch_yahoo.main(["GHOST", "--no-embed", "--base-url", self.base,
                               "--data-dir", self.tmp])
        self.assertEqual(rc, 1)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "GHOST.csv")))


if __name__ == "__main__":
    unittest.main()
