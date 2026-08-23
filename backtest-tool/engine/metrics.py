# -*- coding: utf-8 -*-
"""績效與風險指標。全部用純 Python 寫，每個公式都能用計算機逐格驗算。

誠實解讀的規矩（輸出端負責執行，不是註解裝飾）：
- 夏普值標題只給級距；原始數字放括號裡當參考。
- 交易筆數 < 30 的回測，一律附註「統計上幾乎沒有意義」。
- 無風險利率設 0——算的是「每承受一單位波動換到多少報酬」，不是超額報酬。
"""
import math

from .config import (CORR_WARN, MAX_SINGLE_WEIGHT_WARN, RISK_BANDS, SHARPE_BANDS,
                     STABILITY_MAXDD_FLOOR, STABILITY_ROLL_WINDOW,
                     STABILITY_VOLCV_CEIL, STABILITY_WINRATE_HIGH,
                     STABILITY_WINRATE_LOW, TRADING_DAYS)


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs):
    """樣本標準差（除以 n-1）。"""
    n = len(xs)
    if n < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))


def equity_to_returns(equity):
    return [equity[i] / equity[i - 1] - 1.0 for i in range(1, len(equity))
            if equity[i - 1] > 0]


def sharpe(returns, trading_days=TRADING_DAYS):
    """年化夏普值（無風險利率 0）。報酬全零或樣本不足回傳 None。"""
    if len(returns) < 2:
        return None
    s = stdev(returns)
    if s == 0:
        return None
    return mean(returns) / s * math.sqrt(trading_days)


def sharpe_band(value):
    """夏普值 → 級距標籤。None 回傳「樣本不足」。"""
    if value is None:
        return "樣本不足，算不出來"
    for lo, hi, label in SHARPE_BANDS:
        if lo <= value < hi:
            return label
    return "樣本不足，算不出來"


def annualized_vol(returns, trading_days=TRADING_DAYS):
    return stdev(returns) * math.sqrt(trading_days)


def max_drawdown(equity):
    """最大回檔（負數，例如 -0.35 = 從高點掉 35%）。"""
    peak = float("-inf")
    worst = 0.0
    for e in equity:
        peak = max(peak, e)
        if peak > 0:
            worst = min(worst, e / peak - 1.0)
    return worst


def cagr(equity, n_days, trading_days=TRADING_DAYS):
    """年化報酬率。只當情境參考，不當標題。"""
    if not equity or equity[0] <= 0 or n_days <= 0:
        return None
    years = n_days / trading_days
    if years <= 0:
        return None
    total = equity[-1] / equity[0]
    if total <= 0:
        return None
    return total ** (1.0 / years) - 1.0


def rolling_vol_cv(returns, window=STABILITY_ROLL_WINDOW, trading_days=TRADING_DAYS):
    """20 日滾動年化波動的「標準差 ÷ 平均」。衡量波動本身穩不穩定。"""
    if len(returns) < window * 2:
        return None
    vols = []
    for i in range(window, len(returns) + 1):
        vols.append(stdev(returns[i - window:i]) * math.sqrt(trading_days))
    m = mean(vols)
    if m == 0:
        return None
    return stdev(vols) / m


def _clamp01(x):
    return max(0.0, min(1.0, x))


def stability_score(returns, equity):
    """穩定度 0–100 分，三個成分平均，錨點在 config.py，全部可驗算。

    回傳 dict：score 與三個成分的原始值、各自得分。
    成分算不出來（樣本太短）就不計入平均，並在 notes 說明。
    """
    parts, notes = [], []
    win = None
    if returns:
        win = sum(1 for r in returns if r > 0) / len(returns)
        s1 = _clamp01((win - STABILITY_WINRATE_LOW) /
                      (STABILITY_WINRATE_HIGH - STABILITY_WINRATE_LOW)) * 100
        parts.append(s1)
    else:
        s1 = None
        notes.append("樣本太短，正報酬天數比率算不出來")

    dd = max_drawdown(equity) if equity else None
    if dd is not None:
        s2 = _clamp01(1.0 - (-dd) / STABILITY_MAXDD_FLOOR) * 100
        parts.append(s2)
    else:
        s2 = None
        notes.append("沒有權益曲線，最大回檔算不出來")

    cv = rolling_vol_cv(returns) if returns else None
    if cv is not None:
        s3 = _clamp01(1.0 - cv / STABILITY_VOLCV_CEIL) * 100
        parts.append(s3)
    else:
        s3 = None
        notes.append(f"樣本不足 {STABILITY_ROLL_WINDOW * 2} 天，波動起伏成分不計入")

    return {
        "score": mean(parts) if parts else None,
        "win_rate": win, "win_score": s1,
        "max_dd": dd, "dd_score": s2,
        "vol_cv": cv, "vol_cv_score": s3,
        "notes": notes,
    }


