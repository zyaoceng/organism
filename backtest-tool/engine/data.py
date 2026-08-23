# -*- coding: utf-8 -*-
"""讀取 data/ 底下的日線 CSV 快取。

CSV 格式：date,open,high,low,close,volume（日期升冪、YYYY-MM-DD）。
資料來源：券商行情（IBKR）抓下來的真實日線。沙箱裡 yfinance 被擋，
所以一律走「先存檔、再讀檔」，大量歷史資料不進對話。
"""
import csv
import os
from dataclasses import dataclass

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


@dataclass(frozen=True)
class Bar:
    date: str   # YYYY-MM-DD
    open: float
    high: float
    low: float
    close: float
    volume: float


def load_bars(symbol, data_dir=None):
    """讀一檔的全部日線。回傳 list[Bar]，日期升冪。"""
    path = os.path.join(data_dir or DATA_DIR, f"{symbol}.csv")
    bars = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            o, h, l, c = (float(row["open"]), float(row["high"]),
                          float(row["low"]), float(row["close"]))
            # 少數交易日收盤集合競價的成交價會印在盤中高低區間外（來源瑕疵），
            # 這裡把高低價鉗到至少包含開盤與收盤，模擬器才不會漏觸價。
            bars.append(Bar(
                date=row["date"],
                open=o,
                high=max(h, o, c),
                low=min(l, o, c),
                close=c,
                volume=float(row["volume"] or 0),
            ))
    if any(bars[i].date >= bars[i + 1].date for i in range(len(bars) - 1)):
        raise ValueError(f"{symbol}: 日期沒有嚴格遞增，資料檔有問題")
    return bars


def slice_bars(bars, start=None, end=None):
    """取日期區間（含頭含尾）。日期用字串比較即可，因為是 YYYY-MM-DD。"""
    return [b for b in bars if (start is None or b.date >= start) and (end is None or b.date <= end)]


def daily_returns(bars):
    """收盤對收盤的日報酬。回傳 (dates, returns)，dates[i] 對應 returns[i] 當天。"""
    dates, rets = [], []
    for i in range(1, len(bars)):
        dates.append(bars[i].date)
        rets.append(bars[i].close / bars[i - 1].close - 1.0)
    return dates, rets


def align_returns(series_map):
    """把多檔的 (dates, returns) 對齊到共同交易日（交集）。

    series_map: {symbol: (dates, returns)}
    回傳 (common_dates, {symbol: aligned_returns})。
    共同交易日太少時照樣回傳，由呼叫端決定要不要警告。
    """
    if not series_map:
        return [], {}
    date_sets = [set(d) for d, _ in series_map.values()]
    common = sorted(set.intersection(*date_sets))
    aligned = {}
    for sym, (dates, rets) in series_map.items():
        idx = {d: r for d, r in zip(dates, rets)}
        aligned[sym] = [idx[d] for d in common]
    return common, aligned
