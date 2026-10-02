"""실험 4: 리스크 엔진 한도와 시장 체제 필터.

    uv run python backtest/experiments/risk_regime.py

캐시(backtest/cache)만 읽고 증권사 API·AI는 부르지 않는다. 결과는 backtest/results/experiments/risk/.

변형: 최소 손익비, 건당 위험, 동시 보유 상한, 총 금액 한도, 벤치마크 체제 필터(KODEX 200 / SPY),
조합, 전날 손실 후 진입 금지, 연속 손절 후 휴식. 기준은 운영 규칙(목표 4.0·손절 1.5 ATR, 손익비 2.0, 위험 1%).
"""
import bisect
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common  # noqa: E402
from common import Variant, load_market, run_variant, run_variants, write_report  # noqa: E402
from sim import STOP, Backtest, Rule, net_return  # noqa: E402
from paper_engine.data import indicators  # noqa: E402
from paper_engine.judge.risk import RiskLimits  # noqa: E402

NAME = "risk"
BASE_RULE = Rule("기준", 4.0, 1.5)
AI_RULE = Rule("AI 유사", 2.0, 1.5)
# 운영 SWING 한도 (judge/risk.LIMITS["SWING"])
OPS = RiskLimits(risk_per_trade=0.01, max_position=None, min_reward_risk=2.0, max_daily_loss=0.03)


def limits(**kw) -> RiskLimits:
    return replace(OPS, **kw)


# --- 시장 체제 필터 (벤치마크 일봉, prev_day까지의 봉만 본다) ---

class BenchRegime:
    """벤치마크 종가로 판단하는 체제 필터. kind: sma20 | sma60 | ret5 | sma20_60."""

    def __init__(self, bench: list[dict], kind: str):
        self.dates = [c["date"] for c in bench]
        self.closes = [float(c["closePrice"]) for c in bench]
        self.kind = kind

    def __call__(self, day: str, prev_day: str) -> bool:
        n = bisect.bisect_right(self.dates, prev_day)  # prev_day까지 완성된 봉 수 (day의 봉은 보지 않는다)
        closes = self.closes[:n]
        if self.kind == "sma20":
            s = indicators.sma(closes, 20)
            return s is not None and closes[-1] > s
        if self.kind == "sma60":
            s = indicators.sma(closes, 60)
            return s is not None and closes[-1] > s
        if self.kind == "ret5":
            r = indicators.change_rate(closes, 5)
            return r is not None and r > 0
        if self.kind == "sma20_60":
            a, b = indicators.sma(closes, 20), indicators.sma(closes, 60)
            return a is not None and b is not None and a > b
        raise ValueError(self.kind)


REGIMES = {"sma20": "종가 > 20일선", "sma60": "종가 > 60일선", "ret5": "5일 수익률 > 0", "sma20_60": "20일선 > 60일선"}


# --- 매매 기록을 보는 규칙 (전날 손실, 연속 손절) ---

