#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 data/*.csv 的日線資料內嵌進 index.html。

跑法：python3 embed_data.py
會把 index.html 裡 //__DATA_START__ 與 //__DATA_END__ 之間的內容
換成最新的價格資料。抓了新資料之後重跑一次就好。
"""
import csv
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
HTML = os.path.join(HERE, "index.html")

# 每一檔附註：資料窗與幣別的提醒，前端會顯示。
META = {
    "MU":   {"name": "美光 Micron", "currency": "USD", "note": ""},
    "SNDK": {"name": "SanDisk", "currency": "USD",
             "note": "2025-02 從威騰分拆，歷史只有一年半"},
    "SPY":  {"name": "SPY（標普 500 ETF）", "currency": "USD", "note": "基準"},
    "SOXX": {"name": "SOXX（半導體 ETF）", "currency": "USD", "note": "族群對照"},
    "8299": {"name": "群聯（台幣計價）", "currency": "TWD",
             "note": "來源只給九個月資料；報酬以台幣計，未含匯率"},
}


def load(sym):
    d, o, h, l, c = [], [], [], [], []
    with open(os.path.join(DATA_DIR, f"{sym}.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            oo, hh, ll, cc = (float(row["open"]), float(row["high"]),
                              float(row["low"]), float(row["close"]))
            # 與 engine/data.py 相同的鉗制：高低價至少要包含開收盤。
            d.append(row["date"])
            o.append(round(oo, 4))
            h.append(round(max(hh, oo, cc), 4))
            l.append(round(min(ll, oo, cc), 4))
            c.append(round(cc, 4))
    return {"d": d, "o": o, "h": h, "l": l, "c": c,
            "meta": META.get(sym, {"name": sym, "currency": "USD", "note": ""})}


def main():
    out = {}
    for fn in sorted(os.listdir(DATA_DIR)):
        if fn.endswith(".csv"):
            sym = fn[:-4]
            out[sym] = load(sym)
            print(f"{sym}: {len(out[sym]['d'])} 天 "
                  f"{out[sym]['d'][0]} ~ {out[sym]['d'][-1]}")
    blob = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    with open(HTML, encoding="utf-8") as f:
        html = f.read()
    new = re.sub(
        r"//__DATA_START__.*?//__DATA_END__",
        "//__DATA_START__\nconst PRICE_DATA = " + blob + ";\n//__DATA_END__",
        html, flags=re.S)
    if new == html:
        raise SystemExit("index.html 裡找不到資料標記，沒有改任何東西")
    with open(HTML, "w", encoding="utf-8") as f:
        f.write(new)
    print(f"已寫入 index.html（資料 {len(blob):,} 字元）")


if __name__ == "__main__":
    main()
