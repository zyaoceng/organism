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

    def test_14_gap_above_tp_beats_ambiguous_stop(self):
        """開盤跳空高於停利：停利單必在開盤成交，worst 模式也不准記成停損。"""
        bars = [flat("2025-01-01", 100),
                mk("2025-01-02", 120, 125, 90, 100)]   # 開盤 120 > 停利 110，盤中也殺到 90
        t = [Tranche(label="首筆", trigger="open", capital=10000,
                     stop_loss=95, take_profit=110)]
        tr = simulate("X", bars, t, 20000).tranches[0]
        self.assertEqual((tr.exit_reason, tr.exit_price), ("停利", 120.0))

    def test_15_gap_below_stop_beats_ambiguous_tp(self):
        """開盤跳空低於停損：best 模式也不准記出物理上不存在的停利。"""
        bars = [flat("2025-01-01", 100),
                mk("2025-01-02", 80, 112, 78, 100)]    # 開盤 80 < 停損 95，盤中反彈過停利
        t = [Tranche(label="首筆", trigger="open", capital=10000,
                     stop_loss=95, take_profit=110)]
        tr = simulate("X", bars, t, 20000, ambiguous="best").tranches[0]
        self.assertEqual((tr.exit_reason, tr.exit_price), ("停損", 80.0))

    def test_16_same_day_tp_needs_close_evidence_in_worst(self):
        """進場當天的停利：worst 要收盤站上停利價才算（全日高點可能發生在進場前）。"""
        bars = [mk("2025-01-01", 111, 112, 94, 95.5),  # 高點 112 在盤中，limit 95 進場
                flat("2025-01-02", 96)]
        plan = lambda: [Tranche(label="首筆", trigger="limit_below", trigger_price=95,
                                capital=10000, take_profit=110)]
        worst = simulate("X", bars, plan(), 20000).tranches[0]
        best = simulate("X", bars, plan(), 20000, ambiguous="best").tranches[0]
        self.assertEqual(worst.exit_reason, "期末平倉")          # 收盤 95.5 沒站上 110
        self.assertEqual((best.exit_reason, best.exit_price),
                         ("停利（進場當天）", 110.0))            # 上界才准用全日高點

    def test_17_entry_above_tp_exits_immediately_at_entry(self):
        """突破加碼跳空進在停利價之上：立即停利在進場價，worst 也一樣。"""
        bars = [mk("2025-01-01", 120, 121, 119, 120)]
        t = [Tranche(label="加碼", trigger="stop_above", trigger_price=105,
                     capital=10000, stop_loss=100, take_profit=110)]
        tr = simulate("X", bars, t, 20000).tranches[0]
        self.assertEqual((tr.exit_reason, tr.exit_price), ("停利（進場當天）", 120.0))
        self.assertAlmostEqual(tr.pnl, -2 * COST_RATE * 10000, places=6)

    def test_19_breakout_entry_tp_touch_is_certain_even_in_worst(self):
        """突破買進後碰到更高的停利，必然發生在進場之後——worst 也要認。"""
        bars = [mk("2025-01-01", 101, 112, 101, 106),   # 開盤在觸發價下，盤中衝過停利
                flat("2025-01-02", 90)]
        t = [Tranche(label="加碼", trigger="stop_above", trigger_price=105,
                     capital=10000, stop_loss=100, take_profit=110)]
        tr = simulate("X", bars, t, 20000).tranches[0]
        self.assertEqual((tr.exit_reason, tr.exit_price), ("停利（進場當天）", 110.0))

    def test_20_open_fill_stop_touch_is_certain_even_in_best(self):
        """開盤成交（整天都在進場後）盤中跌破停損——best 也要認賠。"""
        bars = [mk("2025-01-01", 96, 96, 90, 96), flat("2025-01-02", 120)]
        t = [Tranche(label="首筆", trigger="open", capital=10000,
                     stop_loss=95, take_profit=110)]
        tr = simulate("X", bars, t, 20000, ambiguous="best").tranches[0]
        self.assertEqual((tr.exit_reason, tr.exit_price), ("停損（進場當天）", 95.0))

    def test_21_dip_entry_stop_touch_is_certain_even_in_best(self):
        """攤低買進後碰到更低的停損，必然發生在進場之後——best 也要認。"""
        bars = [mk("2025-01-01", 111, 112, 88, 105), flat("2025-01-02", 100)]
        t = [Tranche(label="加碼", trigger="limit_below", trigger_price=95,
                     capital=10000, stop_loss=90)]
        tr = simulate("X", bars, t, 20000, ambiguous="best").tranches[0]
        self.assertEqual((tr.exit_reason, tr.exit_price), ("停損（進場當天）", 90.0))

    def test_18_zero_capital_rejected(self):
        """投入金額 0 是無效計畫：直接報錯，不是靜默算出除以零。"""
        bars = [flat("2025-01-01", 100)]
        with self.assertRaises(ValueError):
            simulate("X", bars, [Tranche(label="首筆", trigger="open", capital=0)], 10000)


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
        """真實資料冒煙測試：MU 五年、買了就抱，跑得完、帳要平。

        資料品質檢查對「原始 CSV」做（load_bars 會鉗高低價，鉗完再驗是恆真式）：
        需要鉗制的 K 棒必須低於 2%，超過代表資料來源有系統性問題。
        """
        import csv as _csv
        from engine.data import DATA_DIR
        with open(f"{DATA_DIR}/MU.csv", newline="", encoding="utf-8") as f:
            raw = list(_csv.DictReader(f))
        bad = sum(1 for row in raw
                  if float(row["high"]) < max(float(row["open"]), float(row["close"]))
                  or float(row["low"]) > min(float(row["open"]), float(row["close"])))
        self.assertLess(bad / len(raw), 0.02,
                        f"原始 CSV 有 {bad}/{len(raw)} 根 K 棒高低價不包含開收盤")
        bars = load_bars("MU")
        self.assertGreater(len(bars), 1000)
        r = buy_and_hold("MU", bars, 100000)
        self.assertEqual(r["tranches"][0].status, "filled")
        pnl_sum = sum(t.pnl for t in r["tranches"] if t.status == "filled")
        self.assertAlmostEqual(r["final_equity"], 100000 + pnl_sum, places=4)


if __name__ == "__main__":
    unittest.main()
