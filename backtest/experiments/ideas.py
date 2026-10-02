"""실험 6: 새로운 접근 (ideas). 캐시만 읽고 증권사 API·AI는 부르지 않는다.

  uv run python backtest/experiments/ideas.py

추세·모멘텀 추종(기준)과 방향이 다른 접근을 시험한다. 매수만 하고, 리스크 엔진(손익비 ≥ 2.0, 손절 주문가 −1%)은
그대로 통과해야 한다. 기준(운영 규칙)은 첫 행.
  - 평균회귀, 급락 반등: 선별 함수와 시나리오 가격 함수를 함께 바꾼다
  - 역선별, 저변동, 상대강도, 고가 근접, 거래대금 순위 급상승: 선별만 바꾸고 시나리오는 기준(4.0·1.5 ATR)
  - 단순 기준선: 벤치마크 보유, 선별 상위 3개 동일 비중 10거래일 롤링 (Backtest 없이 캐시 일봉으로 직접 계산)
결과: backtest/results/experiments/ideas/summary.md, summary.json, <시장>-trades-N.csv
"""
import json
import random
import statistics
import sys
from dataclasses import replace
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (END, RESULTS, SPLIT, START, MarketData, Variant, load_market, run_variant,  # noqa: E402
                    write_report, write_trades)
from screen_rules import predict_row  # noqa: E402
from sim import RANK_COUNT, SCREEN_CANDLES, Backtest, Rule, net_return  # noqa: E402
from paper_engine.data import indicators  # noqa: E402
from paper_engine.judge import screen  # noqa: E402
from paper_engine.judge.risk import LIMITS, SELL_TAX_RATE, STOP_LIMIT_BUFFER  # noqa: E402

NAME = "ideas"
BASE_RULE = Rule("기준", 4.0, 1.5)
EXPECTED = {"KR": -17.81, "US": -17.76}
RR_MARGIN = 1.03  # 목표 보정 시 최소 손익비에 두는 여유 (호가 내림으로 손익비가 조금 줄어든다)
ROLL_HOLD = 10  # 롤링 기준선: 주문일 시가 매수 → 10거래일 뒤 종가 매도
# 주문일 시가에 사서 10거래일 뒤 종가에 팔면 매도일에 새 코호트가 이미 들어와 있어 11개가 겹친다.
# 자본금을 11 × 3 = 33칸으로 나눠 매일 최대 3종목을 사면 비중이 100%를 넘지 않는다
ROLL_COHORTS = ROLL_HOLD + 1
ROLL_SLOTS = ROLL_COHORTS * 3
RANDOM_SEEDS = (1, 2, 3)
WEEKDAYS = "월화수목금"


# --- 지표 ---

def _series(candles):
    closes = [float(c["closePrice"]) for c in candles]
    highs = [float(c["highPrice"]) for c in candles]
    lows = [float(c["lowPrice"]) for c in candles]
    return closes, highs, lows


def _pick(symbol, name, candles, amount, score) -> screen.Pick:
    closes, highs, lows = _series(candles)
    return screen.Pick(symbol, name, round(score, 2), closes[-1], indicators.rsi(closes) or 0.0,
                       indicators.atr(highs, lows, closes) / closes[-1], indicators.change_rate(closes, 20) or 0.0,
                       amount)


def min_target(entry: float, stop: float, commission: float, tax: float) -> float:
    """리스크 엔진의 최소 손익비를 넘는 가장 낮은 목표가 (risk.assess와 같은 비용 계산)."""
    sell = commission + tax
    loss = entry * (1 + commission) - stop * (1 - STOP_LIMIT_BUFFER) * (1 - sell)
    rr = LIMITS["SWING"].min_reward_risk * RR_MARGIN
    return (rr * loss + entry * (1 + commission)) / (1 - sell)


# --- 2. 평균회귀 매수 ---

def mean_reversion_screen(symbol, name, candles, amount):
    """60일선 위인데 RSI(14) < 35 또는 종가 < 20일선 − 1.5 ATR. 점수는 20일선 아래로 눌린 깊이 (ATR 배수)."""
    if len(candles) < screen.MIN_CANDLES:
        return f"일봉 {len(candles)}개"
    closes, highs, lows = _series(candles)
    close = closes[-1]
    sma20, sma60 = indicators.sma(closes, 20), indicators.sma(closes, 60)
    atr = indicators.atr(highs, lows, closes)
    rsi = indicators.rsi(closes)
    if close < sma60:
        return "60일선 아래"
    if not (rsi < 35 or close < sma20 - 1.5 * atr):
        return "눌림 아님"
    return _pick(symbol, name, candles, amount, (sma20 - close) / atr)


class ScenarioStats:
    """시나리오 함수가 목표가를 손익비 기준선까지 올린 횟수."""
    def __init__(self):
        self.n = self.raised = self.none = 0

    def as_dict(self):
        return {"n": self.n, "raised": self.raised, "none": self.none}


def mean_reversion_scenario(data: MarketData, adjust: bool, stats: ScenarioStats):
    """진입 = 전일 종가, 목표 = max(20일선, 진입 + 2 ATR), 손절 = 진입 − 1 ATR.
    adjust면 목표가 손익비 기준선보다 낮을 때 기준선까지 올린다 (리스크 엔진 통과용)."""
    tax = SELL_TAX_RATE[data.market]

    def f(bars, rule, atr):
        closes = [float(c["closePrice"]) for c in bars]
        entry = closes[-1]
        target, stop = max(indicators.sma(closes, 20), entry + 2 * atr), entry - atr
        stats.n += 1
        if adjust:
            need = min_target(entry, stop, data.commission_rate, tax)
            if need > target:
                target = need
                stats.raised += 1
        return entry, target, stop
    return f


# --- 3. 급락 반등 ---

def crash_screen(symbol, name, candles, amount):
    """전일 수익률 −5% 이하 또는 −2 ATR 이상 하락, 60일선 위. 점수는 하락폭 (ATR 배수)."""
    if len(candles) < screen.MIN_CANDLES:
        return f"일봉 {len(candles)}개"
    closes, highs, lows = _series(candles)
    close = closes[-1]
    atr = indicators.atr(highs, lows, closes)
    drop = closes[-2] - close
    if close < indicators.sma(closes, 60):
        return "60일선 아래"
    if not (close / closes[-2] - 1 <= -0.05 or drop >= 2 * atr):
        return "급락 아님"
    return _pick(symbol, name, candles, amount, drop / atr)


def crash_scenario(data: MarketData, adjust: bool, stats: ScenarioStats):
    """진입 = 전일 종가, 목표 = 전일 시가 (갭 메우기), 손절 = 전일 저가 − 0.5 ATR.
    전일 시가가 종가 이하면 (갭 하락 후 장중 반등) 목표가 없어 시나리오를 만들지 않는다. adjust면 평균회귀와 같이 보정."""
    tax = SELL_TAX_RATE[data.market]

    def f(bars, rule, atr):
        prev = bars[-1]
        entry = float(prev["closePrice"])
        target, stop = float(prev["openPrice"]), float(prev["lowPrice"]) - 0.5 * atr
        stats.n += 1
        if adjust:
            need = min_target(entry, stop, data.commission_rate, tax)
            if need > target:
                target = need
                stats.raised += 1
        elif target <= entry:
            stats.none += 1
            return None
        return entry, target, stop
    return f


