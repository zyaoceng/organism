# -*- coding: utf-8 -*-
"""共識 forward EPS × 自訂本益比區間 → 隱含股價與部位損益。

恆等式只有一條：價格 = 每股盈餘 × 本益比。
每股盈餘可以算對算錯（用共識數字，開獎日會揭曉）；
本益比沒有正解，只有你自己給的區間——所以區間是輸入，不是程式替你決定。

嚴禁事項（寫在這裡是給未來的自己看的）：
不要把「今天算出來的合理本益比」乘上「後年的每股盈餘」再說那是現在的合理價，
那是把兩個時間點的東西相乘。表格每一格只回答一個問題：
「如果市場用這個本益比對待這個每股盈餘，價格會是多少、我的部位賺賠多少。」
"""


def eps_pe_grid(eps_scenarios, pe_points, current_price, shares=0.0, avg_cost=None):
    """算出 EPS × PE 的完整矩陣。

    eps_scenarios: [{"label": "FY2027 共識", "eps": 213.23}, ...]
    pe_points:     [5, 7.5, 10] 之類，由使用者自訂。
    shares:        持有股數（0 就只看價格不看損益）。
    avg_cost:      平均成本；沒給就用 current_price（等於「現在才買」）。

    回傳每一格：隱含價格、對現價的漲跌幅、部位市值變化、對成本的損益。
    """
    if current_price is None or current_price <= 0:
        raise ValueError("現價必須是正數")
    # 0 或負的成本視同沒填、退回用現價——與網頁 JS 版同一個判斷。
    base_cost = avg_cost if (avg_cost is not None and avg_cost > 0) else current_price
    rows = []
    for sc in eps_scenarios:
        eps = float(sc["eps"])
        cells = []
        for pe in pe_points:
            implied = eps * float(pe)
            cells.append({
                "pe": float(pe),
                "implied_price": implied,
                "vs_current": implied / current_price - 1.0,
                "position_pnl": shares * (implied - base_cost),
                "vs_cost": (implied / base_cost - 1.0) if base_cost > 0 else None,
            })
        rows.append({"label": sc["label"], "eps": eps, "cells": cells})
    return {
        "current_price": current_price,
        "avg_cost": base_cost,
        "shares": shares,
        "current_pe": [
            {"label": sc["label"], "pe": current_price / float(sc["eps"])}
            for sc in eps_scenarios if float(sc["eps"]) != 0
        ],
        "rows": rows,
    }


def breakeven_pe(current_price, eps):
    """現價隱含的本益比——市場現在用幾倍在對待這個盈餘數字。"""
    if eps == 0:
        return None
    return current_price / eps
