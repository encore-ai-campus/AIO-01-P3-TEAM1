"""실험 7: 추가 기술적 분석 기법과 단기 보유 (techniques). 캐시만 읽고 증권사 API·AI는 부르지 않는다.

    uv run python backtest/experiments/techniques.py

질문: 기술적 분석 기법을 더 도입해야 하는가, 보유 기간을 스윙보다 짧게(1~5거래일) 줄이면 나아지는가.
데이터는 일봉뿐이다 (분봉 이력은 API로 받을 수 없어 장중 기법은 다루지 않는다).

선별(screen_fn) 기법 (지표는 이 파일에 표준 라이브러리로 구현):
  기준(운영 screen.score), MACD(12,26,9) 시그널 상향 교차 + 60일선 위, 볼린저(20,2) %B < 0.2 / 상단 돌파,
  ADX(14) > 25 · +DI > −DI + 기존 점수, 스토캐스틱(14,3) %K < 20에서 상향 교차, RSI(2) < 10 + 200일선(없으면 60일선) 위,
  거래량 확인 돌파(종가 > 전 10일 고가, 거래량 > 전 20일 평균 × 2), OBV 20일 상승 + 종가 > 20일선,
  갭 상승 후속(시가 갭 +2% 이상, 종가 > 시가), 전일 인사이드 바, 복합(위 기법 2개 이상), 무작위 대조(시드 3개)
평가:
  1차 (선별만): 신호 다음 날(주문일) 시가 매수 → N거래일 뒤 종가 매도 롤링 (ideas.py 방식, N = 1·2·3·5·10).
    같은 날 '후보 30 전체' 평균 대비 초과 (= 후보 중 무작위로 골랐을 때의 기대값 대비)와 t값.
  2차 (운영 규칙): Backtest(리스크 엔진, 전일 종가 지정가 DAY, 손절 1.5 ATR + 주문가 −1%)에서 보유 N거래일,
    목표 4 ATR(운영) / 없음(100 ATR, 기한 청산만). 기한 = 주문일 + (N − 1)거래일, 그다음 거래일 시가에 판다
    (기준 선별만 그날 종가에 파는 변형도 돌린다). 1·2일 보유는 운영 정책(SWING_MIN_DAYS = 3) 밖이라
    사실 검증의 보유 기간 검사만 우회한다 (진입가 괴리 검사는 그대로).
같은 변형을 1차 실험 기간(2026-06-01 ~ 09-30)과 표본 외 기간(2026-02-09 ~ 05-29)에 돌린다.
결과: backtest/results/experiments/techniques/summary.md, summary.json, <시장>-<in|oos>-trades-N.csv
"""
import json
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common  # noqa: E402
from common import RESULTS, MarketData, Variant, load_market, run_variant, write_report, write_trades  # noqa: E402
from run import summarize  # noqa: E402
from ideas import Ranks, _pick, _series, all_candidates, random_pick  # noqa: E402
from sim import (EXPIRED, OPEN, RANK_COUNT, SCREEN_CANDLES, STOP, Backtest, Rule, Trade, _f,  # noqa: E402
                 default_scenario, net_return, plan_prices, simulate_trade)
from paper_engine.data import indicators  # noqa: E402
from paper_engine.judge import screen  # noqa: E402
from paper_engine.judge.fact_check import fact_check  # noqa: E402
from paper_engine.judge.risk import SELL_TAX_RATE  # noqa: E402
from paper_engine.judge.scenario import SWING_MIN_DAYS  # noqa: E402

NAME = "techniques"
MARKETS = ("KR", "US")
# (키, 제목, 시작, 끝, 반기 나누는 날, 반기 이름). combo.py와 같은 기간
PERIODS = [
    ("in", "6~9월", "2026-06-01", "2026-09-30", "2026-08-01", ("6~7월", "8~9월")),
    ("oos", "2~5월 (표본 외)", "2026-02-09", "2026-05-29", "2026-04-01", ("2~3월", "4~5월")),
]
# 운영 규칙 그대로의 결과 (재현 확인). 6~9월은 results/<시장>/summary.md, 2~5월은 combo 표본 외 기준 행
EXPECTED = {("in", "KR"): -17.81, ("in", "US"): -17.76, ("oos", "KR"): 16.45, ("oos", "US"): -4.63}
HOLDS = (1, 2, 3, 5, 10)
TARGETS = (("4 ATR", 4.0), ("없음", 100.0))  # 목표 없음 = 목표 100 ATR (사실상 기한·손절 청산만)
STOP_ATR = 1.5
CANDIDATES = 30  # 전략 기본값 (Settings.candidates)
TOP = 3  # 하루 분석 종목 수 (Settings.analyze_top)
TECH_CANDLES = 250  # 기법 선별에 주는 일봉 수 (200일선용). 기준 선별은 운영과 같은 130개
RANDOM_SEEDS = (1, 2, 3)
CONTROL = "후보 30 전체"
# 판정 기준 (결과를 보기 전에 정한 것)
MIN_T, MIN_N = 2.0, 30


# --- 지표 (과거 → 최신 리스트) ---

def ema_series(values: list[float], period: int) -> list[float | None]:
    """지수 이동평균. 첫 값은 앞 period개의 단순 평균, 그 전은 None."""
    k, out, e = 2 / (period + 1), [], None
    for i, v in enumerate(values):
        if i < period - 1:
            out.append(None)
            continue
        e = sum(values[:period]) / period if e is None else v * k + e * (1 - k)
        out.append(e)
    return out


