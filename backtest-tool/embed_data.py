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

# 手寫附註：這些是判斷，不是抓得到的欄位，所以留在程式裡，
# 會蓋過 Yahoo 帶回來的自動欄位。新抓的標的不必在這裡登記。
NOTES = {
    "MU":   {"name": "美光 Micron"},
    "SNDK": {"name": "SanDisk", "note": "2025-02 從威騰分拆，歷史只有一年半"},
    "SPY":  {"name": "SPY（標普 500 ETF）", "note": "基準"},
    "SOXX": {"name": "SOXX（半導體 ETF）", "note": "族群對照"},
    "8299": {"name": "群聯（台幣計價）", "currency": "TWD",
             "note": "來源只給九個月資料；報酬以台幣計，未含匯率"},
}
# 原始五檔是用券商行情抓的；之後用 fetch_yahoo.py 抓的會自己標 Yahoo Finance。
BROKER_SEED = {"MU", "SNDK", "SPY", "SOXX", "8299"}


def load_auto_meta():
    """讀 fetch_yahoo.py 留下的 data/_meta.json（沒有就當空的）。"""
    path = os.path.join(DATA_DIR, "_meta.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def meta_for(sym, auto):
    """自動欄位打底，手寫附註蓋上去。"""
    a = auto.get(sym) or {}
    m = {
        "name": a.get("name") or sym,
        "currency": a.get("currency") or ("USD" if sym in BROKER_SEED else "?"),
        "note": "",
        "source": a.get("source") or ("券商行情" if sym in BROKER_SEED else "自行匯入"),
        "fetched": a.get("fetched_at", ""),
    }
    m.update(NOTES.get(sym, {}))
    return m


def load(sym):
    d, o, h, l, c = [], [], [], [], []
    with open(os.path.join(DATA_DIR, f"{sym}.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            oo, hh, ll, cc = (float(row["open"]), float(row["high"]),
                              float(row["low"]), float(row["close"]))
            # 與 engine/data.py 相同的鉗制：高低價至少要包含開收盤。
            # 不做捨入——內嵌值要和 CSV 逐位元一致，跨引擎才能對帳到底。
            d.append(row["date"])
            o.append(oo)
            h.append(max(hh, oo, cc))
            l.append(min(ll, oo, cc))
            c.append(cc)
    return {"d": d, "o": o, "h": h, "l": l, "c": c}


def main():
    out = {}
    auto = load_auto_meta()
    for fn in sorted(os.listdir(DATA_DIR)):
        if fn.endswith(".csv") and not fn.startswith("_"):
            sym = fn[:-4]
            out[sym] = load(sym)
            out[sym]["meta"] = meta_for(sym, auto)
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
