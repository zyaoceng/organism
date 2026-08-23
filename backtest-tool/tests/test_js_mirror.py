# -*- coding: utf-8 -*-
"""跨引擎對拍：把 index.html 裡的 JS 引擎抽出來，用 node 跑同一批情境，
和 Python 引擎逐格比對。這是「網頁與 Python 同一套規則」宣稱的自動防線——
沒有它，任何一邊單獨修 bug，另一邊會無聲留著舊行為。

環境沒有 node 就跳過（skip），不算失敗。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.data import Bar, load_bars, slice_bars
from engine.simulator import Tranche, simulate

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(HERE, "index.html")

RUNNER = r"""
const spec = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const out = spec.map(sc => {
  const r = simulate(sc.bars, sc.tranches, sc.initialCapital, {ambiguous: sc.ambiguous});
  return {
    finalEquity: r.finalEquity, equity: r.equity, violations: r.violations.length,
    tranches: r.tranches.map(t => ({
      status: t.status, entryDate: t.entryDate, entryPrice: t.entryPrice,
      exitDate: t.exitDate, exitPrice: t.exitPrice, exitReason: t.exitReason,
      pnl: t.pnl, shares: t.shares }))
  };
});
console.log(JSON.stringify(out));
"""


def scenarios():
    """對拍情境：涵蓋跳空穿價、同日雙觸發（worst/best）、當日進出、現金不足、加碼梯次。"""
    def mk(d, o, h, l, c):
        return {"d": d, "o": o, "h": h, "l": l, "c": c}

    flat = lambda d, p: mk(d, p, p, p, p)
    T = lambda **kw: {**{"label": "首筆", "trigger": "open", "triggerPrice": None,
                         "capital": 10000, "stopLoss": None, "takeProfit": None}, **kw}
    out = []
    gap_bars = [flat("2025-01-01", 100), mk("2025-01-02", 120, 125, 90, 100)]
    out.append({"bars": gap_bars, "tranches": [T(stopLoss=95, takeProfit=110)],
                "initialCapital": 20000, "ambiguous": "worst"})
    gap2 = [flat("2025-01-01", 100), mk("2025-01-02", 80, 112, 78, 100)]
    out.append({"bars": gap2, "tranches": [T(stopLoss=95, takeProfit=110)],
                "initialCapital": 20000, "ambiguous": "best"})
    mid = [flat("2025-01-01", 100), mk("2025-01-02", 100, 115, 92, 100)]
    for amb in ("worst", "best"):
        out.append({"bars": mid, "tranches": [T(stopLoss=95, takeProfit=110)],
                    "initialCapital": 20000, "ambiguous": amb})
    same_day = [mk("2025-01-01", 111, 112, 94, 95.5), flat("2025-01-02", 96)]
    for amb in ("worst", "best"):
        out.append({"bars": same_day,
                    "tranches": [T(trigger="limit_below", triggerPrice=95, takeProfit=110)],
                    "initialCapital": 20000, "ambiguous": amb})
    out.append({"bars": [mk("2025-01-01", 120, 121, 119, 120)],
                "tranches": [T(label="加碼", trigger="stop_above", triggerPrice=105,
                               stopLoss=100, takeProfit=110)],
                "initialCapital": 20000, "ambiguous": "worst"})
    # 跳空雙觸發的另外兩個方向、以及「證據必然在進場後」的三個收緊案例
    out.append({"bars": gap_bars, "tranches": [T(stopLoss=95, takeProfit=110)],
                "initialCapital": 20000, "ambiguous": "best"})
    out.append({"bars": gap2, "tranches": [T(stopLoss=95, takeProfit=110)],
                "initialCapital": 20000, "ambiguous": "worst"})
    breakout = [mk("2025-01-01", 101, 112, 101, 106), flat("2025-01-02", 90)]
    dipboth = [mk("2025-01-01", 111, 112, 88, 105), flat("2025-01-02", 100)]
    for amb in ("worst", "best"):
        out.append({"bars": breakout,
                    "tranches": [T(label="加碼", trigger="stop_above", triggerPrice=105,
                                   stopLoss=100, takeProfit=110)],
                    "initialCapital": 20000, "ambiguous": amb})
        out.append({"bars": dipboth,
                    "tranches": [T(label="加碼", trigger="limit_below", triggerPrice=95,
                                   stopLoss=90, takeProfit=110)],
                    "initialCapital": 20000, "ambiguous": amb})
    nocash = [flat("2025-01-01", 100), mk("2025-01-02", 90, 95, 88, 92)]
    out.append({"bars": nocash,
                "tranches": [T(capital=9995, stopLoss=90),
                             T(label="加碼一", trigger="limit_below", triggerPrice=95,
                               capital=8000)],
                "initialCapital": 10000, "ambiguous": "worst"})
    # 真實資料兩段：完整加碼梯次
    mu = slice_bars(load_bars("MU"), "2026-01-02", "2026-04-30")
    real = [{"d": b.date, "o": b.open, "h": b.high, "l": b.low, "c": b.close} for b in mu]
    ladder = [T(capital=40000, stopLoss=260, takeProfit=480),
              T(label="加碼一", trigger="limit_below", triggerPrice=280, capital=30000,
                stopLoss=255, takeProfit=450),
              T(label="加碼二", trigger="stop_above", triggerPrice=330, capital=30000,
                stopLoss=300, takeProfit=520)]
    for amb in ("worst", "best"):
        out.append({"bars": real, "tranches": ladder, "initialCapital": 101000,
                    "ambiguous": amb})
    return out


class TestJsMirror(unittest.TestCase):
    def test_js_engine_matches_python(self):
        if shutil.which("node") is None:
            self.skipTest("環境沒有 node，跳過對拍")
        html = open(INDEX, encoding="utf-8").read()
        m = re.search(r"(/\* ═+ 引擎.*?)\n/\* ═+ 圖表", html, re.S)
        self.assertIsNotNone(m, "index.html 裡找不到引擎區塊標記")
        js = m.group(1) + "\n" + RUNNER

        specs = scenarios()
        with tempfile.TemporaryDirectory() as td:
            jsf = os.path.join(td, "engine_extract.js")
            spf = os.path.join(td, "spec.json")
            open(jsf, "w", encoding="utf-8").write(js)
            open(spf, "w", encoding="utf-8").write(json.dumps(specs))
            proc = subprocess.run(["node", jsf, spf], capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, f"node 執行失敗：{proc.stderr[:800]}")
            js_out = json.loads(proc.stdout)

        for i, sc in enumerate(specs):
            bars = [Bar(date=b["d"], open=b["o"], high=b["h"], low=b["l"],
                        close=b["c"], volume=0) for b in sc["bars"]]
            ts = [Tranche(label=t["label"], trigger=t["trigger"],
                          trigger_price=t["triggerPrice"], capital=t["capital"],
                          stop_loss=t["stopLoss"], take_profit=t["takeProfit"])
                  for t in sc["tranches"]]
            py = simulate("X", bars, ts, sc["initialCapital"], ambiguous=sc["ambiguous"])
            jr = js_out[i]
            ctx = f"情境 {i}（{sc['ambiguous']}）"
            self.assertAlmostEqual(py.final_equity, jr["finalEquity"], places=6, msg=ctx)
            self.assertEqual(len(py.equity), len(jr["equity"]), msg=ctx)
            for a, b in zip(py.equity, jr["equity"]):
                self.assertAlmostEqual(a, b, places=6, msg=ctx)
            self.assertEqual(len(py.violations), jr["violations"], msg=ctx)
            for pt, jt in zip(py.tranches, jr["tranches"]):
                self.assertEqual(pt.status, jt["status"], msg=f"{ctx} {pt.label}")
                self.assertEqual(pt.entry_date, jt["entryDate"], msg=f"{ctx} {pt.label}")
                self.assertEqual(pt.exit_date, jt["exitDate"], msg=f"{ctx} {pt.label}")
                self.assertEqual(pt.exit_reason, jt["exitReason"], msg=f"{ctx} {pt.label}")
                for pv, jv in ((pt.entry_price, jt["entryPrice"]),
                               (pt.exit_price, jt["exitPrice"]),
                               (pt.pnl, jt["pnl"]), (pt.shares, jt["shares"])):
                    if pv is None:
                        self.assertIsNone(jv, msg=f"{ctx} {pt.label}")
                    else:
                        self.assertAlmostEqual(pv, jv, places=6, msg=f"{ctx} {pt.label}")


if __name__ == "__main__":
    unittest.main()
