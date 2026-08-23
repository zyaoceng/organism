# -*- coding: utf-8 -*-
"""交易計畫模擬器：一個計畫＝首筆進場＋若干加碼筆，每一筆有自己的停損停利。

成交規則（全部寫死，HTML 版的 JavaScript 鏡射同一套規則）：

1. 逐日往後走，任何決定只用「當天和更早」的資料——絕不偷看未來。
2. 進場方式三種：
   - open        ：回測起點第一根 K 的開盤價直接買（對應「今晚決定、明早開盤進場」）。
   - limit_below ：跌到觸發價買。當天開盤就低於觸發價 → 用開盤價成交（跳空照實吃）；
                   否則當天最低價碰到觸發價 → 用觸發價成交。
   - stop_above  ：漲到觸發價買（突破加碼）。開盤高於觸發價 → 開盤價成交；
                   否則最高價碰到 → 觸發價成交。
3. 出場（每一筆獨立看自己的停損停利）：
   - 開盤價先看：開盤已高於停利價 → 停利單必在開盤成交，用開盤價出，不管盤中
     有沒有碰到停損；開盤已低於停損價 → 同理，開盤價停損出場。跳空照實吃。
   - 開盤價落在停損與停利之間，才有「順序無法得知」的問題：
     盤中只碰到一邊 → 用那一邊的價位出場；兩邊都碰到 → 預設當作先碰到停損
     （ambiguous="worst"；可改 "best" 做敏感度對照，但報告一律以 worst 為準）。
4. 當天才進場的那一筆，同一天也檢查出場，用「進場價」代替開盤價做上面的先看：
   進場價已高於停利 → 立即停利在進場價；已低於停損 → 立即停損在進場價。
   之後的認定按模式取邊界：worst 是下界——停損用全日最低價認定（就算最低點
   可能發生在進場前，也從寬認賠），停利卻要收盤價站上停利價才算（收盤一定在
   進場之後）；best 是上界——反過來，停利用全日最高價認定、停損要收盤跌破才算。
   兩個模式夾出同日進出的真實結果範圍。
5. 交易成本單邊 0.05%。買進付 資金×(1+0.0005)，賣出收 市值×(1−0.0005)。
6. 不開槓桿、現金不得為負：現金不夠的加碼筆直接跳過，記成一條違規訊息，不是報錯。
   注意：跳過是「永久的」——那一筆整段回測不再嘗試進場，即使之後停損出場讓現金
   回籠、觸發價又再碰到也一樣。要重試的話請把它拆成另一個情境來比。
7. 股數允許小數（美股可買碎股）；每一筆的股數 = 投入金額 ÷ 成交價。
8. 檢查完出場才檢查進場（同一天先出後進，出場釋放的現金當天可用於加碼）。
9. 回測期間結束時還沒出場的筆，用最後一根收盤價平倉，出場原因記「期末平倉」。

「假設路徑」模式：把一條假想價格路徑（例如「從現價一路跌 15% 再漲 30%」）攤成一串
合成 K 棒（開高低收同價），丟進同一個模擬器跑。這樣假設獲利和歷史重播用的是
同一套成交規則，不會有兩套邏輯對不上的問題。
"""
from dataclasses import dataclass, field

from .config import COST_RATE
from .data import Bar


@dataclass
class Tranche:
    label: str                    # 「首筆」「加碼一」……
    trigger: str                  # 'open' | 'limit_below' | 'stop_above'
    capital: float                # 這一筆投入的金額
    trigger_price: float = None   # trigger=='open' 時免填
    stop_loss: float = None       # 沒設就是不停損
    take_profit: float = None     # 沒設就是不停利


@dataclass
class TrancheResult:
    label: str
    status: str                   # 'filled' | 'skipped_no_cash' | 'never_triggered' | 'open'
    entry_date: str = None
    entry_price: float = None
    shares: float = 0.0
    capital: float = 0.0
    exit_date: str = None
    exit_price: float = None
    exit_reason: str = None       # '停損' | '停利' | '期末平倉'
    pnl: float = 0.0              # 含買賣成本
    pnl_pct: float = 0.0          # 相對投入金額
    r_multiple: float = None      # (出場價-進場價)/(進場價-停損價)，沒設停損就沒有


@dataclass
class SimResult:
    symbol: str
    equity_dates: list = field(default_factory=list)
    equity: list = field(default_factory=list)         # 每日收盤後的總權益（現金＋持倉市值）
    tranches: list = field(default_factory=list)       # list[TrancheResult]
    violations: list = field(default_factory=list)     # 現金不足等訊息
    trace: list = field(default_factory=list)          # 逐日事件（給 explain_trade 用）
    final_equity: float = 0.0
    initial_capital: float = 0.0

    @property
    def total_pnl(self):
        return self.final_equity - self.initial_capital

    @property
    def total_return(self):
        return self.total_pnl / self.initial_capital if self.initial_capital else 0.0


