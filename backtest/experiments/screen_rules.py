"""실험 2: 선별 규칙 (judge/screen.py). 캐시만 읽고 증권사 API·AI는 부르지 않는다.

  uv run python backtest/experiments/screen_rules.py

기준(운영 규칙)은 첫 행. 선별 함수는 screen.score를 감싸서 만든다 (60일선 필터 제거만 같은 식을 다시 계산한다).
결과: backtest/results/experiments/screen/summary.md, summary.json, <시장>-trades-N.csv
"""
import random
import statistics
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (END, SPLIT, START, MarketData, Variant, load_market, run_variant, run_variants,  # noqa: E402
                    write_report)
from sim import SCREEN_CANDLES, Backtest, Result, Rule  # noqa: E402
from paper_engine.data import indicators  # noqa: E402
from paper_engine.judge import screen  # noqa: E402

RULE = Rule("기준", 4.0, 1.5)
RANDOM_SEEDS = (1, 2, 3)
HOLD_DAYS = 10  # 단순 예측력 표: 주문일 시가 매수 → 10거래일 뒤 종가 매도


# --- 선별 함수 (screen.score 래핑) ---

def _momentum_points(change20: float) -> float:
    return 20 * min(max(change20, 0) / 0.25, 1)


def with_min_score(minimum: float):
    def f(symbol, name, candles, amount):
        p = screen.score(symbol, name, candles, amount)
        if isinstance(p, screen.Pick) and p.score < minimum:
            return f"점수 {p.score} < {minimum}"
        return p
    return f


def no_momentum(symbol, name, candles, amount):
    """모멘텀 20점을 뺀다 (80점 만점)."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    return replace(p, score=round(p.score - _momentum_points(p.change20d), 1))


def reversed_momentum(symbol, name, candles, amount):
    """모멘텀 반전: 20일 수익률이 낮을수록 높은 점수 (상승 추세 안의 눌림목)."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    return replace(p, score=round(p.score - _momentum_points(p.change20d) + (20 - _momentum_points(p.change20d)), 1))


def rsi_pullback(symbol, name, candles, amount):
    """RSI 40~55 눌림목만."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    if p.rsi > 55:
        return f"RSI {p.rsi:.0f} > 55"
    return p


def breakout20(symbol, name, candles, amount):
    """20일 신고가 돌파: 전일 종가 > 그 이전 20일 고가."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    prior_high = max(float(c["highPrice"]) for c in candles[-21:-1])
    if float(candles[-1]["closePrice"]) <= prior_high:
        return "20일 고가 미돌파"
    return p


def volume_surge(symbol, name, candles, amount):
    """거래량 급증: 전일 거래량 > 20일 평균 × 1.5."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    avg = statistics.mean(float(c["volume"]) for c in candles[-21:-1])
    if float(candles[-1]["volume"]) <= avg * 1.5:
        return "거래량 급증 아님"
    return p


def score_without_sma60(symbol, name, candles, amount):
    """screen.score와 같은 식에서 '60일선 아래' 탈락만 뺀 것. 점수식은 그대로."""
    if len(candles) < screen.MIN_CANDLES:
        return f"일봉 {len(candles)}개"
    closes = [float(c["closePrice"]) for c in candles]
    highs = [float(c["highPrice"]) for c in candles]
    lows = [float(c["lowPrice"]) for c in candles]
    close = closes[-1]
    sma20, sma60 = indicators.sma(closes, 20), indicators.sma(closes, 60)
    rsi = indicators.rsi(closes)
    atr_ratio = indicators.atr(highs, lows, closes) / close
    change20 = indicators.change_rate(closes, 20)
    if not 40 <= rsi <= 75:
        return f"RSI {rsi:.0f}"
    if not 0.015 <= atr_ratio <= 0.08:
        return f"ATR 비율 {atr_ratio:.1%}"
    points = (20 if close > sma20 else 0) + (20 if sma20 > sma60 else 0)
    points += _momentum_points(change20)
    points += 20 * max(0, 1 - abs(rsi - 55) / 20)
    points += 20 * max(0, 1 - abs(atr_ratio - 0.035) / 0.035)
    return screen.Pick(symbol, name, round(points, 1), close, rsi, atr_ratio, change20, amount)


def dip5(symbol, name, candles, amount):
    """추가: 5일 눌림 (전일 종가 < 5거래일 전 종가). 추세 필터·점수는 기준과 같다."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    closes = [float(c["closePrice"]) for c in candles]
    if closes[-1] >= closes[-6]:
        return "5일 눌림 아님"
    return p