# --- 4. 역선별 ---

def lowest_score(symbol, name, candles, amount):
    """기준 필터 통과 종목 중 점수가 가장 낮은 순."""
    p = screen.score(symbol, name, candles, amount)
    return p if isinstance(p, str) else replace(p, score=round(100 - p.score, 1))


def lowest_momentum(symbol, name, candles, amount):
    """기준 필터 통과 종목 중 20일 수익률이 가장 낮은 순."""
    p = screen.score(symbol, name, candles, amount)
    return p if isinstance(p, str) else replace(p, score=round(-p.change20d * 100, 2))


def lowest_return_unfiltered(days: int):
    """필터 없이 후보 30개 중 days일 수익률이 가장 낮은 순 (단순 반전)."""
    def f(symbol, name, candles, amount):
        if len(candles) < screen.MIN_CANDLES:
            return f"일봉 {len(candles)}개"
        closes = [float(c["closePrice"]) for c in candles]
        return _pick(symbol, name, candles, amount, -indicators.change_rate(closes, days) * 100)
    return f


# --- 5. 저변동 ---

def low_volatility(symbol, name, candles, amount):
    """기준 필터 통과 + ATR 비율 1.5~3%. 변동성이 낮을수록 높은 점수."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    if p.atr_ratio > 0.03:
        return f"ATR 비율 {p.atr_ratio:.1%} > 3%"
    return replace(p, score=round((0.03 - p.atr_ratio) * 1000, 2))


# --- 6. 벤치마크 대비 상대강도 ---

def bench_change20(bench: list[dict], last_date: str) -> float | None:
    """last_date(선별 종목의 마지막 봉 = 주문일 전날) 이하의 벤치마크 봉만으로 20일 수익률."""
    closes = [float(c["closePrice"]) for c in bench if c["date"] <= last_date]
    return indicators.change_rate(closes, 20)


def relative_strength(data: MarketData, strong: bool):
    """기준 필터 통과 종목 중 strong이면 20일 수익률 > 벤치마크 20일 수익률, 초과폭이 클수록 높은 점수.
    아니면 벤치마크보다 약한 종목만, 약할수록 높은 점수 (상대약세 반등).
    필터 없는 상대약세는 넣지 않았다: 벤치마크 수익률은 그날 모든 종목에 같아서 순서가 '20일 수익률 최하위 (필터 없음)'과
    같고, 하위 3개는 거의 항상 벤치마크보다 약하므로 결과도 같다."""
    def f(symbol, name, candles, amount):
        p = screen.score(symbol, name, candles, amount)
        if isinstance(p, str):
            return p
        b = bench_change20(data.bench, candles[-1]["date"])
        if b is None:
            return "벤치마크 일봉 부족"
        excess = p.change20d - b
        if (excess <= 0) if strong else (excess >= 0):
            return f"벤치마크 대비 {excess:+.1%}"
        return replace(p, score=round((excess if strong else -excess) * 100, 2))
    return f


# --- 8. 추가 아이디어 ---

def near_high(symbol, name, candles, amount):
    """선별 창(130거래일, 약 6개월) 고가의 3% 안, 60일선 위. 고가에 가까울수록 높은 점수.
    52주 고가는 캐시 일봉이 2025-11부터라 계산할 수 없어 130일로 대신한다."""
    if len(candles) < screen.MIN_CANDLES:
        return f"일봉 {len(candles)}개"
    closes, highs, _ = _series(candles)
    ratio = closes[-1] / max(highs)
    if closes[-1] < indicators.sma(closes, 60):
        return "60일선 아래"
    if ratio < 0.97:
        return f"고가 대비 {ratio - 1:+.1%}"
    return _pick(symbol, name, candles, amount, ratio * 100)


class Ranks:
    """날짜별 유니버스 안 거래대금 순위 (1위부터). Backtest.scan과 같은 기준 (종가 × 거래량)."""
    def __init__(self, data: MarketData):
        self.data = data
        self.index = {sym: {c["date"]: i for i, c in enumerate(bars)} for sym, bars in data.candles.items()}
        by_date: dict[str, list] = {}
        for sym, bars in data.candles.items():
            for c in bars:
                by_date.setdefault(c["date"], []).append((float(c["closePrice"]) * float(c["volume"]), sym))
        self.ranked = {d: [s for _, s in sorted(rows, reverse=True)] for d, rows in by_date.items()}
        self.rank = {d: {s: i for i, s in enumerate(syms, 1)} for d, syms in self.ranked.items()}
        self.days = sorted(self.ranked)

    def of(self, day: str, sym: str) -> int:
        return self.rank.get(day, {}).get(sym, len(self.data.candles))


def rank_jump(ranks: Ranks, min_jump: int = 30):
    """전일 순위가 그 전 20거래일 순위 중앙값보다 min_jump 이상 올라온 종목. 많이 오를수록 높은 점수."""
    def f(symbol, name, candles, amount):
        if len(candles) < screen.MIN_CANDLES:
            return f"일봉 {len(candles)}개"
        now = ranks.of(candles[-1]["date"], symbol)
        before = statistics.median(ranks.of(c["date"], symbol) for c in candles[-21:-1])
        if before - now < min_jump:
            return f"순위 {before:.0f} → {now}"
        return _pick(symbol, name, candles, amount, before - now)
    return f


def random_pick(seed: int):
    """대조군: 후보 30개 중 일봉 60개 이상인 종목을 무작위 순서로."""
    def f(symbol, name, candles, amount):
        if len(candles) < screen.MIN_CANDLES:
            return f"일봉 {len(candles)}개"
        rng = random.Random(f"{seed}:{symbol}:{candles[-1]['date']}")
        return _pick(symbol, name, candles, amount, rng.random() * 100)
    return f


def all_candidates(symbol, name, candles, amount):
    """대조군: 후보 30개 전체 (일봉 60개 이상). 점수는 거래대금."""
    if len(candles) < screen.MIN_CANDLES:
        return f"일봉 {len(candles)}개"
    return _pick(symbol, name, candles, amount, amount)


# --- 변형 ---

def variants(data: MarketData, ranks: Ranks) -> tuple[list[Variant], dict[str, ScenarioStats]]:
    stats: dict[str, ScenarioStats] = {}

    def v(label, rule=BASE_RULE, screen_fn=None, scenario=None, adjust=False, **overrides):
        kw = {}
        if screen_fn is not None:
            kw["screen_fn"] = screen_fn
        if scenario is not None:
            stats[label] = ScenarioStats()
            kw["scenario_fn"] = scenario(data, adjust, stats[label])
        return Variant(label, data.base_settings(**overrides), rule, kw)

    mr5, mr10 = Rule("평균회귀 5일", 2.0, 1.0, holding_days=5), Rule("평균회귀 10일", 2.0, 1.0, holding_days=10)
    cr5, cr10 = Rule("급락 반등 5일", 0.0, 0.5, holding_days=5), Rule("급락 반등 10일", 0.0, 0.5, holding_days=10)
    out = [
        v("기준"),
        v("평균회귀 5일", mr5, mean_reversion_screen, mean_reversion_scenario),
        v("평균회귀 10일", mr10, mean_reversion_screen, mean_reversion_scenario),
        v("평균회귀 5일, 목표 보정", mr5, mean_reversion_screen, mean_reversion_scenario, True),
        v("평균회귀 10일, 목표 보정", mr10, mean_reversion_screen, mean_reversion_scenario, True),
        v("평균회귀 10일, 목표 보정, 시가 진입", mr10, mean_reversion_screen, mean_reversion_scenario, True,
          entry_mode="open"),
        v("급락 반등 5일", cr5, crash_screen, crash_scenario),
        v("급락 반등 5일, 목표 보정", cr5, crash_screen, crash_scenario, True),
        v("급락 반등 10일, 목표 보정", cr10, crash_screen, crash_scenario, True),
        v("역선별: 점수 최하위", screen_fn=lowest_score),
        v("역선별: 20일 수익률 최하위 (필터 통과)", screen_fn=lowest_momentum),
        v("역선별: 20일 수익률 최하위 (필터 없음)", screen_fn=lowest_return_unfiltered(20)),
        v("역선별: 5일 수익률 최하위 (필터 없음)", screen_fn=lowest_return_unfiltered(5)),
        v("저변동 (ATR 1.5~3%)", screen_fn=low_volatility),
        v("상대강도 상위", screen_fn=relative_strength(data, strong=True)),
        v("상대약세 (필터 통과)", screen_fn=relative_strength(data, strong=False)),
        v("추가: 130일 고가 3% 안", screen_fn=near_high),
        v("추가: 거래대금 순위 급상승", screen_fn=rank_jump(ranks)),
    ]
    return out, stats


# 롤링 기준선에 쓸 선별 (라벨, 선별 함수, 하루 종목 수). 시나리오를 따로 쓰는 변형도 선별만 떼어 본다
def rolling_screens(data: MarketData, ranks: Ranks) -> list[tuple[str, object, int]]:
    rows = [
        ("기준 선별 상위 3", screen.score, 3),
        ("평균회귀 선별", mean_reversion_screen, 3),
        ("급락 반등 선별", crash_screen, 3),
        ("역선별: 점수 최하위", lowest_score, 3),
        ("역선별: 20일 수익률 최하위 (필터 통과)", lowest_momentum, 3),
        ("역선별: 20일 수익률 최하위 (필터 없음)", lowest_return_unfiltered(20), 3),
        ("역선별: 5일 수익률 최하위 (필터 없음)", lowest_return_unfiltered(5), 3),
        ("저변동 (ATR 1.5~3%)", low_volatility, 3),
        ("상대강도 상위", relative_strength(data, strong=True), 3),
        ("상대약세 (필터 통과)", relative_strength(data, strong=False), 3),
        ("추가: 130일 고가 3% 안", near_high, 3),
        ("추가: 거래대금 순위 급상승", rank_jump(ranks), 3),
    ]
    rows += [(f"대조군: 무작위 3 seed {s}", random_pick(s), 3) for s in RANDOM_SEEDS]
    rows.append(("대조군: 후보 30 전체", all_candidates, 30))
    return rows


# --- 7. 단순 기준선 (Backtest 없이 캐시 일봉으로 직접 계산) ---

def benchmark_hold(data: MarketData) -> dict:
    """벤치마크를 기간 첫 거래일 시가에 사서 마지막 거래일 종가까지 보유 (비용 포함, 1회 매수·매도)."""
    bars = [c for c in data.bench if START <= c["date"] <= END]
    fill = float(bars[0]["openPrice"])
    c, tax = data.commission_rate, SELL_TAX_RATE[data.market]
    equity = [(b["date"], 1 + net_return(fill, float(b["closePrice"]), c, tax)) for b in bars]
    first = [e for d, e in equity if d < SPLIT]
    values = [e for _, e in equity]
    return {"label": "벤치마크 보유 (6/1 시가 → 9/29 종가)", "returnPct": (values[-1] - 1) * 100,
            "firstHalfPct": (first[-1] - 1) * 100, "secondHalfPct": (values[-1] / first[-1] - 1) * 100,
            "mddPct": _mdd(values) * 100, "period": f"{bars[0]['date']} ~ {bars[-1]['date']}"}


def _mdd(values):
    peak, worst = values[0], 0.0
    for v in values:
        peak = max(peak, v)
        worst = min(worst, v / peak - 1)
    return worst


def rolling_picks(data: MarketData, ranks: Ranks, screen_fn, top: int) -> dict[str, list[str]]:
    """날짜 → 그날 정규장 전에 고른 종목 (Backtest.scan과 같은 규칙: 전일 거래대금 상위 30 → 점수 순 상위 top)."""
    out = {}
    calendar = [d for d in ranks.days if START <= d <= END]
    for day in calendar:
        prev = ranks.days[ranks.days.index(day) - 1]
        picks = []
        for sym in ranks.ranked[prev][:RANK_COUNT][:30]:
            i = ranks.index[sym][prev]
            window = data.candles[sym][:i + 1][-SCREEN_CANDLES:]
            p = screen_fn(sym, data.names.get(sym, sym), window,
                          float(window[-1]["closePrice"]) * float(window[-1]["volume"]))
            if isinstance(p, screen.Pick):
                picks.append(p)
        picks.sort(key=lambda p: p.score, reverse=True)
        out[day] = [p.symbol for p in picks[:top]]
    return out


def rolling_trades(data: MarketData, ranks: Ranks, picks: dict[str, list[str]]) -> list[dict]:
    """주문일 시가 매수 → ROLL_HOLD거래일 뒤 종가 매도. 그 봉이 없으면 마지막 종가로 평가 (complete=False)."""
    c, tax = data.commission_rate, SELL_TAX_RATE[data.market]
    trades = []
    for day, syms in picks.items():
        for sym in syms:
            bars = data.candles[sym]
            i = ranks.index[sym].get(day)
            if i is None:  # 주문일 봉이 없다 (거래정지)
                continue
            j = min(i + ROLL_HOLD, len(bars) - 1)
            fill = float(bars[i]["openPrice"])
            trades.append({"day": day, "symbol": sym, "fill": fill, "exitDay": bars[j]["date"],
                           "complete": i + ROLL_HOLD < len(bars),
                           "ret": net_return(fill, float(bars[j]["closePrice"]), c, tax),
                           "path": [(b["date"], net_return(fill, float(b["closePrice"]), c, tax))
                                    for b in bars[i:j + 1]]})
    return trades


def rolling_equity(trades: list[dict], calendar: list[str], slot: float) -> list[tuple[str, float]]:
    """자본금 1 기준 평가금액 곡선. 각 거래는 slot 금액 (고정, 복리 없음). 청산 뒤 손익은 확정."""
    equity = []
    for day in calendar:
        pnl = 0.0
        for t in trades:
            if t["day"] > day:
                continue
            marks = [r for d, r in t["path"] if d <= day]
            if marks:
                pnl += slot * marks[-1]
        equity.append((day, 1 + pnl))
    return equity


def rolling_row(label: str, data: MarketData, trades: list[dict], calendar: list[str], bench_by_day: dict,
                top: int) -> dict:
    slot = 1 / (ROLL_COHORTS * top)
    equity = rolling_equity(trades, calendar, slot)
    values = [e for _, e in equity]
    first = [e for d, e in equity if d < SPLIT]
    done = [t for t in trades if t["complete"]]
    rets = [t["ret"] for t in done]
    excess = [t["ret"] - bench_by_day[t["day"]] for t in done if t["day"] in bench_by_day]
    days_used = len({t["day"] for t in trades})
    return {"label": label, "n": len(done), "days": days_used,
            "meanPct": statistics.mean(rets) * 100 if rets else None,
            "winRatePct": sum(r > 0 for r in rets) / len(rets) * 100 if rets else None,
            "excessPct": statistics.mean(excess) * 100 if excess else None,
            "firstMeanPct": _mean_pct([t["ret"] for t in done if t["day"] < SPLIT]),
            "secondMeanPct": _mean_pct([t["ret"] for t in done if t["day"] >= SPLIT]),
            "nFirst": sum(t["day"] < SPLIT for t in done), "nSecond": sum(t["day"] >= SPLIT for t in done),
            "returnPct": (values[-1] - 1) * 100, "firstHalfPct": (first[-1] - 1) * 100,
            "secondHalfPct": (values[-1] / first[-1] - 1) * 100, "mddPct": _mdd(values) * 100,
            "avgExposurePct": statistics.mean(
                sum(1 for t in trades if t["day"] <= d <= t["exitDay"]) * slot for d in calendar) * 100}


def _mean_pct(values):
    return statistics.mean(values) * 100 if values else None


def paired_excess(trades: list[dict], control: list[dict]) -> dict:
    """같은 날 '후보 30 전체' 평균 대비 초과 수익 (일별 평균의 차). 10거래일 보유가 겹쳐 일별 값이 독립이 아니므로
    유효 표본을 (일수 ÷ 10)으로 보고 t값을 낸다 (대략적인 보정)."""
    def daily(ts):
        by = {}
        for t in ts:
            if t["complete"]:
                by.setdefault(t["day"], []).append(t["ret"])
        return {d: statistics.mean(v) for d, v in by.items()}
    a, b = daily(trades), daily(control)
    diffs = [a[d] - b[d] for d in a if d in b]
    if len(diffs) < 3:
        return {"days": len(diffs), "meanPct": None, "t": None}
    sd = statistics.stdev(diffs)
    eff = max(len(diffs) / ROLL_HOLD, 1)
    return {"days": len(diffs), "meanPct": statistics.mean(diffs) * 100,
            "t": statistics.mean(diffs) / (sd / eff ** 0.5) if sd else None}


def bench_returns(data: MarketData) -> dict[str, float]:
    """주문일 → 같은 구간 (시가 → ROLL_HOLD거래일 뒤 종가) 벤치마크 수익률 (비용 없음)."""
    out = {}
    for i, c in enumerate(data.bench):
        if i + ROLL_HOLD < len(data.bench):
            out[c["date"]] = float(data.bench[i + ROLL_HOLD]["closePrice"]) / float(c["openPrice"]) - 1
    return out


def weekday_rows(label: str, trades: list[dict]) -> dict:
    row = {"label": label}
    for k, name in enumerate(WEEKDAYS):
        rets = [t["ret"] for t in trades if t["complete"] and date.fromisoformat(t["day"]).weekday() == k]
        row[name] = (_mean_pct(rets), len(rets))
    return row


def run_rolling(data: MarketData, ranks: Ranks) -> tuple[list[dict], dict, list[dict], dict]:
    calendar = [d for d in ranks.days if START <= d <= END]
    bench_by_day = bench_returns(data)
    rows, trades_by = [], {}
    for label, fn, top in rolling_screens(data, ranks):
        trades = rolling_trades(data, ranks, rolling_picks(data, ranks, fn, top))
        trades_by[label] = trades
        rows.append(rolling_row(label, data, trades, calendar, bench_by_day, top))
    seeds = [r for r in rows if r["label"].startswith("대조군: 무작위")]
    avg = {k: (statistics.mean(r[k] for r in seeds) if isinstance(seeds[0][k], float) else seeds[0][k])
           for k in seeds[0]}
    avg["label"] = f"대조군: 무작위 3 평균 ({len(seeds)} 시드)"
    rows.insert(rows.index(seeds[-1]) + 1, avg)
    control = trades_by["대조군: 후보 30 전체"]
    for r in rows:
        if r["label"] in trades_by and r["label"] != "대조군: 후보 30 전체":
            r["vsCandidates"] = paired_excess(trades_by[r["label"]], control)
    weekdays = [weekday_rows("기준 선별 상위 3", trades_by["기준 선별 상위 3"]),
                weekday_rows("대조군: 후보 30 전체", control)]
    return rows, benchmark_hold(data), weekdays, trades_by


def filtered_atr_min(data: MarketData, ranks: Ranks) -> float | None:
    """기간 중 후보 30개에서 기준 필터를 통과한 종목의 최소 ATR 비율 (저변동 선별이 비는 이유 확인용)."""
    values = []
    for day, syms in rolling_picks(data, ranks, screen.score, 30).items():
        prev = ranks.days[ranks.days.index(day) - 1]
        for sym in syms:
            closes, highs, lows = _series(data.candles[sym][:ranks.index[sym][prev] + 1][-SCREEN_CANDLES:])
            values.append(indicators.atr(highs, lows, closes) / closes[-1])
    return min(values) if values else None


def check_rolling_matches_scan(data: MarketData, ranks: Ranks) -> None:
    """롤링 기준선의 선별이 Backtest.scan과 같은 종목을 고르는지 (앞 10거래일)."""
    bt = Backtest(data.base_settings(), BASE_RULE, data.candles, data.names)
    mine = rolling_picks(data, ranks, screen.score, 3)
    for day in list(mine)[:10]:
        prev = bt._prev_trading_day(day)
        theirs = [p.symbol for p in bt.scan(day, prev)[:3]]
        if theirs != mine[day]:
            raise SystemExit(f"[{data.market}] {day} 롤링 선별 {mine[day]} ≠ Backtest.scan {theirs}")


# --- Backtest 변형의 보조 지표 ---

def predict_rows_for(data: MarketData, res, label: str, hold: int) -> dict:
    """시나리오가 만들어진 (주문일, 종목) 쌍을 주문일 시가 매수 → hold거래일 뒤 종가 매도 (비용 없음)."""
    index = {sym: {c["date"]: i for i, c in enumerate(bars)} for sym, bars in data.candles.items()}
    bench_index = {c["date"]: i for i, c in enumerate(data.bench)}
    rows = []
    for day, sym in sorted({(t.day, t.symbol) for t in res.trades}):
        i = index[sym].get(day)
        bars = data.candles[sym]
        if i is None or i + hold >= len(bars):
            continue
        ret = float(bars[i + hold]["closePrice"]) / float(bars[i]["openPrice"]) - 1
        b = bench_index.get(day)
        bench = (float(data.bench[b + hold]["closePrice"]) / float(data.bench[b]["openPrice"]) - 1
                 if b is not None and b + hold < len(data.bench) else None)
        rows.append((day, ret, bench))
    return predict_row(label, rows)


def extra_row(data: MarketData, res, sm: dict, stats: ScenarioStats | None) -> dict:
    placed = [t for t in res.trades if t.placed and t.fill_price is not None and t.ret is not None]
    f = sm["funnel"]
    return {"label": sm["label"],
            "scenarios": f["scenarios"], "riskRejected": f["riskRejected"],
            "rejectReasons": f["rejectReasons"],
            "scenarioStats": stats.as_dict() if stats else None,
            "avgRr": statistics.mean(t.reward_risk for t in res.trades) if res.trades else None,
            "tradeMeanPct": _mean_pct([t.ret for t in placed]), "tradeN": len(placed),
            "tradeFirstPct": _mean_pct([t.ret for t in placed if t.day < SPLIT]),
            "tradeSecondPct": _mean_pct([t.ret for t in placed if t.day >= SPLIT]),
            "avgHoldDays": sm["avgHoldDays"],
            "p5": predict_rows_for(data, res, sm["label"], 5),
            "p10": predict_rows_for(data, res, sm["label"], 10)}


# --- 표 ---

def _p(v, digits=2):
    return "-" if v is None else f"{v:+.{digits}f}%"


def extra_table(rows: list[dict]) -> list[str]:
    lines = ["| 변형 | 시나리오 | 리스크 탈락 | 목표 보정 | 평균 손익비 | 주문 건당 수익률 (건수) | 6~7월 | 8~9월 | "
             "평균 보유(일) | 단순 5일 (초과) | 단순 10일 (초과) | 10일 6~7월 / 8~9월 |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        st = r["scenarioStats"]
        raised = "-" if not st or not st["n"] else f"{st['raised'] / st['n'] * 100:.0f}%"
        rej = "-" if not r["scenarios"] else f"{r['riskRejected']}/{r['scenarios']}"
        rr = "-" if r["avgRr"] is None else f"{r['avgRr']:.2f}"
        hold = "-" if r["avgHoldDays"] is None else f"{r['avgHoldDays']:.1f}"
        p5, p10 = r["p5"], r["p10"]
        lines.append(f"| {r['label']} | {r['scenarios']} | {rej} | {raised} | {rr} | "
                     f"{_p(r['tradeMeanPct'])} ({r['tradeN']}) | {_p(r['tradeFirstPct'])} | {_p(r['tradeSecondPct'])} | "
                     f"{hold} | {_p(p5['meanPct'])} ({_p(p5['excessPct'])}) | "
                     f"{_p(p10['meanPct'])} ({_p(p10['excessPct'])}) | "
                     f"{_p(p10['firstHalfPct'])} ({p10['nFirst']}) / {_p(p10['secondHalfPct'])} ({p10['nSecond']}) |")
    return lines


def rolling_table(rows: list[dict], bench: dict) -> list[str]:
    lines = ["| 선별 | 거래 (일수) | 건당 10일 수익률 | 승률 | 벤치마크 초과 | 후보 30 대비 (t) | 건당 6~7월 / 8~9월 | "
             "포트폴리오 수익률 | 6~7월 | 8~9월 | MDD | 평균 비중 |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        vs = r.get("vsCandidates")
        vs_s = "-" if not vs or vs["meanPct"] is None else (
            f"{vs['meanPct']:+.2f}%p ({vs['t']:+.1f})" if vs["t"] is not None else f"{vs['meanPct']:+.2f}%p")
        win = "-" if r["winRatePct"] is None else f"{r['winRatePct']:.0f}%"
        lines.append(f"| {r['label']} | {r['n']} ({r['days']}) | {_p(r['meanPct'])} | {win} | {_p(r['excessPct'])} | "
                     f"{vs_s} | {_p(r['firstMeanPct'])} ({r['nFirst']}) / {_p(r['secondMeanPct'])} ({r['nSecond']}) | "
                     f"{_p(r['returnPct'])} | {_p(r['firstHalfPct'])} | {_p(r['secondHalfPct'])} | "
                     f"{_p(r['mddPct'])} | {r['avgExposurePct']:.0f}% |")
    lines.append(f"| {bench['label']} | 1 | - | - | - | - | - | {_p(bench['returnPct'])} | "
                 f"{_p(bench['firstHalfPct'])} | {_p(bench['secondHalfPct'])} | {_p(bench['mddPct'])} | 100% |")
    return lines


def weekday_table(rows: list[dict]) -> list[str]:
    lines = ["| 선별 | " + " | ".join(WEEKDAYS) + " |", "|---|" + "---|" * len(WEEKDAYS)]
    for r in rows:
        lines.append(f"| {r['label']} | " + " | ".join(f"{_p(r[k][0])} ({r[k][1]})" for k in WEEKDAYS) + " |")
    return lines


NOTES = [
    "유니버스는 오늘 기준 거래대금 랭킹(1일~1년)의 합집합이라 생존·미래 편향이 있다. 기간 중에 뜬 종목이 미리 들어가 있고 "
    "상장폐지·거래정지 종목은 없다. 1차 선별 실험에서 유니버스 안 거래대금 순위가 낮을수록 이후 10일 수익률이 높았다 "
    "(국내 1~30위 −4.2% → 101위 밖 +3.5%). 후보는 모든 변형에서 운영과 같은 전일 거래대금 상위 30개로 고정해 이 편향이 "
    "가장 적은 구간만 쓴다. 그래도 절대 수익률은 실제보다 좋게 나올 수 있다.",
    "표본은 4개월(약 80거래일)이다. 국내는 KODEX 200이 −18%(7월 −21%)인 급락장, 미국은 SPY +1.2%의 보합장이다. "
    "20여 개 변형 중 가장 좋은 것을 고르는 것 자체가 과최적화이며, 몇 %p 차이는 종목 몇 개로 뒤집힌다.",
    "'목표 보정'은 구조적 목표가(20일선, 전일 시가)가 리스크 엔진의 최소 손익비 2.0(손절 주문가 −1%, 비용 포함)에 "
    f"못 미칠 때 목표를 손익비 {LIMITS['SWING'].min_reward_risk * RR_MARGIN:.2f}가 되는 가격까지 올린 것이다. "
    "리스크 엔진은 바꾸지 않았다. 보정하면 목표가 평균회귀의 논리(20일선 복귀)보다 멀어진다.",
    "평균회귀·급락 반등의 진입은 기준과 같은 전일 종가 지정가 DAY (그날 더 내려야 체결)다. '시가 진입' 행만 시가 시장가다.",
    "주문 건당 수익률은 실제 주문·체결된 거래의 1주 기준 수익률 (비용 차감). 단순 5일·10일은 리스크 엔진·주문 규칙 없이 "
    "시나리오가 만들어진 (주문일, 종목)을 주문일 시가에 사서 5·10거래일 뒤 종가에 판 수익률 (비용 없음)이고, "
    "괄호는 같은 구간의 벤치마크(KODEX 200·SPY)를 뺀 초과 수익률이다.",
    f"롤링 기준선은 Backtest를 쓰지 않는다. 매일 정규장 전 선별(전일 거래대금 상위 30 → 점수 순 상위 3)을 주문일 시가에 "
    f"자본금의 1/{ROLL_SLOTS}씩 사서 {ROLL_HOLD}거래일 뒤 종가에 판다 (비용·거래세 포함, 리스크 엔진·손절 없음, 복리 없음). "
    f"매도일에 다음 코호트가 이미 들어와 {ROLL_COHORTS}개 코호트가 겹치므로 최대 비중 100%. 건당 수익률은 {ROLL_HOLD}거래일 뒤 봉이 있는 거래만, 포트폴리오 수익률은 9/29 "
    "종가로 평가한 미완료 거래까지 포함한다. '후보 30 대비'는 같은 날 후보 30개 전체 평균과의 차이이고, 10일 보유가 겹쳐 "
    "일별 값이 독립이 아니므로 유효 표본을 일수 ÷ 10으로 본 대략적인 t값이다 (|t| < 2면 우연과 구분되지 않는다).",
    "130일 고가: 캐시 일봉이 2025-11부터라 52주 고가를 계산할 수 없어 선별 창(130거래일)의 고가로 대신했다.",
    "요일 효과 표는 롤링 기준선의 거래를 주문일 요일로 나눈 것이다 (미국은 현지 날짜 기준).",
]


def main():
    out_dir = RESULTS / "experiments" / NAME
    out_dir.mkdir(parents=True, exist_ok=True)
    rows_by_market, extra_by_market, rolling_by_market, bench_by_market, weekday_by_market = {}, {}, {}, {}, {}
    atr_min = {}
    for market in ("KR", "US"):
        data = load_market(market)
        ranks = Ranks(data)
        check_rolling_matches_scan(data, ranks)
        vs, stats = variants(data, ranks)
        print(f"[{market}] {len(vs)}개 변형", file=sys.stderr)
        rows, extras = [], []
        for i, v in enumerate(vs, 1):
            res, sm = run_variant(data, v)
            if i == 1 and abs(sm["returnPct"] - EXPECTED[market]) > 0.01:
                raise SystemExit(f"[{market}] 기준 수익률 {sm['returnPct']:+.2f}% ≠ 기대 {EXPECTED[market]:+.2f}%. 중단")
            write_trades(out_dir / f"{market}-trades-{i}.csv", res)
            rows.append(sm)
            extras.append(extra_row(data, res, sm, stats.get(v.label)))
            print(f"  [{market}] {v.label}: {sm['returnPct']:+.2f}% (주문 {sm['orders']}, 체결 {sm['filled']})",
                  file=sys.stderr)
        rows_by_market[market], extra_by_market[market] = rows, extras
        rolling, bench, weekdays, _ = run_rolling(data, ranks)
        rolling_by_market[market], bench_by_market[market], weekday_by_market[market] = rolling, bench, weekdays
        atr_min[market] = filtered_atr_min(data, ranks)
    findings = build_findings(rows_by_market, extra_by_market, rolling_by_market, bench_by_market, weekday_by_market,
                              atr_min)
    path = write_report(NAME, "새로운 접근 (ideas)", rows_by_market, NOTES, findings)
    extra = []
    for market in rows_by_market:
        extra += ["", f"## 보조 지표 ({market}): 리스크 엔진 통과, 건당 수익률, 선별의 단순 예측력", ""]
        extra += extra_table(extra_by_market[market])
    extra += ["", f"## 단순 기준선: 선별만의 성과 (동일 비중 {ROLL_HOLD}거래일 롤링, 리스크 엔진·손절 없음)", ""]
    for market in rolling_by_market:
        extra += [f"{market}:", ""] + rolling_table(rolling_by_market[market], bench_by_market[market]) + [""]
    extra += ["## 요일 효과 (롤링 기준선의 건당 10일 수익률, 주문일 요일별)", ""]
    for market in weekday_by_market:
        extra += [f"{market}:", ""] + weekday_table(weekday_by_market[market]) + [""]
    text = path.read_text()
    marker = "\n## 해석" if findings else "\n## 주의"
    text = text.replace(marker, "\n".join(extra) + marker, 1)
    path.write_text(text)
    j = path.with_name("summary.json")
    payload = json.loads(j.read_text())
    payload["extra"] = extra_by_market
    payload["rolling"] = rolling_by_market
    payload["benchmarkHold"] = bench_by_market
    payload["weekday"] = weekday_by_market
    payload["filteredAtrMin"] = atr_min
    j.write_text(json.dumps(payload, ensure_ascii=False, indent=1, default=str))
    print(text)
    print(f"\n결과: {path}", file=sys.stderr)


def build_findings(rows_by_market, extra_by_market, rolling_by_market, bench_by_market, weekday_by_market,
                   atr_min) -> list[str]:
    """숫자는 표에서 뽑고, 해석 문장은 2026-09-30 실행 결과를 보고 쓴 것이다. 결과가 바뀌면 문장도 다시 읽어야 한다."""
    def get(rows, label):
        for row in rows:
            if row["label"] == label:
                return row
        raise KeyError(label)

    def bt(m, label, key="returnPct"):
        return get(rows_by_market[m], label)[key]

    def ex(m, label, key):
        return get(extra_by_market[m], label)[key]

    def ro(m, label, key="meanPct"):
        return get(rolling_by_market[m], label)[key]

    def vs(m, label):
        v = get(rolling_by_market[m], label).get("vsCandidates") or {}
        if v.get("meanPct") is None:
            return "-"
        return f"{v['meanPct']:+.2f}%p (t {v['t']:+.1f})"

    def roll(m, label):
        """건당 10일 수익률 (6~7월 / 8~9월), 후보 30 대비."""
        return (f"{_p(ro(m, label))} ({_p(ro(m, label, 'firstMeanPct'))} / {_p(ro(m, label, 'secondMeanPct'))}), "
                f"후보 30 대비 {vs(m, label)}")

    def rej(m, label):
        return f"{ex(m, label, 'riskRejected')}/{ex(m, label, 'scenarios')}"

    def rr(m, label):
        v = ex(m, label, "avgRr")
        return "-" if v is None else f"{v:.2f}"

    positive = {m: [f"{r['label']} {_p(r['returnPct'])} (주문 {r['orders']})" for r in rows if r["returnPct"] > 0.005]
                for m, rows in rows_by_market.items()}
    rev20, rev5 = "역선별: 20일 수익률 최하위 (필터 없음)", "역선별: 5일 수익률 최하위 (필터 없음)"
    base_roll, cand, rand = "기준 선별 상위 3", "대조군: 후보 30 전체", "대조군: 무작위 3 평균 (3 시드)"
    n_rules = len([r for r in rolling_by_market["KR"] if not r["label"].startswith("대조군")])
    return [
        "**핵심 답: 이 4개월에서 두 시장·두 반기 모두 양의 기대값을 보인 접근은 없다.** 운영 규칙(리스크 엔진·지정가 진입·OCO)을 "
        f"통과시킨 Backtest에서 플러스인 변형은 국내 {', '.join(positive['KR']) or '없음'}, 미국 "
        f"{', '.join(positive['US']) or '없음'}뿐이고, 표본이 한 자릿수라 의미가 없다. 선별만 떼어 본 롤링 기준선에서 건당 "
        f"기대값이 플러스인 것은 미국의 단기 반전(20일·5일 수익률 최하위)과 저변동뿐이며, 셋 다 국내에서는 재현되지 않거나 "
        "(국내 저변동은 후보가 없음) 6~7월에는 거의 0이거나 음수였다.",
        f"**단기 반전(후보 30개 중 20일 수익률 최하위 3개, 필터 없음)이 유일하게 눈에 띄지만 미국 8~9월에 몰려 있다.** 롤링 건당 "
        f"10일 수익률: 미국 {roll('US', rev20)}, 포트폴리오 {_p(ro('US', rev20, 'returnPct'))} (6~7월 "
        f"{_p(ro('US', rev20, 'firstHalfPct'))}, 8~9월 {_p(ro('US', rev20, 'secondHalfPct'))}, SPY 보유 "
        f"{_p(bench_by_market['US']['returnPct'])}). 5일 최하위도 미국 {roll('US', rev5)}로 같은 방향이라 룩백 하나의 우연은 "
        f"아닐 수 있다. 그러나 국내는 20일 {roll('KR', rev20)}, 5일 {roll('KR', rev5)}로 절대 수익률이 음수다 (후보 평균보다는 "
        "덜 잃었다). 네 경우의 t값은 모두 1.1 이하로 우연과 구분되지 않는다. 운영 규칙에 넣으면 성과가 대부분 사라진다: "
        f"Backtest 미국 {_p(bt('US', rev20))} (주문 건당 {_p(ex('US', rev20, 'tradeMeanPct'))}, 6~7월 "
        f"{_p(bt('US', rev20, 'firstHalfPct'), 1)}, 8~9월 {_p(bt('US', rev20, 'secondHalfPct'), 1)}), 국내 {_p(bt('KR', rev20))}. "
        f"미국 체결 {bt('US', rev20, 'filled')}건 중 목표 {bt('US', rev20, 'exits')['TARGET']}, 손절 "
        f"{bt('US', rev20, 'exits')['STOP']}, 기한 {bt('US', rev20, 'exits')['EXPIRED']}건으로, 4 ATR 목표·1.5 ATR 손절이 "
        "반등 경로(흔들리며 오르는)와 맞지 않았다. 또 이 결과는 "
        "유니버스 편향에 가장 취약하다: 오늘 기준 랭킹으로 만든 유니버스에는 급락 후 회복해 다시 거래가 붙은 종목만 남고, "
        "계속 빠져 잊힌 종목·상장폐지 종목은 빠져 있어 '패자 매수'가 실제보다 좋게 나온다.",
        f"**평균회귀 매수(60일선 위 + RSI<35 또는 20일선 − 1.5 ATR 아래)는 신호가 드물고, 리스크 엔진이 막고, 신호 자체도 나빴다.** "
        f"후보 30개 안에서 4개월간 시나리오 국내 {ex('KR', '평균회귀 5일', 'scenarios')}건, 미국 "
        f"{ex('US', '평균회귀 5일', 'scenarios')}건. 목표 = max(20일선, +2 ATR), 손절 −1 ATR 구조의 평균 손익비는 "
        f"국내 {rr('KR', '평균회귀 5일')}, 미국 {rr('US', '평균회귀 5일')}로 손절 주문가 −1%를 반영한 최소 2.0에 못 미쳐 "
        f"탈락 {rej('KR', '평균회귀 5일')}, {rej('US', '평균회귀 5일')}. 선별만 보면 롤링 국내 {roll('KR', '평균회귀 선별')}, "
        f"미국 {roll('US', '평균회귀 선별')}로 떨어지는 칼날이었다 (국내 신호는 6/1 한 건을 빼면 6월 말~7월 중순 하락 구간). "
        "목표를 손익비 기준선까지 "
        f"올려 통과시키면 미국 5일 {_p(bt('US', '평균회귀 5일, 목표 보정'))}, 10일 {_p(bt('US', '평균회귀 10일, 목표 보정'))}, "
        f"시가 진입 {_p(bt('US', '평균회귀 10일, 목표 보정, 시가 진입'))}로 모두 손실이다. 보유 5일이 10일보다 덜 잃은 것은 "
        "나쁜 신호에 덜 노출된 효과다.",
        f"**급락 반등(전일 −5% 또는 −2 ATR, 60일선 위)은 가장 일관되게 나빴다.** 선별 롤링 국내 {roll('KR', '급락 반등 선별')}, "
        f"미국 {roll('US', '급락 반등 선별')}. 두 시장·두 반기 모두 음수이고 후보 평균보다도 나쁘다 (이 기간 급락은 이어졌다). "
        f"갭 메우기 목표(전일 시가)·전일 저가 − 0.5 ATR 손절 구조는 평균 손익비 국내 {rr('KR', '급락 반등 5일')}, 미국 "
        f"{rr('US', '급락 반등 5일')}로 탈락 {rej('KR', '급락 반등 5일')}, {rej('US', '급락 반등 5일')}. 국내 "
        f"{_p(bt('KR', '급락 반등 5일'))}는 통과한 {bt('KR', '급락 반등 5일', 'orders')}건의 결과라 의미가 없다. 목표를 보정해 "
        f"통과시키면 국내 {_p(bt('KR', '급락 반등 5일, 목표 보정'))}, 미국 {_p(bt('US', '급락 반등 5일, 목표 보정'))}이고 "
        f"평균 보유 {ex('KR', '급락 반등 5일, 목표 보정', 'avgHoldDays'):.1f}일 (국내 체결 "
        f"{bt('KR', '급락 반등 5일, 목표 보정', 'filled')}건 중 손절 {bt('KR', '급락 반등 5일, 목표 보정', 'exits')['STOP']}건: "
        "손절이 가까워 곧바로 손절).",
        f"**역선별: 점수 순서를 뒤집으면 두 시장·두 반기 모두 더 나빴다.** 점수 최하위 롤링 국내 "
        f"{roll('KR', '역선별: 점수 최하위')}, 미국 {roll('US', '역선별: 점수 최하위')} vs 기준 국내 {roll('KR', base_roll)}, "
        f"미국 {roll('US', base_roll)}. 필터 통과 종목 안에서는 점수 높은 쪽이 조금 나았다는 뜻이다 (1차 실험의 '점수 순서는 "
        "무작위와 구분 안 됨'과 모순되지 않는 작은 차이). 반면 필터를 빼고 가장 많이 빠진 종목을 사면 미국에서 좋아진다 "
        "(위 단기 반전). 즉 '추세 추종의 반대'가 나은 것이 아니라, 미국에서는 필터(60일선 위, RSI ≥ 40)가 반등할 종목을 "
        "걸러낸 것이 문제였다. 국내는 필터 통과 20일 최하위 "
        f"{roll('KR', '역선별: 20일 수익률 최하위 (필터 통과)')}로 기준보다 나쁘다.",
        f"**저변동(ATR 1.5~3%)은 국내에 후보가 없고, 미국은 시장 수익률 수준이며 리스크 엔진과 맞지 않는다.** 국내 후보 30개 중 "
        f"필터 통과 종목의 ATR 비율은 기간 내내 최소 {atr_min['KR'] * 100:.1f}%였다 (거래대금 상위는 변동성이 크다). 미국 롤링 "
        f"{roll('US', '저변동 (ATR 1.5~3%)')}, 포트폴리오 {_p(ro('US', '저변동 (ATR 1.5~3%)', 'returnPct'))} (MDD "
        f"{_p(ro('US', '저변동 (ATR 1.5~3%)', 'mddPct'))}). ATR이 작으면 손절 주문가 −1%가 손실에서 차지하는 몫이 커서 "
        f"4 ATR·1.5 ATR로도 손익비가 {rr('US', '저변동 (ATR 1.5~3%)')}에 그쳐 탈락 {rej('US', '저변동 (ATR 1.5~3%)')}, "
        f"Backtest {_p(bt('US', '저변동 (ATR 1.5~3%)'))}.",
        f"**상대강도**: 벤치마크보다 강한 종목만 (필터 통과) 롤링 국내 {roll('KR', '상대강도 상위')}, 미국 "
        f"{roll('US', '상대강도 상위')}. 국내는 후보 평균보다 덜 빠졌고 미국은 더 나빴다 (기준 선별과 같은 패턴). "
        f"상대약세(필터 통과)는 국내 {roll('KR', '상대약세 (필터 통과)')}, 미국 {roll('US', '상대약세 (필터 통과)')}. "
        f"Backtest는 국내 {_p(bt('KR', '상대강도 상위'))} / {_p(bt('KR', '상대약세 (필터 통과)'))}, 미국 "
        f"{_p(bt('US', '상대강도 상위'))} / {_p(bt('US', '상대약세 (필터 통과)'))}로 모두 손실. 상대약세가 국내 Backtest에서 "
        "덜 잃은 것은 주문이 적어서다. 벤치마크는 전일까지의 봉만 썼다.",
        f"**추가 아이디어**: 130일 고가 3% 안은 국내 {roll('KR', '추가: 130일 고가 3% 안')}로 모든 선별 중 가장 나쁘고 "
        f"미국도 {roll('US', '추가: 130일 고가 3% 안')}로 음수다 (1차의 20일 신고가 돌파와 같은 결론: 이 기간 고점 근처 추종은 "
        f"손실). 거래대금 순위 급상승(20일 중앙값 대비 30계단 이상)은 국내 {roll('KR', '추가: 거래대금 순위 급상승')}, 미국 "
        f"{roll('US', '추가: 거래대금 순위 급상승')}로 반기·시장이 엇갈린다. 요일 효과 표는 요일 간 차이가 기준 선별과 후보 전체에서 "
        "서로 다른 방향이라 (국내 기준은 월요일이 가장 낫지만 후보 전체는 월·화가 가장 나쁨) 잡음으로 본다.",
        f"**단순 기준선**: 벤치마크 보유는 국내 {_p(bench_by_market['KR']['returnPct'])} (MDD "
        f"{_p(bench_by_market['KR']['mddPct'])}), 미국 {_p(bench_by_market['US']['returnPct'])}. 기준 선별 상위 3개 동일 비중 "
        f"10거래일 롤링(리스크 엔진·손절 없음)은 국내 {_p(ro('KR', base_roll, 'returnPct'))}, 미국 "
        f"{_p(ro('US', base_roll, 'returnPct'))}로, 운영 규칙 Backtest(국내 {_p(bt('KR', '기준'))}, 미국 {_p(bt('US', '기준'))})와 "
        "국내는 비슷하고 미국은 덜 잃었다. 손실의 대부분은 리스크 엔진이나 청산 규칙이 아니라 선별된 종목 자체에서 나왔고, "
        "미국에서는 지정가 역선택·손절이 몇 %p를 더했다. 후보 풀 자체도 나빴다: "
        f"후보 30개 전체 건당 국내 {_p(ro('KR', cand))}, 미국 {_p(ro('US', cand))}, 무작위 3개 국내 {_p(ro('KR', rand))}, "
        f"미국 {_p(ro('US', rand))}. 국내 기준 선별은 후보 평균보다 {vs('KR', base_roll)} 나았고 미국은 {vs('US', base_roll)}로 "
        "나빴다. 거래대금 상위 종목은 국내 급락장에서 지수보다 더 빠졌다 (고베타).",
        "**리스크 엔진과의 궁합**: 손익비 2.0을 손절 주문가(감시가 −1%)와 비용까지 넣어 계산하므로, ATR 3%인 종목이면 손절 1 ATR에 "
        "목표가 약 2.7 ATR 이상이어야 통과한다. 평균회귀(20일선 복귀), 갭 메우기, 저변동처럼 목표가 가까운 구조는 대부분 "
        "탈락하고, 목표를 억지로 올리면 전략의 논리와 어긋나 결과도 나빠졌다. 이 실험은 리스크 엔진을 바꾸지 않았고, 느슨하게 "
        "하자는 근거도 되지 않는다 (통과하지 못한 신호 자체가 음수였다).",
        "**두 반기 일관성**: 국내는 거의 모든 접근이 6~7월(KODEX 200 −19%, 고점 대비 −41%)에 크게 잃고 8~9월에 일부 되찾았다. "
        "미국은 6~7월 손실, 8~9월 이익이 대부분이다. 두 반기 모두 같은 부호로 일관된 것은 '나쁜 쪽'뿐이다: 급락 반등, 평균회귀 "
        "(미국), 130일 고가 근접(국내)은 두 반기 모두 음수였다. 좋은 쪽으로 일관된 것은 없다.",
        f"**과최적화 경고**: 4개월(약 82거래일), 선별 규칙 {n_rules}개 × 2개 시장을 비교했다. 10일 보유가 겹쳐 유효 표본은 "
        "시장당 8~9개 구간에 불과하고, 규칙 하나당 거래는 수십~200건이지만 서로 강하게 상관돼 있다. 규칙이 이만큼 많으면 효과가 "
        "없어도 가장 좋은 것의 t값이 1.5 안팎으로 나오는 것이 보통이라, 최고치 t 1.1은 잡음 범위다. 유니버스는 오늘 기준 랭킹의 "
        "합집합이라 반전·패자 매수에 특히 유리한 생존 편향이 있다. 국내는 급락장, 미국은 보합장 한 번씩뿐이다. 결론은 "
        "'채택할 접근은 없다'이다. 미국 단기 반전은 가설로만 남기고, 다른 기간과 편향 없는 유니버스(운영에서 매일 거래대금 "
        "랭킹을 기록해 쌓은 것)로 다시 확인하기 전에는 운영 규칙에 넣지 않는다.",
    ]


if __name__ == "__main__":
    main()