class _Live:
    """模擬期間一筆 tranche 的內部狀態。"""

    def __init__(self, plan_tranche):
        self.t = plan_tranche
        self.res = TrancheResult(label=plan_tranche.label, status="never_triggered",
                                 capital=plan_tranche.capital)
        self.entered = False
        self.exited = False


def _entry_fill(tranche, bar, is_first_bar):
    """回傳成交價，沒觸發回傳 None。"""
    if tranche.trigger == "open":
        return bar.open if is_first_bar else None
    if tranche.trigger == "limit_below":
        if bar.open <= tranche.trigger_price:
            return bar.open
        if bar.low <= tranche.trigger_price:
            return tranche.trigger_price
        return None
    if tranche.trigger == "stop_above":
        if bar.open >= tranche.trigger_price:
            return bar.open
        if bar.high >= tranche.trigger_price:
            return tranche.trigger_price
        return None
    raise ValueError(f"未知的進場方式：{tranche.trigger}")


def _exit_check(t, bar, entered_today, entry_price, ambiguous):
    """回傳 (出場價, 原因) 或 (None, None)。實作 docstring 規則 3、4。

    起手價（隔日持倉＝開盤價；當天進場＝進場價）已經穿過其中一邊時，
    順序不是未知——那一邊必定先成交，ambiguous 根本輪不到上場。
    只有起手價落在兩價之間，才交給 ambiguous 裁決。
    """
    has_stop = t.stop_loss is not None
    has_tp = t.take_profit is not None
    ref = entry_price if entered_today else bar.open

    # 起手價已穿過某一邊 → 該邊立即成交（跳空／進場瞬間），照實吃。
    if has_tp and ref >= t.take_profit:
        return ref, "停利"
    if has_stop and ref <= t.stop_loss:
        return ref, "停損"

    if entered_today:
        # 全日高低點可能發生在進場之前。worst＝下界：停損從寬（全日低點）、
        # 停利從嚴（要收盤站上）；best＝上界：反過來。
        if ambiguous == "worst":
            stop_hit = has_stop and bar.low <= t.stop_loss
            tp_hit = has_tp and bar.close >= t.take_profit
        else:
            stop_hit = has_stop and bar.close <= t.stop_loss
            tp_hit = has_tp and bar.high >= t.take_profit
    else:
        stop_hit = has_stop and bar.low <= t.stop_loss
        tp_hit = has_tp and bar.high >= t.take_profit

    if stop_hit and tp_hit:
        first = "stop" if ambiguous == "worst" else "tp"
    elif stop_hit:
        first = "stop"
    elif tp_hit:
        first = "tp"
    else:
        return None, None
    if first == "stop":
        return t.stop_loss, "停損"
    return t.take_profit, "停利"


