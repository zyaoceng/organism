# -*- coding: utf-8 -*-
"""引擎單元測試。跑法（在 backtest-tool/ 目錄下）：
    python3 -m unittest discover -s tests -v

重點測試是 test_01_no_future_data：把未來的 K 棒整個改掉，
前半段的每一個決定都必須一模一樣，否則就是模擬器偷看了未來。
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.config import COST_RATE
from engine.data import Bar, load_bars
from engine.metrics import max_drawdown, sharpe, stdev
from engine.report import buy_and_hold, run_scenario
from engine.simulator import Tranche, payoff_curve, simulate, synthetic_bars
from engine.valuation import eps_pe_grid


def mk(date, o, h, l, c):
    return Bar(date=date, open=o, high=h, low=l, close=c, volume=0)


def flat(date, p):
    return mk(date, p, p, p, p)


class TestNoFutureData(unittest.TestCase):
    def test_01_no_future_data(self):
        """改掉第 15 天以後的所有 K 棒，前 15 天的決定必須一字不差。"""
        base = [mk(f"2025-01-{d:02d}", 100 + d, 103 + d, 97 + d, 101 + d)
                for d in range(1, 31)]
        mutated = base[:15] + [mk(f"2025-01-{d:02d}", 500, 900, 10, 400)
                               for d in range(16, 31)]
        tranches = lambda: [
            Tranche(label="首筆", trigger="open", capital=30000,
                    stop_loss=95, take_profit=140),
            Tranche(label="加碼一", trigger="limit_below", trigger_price=99,
                    capital=20000, stop_loss=94, take_profit=130),
            Tranche(label="加碼二", trigger="stop_above", trigger_price=112,
                    capital=20000, stop_loss=105, take_profit=150),
        ]
        r1 = simulate("X", base, tranches(), 100000)
        r2 = simulate("X", mutated, tranches(), 100000)
        cutoff = base[14].date
        self.assertEqual(r1.equity[:15], r2.equity[:15])
        t1 = [e for e in r1.trace if e[0] <= cutoff]
        t2 = [e for e in r2.trace if e[0] <= cutoff]
        self.assertEqual(t1, t2)


class TestFills(unittest.TestCase):
    def test_02_gap_through_stop_fills_at_open(self):
        """跳空跌破停損 → 用開盤價出場，不能假裝停在停損價。"""
        bars = [flat("2025-01-01", 100),
                mk("2025-01-02", 80, 85, 78, 82)]   # 開盤 80，遠低於停損 95
        t = [Tranche(label="首筆", trigger="open", capital=10000, stop_loss=95)]
        r = simulate("X", bars, t, 20000)
        tr = r.tranches[0]
        self.assertEqual(tr.exit_reason, "停損")
        self.assertEqual(tr.exit_price, 80.0)

    def test_03_same_day_stop_and_tp_worst_takes_stop(self):
        """同一天停損停利都碰到：worst 當作先停損；best 當作先停利。"""
        bars = [flat("2025-01-01", 100),
                mk("2025-01-02", 100, 115, 92, 100)]  # 停損 95、停利 110 都碰到
        plan = lambda: [Tranche(label="首筆", trigger="open", capital=10000,
                                stop_loss=95, take_profit=110)]
        worst = simulate("X", bars, plan(), 20000).tranches[0]
        best = simulate("X", bars, plan(), 20000, ambiguous="best").tranches[0]
        self.assertEqual((worst.exit_reason, worst.exit_price), ("停損", 95.0))
        self.assertEqual((best.exit_reason, best.exit_price), ("停利", 110.0))

    def test_04_addon_has_independent_stop(self):
        """加碼筆自己停損出場，原始部位不受影響、抱到期末。"""
        bars = [flat("2025-01-01", 100),
                mk("2025-01-02", 96, 97, 93, 94),    # 加碼 95 觸發、其停損 93.5 同日觸發
                flat("2025-01-03", 98)]
        t = [Tranche(label="首筆", trigger="open", capital=10000, stop_loss=88),
             Tranche(label="加碼一", trigger="limit_below", trigger_price=95,
                     capital=10000, stop_loss=93.5)]
        r = simulate("X", bars, t, 30000)
        base, addon = r.tranches
        self.assertEqual(addon.entry_price, 95.0)
        self.assertEqual(addon.exit_reason, "停損（進場當天）")
        self.assertEqual(addon.exit_price, 93.5)
        self.assertEqual(base.exit_reason, "期末平倉")
        self.assertEqual(base.exit_price, 98.0)

    def test_05_cash_never_negative_skips_tranche(self):
        """現金不夠的加碼直接跳過並記違規，權益永遠為正。"""
        bars = [flat("2025-01-01", 100), flat("2025-01-02", 95)]
        t = [Tranche(label="首筆", trigger="open", capital=9000),
             Tranche(label="加碼一", trigger="limit_below", trigger_price=96,
                     capital=5000)]
        r = simulate("X", bars, t, 10000)
        self.assertEqual(r.tranches[1].status, "skipped_no_cash")
        self.assertEqual(len(r.violations), 1)
        self.assertTrue(all(e > 0 for e in r.equity))

    def test_06_exit_frees_cash_for_same_day_entry(self):
        """同一天先出後進：停損釋放的現金，當天的加碼可以用。"""
        bars = [flat("2025-01-01", 100),
                mk("2025-01-02", 90, 95, 88, 92)]
        t = [Tranche(label="首筆", trigger="open", capital=9995, stop_loss=90),
             Tranche(label="加碼一", trigger="limit_below", trigger_price=95,
                     capital=8000)]
        r = simulate("X", bars, t, 10000)
        base, addon = r.tranches
        self.assertEqual(base.exit_reason, "停損")
        self.assertEqual(base.exit_price, 90.0)          # 開盤即觸價
        self.assertEqual(addon.status, "filled")          # 靠釋放的現金進場
        self.assertEqual(addon.entry_date, "2025-01-02")
        self.assertEqual(addon.entry_price, 90.0)         # 跳空穿過限價 → 開盤價成交

    def test_07_costs_applied_both_sides(self):
        """買賣各付 0.05%：原地平倉的損益應恰為 −2×成本×投入金額。"""
        bars = [flat("2025-01-01", 100), flat("2025-01-02", 100)]
        t = [Tranche(label="首筆", trigger="open", capital=10000)]
        r = simulate("X", bars, t, 20000)
        self.assertAlmostEqual(r.tranches[0].pnl, -2 * COST_RATE * 10000, places=6)


class TestMetrics(unittest.TestCase):
    def test_08_sharpe_and_drawdown_hand_computed(self):
        """權益 [100,110,99,108.9] → 日報酬 [+10%,−10%,+10%]，手算對帳。"""
        equity = [100.0, 110.0, 99.0, 108.9]
        rets = [0.10, -0.10, 0.10]
        m = sum(rets) / 3
        s = stdev(rets)
        expect = m / s * math.sqrt(252)
        got = sharpe(rets)
        self.assertAlmostEqual(got, expect, places=10)
        self.assertAlmostEqual(got, 4.5826, places=3)     # 手算錨定值
        self.assertAlmostEqual(max_drawdown(equity), -0.10, places=10)


class TestValuation(unittest.TestCase):
    def test_09_eps_pe_grid_hand_computed(self):
        g = eps_pe_grid(
            eps_scenarios=[{"label": "FY2027 共識", "eps": 213.23}],
            pe_points=[5, 7.5, 10],
            current_price=1596.08, shares=10, avg_cost=1400.0)
        cell = g["rows"][0]["cells"][1]
        self.assertAlmostEqual(cell["implied_price"], 1599.225, places=6)
        self.assertAlmostEqual(cell["vs_current"], 1599.225 / 1596.08 - 1, places=10)
        self.assertAlmostEqual(cell["position_pnl"], 10 * (1599.225 - 1400.0), places=6)
        self.assertAlmostEqual(g["current_pe"][0]["pe"], 1596.08 / 213.23, places=10)


class TestHypotheticalPath(unittest.TestCase):
    def test_10_payoff_monotonic_down_stops_everything(self):
        """從 100 一路走到 80：首筆停損 90 出、95 的加碼進場後也在 90 停損。"""
        t = [Tranche(label="首筆", trigger="open", capital=10000,
                     stop_loss=90, take_profit=110),
             Tranche(label="加碼一", trigger="limit_below", trigger_price=95,
                     capital=10000, stop_loss=90)]
        (x, pnl, ret), = payoff_curve(t, 100.0, [80.0], 30000)
        # 手算：首筆 100→90 損 -1009.5；加碼 95→90 損 -536.053
        expect1 = 10000 / 100 * 90 * (1 - COST_RATE) - 10000 * (1 + COST_RATE)
        expect2 = 10000 / 95 * 90 * (1 - COST_RATE) - 10000 * (1 + COST_RATE)
        self.assertAlmostEqual(pnl, expect1 + expect2, places=6)

    def test_11_payoff_monotonic_up_hits_tp(self):
        """從 100 一路走到 120：停利 110 先把獲利鎖住，不會算到 120。"""
        t = [Tranche(label="首筆", trigger="open", capital=10000,
                     stop_loss=90, take_profit=110)]
        # 初始資金要含 0.05% 買進成本，否則整筆會被「現金不得為負」擋下——
        # 這是刻意的行為，前端會把這種情況用違規訊息標出來。
        (x, pnl, ret), = payoff_curve(t, 100.0, [120.0], 10100)
        expect = 10000 / 100 * 110 * (1 - COST_RATE) - 10000 * (1 + COST_RATE)
        self.assertAlmostEqual(pnl, expect, places=6)

    def test_12_synthetic_bars_insert_crossed_levels(self):
        t = [Tranche(label="A", trigger="limit_below", trigger_price=95,
                     capital=1, stop_loss=90, take_profit=110)]
        bars = synthetic_bars([100, 85], t)
        self.assertEqual([b.close for b in bars], [100, 95, 90, 85])


class TestRealData(unittest.TestCase):
    def test_13_real_data_smoke(self):
        """真實資料冒煙測試：MU 五年、買了就抱，跑得完、帳要平。"""
        bars = load_bars("MU")
        self.assertGreater(len(bars), 1000)
        self.assertTrue(all(b.high >= max(b.open, b.close) and
                            b.low <= min(b.open, b.close) for b in bars))
        r = buy_and_hold("MU", bars, 100000)
        self.assertEqual(r["tranches"][0].status, "filled")
        pnl_sum = sum(t.pnl for t in r["tranches"] if t.status == "filled")
        self.assertAlmostEqual(r["final_equity"], 100000 + pnl_sum, places=4)


if __name__ == "__main__":
    unittest.main()