def macd_hist(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> list[float]:
    """MACD 히스토그램 (MACD선 − 시그널선). 계산 가능한 구간만."""
    f, s = ema_series(closes, fast), ema_series(closes, slow)
    line = [a - b for a, b in zip(f, s) if a is not None and b is not None]
    sig = ema_series(line, signal)
    return [a - b for a, b in zip(line, sig) if b is not None]


def bollinger_pb(closes: list[float], period: int = 20, k: float = 2.0) -> float | None:
    """%B = (종가 − 하단) / (상단 − 하단). 표준편차는 모집단 기준."""
    if len(closes) < period:
        return None
    w = closes[-period:]
    mid = sum(w) / period
    sd = statistics.pstdev(w)
    if sd == 0:
        return None
    return (closes[-1] - (mid - k * sd)) / (2 * k * sd)


def adx(highs: list[float], lows: list[float], closes: list[float], n: int = 14) -> tuple[float, float, float] | None:
    """Wilder ADX. (ADX, +DI, −DI)."""
    if len(closes) < 2 * n + 1:
        return None
    tr, pdm, ndm = [], [], []
    for i in range(1, len(closes)):
        up, dn = highs[i] - highs[i - 1], lows[i - 1] - lows[i]
        pdm.append(up if up > dn and up > 0 else 0.0)
        ndm.append(dn if dn > up and dn > 0 else 0.0)
        tr.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    a, p, m = sum(tr[:n]), sum(pdm[:n]), sum(ndm[:n])
    dxs, pdi, mdi = [], 0.0, 0.0
    for i in range(n, len(tr) + 1):
        if i > n:
            a, p, m = a - a / n + tr[i - 1], p - p / n + pdm[i - 1], m - m / n + ndm[i - 1]
        pdi, mdi = (100 * p / a, 100 * m / a) if a else (0.0, 0.0)
        dxs.append(100 * abs(pdi - mdi) / (pdi + mdi) if pdi + mdi else 0.0)
    value = sum(dxs[:n]) / n
    for dx in dxs[n:]:
        value = (value * (n - 1) + dx) / n
    return value, pdi, mdi


def stochastic(highs, lows, closes, n: int = 14, smooth: int = 3) -> tuple[list[float], list[float]] | None:
    """슬로 스토캐스틱 (14,3): %K = 원 %K의 3일 평균, %D = %K의 3일 평균. 마지막 몇 개만 계산한다."""
    need = n + 2 * (smooth - 1) + 1  # %K·%D 각 2개 (교차 판정)
    if len(closes) < need:
        return None
    raw = []
    for i in range(len(closes) - need + n - 1, len(closes)):
        hh, ll = max(highs[i - n + 1:i + 1]), min(lows[i - n + 1:i + 1])
        raw.append(100 * (closes[i] - ll) / (hh - ll) if hh > ll else 50.0)
    k = [sum(raw[i - smooth + 1:i + 1]) / smooth for i in range(smooth - 1, len(raw))]
    d = [sum(k[i - smooth + 1:i + 1]) / smooth for i in range(smooth - 1, len(k))]
    return k[-len(d):], d


def slope(values: list[float]) -> float:
    """최소제곱 기울기 (x = 0, 1, ...)."""
    n = len(values)
    mx, my = (n - 1) / 2, sum(values) / n
    return sum((i - mx) * (v - my) for i, v in enumerate(values)) / sum((i - mx) ** 2 for i in range(n))


# --- 선별 기법. (종목, 이름, 일봉, 거래대금) → Pick | 탈락 사유 ---

def _volumes(candles):
    return [float(c["volume"]) for c in candles]


def _opens(candles):
    return [float(c["openPrice"]) for c in candles]


def macd_cross(symbol, name, candles, amount):
    closes, highs, lows = _series(candles)
    hist = macd_hist(closes)
    if len(hist) < 2 or not hist[-2] <= 0 < hist[-1]:
        return "MACD 교차 없음"
    if closes[-1] < indicators.sma(closes, 60):
        return "60일선 아래"
    return _pick(symbol, name, candles, amount, hist[-1] / indicators.atr(highs, lows, closes) * 100)


def bb_revert(symbol, name, candles, amount):
    pb = bollinger_pb(_series(candles)[0])
    if pb is None or pb >= 0.2:
        return "%B ≥ 0.2"
    return _pick(symbol, name, candles, amount, (0.2 - pb) * 100)


def bb_break(symbol, name, candles, amount):
    pb = bollinger_pb(_series(candles)[0])
    if pb is None or pb <= 1:
        return "상단 돌파 아님"
    return _pick(symbol, name, candles, amount, pb * 100)


def adx_trend(symbol, name, candles, amount):
    base = screen.score(symbol, name, candles[-SCREEN_CANDLES:], amount)
    if not isinstance(base, screen.Pick):
        return base
    closes, highs, lows = _series(candles)
    a = adx(highs, lows, closes)
    if a is None or a[0] <= 25 or a[1] <= a[2]:
        return "ADX 추세 아님"
    return base


def stoch_cross(symbol, name, candles, amount):
    closes, highs, lows = _series(candles)
    st = stochastic(highs, lows, closes)
    if st is None:
        return "스토캐스틱 계산 불가"
    k, d = st
    if not (k[-2] < 20 and k[-2] <= d[-2] and k[-1] > d[-1]):
        return "침체권 상향 교차 없음"
    return _pick(symbol, name, candles, amount, 20 - k[-2])


TREND_200 = {"sma200": 0, "sma60": 0}  # RSI(2)가 몇 번 200일선을 썼는지 (보고용)


def rsi2(symbol, name, candles, amount):
    closes = _series(candles)[0]
    r = indicators.rsi(closes, 2)
    if r is None or r >= 10:
        return "RSI(2) ≥ 10"
    trend = indicators.sma(closes, 200) if len(closes) >= 200 else indicators.sma(closes, 60)
    if closes[-1] < trend:
        return "추세선 아래"
    TREND_200["sma200" if len(closes) >= 200 else "sma60"] += 1
    return _pick(symbol, name, candles, amount, 10 - r)


def volume_break(symbol, name, candles, amount):
    closes, highs, _ = _series(candles)
    vols = _volumes(candles)
    avg = statistics.mean(vols[-21:-1])
    if not (closes[-1] > max(highs[-11:-1]) and avg > 0 and vols[-1] > 2 * avg):
        return "거래량 확인 돌파 아님"
    return _pick(symbol, name, candles, amount, vols[-1] / avg)


def obv_trend(symbol, name, candles, amount):
    closes = _series(candles)[0]
    vols = _volumes(candles)
    obv = [0.0]
    for i in range(len(closes) - 20, len(closes)):
        diff = closes[i] - closes[i - 1]
        obv.append(obv[-1] + (vols[i] if diff > 0 else -vols[i] if diff < 0 else 0.0))
    s = slope(obv[1:])
    if s <= 0 or closes[-1] <= indicators.sma(closes, 20):
        return "OBV 상승 추세 아님"
    avg = statistics.mean(vols[-20:])
    return _pick(symbol, name, candles, amount, s / avg * 100 if avg else 0.0)


def gap_follow(symbol, name, candles, amount):
    closes = _series(candles)[0]
    opens = _opens(candles)
    gap = opens[-1] / closes[-2] - 1
    if gap < 0.02 or closes[-1] <= opens[-1]:
        return "갭 상승 강한 마감 아님"
    return _pick(symbol, name, candles, amount, gap * 100)


def inside_bar(symbol, name, candles, amount):
    _, highs, lows = _series(candles)
    if not (highs[-1] <= highs[-2] and lows[-1] >= lows[-2]) or highs[-2] <= lows[-2]:
        return "인사이드 바 아님"
    return _pick(symbol, name, candles, amount, (1 - (highs[-1] - lows[-1]) / (highs[-2] - lows[-2])) * 100)


# (키, 라벨, 함수). 복합은 이 목록 중 2개 이상 동시 충족
TECHNIQUES = [
    ("macd", "MACD 상향 교차 + 60일선 위", macd_cross),
    ("bb_revert", "볼린저 %B < 0.2 (평균회귀)", bb_revert),
    ("bb_break", "볼린저 상단 돌파 (추세)", bb_break),
    ("adx", "ADX > 25 · +DI > −DI + 기존 점수", adx_trend),
    ("stoch", "스토캐스틱 %K < 20 상향 교차", stoch_cross),
    ("rsi2", "RSI(2) < 10 + 200일선(없으면 60일선) 위", rsi2),
    ("vol_break", "거래량 확인 돌파 (10일 고가, 거래량 2배)", volume_break),
    ("obv", "OBV 20일 상승 + 20일선 위", obv_trend),
    ("gap", "갭 상승 +2% 후 강한 마감", gap_follow),
    ("inside", "전일 인사이드 바", inside_bar),
]
BASE, COMPOSITE = "기준 (운영 선별)", "복합: 기법 2개 이상"
LABELS = [BASE] + [lbl for _, lbl, _ in TECHNIQUES] + [COMPOSITE]
RANDOM_LABELS = [f"무작위 seed {s}" for s in RANDOM_SEEDS]
RANDOM_AVG = "무작위 평균 (3 시드)"


# --- 날짜별 선별 결과 (Backtest.scan과 같은 규칙: 전일 거래대금 상위 30 → 점수 순) ---

def daily_picks(data: MarketData, ranks: Ranks, start: str, end: str) -> tuple[dict, dict]:
    """{라벨: {날짜: [Pick, ...] (점수 순, 전부)}}, 기법별 신호 수 (후보 30 안, 일 합계)."""
    labels = LABELS + RANDOM_LABELS + [CONTROL]
    out = {lbl: {} for lbl in labels}
    signals = {lbl: 0 for lbl in LABELS}
    randoms = [random_pick(s) for s in RANDOM_SEEDS]
    for day in [d for d in ranks.days if start <= d <= end]:
        prev = ranks.days[ranks.days.index(day) - 1]
        got = {lbl: [] for lbl in labels}
        for sym in ranks.ranked[prev][:RANK_COUNT][:CANDIDATES]:
            i = ranks.index[sym][prev]
            window = data.candles[sym][:i + 1][-TECH_CANDLES:]
            short = window[-SCREEN_CANDLES:]
            amount = float(window[-1]["closePrice"]) * float(window[-1]["volume"])
            name = data.names.get(sym, sym)
            res = {BASE: screen.score(sym, name, short, amount), CONTROL: all_candidates(sym, name, short, amount)}
            for lbl, fn in zip(RANDOM_LABELS, randoms):
                res[lbl] = fn(sym, name, short, amount)
            hits = 0
            for _, lbl, fn in TECHNIQUES:
                res[lbl] = fn(sym, name, window, amount) if len(window) >= screen.MIN_CANDLES else "일봉 부족"
                hits += isinstance(res[lbl], screen.Pick)
            if hits >= 2:
                res[COMPOSITE] = _pick(sym, name, window, amount, hits)
            for lbl, p in res.items():
                if isinstance(p, screen.Pick):
                    got[lbl].append(p)
        for lbl in labels:
            got[lbl].sort(key=lambda p: p.score, reverse=True)
            out[lbl][day] = got[lbl]
            if lbl in signals:
                signals[lbl] += len(got[lbl])
    return out, signals


def check_matches_scan(data: MarketData, picks: dict, start: str) -> None:
    """기준 선별이 Backtest.scan과 같은 종목을 고르는지 (앞 10거래일)."""
    bt = Backtest(data.base_settings(start=start), Rule("기준", 4.0, STOP_ATR), data.candles, data.names)
    for day in list(picks[BASE])[:10]:
        theirs = [p.symbol for p in bt.scan(day, bt._prev_trading_day(day))[:TOP]]
        mine = [p.symbol for p in picks[BASE][day][:TOP]]
        if theirs != mine:
            raise SystemExit(f"[{data.market}] {day} 선별 {mine} ≠ Backtest.scan {theirs}")


# --- 1차: 선별만의 예측력 (롤링) ---

def rolling_trades(data: MarketData, ranks: Ranks, picks: dict[str, list], top: int, hold: int, end: str) -> list[dict]:
    """주문일 시가 매수 → hold거래일 뒤 종가 매도 (비용 차감). 매도일이 기간 끝을 넘으면 뺀다."""
    c, tax = data.commission_rate, SELL_TAX_RATE[data.market]
    out = []
    for day, ps in picks.items():
        for p in ps[:top]:
            bars = data.candles[p.symbol]
            i = ranks.index[p.symbol].get(day)
            if i is None or i + hold >= len(bars) or bars[i + hold]["date"] > end:
                continue
            fill, exit_ = float(bars[i]["openPrice"]), float(bars[i + hold]["closePrice"])
            out.append({"day": day, "symbol": p.symbol, "ret": net_return(fill, exit_, c, tax),
                        "gross": exit_ / fill - 1})
    return out


def _mean(values):
    values = [v for v in values if v is not None]
    return statistics.mean(values) if values else None


def _daily_mean(trades: list[dict]) -> dict[str, float]:
    by: dict[str, list[float]] = {}
    for t in trades:
        by.setdefault(t["day"], []).append(t["ret"])
    return {d: statistics.mean(v) for d, v in by.items()}


def effective_days(days: list[str], all_days: list[str], hold: int) -> int:
    """겹치지 않는 보유 구간 수 (앞 구간이 끝난 뒤 시작한 날만 센다). 보유 구간 = 주문일부터 hold거래일 뒤까지."""
    pos = {d: i for i, d in enumerate(all_days)}
    n, last = 0, -10 ** 9
    for d in sorted(days):
        if pos[d] > last + hold:
            n, last = n + 1, pos[d]
    return n


def excess_stats(trades: list[dict], control: list[dict], all_days: list[str], hold: int) -> dict:
    """같은 날 후보 30 전체 평균 대비 초과 (일별 평균의 차). t는 겹치지 않는 구간 수를 유효 표본으로 본다."""
    a, b = _daily_mean(trades), _daily_mean(control)
    days = [d for d in a if d in b]
    diffs = [a[d] - b[d] for d in days]
    if len(diffs) < 3:
        return {"excessPct": statistics.mean(diffs) * 100 if diffs else None, "t": None, "eff": len(diffs)}
    eff = max(effective_days(days, all_days, hold), 1)
    sd = statistics.stdev(diffs)
    mean = statistics.mean(diffs)
    return {"excessPct": mean * 100, "t": mean / (sd / math.sqrt(eff)) if sd else None, "eff": eff}


def rolling_cell(data: MarketData, ranks: Ranks, picks: dict, end: str, split: str) -> dict:
    """{라벨: {보유: 통계}}. 무작위 평균 행 포함."""
    out = {}
    for hold in HOLDS:
        control = rolling_trades(data, ranks, picks[CONTROL], CANDIDATES, hold, end)
        rand_trades = {lbl: rolling_trades(data, ranks, picks[lbl], TOP, hold, end) for lbl in RANDOM_LABELS}
        rand_mean = statistics.mean(t["ret"] for ts in rand_trades.values() for t in ts)
        for lbl in LABELS + RANDOM_LABELS + [CONTROL]:
            ts = rand_trades.get(lbl) or (control if lbl == CONTROL else
                                          rolling_trades(data, ranks, picks[lbl], TOP, hold, end))
            rets = [t["ret"] for t in ts]
            row = {"n": len(ts), "meanPct": statistics.mean(rets) * 100 if rets else None,
                   "grossPct": statistics.mean(t["gross"] for t in ts) * 100 if ts else None,
                   "absGrossPct": statistics.mean(abs(t["gross"]) for t in ts) * 100 if ts else None,
                   "winRatePct": sum(r > 0 for r in rets) / len(rets) * 100 if rets else None,
                   "vsRandomPct": (statistics.mean(rets) - rand_mean) * 100 if rets else None}
            for half, sel in (("first", lambda d: d < split), ("second", lambda d: d >= split)):
                hts = [t for t in ts if sel(t["day"])]
                hc = [t for t in control if sel(t["day"])]
                row[half] = excess_stats(hts, hc, ranks.days, hold) | {"n": len(hts)}
            if lbl != CONTROL:
                row |= excess_stats(ts, control, ranks.days, hold)
            out.setdefault(lbl, {})[hold] = row
        seeds = [out[lbl][hold] for lbl in RANDOM_LABELS]
        out.setdefault(RANDOM_AVG, {})[hold] = {
            k: _mean([r[k] for r in seeds]) for k in ("n", "meanPct", "grossPct", "absGrossPct", "winRatePct",
                                                      "excessPct", "t")}
    return out


# --- 2차: 운영 규칙 Backtest ---

class PeriodBacktest(Backtest):
    """주문 결과를 기간 끝(settings.end)까지의 봉으로만 계산한다 (combo.ComboBacktest와 같은 이유)."""

    def _from(self, symbol: str, day: str) -> list[dict]:
        return [c for c in super()._from(symbol, day) if c["date"] <= self.s.end]


class TechBacktest(PeriodBacktest):
    """미리 계산한 선별 결과를 쓰고, 보유 기간을 거래일로 센다.

    기한 = 주문일 + (N − 1)거래일. exit_at "open"이면 기한 다음 거래일 시가(운영: 기한 경과 시 시장가),
    "close"면 그날 종가에 판다. 체결은 주문일(지정가 DAY)뿐이라 주문일 = 체결일이다.
    사실 검증은 보유 기간 검사만 우회한다 (N < SWING_MIN_DAYS면 운영 정책 밖).
    """

    def __init__(self, settings, rule, candles, names, picks: dict[str, list], exit_at: str = "open"):
        super().__init__(settings, rule, candles, names)
        self.picks, self.exit_at = picks, exit_at

    def scan(self, day: str, prev_day: str) -> list[screen.Pick]:
        return list(self.picks.get(day, []))

    def _scenario(self, p, day):
        bars = self._before(p.symbol, day)
        closes = [_f(c, "closePrice") for c in bars]
        atr = indicators.atr([_f(c, "highPrice") for c in bars], [_f(c, "lowPrice") for c in bars], closes)
        rule, s = self.rule, self.s
        entry_raw, target_raw, stop_raw = default_scenario(bars, rule, atr)
        raw = {"horizon": "SWING", "holdingDays": max(rule.holding_days, SWING_MIN_DAYS), "entryPrice": entry_raw}
        if fact_check({"lastPrice": closes[-1]}, raw):
            return None
        entry, target, stop_trigger, stop_order = plan_prices(entry_raw, target_raw, stop_raw, s.currency)
        if not 0 < stop_trigger < entry < target:
            return None
        future, n = self._from(p.symbol, day), rule.holding_days
        if self.exit_at == "open":
            expire = future[n - 1]["date"] if len(future) >= n else "9999-12-31"
            status, filled_at, fill, closed_at, exit_ = simulate_trade(
                future, entry, target, stop_trigger, stop_order, expire, currency=s.currency)
        else:
            window = future[:n + 1]
            expire = window[-1]["date"] if window else "9999-12-31"
            status, filled_at, fill, closed_at, exit_ = simulate_trade(
                window, entry, target, stop_trigger, stop_order, expire, currency=s.currency)
            if status == OPEN and len(window) == n + 1:
                status, closed_at, exit_ = EXPIRED, window[-1]["date"], _f(window[-1], "closePrice")
        t = Trade(day=day, symbol=p.symbol, name=p.name, score=p.score, entry=entry, target=target,
                  stop_trigger=stop_trigger, stop_order=stop_order, expire_date=expire,
                  probability=rule.probability, reward_risk=0.0, approved=False, reasons=[], atr=atr,
                  status=status, filled_at=filled_at, fill_price=fill, closed_at=closed_at, exit_price=exit_)
        if fill is not None:
            last_price = exit_ if exit_ is not None else _f(self.candles[p.symbol][-1], "closePrice")
            t.ret = net_return(fill, last_price, s.commission_rate, self.tax)
        return t


def cost_stats(res) -> dict:
    """비용 (자본금 대비 %): 수수료·세금, 손절 주문가 −1% (감시가 대비 덜 받은 금액)."""
    s = res.settings
    tax = SELL_TAX_RATE[s.market]
    closed = [t for t in res.trades if t.placed and t.fill_price is not None and t.closed_at]
    fees = sum(t.quantity * (t.fill_price * s.commission_rate + t.exit_price * (s.commission_rate + tax))
               for t in closed)
    stops = [t for t in closed if t.status == STOP]
    buffer = sum(t.quantity * (t.stop_trigger - t.exit_price) for t in stops if t.exit_price == t.stop_order)
    rets = [t.ret for t in closed if t.ret is not None]
    return {"feesPct": fees * s.fx_rate / s.capital_krw * 100, "stopBufferPct": buffer * s.fx_rate / s.capital_krw * 100,
            "stopSharePct": len(stops) / len(closed) * 100 if closed else None, "closed": len(closed),
            "avgRetPct": statistics.mean(rets) * 100 if rets else None}


def run_backtest(data: MarketData, label: str, settings, rule: Rule, picks=None, exit_at="open") -> dict:
    if picks is None:
        v = Variant(label, settings, rule)
        common.Backtest = PeriodBacktest
        res, sm = run_variant(data, v)
    else:
        res = TechBacktest(settings, rule, data.candles, data.names, picks, exit_at).run()
        sm = summarize(res, data.bench)
        sm["label"] = label
        sm["firstHalfPct"], sm["secondHalfPct"] = common.split_returns(res)
        sm["avgHoldDays"] = None
    sm["perExposure"] = sm["returnPct"] / sm["avgExposurePct"] if sm["avgExposurePct"] else None
    sm["cost"] = cost_stats(res)
    sm["_res"] = res
    return sm


def run_cell(data: MarketData, picks: dict, start: str, end: str, split: str) -> dict:
    """{(라벨, 보유, 목표, 청산): 요약}. 라벨 '운영 그대로'는 sim.Backtest 그대로 (달력 기한)."""
    common.SPLIT = split  # split_returns가 모듈 전역을 본다
    settings = data.base_settings(start=start, end=end)
    out = {("운영 그대로", 10, "4 ATR", "open"): run_backtest(data, "운영 규칙 그대로 (sim.Backtest, 달력 기한)",
                                                          settings, Rule("기준", 4.0, STOP_ATR))}
    for lbl in LABELS + RANDOM_LABELS:
        for hold in HOLDS:
            for tname, tatr in TARGETS:
                rule = Rule(f"{hold}일 목표 {tname}", tatr, STOP_ATR, holding_days=hold)
                out[(lbl, hold, tname, "open")] = run_backtest(
                    data, f"{lbl} · {hold}일 · 목표 {tname}", settings, rule, picks[lbl])
    for hold in HOLDS:  # 기준 선별: 기한 다음 날 종가 청산
        rule = Rule(f"{hold}일 목표 4 ATR", 4.0, STOP_ATR, holding_days=hold)
        out[(BASE, hold, "4 ATR", "close")] = run_backtest(
            data, f"{BASE} · {hold}일 · 목표 4 ATR · 종가 청산", settings, rule, picks[BASE], "close")
    for hold in HOLDS:  # 무작위 평균
        for tname, _ in TARGETS:
            seeds = [out[(lbl, hold, tname, "open")] for lbl in RANDOM_LABELS]
            out[(RANDOM_AVG, hold, tname, "open")] = {
                "label": f"{RANDOM_AVG} · {hold}일 · 목표 {tname}",
                **{k: _mean([s[k] for s in seeds]) for k in ("returnPct", "avgExposurePct", "orders", "filled",
                                                             "mddPct", "perExposure")}}
    common.SPLIT = "2026-08-01"
    return out


# --- 판정 ---

def judge(rolling: dict, bts: dict) -> list[dict]:
    """기법 × 보유별 판정. cells: (기간, 시장) 4칸."""
    rows = []
    cells = [(k, m) for k, *_ in PERIODS for m in MARKETS]
    for lbl in LABELS[1:]:
        for hold in HOLDS:
            row = {"label": lbl, "hold": hold, "cells": {}, "posHalves": 0}
            for key, m in cells:
                r = rolling[(key, m)][lbl][hold]
                base = bts[(key, m)][(BASE, hold, "4 ATR", "open")]["perExposure"]
                mine = bts[(key, m)][(lbl, hold, "4 ATR", "open")]["perExposure"]
                ok1 = (r["excessPct"] is not None and r["excessPct"] > 0 and r["t"] is not None
                       and r["t"] >= MIN_T and r["n"] >= MIN_N)
                ok2 = mine is not None and base is not None and mine > base
                rand = bts[(key, m)][(RANDOM_AVG, hold, "4 ATR", "open")]["perExposure"]
                row["cells"][f"{m}-{key}"] = {"excessPct": r["excessPct"], "t": r["t"], "n": r["n"], "pass1": ok1,
                                              "perExposure": mine, "basePerExposure": base, "pass2": ok2,
                                              "randomPerExposure": rand,
                                              "beatsRandom": mine is not None and rand is not None and mine > rand}
                row["posHalves"] += sum(1 for h in ("first", "second")
                                        if r[h]["excessPct"] is not None and r[h]["excessPct"] > 0)
            row["pass1"] = sum(c["pass1"] for c in row["cells"].values())
            row["pass2"] = sum(c["pass2"] for c in row["cells"].values())
            row["beatsRandom"] = sum(c["beatsRandom"] for c in row["cells"].values())
            row["adopt"] = row["pass1"] == 4 and row["pass2"] == 4
            rows.append(row)
    return rows


# --- 표 ---

def _p(v, d=2):
    return "-" if v is None else f"{v:+.{d}f}"


def _t(v):
    return "-" if v is None else f"{v:+.1f}"


def rolling_tables(cell: dict, signals: dict, days: int) -> list[str]:
    head = "| 선별 | 신호/일 | " + " | ".join(f"{h}일" for h in HOLDS) + " |"
    sep = "|---|---|" + "---|" * len(HOLDS)
    a = ["건당 평균 수익률 % (비용 차감, 승률), n은 5일 보유 기준 건수:", "", head.replace("신호/일", "n"), sep]
    b = ["후보 30 전체 대비 초과 %p (t, 유효 표본):", "", head, sep]
    for lbl in LABELS + [RANDOM_AVG, CONTROL]:
        rs = cell[lbl]
        a.append(f"| {lbl} | {rs[5]['n']:.0f} | " + " | ".join(
            f"{_p(rs[h]['meanPct'])} ({rs[h]['winRatePct']:.0f}%)" if rs[h]["meanPct"] is not None else "-"
            for h in HOLDS) + " |")
        if lbl == CONTROL:
            continue
        sig = f"{signals[lbl] / days:.1f}" if lbl in signals else "-"
        b.append(f"| {lbl} | {sig} | " + " | ".join(
            f"{_p(rs[h]['excessPct'])} ({_t(rs[h]['t'])}" + (f", {rs[h]['eff']})" if "eff" in rs[h] else ")")
            for h in HOLDS) + " |")
    return a + [""] + b


def judge_table(rows: list[dict]) -> list[str]:
    cells = [f"{m}-{k}" for k, *_ in PERIODS for m in MARKETS]
    names = {"KR-in": "KR 6~9", "US-in": "US 6~9", "KR-oos": "KR 2~5", "US-oos": "US 2~5"}
    lines = ["| 기법 | 보유 | " + " | ".join(names[c] for c in cells) +
             " | 1차 통과 칸 | 비중당 개선 칸 | (참고) 무작위보다 비중당 나은 칸 | 양의 반기 /8 | 판정 |",
             "|---|---|" + "---|" * len(cells) + "---|---|---|---|---|"]
    for r in rows:
        cs = [r["cells"][c] for c in cells]
        lines.append(f"| {r['label']} | {r['hold']} | " + " | ".join(
            f"{_p(c['excessPct'])} / {_t(c['t'])} / {c['n']}" + (" ✔" if c["pass1"] else "") for c in cs) +
            f" | {r['pass1']}/4 | {r['pass2']}/4 | {r['beatsRandom']}/4 | {r['posHalves']} | "
            f"{'채택 후보' if r['adopt'] else '채택 근거 없음'} |")
    return lines


def bt_matrix(bt: dict, tname: str) -> list[str]:
    lines = ["| 선별 | " + " | ".join(f"{h}일" for h in HOLDS) + " |", "|---|" + "---|" * len(HOLDS)]
    for lbl in LABELS + [RANDOM_AVG]:
        cells = []
        for h in HOLDS:
            sm = bt[(lbl, h, tname, "open")]
            cells.append(f"{_p(sm['returnPct'], 1)}% / {_p(sm['perExposure'])} / {sm['orders']:.0f}")
        lines.append(f"| {lbl} | " + " | ".join(cells) + " |")
    return lines


def hold_table(bt: dict, roll: dict) -> list[str]:
    """기준 선별과 후보 30 전체에서 보유 기간별 결과와 비용."""
    lines = ["| 보유 | 롤링 후보30 총수익 | 롤링 후보30 순수익 | 비용 ÷ 평균 절대 총수익 | 기준 BT 시가 청산 | 기준 BT 종가 청산 | "
             "목표 없음 | 주문 | PF | 손절 비율 | 평균 비중 | 수수료·세금 | 손절 −1% 비용 | 비용 ÷ 비중 |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for h in HOLDS:
        c = roll[CONTROL][h]
        o, cl, no = bt[(BASE, h, "4 ATR", "open")], bt[(BASE, h, "4 ATR", "close")], bt[(BASE, h, "없음", "open")]
        cost = c["grossPct"] - c["meanPct"]
        pf = "-" if o["profitFactor"] is None else f"{o['profitFactor']:.2f}"
        share = "-" if o["cost"]["stopSharePct"] is None else f"{o['cost']['stopSharePct']:.0f}%"
        lines.append(f"| {h}일 | {_p(c['grossPct'])}% | {_p(c['meanPct'])}% | {cost / c['absGrossPct'] * 100:.0f}% | "
                     f"{_p(o['returnPct'], 1)}% ({_p(o['perExposure'])}) | {_p(cl['returnPct'], 1)}% | "
                     f"{_p(no['returnPct'], 1)}% | {o['orders']} | {pf} | "
                     f"{share} | {o['avgExposurePct']:.0f}% | {o['cost']['feesPct']:.2f}% | "
                     f"{o['cost']['stopBufferPct']:.2f}% | "
                     f"{(o['cost']['feesPct'] + o['cost']['stopBufferPct']) / o['avgExposurePct'] * 100:.1f}% |")
    return lines


def report_rows(bt: dict) -> list[dict]:
    """write_report 표에 넣을 행: 운영 그대로, 모든 선별 10일, 기준 선별의 보유·목표·청산 변형."""
    keys = [("운영 그대로", 10, "4 ATR", "open")]
    keys += [(lbl, 10, "4 ATR", "open") for lbl in LABELS + RANDOM_LABELS]
    keys += [(BASE, h, "4 ATR", "open") for h in HOLDS if h != 10]
    keys += [(BASE, h, "없음", "open") for h in HOLDS]
    keys += [(BASE, h, "4 ATR", "close") for h in HOLDS]
    return [bt[k] for k in keys]


# --- 자체 점검 (합성 데이터) ---

def self_check() -> None:
    flat = [10.0] * 60
    assert all(abs(v - 10) < 1e-9 for v in ema_series(flat, 12)[11:])
    assert all(abs(h) < 1e-9 for h in macd_hist(flat))
    up = [10 + i * 0.1 for i in range(60)]
    assert bollinger_pb(up) > 0.8 and bollinger_pb(list(reversed(up))) < 0.2
    a = adx([x + 0.5 for x in up], [x - 0.5 for x in up], up)
    assert a[0] > 25 and a[1] > a[2]
    k, d = stochastic([x + 0.5 for x in up], [x - 0.5 for x in up], up)
    assert len(k) == len(d) == 2 and k[-1] > 50
    assert abs(slope([1, 2, 3, 4]) - 1) < 1e-9
    # 전일(마지막 봉) MACD 교차: 긴 하락 뒤 급반등
    down = [20 - i * 0.1 for i in range(80)] + [13, 15, 17]
    h = macd_hist(down)
    assert h[-2] <= 0 < h[-1] or h[-3] <= 0 < h[-2] or h[-1] > h[-2]


# --- 보고서 ---

# 아래 문장은 2026-09-30 실행 결과를 보고 썼다 (숫자는 위 표와 summary.json)
FINDINGS = [
    "**판정 기준을 넘은 기법 × 보유 조합은 없다 (55개 중 0개, 채택 근거 없음).** 한 칸에서라도 t ≥ 2인 조합이 하나도 없다 (가장 높은 것이 KR 6~9월 볼린저 %B < 0.2 1일 "
    "보유 t 1.9). 네 칸 모두 후보 30 대비 초과가 양수인 조합도 인사이드 바 1·2·3일뿐이고 모두 t ≤ 1.5다. 2차 기준(비중당 수익률이 같은 보유의 기준 선별보다 높음)을 네 칸 모두 "
    "넘은 것은 OBV 2·3일, 인사이드 바 2일이지만 이들은 1차에서 0칸 통과다.",
    "**기법의 성패는 시장 국면을 따라 뒤집힌다.** 평균회귀 계열(볼린저 %B < 0.2, RSI(2) < 10)은 약세·횡보였던 6~9월 두 시장에서 후보 30보다 나았지만 급등장인 KR "
    "2~5월에는 더 나빴다 (볼린저 %B < 0.2 10일: KR 6~9월 +4.08%p, KR 2~5월 −2.48%p. 스토캐스틱도 KR 2~5월에 가장 나빴다). 추세·돌파 계열(볼린저 상단 "
    "돌파, MACD, 거래량 돌파, 갭 상승)은 대체로 반대다 (볼린저 상단 돌파 5일: KR 6~9월 −3.33%p, KR 2~5월 +0.61%p, 1일 +1.78%p). 2차에서도 US 6~9월 "
    "볼린저 %B < 0.2는 +15.5%(기준 −18.9%)였지만 KR 2~5월은 +4.3%(기준 +17.4%, 무작위 +23.1%)였다. 어느 기법을 쓸지 고르는 일은 다음 국면을 맞히는 일과 같다.",
    "**여러 기법을 묶어도 나아지지 않았다.** 복합(기법 2개 이상)은 서로 반대 방향인 신호를 섞어 평균에 가까워졌다 (롤링 초과 −2.02~+1.94%p, t ≤ 0.9). 거래대금 상위 30 "
    "안에서 하루 8~16개 종목이 조건을 채워 사실상 '거의 아무 종목'이 된다.",
    "**기준(운영) 선별도 여전히 무작위와 구분되지 않는다.** 후보 30 대비 초과는 KR 두 기간 +0.67~+3.59%p, US 두 기간 −1.05~+0.14%p이고 t ≤ 1.4다 "
    "(screen·ideas 실험과 같은 결론). 2차 10일 보유에서 무작위 평균보다 비중당 수익률이 나은 칸은 KR 두 칸뿐이고 (6~9월 −0.42 대 −0.56, 2~5월 +0.39 대 "
    "+0.38로 사실상 같음) US 두 칸은 무작위보다 나쁘다. 그래서 '기준보다 비중당 개선'은 낮은 문턱이다 (참고 열: 무작위보다 나은 칸은 어느 조합도 3/4 이하).",
    "**보유 기간 단축(1~2일)의 수익률 개선은 비중 축소 효과다.** 기준 선별 목표 4 ATR에서 6~9월 KR은 10일 −18.2% → 1일 −7.8%, US는 −18.9% → −7.7%로 "
    "손실이 줄었지만 평균 비중도 43~46% → 13~16%로 줄었고, 비중당 수익률은 1·2일이 10일보다 나쁘다 (KR −0.59·−0.63 대 −0.42, US −0.48·−0.66 대 "
    "−0.41). 오르는 국면에서는 같은 방식으로 수익을 포기한다 (KR 2~5월 +17.4% → +0.6%, 비중당 +0.39 → +0.04). 3일은 10일과 비슷하거나 나쁘고, 5일은 6~9월에 "
    "조금 낫고 2~5월에 비슷하다 (combo의 '보유 5일' 결론과 같다).",
    "**짧게 들수록 투자금 대비 비용이 커진다.** 왕복 비용(KR 수수료 0.015% × 2 + 세금 0.2%, US 수수료 0.1% × 2)은 1회 움직임의 2~6%라 건당으로는 작지만, 회전이 "
    "빨라 4개월 누적 수수료·세금이 1일 보유는 자본금의 2.4~2.7%, 10일은 0.9~1.4%다. 평균 비중으로 나누면 1일 20~24%, 10일 7~10%로 투자한 돈 1원당 비용이 2~3배다. "
    "손절 주문가 −1% 비용은 반대로 길게 들수록 커진다 (손절 비율 1일 3~7% → 10일 48~66%, 누적 0.4~0.9% → 2.0~3.6%).",
    "**1~3일 보유에서는 목표가(4 ATR)가 거의 닿지 않는다** (기준 선별 1·2·3일 목표 도달 0~2건). 목표 없음(기한 청산만)과의 차이는 대부분 US에서 손익비 기준(비용 반영 "
    "2.0)에 걸리던 시나리오가 통과해 주문이 는 것뿐이다 (US 6~9월 1일: 손익비 탈락 33건 → 0건). 기한 다음 날 시가 대신 종가에 파는 변형은 1일 보유에서 네 칸 중 세 칸이 더 "
    "나빴고, 2일 이상에서는 부호가 섞였다.",
]
RECOMMEND = [
    "**새 기술적 분석 기법은 도입하지 않는다.** 10개 기법과 복합 모두 판정 기준(네 칸 × t ≥ 2 × 비중당 개선)을 넘지 못했다. 평균회귀와 추세 추종은 국면에 따라 성패가 뒤집혔고, "
    "이것을 이용하려면 국면 판단이 먼저 필요하다 (risk 실험의 체제 필터도 기대값의 부호를 바꾸지 못했다).",
    "**보유 기간을 1~2일로 줄이지 않는다.** 손실 축소는 비중 축소 효과이고 비중당 수익률은 나빠졌으며, 오르는 국면의 수익을 버리고, 투자금 대비 비용이 2~3배다. 1·2일 보유는 운영 "
    "정책(scenario.SWING_MIN_DAYS = 3, 스윙 3~20거래일) 밖이라 채택하려면 정책 변경(사용자 결정)과 fact_check 수정이 필요한데, 그럴 근거가 없다. 3~5일은 정책 "
    "안이고 10일과 차이가 표본 오차 수준이라 바꿀 이유도 없다.",
    "**과최적화 주의: 표에서 좋아 보이는 칸을 골라 쓰지 않는다.** 55개 조합 × 4칸을 봤고, 칸마다 유효 표본은 겹치지 않는 구간 6~42개다. US 6~9월 볼린저 %B < "
    "0.2(+15.5%), US 2~5월 MACD 2일(+8.6%) 같은 한 칸의 성과는 우연으로 충분히 나온다. 인사이드 바가 20개(4칸 × 보유 5개) 중 18개에서 양의 초과였지만 보유 기간끼리 "
    "같은 신호라 독립이 아니고, 11개 기법 중 하나가 우연히 네 칸 모두 같은 부호일 기대 횟수가 약 0.7개라 가설 이상이 아니다 (t ≤ 1.5). 두 기간 모두 극단적 국면(KODEX 200 "
    "−18%, +73%)이고 유니버스 편향이 있다. 다시 볼 때는 serve가 쌓는 실제 랭킹(`rankings` 표)으로 편향 없는 후보를 만든 뒤, 기법을 새로 고르지 말고 이 표의 조합만 표본 "
    "외로 확인한다.",
]
NOTES = [
    "데이터는 일봉뿐이다. 분봉 이력은 API로 받을 수 없어 장중 기법(시가 돌파 진입, VWAP 등)은 다루지 않았다. "
    "인사이드 바 돌파는 진입 후 전일 고가 돌파를 일봉으로 확인할 수 없어 '전일 인사이드 바'를 신호로만 썼다.",
    f"기법 선별에는 일봉 {TECH_CANDLES}개까지 준다 (기준 선별은 운영과 같은 {SCREEN_CANDLES}개). 캐시가 2025-11-03부터라 "
    "2~5월과 6~8월 중순에는 200일선을 계산할 수 없어 RSI(2)는 대부분 60일선을 썼다.",
    "1·2일 보유는 운영 정책(scenario.SWING_MIN_DAYS = 3, 스윙 3~20거래일) 밖이다. 백테스트는 사실 검증의 보유 기간 검사만 "
    "우회했다. 채택하려면 정책 변경(사용자 결정)이 필요하다.",
    "2차 Backtest의 보유 기간은 거래일로 센다 (기한 = 주문일 + (N − 1)거래일, 다음 거래일 시가 청산). 운영 코드는 달력 날짜 "
    "기한(holding_days × 7 ÷ 5 + 2일)이라 10일 보유도 '운영 그대로' 행과 조금 다르다.",
    "롤링(1차)은 주문일 시가 매수 → N거래일 뒤 종가 매도, 비용(수수료·세금) 차감, 리스크 엔진·손절 없음. 매도일이 기간 끝을 "
    "넘는 신호는 뺐다. t값은 일별 초과(기법 평균 − 후보 30 평균)의 평균을 표준오차로 나눈 것이고, 유효 표본은 겹치지 않는 "
    "보유 구간 수로 봤다 (대략적인 보정).",
    "'후보 30 전체'는 전일 거래대금 상위 30 중 일봉 60개 이상인 종목 전부의 평균이고, 무작위 3종목 선택의 기대값과 같다. "
    "그래서 '무작위 대비 초과'의 기준으로 쓴다 (무작위 시드 3개의 결과도 표에 있다).",
    "유니버스 편향: 오늘(2026-09-30) 기준 거래대금 랭킹의 합집합이다. 기간 중에 뜬 종목이 미리 들어가 있고 상장폐지 종목이 "
    "없다. 모든 기법에 같이 작용하지만 반전·평균회귀 계열을 실제보다 좋게 보이게 할 수 있다.",
    "다중 비교: 기법 11개 × 보유 5개 = 55개 조합을 4칸에서 본다. 한 칸의 t ≥ 2는 우연으로도 몇 개 나온다. 그래서 네 칸 모두를 "
    "요구했다.",
]


def write_summary(rolling, signals, days, bts, judged) -> Path:
    rows_by = {}
    for key, title, *_ in PERIODS:
        for m in MARKETS:
            rows_by[f"{m} · {title}"] = [{k: v for k, v in sm.items() if k != "_res"} for sm in report_rows(bts[(key, m)])]
    path = write_report(NAME, "추가 기술적 분석 기법과 단기 보유", rows_by, NOTES, FINDINGS)
    text = path.read_text()
    # 표본 외 표의 반기 이름을 바꾼다
    head, _, tail = text.partition("## KR · 2~5월")
    body, _, rest = tail.partition("## 해석")
    body = body.replace("| 6~7월 | 8~9월 |", "| 2~3월 | 4~5월 |")
    text = head + "## KR · 2~5월" + body + "## 해석" + rest
    text = text.replace(
        "기간 2026-06-01 ~ 2026-09-30, 자본금 1000만원, AI 없음. 기준(운영 규칙)은 첫 행.",
        "기간 2026-06-01 ~ 09-30과 표본 외 2026-02-09 ~ 05-29, 자본금 1000만원, AI 없음, 일봉만. "
        "아래 시장별 표(운영 규칙 Backtest)의 첫 행은 운영 규칙 그대로(sim.Backtest), 이후는 거래일 기한 서브클래스 "
        "(모든 선별 10일, 기준 선별의 보유 1·2·3·5일, 목표 없음, 종가 청산).")
    pre = ["## 질문", "",
           "더 다양한 기술적 분석 기법을 도입해야 하는가, 보유 기간을 스윙보다 짧게(1~5거래일) 줄이면 나아지는가.", "",
           "## 판정 기준 (결과를 보기 전에 정함)", "",
           "기법 × 보유 기간 조합이 **채택 후보**가 되려면 네 칸(6~9월·2~5월 × KR·US) **모두**에서:",
           "",
           f"1. 롤링(1차): 후보 30 전체(= 무작위 기대값) 대비 초과 > 0, t ≥ {MIN_T:.0f}, 신호(체결 가정 건수) ≥ {MIN_N}",
           "2. 운영 규칙 Backtest(2차, 목표 4 ATR): 비중당 수익률(수익률 ÷ 평균 비중)이 같은 보유 기간의 기준 선별보다 높다",
           "",
           "하나라도 못 넘으면 '채택 근거 없음'. 보유 기간 단축은 기법과 분리해 기준 선별·후보 30 전체에서 1·2·3·5·10일을 비교한다.",
           "", "## 1차: 선별만의 예측력 (롤링)", ""]
    for key, title, *_ in PERIODS:
        for m in MARKETS:
            pre += [f"### {m} · {title}", ""] + rolling_tables(rolling[(key, m)], signals[(key, m)],
                                                                days[(key, m)]) + [""]
    pre += ["## 판정 기준 대비", "",
            "칸 = 후보 30 대비 초과 %p / t / 신호 수 (✔ = 1차 기준 통과). 비중당 개선 칸 = 2차 목표 4 ATR에서 같은 보유 기간의 "
            "기준 선별보다 비중당 수익률이 높은 칸 수. 양의 반기 = 8개 반기(4칸 × 앞·뒤) 중 초과가 양수인 수.", ""]
    pre += judge_table(judged)
    adopted = [f"{r['label']} {r['hold']}일" for r in judged if r["adopt"]]
    pre += ["", f"**채택 후보: {', '.join(adopted) if adopted else '없음 (채택 근거 없음)'}**", "",
            "## 2차: 운영 규칙 Backtest (리스크 엔진 포함)", "",
            "칸 = 수익률 / 비중당 수익률 / 주문 수. 손절 1.5 ATR(주문가 −1%), 전일 종가 지정가 DAY, 자본금 1000만원.", ""]
    for key, title, *_ in PERIODS:
        for m in MARKETS:
            for tname, _ in TARGETS:
                pre += [f"### {m} · {title} · 목표 {tname}", ""] + bt_matrix(bts[(key, m)], tname) + [""]
    pre += ["## 보유 기간과 비용 (기법과 분리)", "",
            "롤링 후보30 = 후보 30 전체를 시가 매수 → N일 뒤 종가 매도 (총수익은 비용 전, 순수익은 비용 후, "
            "비용 ÷ 평균 절대 총수익 = 왕복 비용이 건당 평균 움직임의 몇 %인지). 기준 BT = 기준 선별의 운영 규칙 Backtest "
            "(목표 4 ATR, 괄호는 비중당 수익률). 비용 열은 자본금 대비 누적, 비용 ÷ 비중 = (수수료·세금 + 손절 −1% 비용) "
            "÷ 평균 비중 (투자한 돈 1원당 비용).", ""]
    for key, title, *_ in PERIODS:
        for m in MARKETS:
            pre += [f"### {m} · {title}", ""] + hold_table(bts[(key, m)], rolling[(key, m)]) + [""]
    first, _, after = text.partition("\n## ")
    text = first + "\n" + "\n".join(pre) + "\n## " + after
    text = text.replace("파일: `<시장>-trades-N.csv` (N은 표의 행 순서)",
                        "파일: `<시장>-<in|oos>-trades-N.csv` (in = 6~9월, oos = 2~5월, N은 시장별 표의 행 순서)")
    if RECOMMEND:
        text = text.replace("\n## 주의", "\n## 권고\n\n" + "\n".join(f"- {x}" for x in RECOMMEND) + "\n\n## 주의")
    path.write_text(text)
    js = {"rolling": {f"{m}-{k}": v for (k, m), v in rolling.items()},
          "signals": {f"{m}-{k}": v for (k, m), v in signals.items()},
          "backtests": {f"{m}-{k}": {" | ".join(map(str, kk)): {x: y for x, y in sm.items() if x != "_res"}
                                     for kk, sm in bt.items()} for (k, m), bt in bts.items()},
          "judge": judged, "rsi2Trend": TREND_200}
    (path.parent / "summary.json").write_text(json.dumps(js, ensure_ascii=False, indent=1, default=str))
    return path


def main() -> None:
    self_check()
    rolling, signals, days, bts = {}, {}, {}, {}
    out = RESULTS / "experiments" / NAME
    out.mkdir(parents=True, exist_ok=True)
    for m in MARKETS:
        data = load_market(m)
        ranks = Ranks(data)
        for key, title, start, end, split, _ in PERIODS:
            picks, sig = daily_picks(data, ranks, start, end)
            check_matches_scan(data, picks, start)
            days[(key, m)] = len(picks[BASE])
            signals[(key, m)] = sig
            rolling[(key, m)] = rolling_cell(data, ranks, picks, end, split)
            bt = bts[(key, m)] = run_cell(data, picks, start, end, split)
            got = bt[("운영 그대로", 10, "4 ATR", "open")]["returnPct"]
            if abs(got - EXPECTED[(key, m)]) > 0.05:
                raise SystemExit(f"[{m} {key}] 운영 규칙 재현 실패: {got:+.2f}% ≠ {EXPECTED[(key, m)]:+.2f}%")
            for i, sm in enumerate(report_rows(bt), 1):
                write_trades(out / f"{m}-{key}-trades-{i}.csv", sm["_res"])
            print(f"  [{m} {key}] 완료: 운영 그대로 {got:+.2f}%", file=sys.stderr)
    judged = judge(rolling, bts)
    print(write_summary(rolling, signals, days, bts, judged))


if __name__ == "__main__":
    main()
