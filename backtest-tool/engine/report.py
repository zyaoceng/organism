# -*- coding: utf-8 -*-
"""把一個情境跑完、整理成一份可以並排比較的結果。"""
from .config import MIN_TRADES_FOR_STATS
from .metrics import (cagr, equity_to_returns, max_drawdown, sharpe,
                      sharpe_band, stability_score)
from .simulator import simulate


def run_scenario(name, symbol, bars, tranches, initial_capital, ambiguous="worst"):
    """跑一個情境，回傳含誠實註記的結果 dict。"""
    sim = simulate(symbol, bars, tranches, initial_capital, ambiguous=ambiguous)
    rets = equity_to_returns(sim.equity)
    sp = sharpe(rets)
    n_closed = sum(1 for t in sim.tranches if t.status == "filled")
    notes = list(sim.violations)
    if n_closed and n_closed < MIN_TRADES_FOR_STATS:
        notes.append(f"只有 {n_closed} 筆進出，統計上幾乎沒有意義——"
                     f"這是單一計畫的沙盤推演，不是規則有沒有效的證據")
    return {
        "name": name,
        "symbol": symbol,
        "period": (bars[0].date, bars[-1].date) if bars else (None, None),
        "initial_capital": initial_capital,
        "final_equity": sim.final_equity,
        "total_pnl": sim.total_pnl,
        "total_return": sim.total_return,
        "sharpe": sp,
        "sharpe_band": sharpe_band(sp),
        "max_dd": max_drawdown(sim.equity),
        "cagr": cagr(sim.equity, max(len(sim.equity) - 1, 0)),
        "stability": stability_score(rets, sim.equity),
        "tranches": sim.tranches,
        "violations": sim.violations,
        "notes": notes,
        "equity_dates": sim.equity_dates,
        "equity": sim.equity,
        "trace": sim.trace,
    }


def buy_and_hold(symbol, bars, initial_capital):
    """對照組：第一天開盤全買、抱到最後。守紀律的代價要跟這個比才誠實。

    投入金額扣掉買進成本，否則「現金不得為負」會把這一筆擋下來。
    """
    from .config import COST_RATE
    from .simulator import Tranche
    t = [Tranche(label="買了就抱", trigger="open",
                 capital=initial_capital / (1 + COST_RATE))]
    return run_scenario(f"{symbol} 買了就抱", symbol, bars, t, initial_capital)