def simulate(symbol, bars, tranches, initial_capital, ambiguous="worst",
             cost_rate=COST_RATE, close_at_end=True):
    """跑一個交易計畫。bars 必須已切好回測區間、日期升冪。"""
    if ambiguous not in ("worst", "best"):
        raise ValueError("ambiguous 只能是 'worst' 或 'best'")
    for t in tranches:
        if not (t.capital > 0):
            raise ValueError(f"{t.label}：投入金額必須是正數（收到 {t.capital}）")
    res = SimResult(symbol=symbol, initial_capital=initial_capital)
    cash = initial_capital
    lives = [_Live(t) for t in tranches]

    for i, bar in enumerate(bars):
        entered_today = set()

        # ── 先檢查「昨天以前就進場」的出場 ──
        for lv in lives:
            if not lv.entered or lv.exited:
                continue
            px, reason = _exit_check(lv.t, bar, False, lv.res.entry_price, ambiguous)
            if px is not None:
                cash += lv.res.shares * px * (1 - cost_rate)
                _close(lv, bar.date, px, reason, cost_rate)
                res.trace.append((bar.date, f"{lv.t.label}：{reason}出場 @ {px:g}"))

        # ── 再檢查進場（先出後進，釋放的現金當天可用） ──
        for lv in lives:
            if lv.entered or lv.res.status == "skipped_no_cash":
                continue
            px = _entry_fill(lv.t, bar, i == 0)
            if px is None:
                continue
            need = lv.t.capital * (1 + cost_rate)
            if need > cash + 1e-9:
                lv.res.status = "skipped_no_cash"
                res.violations.append(
                    f"{bar.date} {lv.t.label}：現金 {cash:,.2f} 不足以投入 "
                    f"{lv.t.capital:,.2f}（含成本需 {need:,.2f}），這筆沒有進場")
                res.trace.append((bar.date, f"{lv.t.label}：觸發但現金不足，跳過"))
                continue
            cash -= need
            lv.entered = True
            lv.res.status = "open"
            lv.res.entry_date = bar.date
            lv.res.entry_price = px
            lv.res.shares = lv.t.capital / px
            entered_today.add(id(lv))
            res.trace.append((bar.date, f"{lv.t.label}：進場 @ {px:g}，"
                                        f"{lv.res.shares:,.4f} 股，投入 {lv.t.capital:,.2f}"))

        # ── 當天才進場的，同一天也檢查出場（保守） ──
        for lv in lives:
            if id(lv) not in entered_today or lv.exited:
                continue
            px, reason = _exit_check(lv.t, bar, True, lv.res.entry_price, ambiguous)
            if px is not None:
                cash += lv.res.shares * px * (1 - cost_rate)
                _close(lv, bar.date, px, reason + "（進場當天）", cost_rate)
                res.trace.append((bar.date, f"{lv.t.label}：進場當天就{reason} @ {px:g}"))

        # ── 收盤結算 ──
        holding = sum(lv.res.shares * bar.close for lv in lives if lv.entered and not lv.exited)
        res.equity_dates.append(bar.date)
        res.equity.append(cash + holding)

    # ── 期末平倉 ──
    if bars and close_at_end:
        last = bars[-1]
        for lv in lives:
            if lv.entered and not lv.exited:
                cash += lv.res.shares * last.close * (1 - cost_rate)
                _close(lv, last.date, last.close, "期末平倉", cost_rate)
        res.equity[-1] = cash

    res.final_equity = res.equity[-1] if res.equity else initial_capital
    res.tranches = [lv.res for lv in lives]
    return res


def _close(lv, date, price, reason, cost_rate):
    r = lv.res
    r.exit_date = date
    r.exit_price = price
    r.exit_reason = reason
    buy_cost = lv.t.capital * cost_rate
    proceeds = r.shares * price * (1 - cost_rate)
    r.pnl = proceeds - lv.t.capital - buy_cost
    r.pnl_pct = r.pnl / lv.t.capital
    if lv.t.stop_loss is not None and r.entry_price and r.entry_price > lv.t.stop_loss:
        r.r_multiple = (price - r.entry_price) / (r.entry_price - lv.t.stop_loss)
    r.status = "filled"
    lv.exited = True


# ────────────────────────── 假設路徑 ──────────────────────────

def synthetic_bars(anchor_prices, tranches):
    """把一條假想路徑（錨點價格序列）攤成合成 K 棒。

    兩個錨點之間，把所有會被路過的關鍵價位（各筆的觸發價、停損、停利）
    依行進方向插進去，每個價位一根「開高低收同價」的合成 K 棒。
    這樣觸價成交都會精準落在關鍵價位上，和成交規則完全一致。
    """
    levels = set()
    for t in tranches:
        for p in (t.trigger_price, t.stop_loss, t.take_profit):
            if p is not None:
                levels.add(p)
    path = []
    for k in range(len(anchor_prices) - 1):
        a, b = anchor_prices[k], anchor_prices[k + 1]
        if not path:
            path.append(a)
        crossed = sorted([p for p in levels if min(a, b) < p < max(a, b)],
                         reverse=(b < a))
        path.extend(crossed)
        path.append(b)
    if len(anchor_prices) == 1:
        path = [anchor_prices[0]]
    # 標籤與網頁 JS 版一致（「第N步」），跨引擎對帳時日期欄才對得上。
    return [Bar(date=f"第{i}步", open=p, high=p, low=p, close=p, volume=0)
            for i, p in enumerate(path)]


def payoff_curve(tranches, current_price, targets, initial_capital,
                 ambiguous="worst", cost_rate=COST_RATE):
    """「假設價格從現價一路走到目標價、不回頭」之下，整個計畫的損益。

    回傳 list[(目標價, 損益金額, 報酬率)]。報酬率相對 initial_capital。
    路徑單邊、不回頭，是刻意的簡化——真實走勢會來回，
    來回的情境請用 simulate + synthetic_bars 自訂路徑。
    """
    out = []
    for x in targets:
        bars = synthetic_bars([current_price, x], tranches)
        r = simulate("hypothetical", bars, tranches, initial_capital,
                     ambiguous=ambiguous, cost_rate=cost_rate, close_at_end=True)
        out.append((x, r.total_pnl, r.total_return))
    return out