def near_sma20(symbol, name, candles, amount):
    """추가: 20일선 눌림목 (종가가 20일선의 −3% ~ +1%). 추세 필터·점수는 기준과 같다."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    closes = [float(c["closePrice"]) for c in candles]
    gap = closes[-1] / indicators.sma(closes, 20) - 1
    if not -0.03 <= gap <= 0.01:
        return f"20일선 대비 {gap:+.1%}"
    return p


def by_trading_amount(symbol, name, candles, amount):
    """추가: 필터만 두고 점수 대신 거래대금 순 (점수식이 순서에 보태는 것이 있는지)."""
    p = screen.score(symbol, name, candles, amount)
    if isinstance(p, str):
        return p
    return replace(p, score=amount)


def random_pick(seed: int, filtered: bool):
    """무작위 선별. filtered=False면 후보(거래대금 상위) 중 일봉 60개만 요구, True면 기준 필터 통과 종목 중."""
    def f(symbol, name, candles, amount):
        if filtered:
            p = screen.score(symbol, name, candles, amount)
            if isinstance(p, str):
                return p
        elif len(candles) < screen.MIN_CANDLES:
            return f"일봉 {len(candles)}개"
        rng = random.Random(f"{seed}:{symbol}:{candles[-1]['date']}")
        return screen.Pick(symbol, name, round(rng.random() * 100, 1), float(candles[-1]["closePrice"]),
                           0.0, 0.0, 0.0, amount)
    return f


def variants(data: MarketData) -> list[Variant]:
    s = data.base_settings()

    def v(label, screen_fn=None, **overrides):
        return Variant(label, data.base_settings(**overrides) if overrides else s, RULE,
                       {} if screen_fn is None else {"screen_fn": screen_fn})

    out = [
        v("기준"),
        v("분석 수 1", analyze_top=1), v("분석 수 5", analyze_top=5), v("분석 수 10", analyze_top=10),
        v("후보 수 60", candidates=60), v("후보 수 100", candidates=100),
        v("점수 하한 60", with_min_score(60)), v("점수 하한 70", with_min_score(70)),
        v("모멘텀 제거", no_momentum), v("모멘텀 반전 (눌림목)", reversed_momentum),
        v("RSI 40~55만", rsi_pullback),
        v("20일 신고가 돌파", breakout20),
        v("거래량 급증 ×1.5", volume_surge),
        v("60일선 필터 제거", score_without_sma60),
        v("추가: 5일 눌림", dip5),
        v("추가: 20일선 눌림목", near_sma20),
        v("추가: 필터만, 거래대금 순", by_trading_amount),
    ]
    for seed in RANDOM_SEEDS:
        out.append(v(f"무작위 (후보 30) seed {seed}", random_pick(seed, filtered=False)))
    for seed in RANDOM_SEEDS:
        out.append(v(f"무작위 (필터 통과) seed {seed}", random_pick(seed, filtered=True)))
    return out


# --- 무작위 시드 평균 행 ---

AVG_KEYS = ("returnPct", "firstHalfPct", "secondHalfPct", "mddPct", "avgExposurePct", "orders", "filled",
            "winRatePct", "profitFactor")


def _mean(values):
    values = [x for x in values if x is not None]
    return statistics.mean(values) if values else None


def average_rows(label: str, rows: list[dict]) -> dict:
    avg = dict(rows[0])
    avg["label"] = label
    for k in AVG_KEYS:
        avg[k] = _mean(r[k] for r in rows)
    avg["orders"], avg["filled"] = round(avg["orders"]), round(avg["filled"])
    avg["exits"] = {k: round(_mean(r["exits"][k] for r in rows)) for k in rows[0]["exits"]}
    avg["funnel"] = {k: (round(_mean(r["funnel"][k] for r in rows)) if isinstance(rows[0]["funnel"][k], (int, float))
                         else rows[0]["funnel"][k]) for k in rows[0]["funnel"]}
    avg["seeds"] = [r["label"] for r in rows]
    return avg


def insert_averages(rows: list[dict]) -> list[dict]:
    """무작위 시드 행들 뒤에 평균 행을 끼운다."""
    out, group = [], {}
    for r in rows:
        out.append(r)
        if r["label"].startswith("무작위"):
            group.setdefault(r["label"].split(" seed")[0], []).append(r)
    for prefix, rs in group.items():
        out.append(average_rows(f"{prefix} 평균 ({len(rs)} 시드)", rs))
    return out


# --- 선별 규칙 자체의 예측력: 주문일 시가 매수 → 10거래일 뒤 종가 매도 ---

def simple_returns(data: MarketData, res: Result, index: dict, bench_index: dict) -> list[tuple[str, float, float]]:
    """(주문일, 수익률, 같은 구간 벤치마크 수익률). 10거래일 뒤 종가가 있는 것만."""
    rows = []
    for day, sym in sorted({(t.day, t.symbol) for t in res.trades}):
        i = index[sym].get(day)
        bars = data.candles[sym]
        if i is None or i + HOLD_DAYS >= len(bars):
            continue
        ret = float(bars[i + HOLD_DAYS]["closePrice"]) / float(bars[i]["openPrice"]) - 1
        b = bench_index.get(day)
        bench = (float(data.bench[b + HOLD_DAYS]["closePrice"]) / float(data.bench[b]["openPrice"]) - 1
                 if b is not None and b + HOLD_DAYS < len(data.bench) else None)
        rows.append((day, ret, bench))
    return rows


def predict_row(label: str, rows: list[tuple[str, float, float]]) -> dict:
    rets = [r for _, r, _ in rows]
    excess = [r - b for _, r, b in rows if b is not None]
    first = [r for d, r, _ in rows if d < SPLIT]
    second = [r for d, r, _ in rows if d >= SPLIT]
    return {"label": label, "n": len(rows), "meanPct": _mean(rets) and _mean(rets) * 100,
            "winRatePct": (sum(r > 0 for r in rets) / len(rets) * 100) if rets else None,
            "excessPct": _mean(excess) and _mean(excess) * 100,
            "firstHalfPct": _mean(first) and _mean(first) * 100, "nFirst": len(first),
            "secondHalfPct": _mean(second) and _mean(second) * 100, "nSecond": len(second)}


def predict_rows(data: MarketData, vs: list[Variant]) -> list[dict]:
    index = {sym: {c["date"]: i for i, c in enumerate(bars)} for sym, bars in data.candles.items()}
    bench_index = {c["date"]: i for i, c in enumerate(data.bench)}
    out, group = [], {}
    for v in vs:
        res = Backtest(v.settings, v.rule, data.candles, data.names, **v.backtest_kwargs).run()
        rows = simple_returns(data, res, index, bench_index)
        out.append(predict_row(v.label, rows))
        if v.label.startswith("무작위"):
            group.setdefault(v.label.split(" seed")[0], []).extend(rows)
    for prefix, rows in group.items():
        out.append(predict_row(f"{prefix} 평균 ({len(RANDOM_SEEDS)} 시드, 합산)", rows))
    return out


def _p(v, digits=2):
    return "-" if v is None else f"{v:+.{digits}f}%"


def predict_table(rows: list[dict]) -> list[str]:
    lines = ["| 변형 | 건수 | 평균 10일 수익률 | 승률 | 벤치마크 초과 | 6~7월 (건수) | 8~9월 (건수) |",
             "|---|---|---|---|---|---|---|"]
    for r in rows:
        win = "-" if r["winRatePct"] is None else f"{r['winRatePct']:.0f}%"
        lines.append(f"| {r['label']} | {r['n']} | {_p(r['meanPct'])} | {win} | {_p(r['excessPct'])} | "
                     f"{_p(r['firstHalfPct'])} ({r['nFirst']}) | {_p(r['secondHalfPct'])} ({r['nSecond']}) |")
    return lines


# --- 유니버스 편향 점검: 전일 거래대금 순위 구간별 10거래일 수익률 (선별 없이 유니버스 전체) ---

RANK_BUCKETS = ((1, 30), (31, 60), (61, 100), (101, 10_000))


def rank_bucket_rows(data: MarketData) -> list[dict]:
    days = sorted({c["date"] for bars in data.candles.values() for c in bars})
    calendar = [d for d in days if START <= d <= END]
    index = {sym: {c["date"]: i for i, c in enumerate(bars)} for sym, bars in data.candles.items()}
    bench_index = {c["date"]: i for i, c in enumerate(data.bench)}
    buckets: dict[tuple, list] = {b: [] for b in RANK_BUCKETS}
    for day in calendar:
        prev = days[days.index(day) - 1]
        ranked = sorted(((float(c["closePrice"]) * float(c["volume"]), sym)
                         for sym, ix in index.items() if (i := ix.get(prev)) is not None
                         for c in [data.candles[sym][i]]), reverse=True)
        b = bench_index.get(day)
        if b is None or b + HOLD_DAYS >= len(data.bench):
            continue
        bench = float(data.bench[b + HOLD_DAYS]["closePrice"]) / float(data.bench[b]["openPrice"]) - 1
        for rank, (_, sym) in enumerate(ranked, 1):
            i = index[sym].get(day)
            bars = data.candles[sym]
            if i is None or i + HOLD_DAYS >= len(bars):
                continue
            ret = float(bars[i + HOLD_DAYS]["closePrice"]) / float(bars[i]["openPrice"]) - 1
            for lo, hi in RANK_BUCKETS:
                if lo <= rank <= hi:
                    buckets[(lo, hi)].append((day, ret, bench))
    return [predict_row(f"순위 {lo}~{hi}" if hi < 10_000 else f"순위 {lo}+", rows)
            for (lo, hi), rows in buckets.items() if rows]


def bucket_table(rows: list[dict]) -> list[str]:
    lines = ["| 전일 거래대금 순위 (유니버스 안) | 건수 | 평균 10일 수익률 | 승률 | 벤치마크 초과 | 6~7월 | 8~9월 |",
             "|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['label']} | {r['n']} | {_p(r['meanPct'])} | {r['winRatePct']:.0f}% | {_p(r['excessPct'])} | "
                     f"{_p(r['firstHalfPct'])} | {_p(r['secondHalfPct'])} |")
    return lines


def check_baseline(data: MarketData, expected: float) -> None:
    """기준이 운영 결과와 같은지, 60일선 재계산이 필터를 켜면 screen.score와 같은지 확인."""
    _, sm = run_variant(data, Variant("기준", data.base_settings(), RULE))
    if abs(sm["returnPct"] - expected) > 0.01:
        raise SystemExit(f"[{data.market}] 기준 수익률 {sm['returnPct']:+.2f}% ≠ 기대 {expected:+.2f}%. 중단")
    for sym, bars in data.candles.items():
        for end in (200, len(bars)):
            window = bars[:end][-SCREEN_CANDLES:]
            mine = score_without_sma60(sym, sym, window, 1.0)
            base = screen.score(sym, sym, window, 1.0)
            if isinstance(base, screen.Pick) and mine != base:
                raise SystemExit(f"60일선 제거 점수식이 기준과 다름: {sym} {base} vs {mine}")


NOTES = [
    "유니버스는 오늘 기준 거래대금 랭킹의 합집합이라 생존·미래 편향이 있다 (기간 중에 뜬 종목이 미리 들어가 있고, "
    "상장폐지·거래정지 종목은 없다). 이 편향은 모든 변형에 같은 방향으로 작용하지만, 절대 수익률은 실제보다 좋게 나온다.",
    "표본은 4개월(약 80거래일), 변형당 주문 40~100건이다. 변형 사이 몇 %p 차이는 종목 몇 개의 결과로 뒤집힐 수 있어 "
    "통계적으로 의미 있는 차이가 아니다. 여러 변형 중 가장 좋은 것을 고르는 것 자체가 과최적화다.",
    "국내는 이 기간 KODEX 200이 −18%(7월 −21%)로 급락장이라 추세 추종 규칙 전체가 불리했다. "
    "강세장에서는 반대 결론이 나올 수 있다.",
    "예측력 표는 리스크 엔진·주문 규칙 없이 선별 결과(시나리오가 만들어진 (주문일, 종목) 쌍)를 주문일 시가에 사서 "
    f"{HOLD_DAYS}거래일 뒤 종가에 판 단순 수익률이다. 비용은 뺐고, {HOLD_DAYS}거래일 뒤 봉이 없는 9월 후반 선별은 제외했다. "
    "벤치마크 초과는 같은 날짜 구간의 KODEX 200(국내)·SPY(미국) 수익률을 뺀 값이다.",
    "무작위 선별은 시드 3개를 각각 돌리고 평균 행을 덧붙였다 (예측력 표의 평균은 3개 시드의 건을 합산한 평균).",
    "선별 이후 단계(시나리오 ATR 4.0·1.5, 리스크 엔진, 지정가 DAY 진입, OCO 청산)는 모든 변형에서 운영 규칙 그대로다.",
]


def main():
    expected = {"KR": -17.81, "US": -17.76}
    rows_by_market, predict_by_market, bucket_by_market = {}, {}, {}
    for market in ("KR", "US"):
        data = load_market(market)
        check_baseline(data, expected[market])
        vs = variants(data)
        print(f"[{market}] {len(vs)}개 변형", file=sys.stderr)
        rows_by_market[market] = insert_averages(run_variants(data, vs, name="screen"))
        predict_by_market[market] = predict_rows(data, vs)
        bucket_by_market[market] = rank_bucket_rows(data)
    findings = build_findings(rows_by_market, predict_by_market, bucket_by_market)
    path = write_report("screen", "선별 규칙 (screen)", rows_by_market, NOTES, findings)
    # 예측력 표를 summary.md 끝에, summary.json에 predict 키로 덧붙인다
    extra = []
    for market, rows in predict_by_market.items():
        extra += ["", f"## 선별 규칙 자체의 예측력 ({market}): 주문일 시가 매수 → {HOLD_DAYS}거래일 뒤 종가 매도", ""]
        extra += predict_table(rows)
    extra += ["", "## 유니버스 편향 점검: 전일 거래대금 순위 구간별 10거래일 수익률 (선별 없이 유니버스 전체)", "",
              "운영에서는 그날 실제 랭킹 상위 30개가 후보다. 백테스트 유니버스는 오늘 기준 랭킹의 합집합이라, 기간 중 순위가 "
              "낮았던 종목은 '나중에 거래가 늘어난(대개 오른) 종목'이다. 순위가 낮을수록 수익률이 높으면 그 편향이 보이는 것이다."]
    for market, rows in bucket_by_market.items():
        extra += ["", f"{market}:", ""] + bucket_table(rows)
    text = path.read_text()
    marker = "\n## 해석"
    text = text.replace(marker, "\n".join(extra) + "\n" + marker, 1)
    path.write_text(text)
    import json
    j = path.with_name("summary.json")
    payload = json.loads(j.read_text())
    payload["predict"] = predict_by_market
    payload["rankBuckets"] = bucket_by_market
    j.write_text(json.dumps(payload, ensure_ascii=False, indent=1, default=str))
    print(text)
    print(f"\n결과: {path}", file=sys.stderr)


def build_findings(rows_by_market: dict, predict_by_market: dict, bucket_by_market: dict) -> list[str]:
    """숫자는 표에서 뽑고, 해석 문장은 2026-09-30 실행 결과를 보고 쓴 것이다. 결과가 바뀌면 문장도 다시 읽어야 한다."""
    def find(rows, label):
        """라벨이 정확히 같은 행, 없으면 그 라벨로 시작하는 첫 행 (무작위 평균 행)."""
        exact = [row for row in rows if row["label"] == label]
        prefix = [row for row in rows if row["label"].startswith(label)]
        return (exact or prefix or [None])[0]

    def r(market, label, key="returnPct"):
        row = find(rows_by_market[market], label)
        return None if row is None else row[key]

    def p(market, label, key="meanPct"):
        row = find(predict_by_market[market], label)
        return None if row is None else row[key]

    def b(market, label, key="meanPct"):
        for row in bucket_by_market[market]:
            if row["label"] == label:
                return row[key]
        return None

    def both(label, key="returnPct", fn=r, digits=2):
        return f"국내 {_p(fn('KR', label, key), digits)}, 미국 {_p(fn('US', label, key), digits)}"

    def halves(market, label):
        return f"{_p(p(market, label, 'firstHalfPct'))} / {_p(p(market, label, 'secondHalfPct'))}"

    rand, rand_f = "무작위 (후보 30) 평균", "무작위 (필터 통과) 평균"
    return [
        f"**기준(운영 규칙)은 두 시장 모두 손실이다** (자산 {both('기준')}). 선별된 종목을 주문일 시가에 사서 10거래일 뒤 "
        f"종가에 판 단순 수익률은 {both('기준', 'meanPct', p)}, 벤치마크 초과는 {both('기준', 'excessPct', p)}로 "
        "선별 규칙 자체가 시장을 이기지 못했다. 미국은 SPY가 +1.2%인 기간에도 선별 종목은 마이너스였다.",
        f"**규칙은 무작위보다 낫다는 증거가 없다.** 단순 10일 수익률 기준으로 국내는 후보 30개 무작위 "
        f"{_p(p('KR', rand))}, 필터(60일선·RSI·ATR) 통과 종목 중 무작위 {_p(p('KR', rand_f))}, 기준 {_p(p('KR', '기준'))}. "
        "급락장에서 필터는 추세가 꺾인 종목을 걸러 무작위보다 나았지만, 점수 순서가 보태는 몫은 필터 통과 무작위의 시드 범위"
        f"({_p(p('KR', '무작위 (필터 통과) seed 3'))}~{_p(p('KR', '무작위 (필터 통과) seed 2'))}) 바로 위에 있어 "
        f"우연과 구분되지 않는다. 미국은 반대로 후보 30개 무작위 {_p(p('US', rand))}, 필터 통과 무작위 {_p(p('US', rand_f))}, "
        f"기준 {_p(p('US', '기준'))}로 필터와 점수 순서가 모두 해로웠다 (RSI 40 미만 등 걸러낸 종목이 반등). "
        f"자산 수익률(후보 30 무작위 {both(rand)})은 무작위가 같은 종목을 반복 선별하지 않아 투자 비중이 "
        f"{r('KR', rand, 'avgExposurePct'):.0f}~{r('US', rand, 'avgExposurePct'):.0f}%로 높아진 효과가 섞여 있어 "
        "선별 규칙 비교에는 단순 10일 수익률 표가 더 맞다.",
        f"**후보 수 60·100의 개선은 믿을 수 없다** (자산 60: {both('후보 수 60')}, 100: {both('후보 수 100')}, "
        f"단순 10일 60: {both('후보 수 60', 'meanPct', p)}, 100: {both('후보 수 100', 'meanPct', p)}). "
        "유니버스 편향 점검 표에서 선별 없이도 전일 거래대금 순위가 낮은 종목일수록 10일 수익률이 높다 "
        f"(국내 1~30위 {_p(b('KR', '순위 1~30'))} → 61~100위 {_p(b('KR', '순위 61~100'))} → 101위 밖 {_p(b('KR', '순위 101+'))}, "
        f"미국 {_p(b('US', '순위 1~30'))} → {_p(b('US', '순위 61~100'))} → {_p(b('US', '순위 101+'))}). "
        "유니버스가 오늘 기준 랭킹으로 만들어져, 기간 중 순위가 낮았던 종목은 '나중에 거래가 늘어난(오른) 종목'이다. "
        "운영에서는 그날 실제 랭킹 31~100위가 후보가 되므로 이 편향이 없다. 이 두 변형은 백테스트로 판단할 수 없다.",
        f"**분석 수**: 자산 1개 {both('분석 수 1')}, 5개 {both('분석 수 5')}, 10개 {both('분석 수 10')}. "
        "종목 수에 따라 투자 비중이 23%에서 74%까지 바뀌어 손실 크기가 달라진 것이고 (기대값이 음수면 덜 살수록 낫다), "
        f"1위 종목만의 단순 10일 수익률은 {both('분석 수 1', 'meanPct', p)}로 국내는 기준보다 조금 낫고 미국은 더 나쁘다. "
        "점수 1위가 2~3위보다 좋은 종목이 아니다.",
        f"**점수 하한**: 자산 60 {both('점수 하한 60')}, 70 {both('점수 하한 70')}. 남은 종목의 단순 10일 수익률은 "
        f"60 {both('점수 하한 60', 'meanPct', p)}, 70 {both('점수 하한 70', 'meanPct', p)}로 기준과 같은 수준이다. "
        "손실이 준 것은 주문 수가 줄어서이고, 점수가 높은 종목이 더 좋은 종목이라는 신호는 없다.",
        f"**모멘텀 점수는 시장에 따라 반대로 나왔다.** 단순 10일 수익률: 국내 제거 {_p(p('KR', '모멘텀 제거'))}, "
        f"반전 {_p(p('KR', '모멘텀 반전'))} (기준 {_p(p('KR', '기준'))}); 미국 제거 {_p(p('US', '모멘텀 제거'))}, "
        f"반전 {_p(p('US', '모멘텀 반전'))} (기준 {_p(p('US', '기준'))}). 국내 급락장에서는 20일 수익률이 높은 종목이 "
        "오히려 덜 빠졌고 (또는 유니버스 편향으로 나중에 뜬 종목이 이미 오르고 있었고), 미국에서는 모멘텀이 약간 해로웠다. "
        "'눌림목' 반전이 낫다고 할 근거는 없다.",
        f"**RSI 40~55만 (국내 유일한 플러스, 자산 {_p(r('KR', 'RSI 40~55만'))})은 종목 예측력이 아니라 손절 경로의 차이다.** "
        f"단순 10일 수익률은 {_p(p('KR', 'RSI 40~55만'))}로 기준({_p(p('KR', '기준'))})과 같고 벤치마크 초과도 "
        f"{_p(p('KR', 'RSI 40~55만', 'excessPct'))}다. 대신 체결된 시나리오 중 손절로 끝난 비율이 기준 50%에서 28%로 줄었다 "
        "(덜 과열된 종목이 10일 안에 −1.5 ATR까지 파고드는 일이 적었다). 이 경로 효과는 미국에서는 반대였고 "
        f"(자산 {_p(r('US', 'RSI 40~55만'))}, 단순 {_p(p('US', 'RSI 40~55만'))}, 손절 비율 59%), 국내 두 반기도 "
        f"{halves('KR', 'RSI 40~55만')}로 방향이 다르다. 채택 근거로는 약하다.",
        f"**20일 신고가 돌파는 국내에서 일관되게 나빴다.** 단순 10일 {_p(p('KR', '20일 신고가 돌파'))} (승률 "
        f"{p('KR', '20일 신고가 돌파', 'winRatePct'):.0f}%, 두 반기 {halves('KR', '20일 신고가 돌파')}), 자산 "
        f"{_p(r('KR', '20일 신고가 돌파'))}. 돌파 다음 10일에 되돌림이 컸다. 미국은 단순 {_p(p('US', '20일 신고가 돌파'))}로 "
        "기준과 비슷하다. 이 기간 국내에서 돌파 추종은 모든 변형 중 가장 나쁜 예측력이다.",
        f"**거래량 급증 ×1.5**: 단순 10일 국내 {_p(p('KR', '거래량 급증'))} ({halves('KR', '거래량 급증')}), 미국 "
        f"{_p(p('US', '거래량 급증'))} (승률 {p('US', '거래량 급증', 'winRatePct'):.0f}%). 국내 6~7월에는 급등·뉴스 종목의 "
        "되돌림으로 크게 잃었고 8~9월과 미국에서는 기준보다 나았다. 반기와 시장이 엇갈려 결론을 낼 수 없다.",
        f"**60일선 필터 제거**: 자산 {both('60일선 필터 제거')}, 단순 10일 {both('60일선 필터 제거', 'meanPct', p)}로 기준과 "
        "거의 같다 (국내 선별 212→234건). 60일선 아래 종목이 후보에 들어와도 결과가 안 바뀌어, 이 필터는 이 기간 "
        "손실을 막지도 키우지도 않았다.",
        f"**추가 변형**: 5일 눌림은 국내 단순 {_p(p('KR', '추가: 5일 눌림'))} ({halves('KR', '추가: 5일 눌림')}, 초과 "
        f"{_p(p('KR', '추가: 5일 눌림', 'excessPct'))}), 미국 {_p(p('US', '추가: 5일 눌림'))}. 20일선 눌림목은 국내 자산 "
        f"{_p(r('KR', '추가: 20일선 눌림목'))}이지만 주문 {r('KR', '추가: 20일선 눌림목', 'orders')}건 중 보유중 "
        f"{r('KR', '추가: 20일선 눌림목', 'exits')['OPEN']}건이 9월 말 미실현이고 단순 10일은 {_p(p('KR', '추가: 20일선 눌림목'))} "
        f"(초과 {_p(p('KR', '추가: 20일선 눌림목', 'excessPct'))}), 미국 자산 {_p(r('US', '추가: 20일선 눌림목'))}. "
        f"필터만 두고 거래대금 순으로 고르면 단순 10일 {both('추가: 필터만, 거래대금 순', 'meanPct', p)}로 기준과 같다. "
        "즉 점수식의 순서는 거래대금 순서보다 나을 것이 없다.",
        "**두 반기 일관성**: 국내는 거의 모든 변형이 6~7월(코스피 급락)에 손실의 대부분을 냈고 8~9월은 소폭 손실이나 보합이다. "
        "미국은 6~7월 손실, 8~9월 소폭 이익이 대부분이다. 단순 10일 수익률에서 두 반기·두 시장 모두 기준보다 나은 변형은 "
        "편향이 걸린 후보 수 60·100뿐이다. 나머지는 한 시장이나 한 반기에서만 낫고 다른 쪽에서 뒤집힌다.",
        "**과최적화 위험**: 4개월(약 80거래일), 변형당 주문 30~150건 표본에서 23개 변형을 비교했다. 변형 사이 몇 %p 차이는 "
        "종목 몇 개로 뒤집히고, 가장 좋아 보이는 것을 고르는 것 자체가 과최적화다. 유니버스 생존·미래 편향은 후보 수를 "
        "넓히는 변형에서 직접 드러났고 (순위 구간 표), 다른 변형에도 절대 수익률을 좋게 보이게 하는 방향으로 작용한다. "
        "결론은 '선별 규칙의 미세 조정으로 얻을 것이 없고, 특정 변형을 채택할 근거도 없다'이다. 국내 20일 신고가 돌파처럼 "
        "일관되게 나쁜 것은 피하고, 나머지는 다른 기간(특히 강세장)과 편향 없는 유니버스로 다시 확인해야 한다.",
    ]


if __name__ == "__main__":
    main()