def correlation(xs, ys):
    n = min(len(xs), len(ys))
    if n < 2:
        return None
    xs, ys = xs[:n], ys[:n]
    mx, my = mean(xs), mean(ys)
    sx, sy = stdev(xs), stdev(ys)
    if sx == 0 or sy == 0:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (n - 1)
    return cov / (sx * sy)


def portfolio_report(aligned_returns, values, spy_returns=None):
    """組合層級的風險與穩定度。

    aligned_returns: {symbol: [日報酬]}，已對齊共同交易日。
    values: {symbol: 部位金額}。
    spy_returns: 同一段共同交易日的 SPY 日報酬（用來換算風險倍數）。

    假設寫明：組合日報酬 = 各檔日報酬按目前權重加權，等於「每天把部位調回
    目前比例」。這是風險估計的標準做法，跟買了不動的實際路徑會有小差異。
    """
    syms = [s for s in values if s in aligned_returns and values[s] > 0]
    total = sum(values[s] for s in syms)
    if not syms or total <= 0:
        return {"error": "沒有有效部位"}
    w = {s: values[s] / total for s in syms}
    n = min(len(aligned_returns[s]) for s in syms)
    port = [sum(w[s] * aligned_returns[s][i] for s in syms) for i in range(n)]

    equity = [1.0]
    for r in port:
        equity.append(equity[-1] * (1 + r))

    vol = annualized_vol(port)
    sp = sharpe(port)
    hhi = sum(v ** 2 for v in w.values())
    max_w_sym = max(w, key=w.get)

    spy_vol = annualized_vol(spy_returns[:n]) if spy_returns else None
    ratio = (vol / spy_vol) if spy_vol else None
    risk_label = None
    if ratio is not None:
        for lo, hi, label in RISK_BANDS:
            if lo <= ratio < hi:
                risk_label = label
                break

    corr, warn_pairs = {}, []
    for i, a in enumerate(syms):
        for b in syms[i + 1:]:
            c = correlation(aligned_returns[a][:n], aligned_returns[b][:n])
            corr[(a, b)] = c
            if c is not None and c >= CORR_WARN:
                warn_pairs.append((a, b, c))

    warnings = []
    if w[max_w_sym] > MAX_SINGLE_WEIGHT_WARN:
        warnings.append(f"{max_w_sym} 佔 {w[max_w_sym]:.0%}，單一持股超過 "
                        f"{MAX_SINGLE_WEIGHT_WARN:.0%}，個股消息會直接決定整個組合的日子好壞")
    for a, b, c in warn_pairs:
        warnings.append(f"{a} 和 {b} 相關係數 {c:.2f}——兩檔會一起漲一起跌，"
                        f"分散效果比看起來少")
    if n < TRADING_DAYS:
        warnings.append(f"共同交易日只有 {n} 天（不到一年），所有統計都要打折看")

    return {
        "weights": w, "n_days": n,
        "ann_vol": vol, "spy_vol": spy_vol, "vol_ratio": ratio, "risk_label": risk_label,
        "sharpe": sp, "sharpe_band": sharpe_band(sp),
        "max_dd": max_drawdown(equity),
        "hhi": hhi, "effective_n": 1.0 / hhi if hhi > 0 else None,
        "max_weight": (max_w_sym, w[max_w_sym]),
        "correlations": corr,
        "stability": stability_score(port, equity),
        "warnings": warnings,
    }
