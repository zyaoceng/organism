# -*- coding: utf-8 -*-
"""
VRVP 量價分佈指標（給富途/牛牛式「指標編輯 → Python」欄位用）

為什麼不是真正的 VRVP：
    VRVP = Visible Range Volume Profile，定義上要知道「圖表目前可視範圍的左右邊界」。
    這類指標編輯器只餵逐根 K 線序列，沒有任何 API 回傳視窗邊界，所以拿不到可視範圍。
    這支改成「滾動視窗量價分佈」：固定取最近 LOOKBACK 根 K 線算 profile。
    把 LOOKBACK 設成你螢幕上平常看得到的根數，出來的 POC/VAH/VAL 跟 VRVP 幾乎一致。

畫出什麼：
    POC  控制點，成交量最大的那一格價位（最厚的籌碼）
    VAH  價值區上緣
    VAL  價值區下緣（POC 往兩邊擴張到涵蓋總量 VALUE_AREA 為止）

用法：
    整份貼進指標編輯器的 Python 分頁 → 應用。三條線疊在主圖上。
    只改最上面四個參數就好。

演算法：
    視窗內最高最低價切成 BINS 格，每根 K 線的成交量沿著它自己的 [low, high]
    均攤到覆蓋到的格子（不是只算收盤價那一格，這是跟一般粗糙版本的差別）。
"""

# 定義指標基礎資訊（縮寫、全名、展示位置、指標介紹）
# 第三個參數 True = 疊在主圖；改成 False 會跑到副圖，價位線就對不上了
indicator("VRVP", "量價分佈 POC/VAH/VAL", True,
          "最近 N 根 K 線的成交量在價格軸上的分佈，標出控制點與價值區上下緣")


# ---------------- 參數 ----------------
LOOKBACK   = 120    # 統計視窗：最近幾根 K 線（等同你眼睛看到的範圍）
BINS       = 48     # 價格軸切幾格；格子愈多愈細，但 POC 會愈跳
VALUE_AREA = 0.70   # 價值區佔總成交量的比例，業界慣例 70%
CALC_BARS  = 400    # 只計算最後幾根 K 線，避免整段歷史跑太慢
# --------------------------------------

NAN = float("nan")


def _to_list(series):
    """把平台回傳的序列轉成一般 list，順便把 None 換成 nan。"""
    out = []
    for x in series:
        try:
            out.append(float(x))
        except (TypeError, ValueError):
            out.append(NAN)
    return out


def _volume_series(n):
    """取成交量；平台若沒有 volume()，退化成每根 K 線等權重。"""
    try:
        return _to_list(volume())
    except NameError:
        return [1.0] * n


def _is_bad(x):
    return x != x  # nan 不等於自己


def _profile(hi, lo, vol, start, end):
    """算 [start, end] 這段的量價分佈，回傳 (poc, vah, val) 三個價位。"""
    top = NAN
    bot = NAN
    for i in range(start, end + 1):
        if _is_bad(hi[i]) or _is_bad(lo[i]):
            continue
        if _is_bad(top) or hi[i] > top:
            top = hi[i]
        if _is_bad(bot) or lo[i] < bot:
            bot = lo[i]
    if _is_bad(top) or _is_bad(bot) or top <= bot:
        return NAN, NAN, NAN

    step = (top - bot) / BINS
    buckets = [0.0] * BINS

    for i in range(start, end + 1):
        h, l, v = hi[i], lo[i], vol[i]
        if _is_bad(h) or _is_bad(l) or _is_bad(v) or v <= 0:
            continue
        lo_idx = int((l - bot) / step)
        hi_idx = int((h - bot) / step)
        if lo_idx < 0:
            lo_idx = 0
        if hi_idx > BINS - 1:
            hi_idx = BINS - 1
        if hi_idx < lo_idx:
            hi_idx = lo_idx
        share = v / (hi_idx - lo_idx + 1)   # 成交量沿著當根的價格區間均攤
        for b in range(lo_idx, hi_idx + 1):
            buckets[b] += share

    total = 0.0
    poc_idx = 0
    for b in range(BINS):
        total += buckets[b]
        if buckets[b] > buckets[poc_idx]:
            poc_idx = b
    if total <= 0:
        return NAN, NAN, NAN

    # 從 POC 往兩邊擴張，每次併吞較厚的那一邊，直到涵蓋 VALUE_AREA
    target = total * VALUE_AREA
    lower = poc_idx
    upper = poc_idx
    covered = buckets[poc_idx]
    while covered < target and (lower > 0 or upper < BINS - 1):
        below = buckets[lower - 1] if lower > 0 else -1.0
        above = buckets[upper + 1] if upper < BINS - 1 else -1.0
        if above >= below:
            upper += 1
            covered += buckets[upper]
        else:
            lower -= 1
            covered += buckets[lower]

    poc = bot + (poc_idx + 0.5) * step
    vah = bot + (upper + 1) * step
    val = bot + lower * step
    return poc, vah, val


def function():
    """回傳三條序列：POC、VAH、VAL。"""
    hi = _to_list(high())
    lo = _to_list(low())
    n = len(hi)
    vol = _volume_series(n)

    poc_line = [NAN] * n
    vah_line = [NAN] * n
    val_line = [NAN] * n

    first = n - CALC_BARS
    if first < LOOKBACK - 1:
        first = LOOKBACK - 1

    for i in range(first, n):
        start = i - LOOKBACK + 1
        if start < 0:
            start = 0
        poc_line[i], vah_line[i], val_line[i] = _profile(hi, lo, vol, start, i)

    return poc_line, vah_line, val_line


# 當使用該指標時，執行以下程式碼
if __name__ == "__main__":

    poc, vah, val = function()

    plot("POC", poc)   # 控制點：籌碼最厚的價位
    plot("VAH", vah)   # 價值區上緣
    plot("VAL", val)   # 價值區下緣

    # 輸出用於指標回測的參數
    output_parameter(POC=poc, VAH=vah, VAL=val)
