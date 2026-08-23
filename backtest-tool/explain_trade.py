#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""逐筆追蹤器：把一個情境逐日重播給你看，並用獨立算術對帳。

用法：
    python3 explain_trade.py --symbol MU --start 2026-01-02 --capital 101000 \
        --plan examples/plan_mu.json
（examples/plan_mu.json 是附的範例；換成你自己的計畫 JSON 即可。）

四個階段：
  一、計畫內容——每一筆的進場方式、金額、停損、停利。
  二、逐日重播——用引擎自己的觸發函式，一天一天列出檢查結果。
  三、逐筆對帳——每筆的損益用「股數×價差−成本」獨立重算一次，和引擎輸出比對。
  四、總帳對帳——期末權益必須等於 初始資金＋所有筆損益總和，差超過一分錢就報錯。
"""
import argparse
import json
import sys

from engine.data import load_bars, slice_bars
from engine.report import run_scenario
from engine.simulator import Tranche, _entry_fill, _exit_check
from engine.config import COST_RATE


def load_plan(path):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    return [Tranche(**t) for t in cfg["tranches"]], cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", default=None)
    ap.add_argument("--capital", type=float, default=100000)
    ap.add_argument("--plan", required=True, help="JSON：{\"tranches\": [...]}")
    args = ap.parse_args()

    tranches, _ = load_plan(args.plan)
    bars = slice_bars(load_bars(args.symbol), args.start, args.end)
    if not bars:
        sys.exit("這個區間沒有資料")

    print("═" * 62)
    print(f"階段一：計畫內容（{args.symbol}，{bars[0].date} ～ {bars[-1].date}，"
          f"初始資金 {args.capital:,.0f}）")
    print("═" * 62)
    for t in tranches:
        if t.trigger == "open":
            trig = "起點開盤買進"
        elif t.trigger == "limit_below":
            trig = f"跌到 {t.trigger_price:g} 買"
        else:
            trig = f"漲到 {t.trigger_price:g} 買"
        print(f"  {t.label}：{trig}｜投入 {t.capital:,.0f}"
              f"｜停損 {t.stop_loss if t.stop_loss is not None else '—'}"
              f"｜停利 {t.take_profit if t.take_profit is not None else '—'}")

    result = run_scenario("追蹤", args.symbol, bars, tranches, args.capital)

    print()
    print("═" * 62)
    print("階段二：逐日重播（只列有事情發生的日子；用引擎自己的觸發函式）")
    print("═" * 62)
    open_state = {t.label: None for t in tranches}   # label -> entry_price
    done = set()
    for i, bar in enumerate(bars):
        lines = []
        for t in tranches:
            if t.label in done:
                continue
            if open_state[t.label] is None:
                px = _entry_fill(t, bar, i == 0)
                if px is not None:
                    lines.append(f"{t.label}：觸發進場檢查 → 成交價 {px:g}"
                                 f"（開 {bar.open:g} 高 {bar.high:g} 低 {bar.low:g}）")
                    open_state[t.label] = px
                    xp, reason = _exit_check(t, bar, True, px, "worst")
                    if xp is not None:
                        lines.append(f"{t.label}：進場當天就{reason} @ {xp:g}")
                        done.add(t.label)
            else:
                xp, reason = _exit_check(t, bar, False, open_state[t.label], "worst")
                if xp is not None:
                    lines.append(f"{t.label}：{reason}出場 @ {xp:g}"
                                 f"（開 {bar.open:g} 高 {bar.high:g} 低 {bar.low:g}）")
                    done.add(t.label)
        if lines:
            print(f"  {bar.date}")
            for ln in lines:
                print(f"    {ln}")

    print()
    print("═" * 62)
    print("階段三：逐筆對帳（獨立算術 vs 引擎輸出）")
    print("═" * 62)
    ok = True
    for tr in result["tranches"]:
        if tr.status in ("never_triggered", "skipped_no_cash"):
            print(f"  {tr.label}：{ '一直沒觸發' if tr.status=='never_triggered' else '現金不足被跳過' }")
            continue
        manual = tr.shares * tr.exit_price * (1 - COST_RATE) - tr.capital * (1 + COST_RATE)
        diff = abs(manual - tr.pnl)
        flag = "✓" if diff < 0.01 else "✗ 不一致！"
        if diff >= 0.01:
            ok = False
        print(f"  {tr.label}：{tr.entry_date} 進 @ {tr.entry_price:g} → "
              f"{tr.exit_date} {tr.exit_reason} @ {tr.exit_price:g}｜"
              f"引擎損益 {tr.pnl:,.2f}｜手算 {manual:,.2f}｜{flag}")

    print()
    print("═" * 62)
    print("階段四：總帳對帳")
    print("═" * 62)
    pnl_sum = sum(tr.pnl for tr in result["tranches"] if tr.status == "filled")
    expect = args.capital + pnl_sum
    diff = abs(expect - result["final_equity"])
    print(f"  初始資金 {args.capital:,.2f} ＋ 各筆損益合計 {pnl_sum:,.2f} "
          f"＝ {expect:,.2f}")
    print(f"  引擎期末權益 ＝ {result['final_equity']:,.2f}（差 {diff:.4f}）")
    if diff >= 0.01:
        ok = False
    print(f"  {'✓ 對帳一致' if ok else '✗ 對帳不一致，引擎有 bug，不要使用結果'}")
    print()
    raw_sp = "—（樣本不足）" if result["sharpe"] is None else f"{result['sharpe']:.2f}"
    print(f"  夏普值級距：{result['sharpe_band']}（原始值 {raw_sp}，僅供參考）")
    print(f"  最大回檔：{result['max_dd']:.1%}｜總報酬：{result['total_return']:.1%}")
    for n in result["notes"]:
        print(f"  註：{n}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