class RecordingBacktest(Backtest):
    """만든 시나리오를 모두 기록해 두어, 체제 필터가 전날까지의 매매 결과를 볼 수 있게 한다.

    pause_fn(backtest, day, prev_day) -> bool. True면 그날 새 진입 허용. regime_fn과 함께 주면 둘 다 통과해야 한다.
    기록(log)의 각 거래는 주문 결과가 미리 계산돼 있지만, 규칙은 prev_day 이전에 청산된 것만 본다 (미래 참조 금지).
    """

    def __init__(self, *args, pause_fn=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.log = []
        if pause_fn is not None:
            base = self.regime_fn
            self.regime_fn = lambda day, prev: (base is None or base(day, prev)) and pause_fn(self, day, prev)

    def _scenario(self, p, day):
        t = super()._scenario(p, day)
        if t is not None:
            self.log.append(t)
        return t

    def realized_pnl(self, day: str) -> float:
        """day에 청산된 주문의 손익 합 (거래 통화, 비용 차감)."""
        return sum(t.quantity * t.fill_price * net_return(t.fill_price, t.exit_price, self.s.commission_rate, self.tax)
                   for t in self.log if t.placed and t.fill_price is not None and t.closed_at == day)

    def equity_at(self, day: str) -> float:
        """day 종가 기준 평가금액 (거래 통화). 그날까지 체결·청산된 것만 반영."""
        s, cash, held = self.s, self.s.capital_krw / self.s.fx_rate, 0.0
        for t in self.log:
            if not t.placed or t.fill_price is None or t.filled_at > day:
                continue
            cash -= t.quantity * t.fill_price * (1 + s.commission_rate)
            if t.closed_at is not None and t.closed_at <= day:
                cash += t.quantity * t.exit_price * (1 - s.commission_rate - self.tax)
            else:
                held += t.quantity * self._last_close(t.symbol, day)
        return cash + held


def prev_day_loss(threshold: float):
    """전날 확정 손실이 자산의 threshold 이상이면 그날 진입 금지."""
    def f(bt: RecordingBacktest, day: str, prev_day: str) -> bool:
        loss = -bt.realized_pnl(prev_day)
        return loss < bt.equity_at(prev_day) * threshold
    return f


def consecutive_stops(n: int, rest_days: int):
    """직전 n건의 청산이 모두 손절이면, 마지막 손절 뒤 rest_days 거래일 동안 진입 금지."""
    def f(bt: RecordingBacktest, day: str, prev_day: str) -> bool:
        closed = sorted((t for t in bt.log if t.placed and t.closed_at and t.closed_at <= prev_day),
                        key=lambda t: t.closed_at)
        last = closed[-n:]
        if len(last) < n or any(t.status != STOP for t in last):
            return True
        return bt._days_since(last[-1].closed_at, day) > rest_days
    return f


# run_variant는 common의 Backtest 이름을 쓰므로 기록하는 서브클래스로 바꿔 끼운다 (기본 동작은 같다)
common.Backtest = RecordingBacktest


def base_variants(data) -> list[Variant]:
    S = data.base_settings
    v = [Variant("기준 (손익비 2.0, 위험 1%, 상한 없음)", S(), BASE_RULE)]
    for rr in (1.5, 2.5, 3.0):
        v.append(Variant(f"최소 손익비 {rr}", S(risk_limits=limits(min_reward_risk=rr)), BASE_RULE))
    v.append(Variant("최소 손익비 1.5 + AI 유사 규칙 (2.0·1.5 ATR)", S(risk_limits=limits(min_reward_risk=1.5)), AI_RULE))
    for r in (0.005, 0.02):
        v.append(Variant(f"건당 위험 {r * 100:g}%", S(risk_limits=limits(risk_per_trade=r)), BASE_RULE))
    for n in (1, 2, 3, 5):
        v.append(Variant(f"동시 보유 상한 {n}", S(max_positions=n), BASE_RULE))
    for krw in (2_000_000, 5_000_000):
        v.append(Variant(f"총 금액 한도 {krw // 10_000}만원", S(max_total_krw=krw), BASE_RULE))
    return v


def regime_variants(data) -> list[Variant]:
    return [Variant(f"체제: {label}", data.base_settings(), BASE_RULE,
                    {"regime_fn": BenchRegime(data.bench, kind)}) for kind, label in REGIMES.items()]


def extra_variants(data, best: str) -> list[Variant]:
    S, label = data.base_settings, REGIMES[best]
    return [
        Variant(f"조합: {label} + 보유 상한 3", S(max_positions=3), BASE_RULE,
                {"regime_fn": BenchRegime(data.bench, best)}),
        Variant(f"조합: {label} + 건당 위험 0.5%", S(risk_limits=limits(risk_per_trade=0.005)), BASE_RULE,
                {"regime_fn": BenchRegime(data.bench, best)}),
        Variant("전날 손실 ≥ 1%면 진입 금지", S(), BASE_RULE, {"pause_fn": prev_day_loss(0.01)}),
        Variant("전날 손실 ≥ 2%면 진입 금지", S(), BASE_RULE, {"pause_fn": prev_day_loss(0.02)}),
        Variant("연속 손절 3회 → 3거래일 휴식", S(), BASE_RULE, {"pause_fn": consecutive_stops(3, 3)}),
        Variant("연속 손절 2회 → 5거래일 휴식", S(), BASE_RULE, {"pause_fn": consecutive_stops(2, 5)}),
    ]


def main() -> None:
    markets = {m: load_market(m) for m in ("KR", "US")}
    # 1. 체제 필터 4종을 먼저 돌려 두 시장 평균 수익률이 가장 좋은 것을 조합에 쓴다
    scores = {}
    for kind in REGIMES:
        for m, data in markets.items():
            v = Variant(kind, data.base_settings(), BASE_RULE, {"regime_fn": BenchRegime(data.bench, kind)})
            scores[kind] = scores.get(kind, 0.0) + run_variant(data, v)[1]["returnPct"] / len(markets)
    best = max(scores, key=scores.get)
    print(f"체제 필터 두 시장 평균 수익률: {scores} → 조합에 {best}", file=sys.stderr)

    rows = {}
    for m, data in markets.items():
        print(f"[{m}]", file=sys.stderr)
        rows[m] = run_variants(data, base_variants(data) + regime_variants(data) + extra_variants(data, best),
                               name=NAME)
    base = {m: rows[m][0]["returnPct"] for m in rows}
    assert abs(base["KR"] + 17.81) < 0.05 and abs(base["US"] + 17.76) < 0.05, f"기준이 다르다: {base}"

    regime_days = {m: {sm["label"]: sm["funnel"].get("regimeSkipped", 0) for sm in rows[m]} for m in rows}
    notes = [
        "기준은 운영 규칙(목표 4.0·손절 1.5 ATR, 손익비 2.0, 건당 위험 1%, 종목당 비중 한도 없음, 총 한도 자본금). "
        "최소 손익비 2.0과 건당 위험 1%는 기준과 같으므로 따로 돌리지 않았다.",
        "일일 손실 한도(3%)는 백테스트에서 발동하지 않는다. 선별이 정규장 전에 돌고 그 시점의 당일 확정 손실은 항상 0이라 "
        "AccountContext.daily_loss_krw가 0이다. 운영도 전략을 정규장 1시간 전에 돌리고 손실을 청산일(로컬 날짜) 기준으로 세므로 "
        "국내는 같다 (미국은 세션이 한국 시간 자정을 넘겨 전 세션 후반의 손실이 '오늘'로 잡힐 수 있으나 재현하지 않았다). "
        "대신 '전날 손실이 자산의 X% 이상이면 다음 날 진입 금지'를 서브클래스로 실험했다.",
        "체제 필터는 벤치마크(KR KODEX 200, US SPY)의 전 거래일까지의 종가만 본다. 조합에 쓴 필터는 4종을 먼저 돌려 "
        f"두 시장 평균 수익률이 가장 좋은 것({REGIMES[best]})을 골랐다. 이 선택 자체가 같은 표본에서 이루어진 것이라 "
        "과최적화 요소가 있다.",
        "체제 제외일: " + "; ".join(f"{m} " + ", ".join(f"{k.replace('체제: ', '')} {v}일"
                                                     for k, v in regime_days[m].items() if k.startswith("체제:"))
                                   for m in regime_days) + f" (거래일 KR {rows['KR'][0]['tradingDays']}, "
        f"US {rows['US'][0]['tradingDays']}).",
        "전날 손실·연속 손절 규칙은 전 거래일까지 청산된 주문만 본다. 손실 비율의 분모는 전 거래일 종가 기준 평가금액이다.",
        "표본은 4개월(약 85거래일)이고 유니버스는 오늘 기준 거래대금 랭킹의 합집합이라 생존·미래 편향이 있다. "
        "변형 간 차이는 대부분 '얼마나 덜 샀는가'에서 나오므로, 전략의 기대값이 양수로 바뀌면 방향이 반대가 된다.",
        "일봉 판정은 불리한 쪽(같은 봉에서 손절·목표 동시 도달이면 손절, 손절은 감시가 −1% 주문가에 체결)이다. "
        "기간 마지막 날 보유 중인 종목은 마지막 종가로 평가했다.",
    ]
    findings = FINDINGS
    path = write_report(NAME, "리스크 엔진 한도와 시장 체제 필터", rows, notes, findings)
    print(f"결과: {path}", file=sys.stderr)


FINDINGS = [
    "**최소 손익비는 이 규칙에서 통과 여부만 가른다.** 기준 규칙(4.0·1.5 ATR)의 손익비는 손절 주문가(감시가 −1%)와 비용을 "
    "반영하면 KR 2.09~2.42, US 1.89~2.42다. 1.5로 낮추면 KR은 기준과 완전히 같고(탈락한 것이 원래 없었다), US는 손익비 "
    "1.9~2.0이던 시나리오 10건이 더 들어와 −17.76% → −18.33%로 조금 나빠졌다. 2.5·3.0은 통과 0건(수익률 0%)이다. "
    "AI 유사 규칙(2.0·1.5 ATR)은 손익비가 KR 1.03~1.20, US 0.92~1.20이라 1.5로 낮춰도 전부 탈락한다. 실제 AI 시나리오를 "
    "통과시키려면 기준을 1.0 근처까지 내려야 하는데, 그러면 손익비 1.5 이하의 시나리오까지 들어오고 이 기간 성과는 더 나빠질 방향이다.",
    "**건당 위험은 손익을 거의 비례로 바꾼다.** 0.5%는 KR −7.87%·US −5.59%, 2%는 KR −35.67%·US −22.98% (기준 −17.8%). "
    "매매 건수·승률(22~26%)·PF는 거의 같고 수량만 달라졌다. US 2%는 매수 가능 금액이 먼저 바닥나(평균 비중 74%) 손실이 두 배까지 "
    "가지 않았다. 두 반기 모두 같은 방향이다. 전략 기대값이 음수인 동안 위험을 줄이면 손실이 줄지만, 전략이 좋아지면 반대가 된다.",
    "**동시 보유 상한은 1~3개에서만 의미가 있고, 효과는 '덜 샀기 때문'이다.** 기준의 동시 보유는 평균 KR 5.1개·US 4.4개, 최대 9~11개다. "
    "상한 1은 KR −2.03%·US −1.03% (비중 8~12%, 주문 11~12건), 2는 KR −6.22%·US −6.51%, 3은 KR −9.19%·US −11.03%, "
    "5는 KR −15.39%·US −15.19%다. 승률은 22~27%로 기준과 같고 8~9월은 상한 1·2에서 소폭 플러스(+0.2~+1.1%)인데 표본이 "
    "10~20건이라 의미를 두기 어렵다. 총 금액 한도는 200만원이 KR −7.83%·US −4.33%(운영 기본값, 기존 결과와 같음), 500만원은 "
    "KR −18.02%·US −13.04%로 KR에서는 거의 묶이지 않았다(평균 비중 37%). KR 500만원이 기준보다 0.2%p 나쁜 것은 주문 순서가 바뀐 "
    "경로 차이이고 의미 있는 차이가 아니다.",
    "**시장 체제 필터는 KR에서만 손실을 줄였고, US에서는 어느 것도 도움이 안 됐다.** KR: 종가 > 20일선 −13.79%, 종가 > 60일선 −14.91%, "
    "5일 수익률 > 0 −12.16%, 20일선 > 60일선 −14.79%. KODEX 200이 7월에 −18.9%였는데 20일선·5일 수익률 필터는 7월에 20~21일을 "
    "막아 6~7월 손실을 −15.8% → −10.3~−10.5%로 줄였다. 반면 60일선·20/60일선 교차 필터는 느려서 6월엔 안 막고 8~9월(반등, +8.6%·+2.0%)에 "
    "34~39일을 막았다. 그래서 승률 9~12%·PF 0.1의 최악 거래만 남았고, 손실이 준 것은 단지 매매가 줄어서다. US: SPY가 +1.2%로 "
    "횡보해 20일선 > 60일선은 한 번도 안 걸렸고(기준과 동일), 종가 > 60일선은 7일만 걸렸다. 종가 > 20일선은 −19.35%, 5일 수익률 > 0은 "
    "−17.74%로 기준(−17.76%)과 같거나 나빴다. 전략 손실은 시장 방향과 무관하게 선별·진입 규칙에서 나오므로 체제 필터로 못 막는다.",
    "**조합에는 두 시장 평균이 가장 좋은 '5일 수익률 > 0'을 썼는데, 그 평균은 전부 KR에서 나온 것이다.** 조합 결과는 KR −6.30%(보유 상한 3)·"
    "−4.70%(건당 위험 0.5%), US −6.23%·−7.26%다. KR에서는 상한 3 단독(−9.19%)·위험 0.5% 단독(−7.87%)보다 더 줄었지만, US에서는 "
    "위험 0.5% 단독(−5.59%)보다 조합(−7.26%)이 오히려 나쁘다 (필터가 8~9월 진입 시점을 바꿔 −2.5%). 실험 전체에서 손실이 가장 작은 "
    "쪽은 조합이지만 승률 16~32%·PF 0.3~0.6으로 기준과 다르지 않고, 양의 기대값을 만든 변형은 하나도 없다.",
    "**전날 손실 규칙은 효과가 없고, 연속 손절 휴식은 소폭·일관되게 줄였다.** 전날 손실 ≥ 1%는 KR −17.86%·US −17.03% (제외 10·9일), "
    "≥ 2%는 KR −18.08%·US −16.45% (제외 1·3일)로, KR은 기준보다 나쁘고 US는 조금 나은 잡음 수준이다. 하루 확정 손실이 자산의 1%를 "
    "넘는 날이 4개월에 10일 안팎이라 규칙이 거의 안 걸린다. 연속 손절 3회 → 3거래일 휴식은 KR −15.28%·US −14.22%, 2회 → 5거래일은 "
    "KR −13.66%·US −13.38%로 두 시장 모두 기준보다 2.5~4.5%p 낫다. 다만 개선은 6~7월에서만 나오고(KR −12.4%·−10.3%, US −11.8%·−12.8%), "
    "8~9월은 기준과 같거나 나쁘다. 휴식 중에도 보유 중인 종목이 손절되면 휴식이 연장돼(3회 규칙 KR 제외 23일, 2회 규칙 33일) "
    "결국 하락기에 덜 산 효과다. 승률은 23~28%로 오르지 않았다.",
    "**과최적화 경고.** 4개월·하락장 한 번(KR 7월) 표본이라 어떤 변형이 좋았는지는 대부분 '7월에 얼마나 안 샀는가'로 결정된다. "
    "조합에 쓴 체제 필터를 같은 표본에서 골랐고, 8~9월만 보면 KR에서 체제 필터가 기준보다 나쁜 경우(종가 > 20일선 −3.9%)도 있다. "
    "유니버스는 오늘 기준 거래대금 상위의 합집합이라 기간 중에 뜬 종목이 미리 들어가 있고 상장폐지 종목은 없다. 여기서 확인된 것은 "
    "한도·필터의 방향(비중을 줄이면 손실이 줄고 승률·PF는 그대로)뿐이고, 어떤 값이 최적인지는 말할 수 없다. 손실의 원인은 선별과 "
    "진입 규칙이므로 리스크 한도·체제 필터 조정은 그 뒤에 할 일이다.",
]


if __name__ == "__main__":
    main()
