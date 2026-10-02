"""실험 1: 진입 방식 (entry). 캐시 일봉만 쓰고 증권사 API·AI는 부르지 않는다.

    uv run python backtest/experiments/entry.py

변형:
  1. 기준: 전일 종가 지정가 DAY 주문 (운영 규칙)
  2. 시가 시장가
  3. 전일 종가 − ATR × 0.25 / 0.5 / 1.0 지정가
  4. 지정가 유효 기간 2·3거래일
  5. 확인 진입: 시가가 전일 종가 이상인 날만 시가 시장가 (장 시작 직후 시가를 보고 낼 수 있는 규칙)
  6. 역선택 확인: 시가가 전일 종가보다 낮은 날만 시가 시장가
  7. 지정가 → 미체결이면 다음 날 시가 시장가
  8. 확인 진입 + 갭 상한 (시가가 전일 종가 이상, 전일 종가 + ATR × 0.5 이하)

simulate_trade에 없는 규칙(5~8)은 Backtest를 서브클래스해 _scenario가 만든 Trade를 주문일 봉으로 다시 판정한다.
"""
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import SPLIT, Variant, load_market, run_variants, write_report  # noqa: E402
from sim import UNFILLED, Backtest, Rule, Trade, net_return, simulate_trade  # noqa: E402

BASE_RULE = Rule("기준", 4.0, 1.5)
EXPECTED_BASE = {"KR": -17.81, "US": -17.76}  # results/<시장>/summary.md 의 기준 결과
HORIZON = 10  # 역선택 검증: 주문일 시가 → 10거래일 후 종가


def _f(c: dict, key: str) -> float:
    return float(c[key])


class EntryBacktest(Backtest):
    """주문일 시가로 진입을 거르거나(confirm), 지정가 미체결 시 다음 날 시가로 사는(fallback) 변형.

    confirm: (시가, 전일 종가, ATR) → 진입 허용 여부. entry_mode="open"과 같이 쓴다.
    fallback: True면 지정가 주문이 유효 기간 안에 체결되지 않았을 때 그 다음 거래일 시가에 시장가로 산다.
    """

    def __init__(self, *args, confirm=None, fallback: bool = False, **kwargs):
        super().__init__(*args, **kwargs)
        self.confirm, self.fallback = confirm, fallback

    def _scenario(self, p, day):
        t = super()._scenario(p, day)
        if t is None:
            return None
        bars = self._from(p.symbol, day)
        if self.confirm is not None and bars:
            prev_close = _f(self._before(p.symbol, day)[-1], "closePrice")
            if not self.confirm(_f(bars[0], "openPrice"), prev_close, t.atr):
                self._unfill(t)
        if self.fallback and t.status == UNFILLED and len(bars) > self.s.fill_window_days:
            status, filled_at, fill, closed_at, exit_ = simulate_trade(
                bars[self.s.fill_window_days:], t.entry, t.target, t.stop_trigger, t.stop_order, t.expire_date,
                entry_mode="open", currency=self.s.currency)
            t.status, t.filled_at, t.fill_price, t.closed_at, t.exit_price = status, filled_at, fill, closed_at, exit_
            if fill is not None:
                last_price = exit_ if exit_ is not None else _f(self.candles[p.symbol][-1], "closePrice")
                t.ret = net_return(fill, last_price, self.s.commission_rate, self.tax)
        return t

    @staticmethod
    def _unfill(t: Trade) -> None:
        t.status, t.filled_at, t.fill_price, t.closed_at, t.exit_price, t.ret = UNFILLED, None, None, None, None, None


def confirm_up(open_, prev_close, atr):
    return open_ >= prev_close


def confirm_down(open_, prev_close, atr):
    return open_ < prev_close


def confirm_up_capped(open_, prev_close, atr):
    return prev_close <= open_ <= prev_close + atr * 0.5


def variants(data) -> list[Variant]:
    S = data.base_settings
    return [
        Variant("기준: 전일 종가 지정가 DAY", S(), BASE_RULE),
        Variant("시가 시장가", S(entry_mode="open"), BASE_RULE),
        Variant("지정가 전일 종가 −0.25 ATR", S(entry_mode="limit_below", entry_offset_atr=0.25), BASE_RULE),
        Variant("지정가 전일 종가 −0.5 ATR", S(entry_mode="limit_below", entry_offset_atr=0.5), BASE_RULE),
        Variant("지정가 전일 종가 −1.0 ATR", S(entry_mode="limit_below", entry_offset_atr=1.0), BASE_RULE),
        Variant("지정가 유효 2거래일", S(fill_window_days=2), BASE_RULE),
        Variant("지정가 유효 3거래일", S(fill_window_days=3), BASE_RULE),
        Variant("확인 진입: 시가 ≥ 전일 종가일 때 시가 시장가", S(entry_mode="open"), BASE_RULE,
                {"confirm": confirm_up}),
        Variant("역선택 확인: 시가 < 전일 종가일 때 시가 시장가", S(entry_mode="open"), BASE_RULE,
                {"confirm": confirm_down}),
        Variant("지정가 DAY → 미체결 시 다음 날 시가 시장가", S(), BASE_RULE, {"fallback": True}),
        Variant("확인 진입 + 갭 상한 (전일 종가 ≤ 시가 ≤ +0.5 ATR)", S(entry_mode="open"), BASE_RULE,
                {"confirm": confirm_up_capped}),
    ]


def run_market(data) -> tuple[list[dict], dict]:
    vs = variants(data)
    # confirm/fallback 변형은 서브클래스로 돈다. run_variants는 Backtest를 직접 만들므로 잠시 바꿔 끼운다
    import common
    saved = common.Backtest
    common.Backtest = EntryBacktest
    try:
        rows = run_variants(data, vs, name="entry")
    finally:
        common.Backtest = saved
    base = rows[0]["returnPct"]
    if abs(base - EXPECTED_BASE[data.market]) > 0.05:
        raise SystemExit(f"[{data.market}] 기준 결과 {base:+.2f}%가 예상 {EXPECTED_BASE[data.market]:+.2f}%와 다름. "
                         "캐시나 코드가 바뀌었는지 확인")
    return rows, adverse_selection(data)


def adverse_selection(data) -> dict:
    """기준 변형의 시나리오를 체결/미체결, 시가 방향별로 나눠 주문일 시가 → 10거래일 후 종가 수익률을 본다."""
    bt = Backtest(data.base_settings(), BASE_RULE, data.candles, data.names)
    res = bt.run()
    groups: dict[str, list[float]] = {}
    half: dict[str, dict[str, list[float]]] = {}
    for t in res.trades:
        bars = bt._from(t.symbol, t.day)
        if len(bars) <= HORIZON:
            continue
        o = _f(bars[0], "openPrice")
        fwd = _f(bars[HORIZON], "closePrice") / o - 1
        prev_close = _f(bt._before(t.symbol, t.day)[-1], "closePrice")
        keys = ["전체", "체결" if t.fill_price is not None else "미체결",
                "시가 ≥ 전일 종가" if o >= prev_close else "시가 < 전일 종가"]
        if t.placed:
            keys.append("주문분 체결" if t.fill_price is not None else "주문분 미체결")
        for k in keys:
            groups.setdefault(k, []).append(fwd)
            half.setdefault(k, {}).setdefault("6~7월" if t.day < SPLIT else "8~9월", []).append(fwd)
    order = ["전체", "체결", "미체결", "주문분 체결", "주문분 미체결", "시가 ≥ 전일 종가", "시가 < 전일 종가"]
    return {k: {"n": len(groups[k]), "meanPct": statistics.mean(groups[k]) * 100,
                "medianPct": statistics.median(groups[k]) * 100,
                "winPct": sum(1 for x in groups[k] if x > 0) / len(groups[k]) * 100,
                "halves": {h: (statistics.mean(v) * 100, len(v)) for h, v in half[k].items()}}
            for k in order if k in groups}


def per_trade(market: str, count: int) -> list[dict]:
    """변형별 주문분 체결 건의 1주 수익률 평균 (비중과 무관한 비교). run_variants가 남긴 CSV를 읽는다."""
    import csv
    from common import RESULTS
    rows = []
    for n in range(1, count + 1):
        with open(RESULTS / "experiments" / "entry" / f"{market}-trades-{n}.csv") as f:
            trades = [t for t in csv.DictReader(f) if t["placed"] == "True" and t["fill"] and t["ret_1share"]]
        rets = [float(t["ret_1share"]) for t in trades]
        h1 = [float(t["ret_1share"]) for t in trades if t["day"] < SPLIT]
        h2 = [float(t["ret_1share"]) for t in trades if t["day"] >= SPLIT]
        rows.append({"n": len(rets), "meanPct": statistics.mean(rets) * 100 if rets else None,
                     "firstHalf": (statistics.mean(h1) * 100 if h1 else None, len(h1)),
                     "secondHalf": (statistics.mean(h2) * 100 if h2 else None, len(h2)),
                     "fillVsEntryPct": statistics.mean(float(t["fill"]) / float(t["entry"]) - 1
                                                       for t in trades) * 100 if trades else None})
    return rows


def per_trade_table(rows_by_market: dict[str, list[dict]], stats_by_market: dict[str, list[dict]]) -> list[str]:
    lines = ["| 시장 | 변형 | 체결 | 건당 평균 | 6~7월 | 8~9월 | 체결가−기준가 |", "|---|---|---|---|---|---|---|"]
    for market, rows in rows_by_market.items():
        for sm, st in zip(rows, stats_by_market[market]):
            a, b = st["firstHalf"], st["secondHalf"]
            mean = "-" if st["meanPct"] is None else f"{st['meanPct']:+.2f}%"
            gap = "-" if st["fillVsEntryPct"] is None else f"{st['fillVsEntryPct']:+.2f}%"
            lines.append(f"| {market} | {sm['label']} | {st['n']} | {mean} | {_half(*a)} | {_half(*b)} | {gap} |")
    return lines


def _half(v, n) -> str:
    return "-" if v is None else f"{v:+.2f}% ({n})"


def adverse_table(by_market: dict[str, dict]) -> list[str]:
    lines = ["| 시장 | 그룹 | 건수 | 평균 | 중앙값 | 상승 비율 | 6~7월 | 8~9월 |", "|---|---|---|---|---|---|---|---|"]
    for market, groups in by_market.items():
        for k, g in groups.items():
            h = g["halves"]
            a, b = h.get("6~7월"), h.get("8~9월")
            lines.append(f"| {market} | {k} | {g['n']} | {g['meanPct']:+.2f}% | {g['medianPct']:+.2f}% | "
                         f"{g['winPct']:.0f}% | {'-' if a is None else f'{a[0]:+.2f}% ({a[1]})'} | "
                         f"{'-' if b is None else f'{b[0]:+.2f}% ({b[1]})'} |")
    return lines


FINDINGS = [
    "**진입 방식을 바꿔도 손실이다.** 기준(전일 종가 지정가 DAY)이 KR −17.8%, US −17.8%이고, 11개 변형 중 두 시장 "
    "모두에서 플러스로 돌아선 것은 없다. 건당 수익률도 KR은 모든 변형이 −3.5~−4.8%, US는 −0.4~−2.3%로 전부 음수다. "
    "진입 방식은 손실의 크기를 몇 %p 바꿀 뿐 부호를 바꾸지 못하며, 손실의 주원인이 선별 규칙과 시나리오 구조"
    "(10거래일 안에 4 ATR 목표에 거의 닿지 않음)라는 기준 백테스트의 결론이 유지된다.",
    "**역선택 가설은 '실제 주문분'에서는 확인되고 US에서 더 뚜렷하다 (역선택 표).** 주문한 시나리오 중 지정가로 "
    "체결된 그룹의 주문일 시가 → 10거래일 후 수익률은 KR −2.6%, US −2.7%이고, 미체결 그룹은 KR −0.0%(7건), "
    "US +3.3%(18건)다. 다만 승인 여부와 무관하게 모든 시나리오로 넓히면 KR은 체결 −2.0%·미체결 −2.1%로 차이가 없고 "
    "(KR은 90%가 체결되어 미체결 표본이 19건뿐), US만 체결 −1.8%·미체결 +0.7%로 차이가 남는다. "
    "즉 역선택은 존재하되 KR에서는 표본이 작아 크기를 믿기 어렵다.",
    "**시가 방향 자체는 이후 성과를 예측하지 못한다.** 같은 표에서 시가가 전일 종가 이상인 날의 시가 → 10거래일 수익률은 "
    "KR −2.9%, US −2.0%로, 시가가 낮은 날(KR −0.6%, US −0.6%)보다 오히려 나쁘다 (갭 상승의 되돌림). 따라서 "
    "'오르는 날만 산다'는 확인 진입이 개선을 낳는다면 그 이유는 신호가 아니라 다른 데 있다.",
    "**확인 진입(시가 ≥ 전일 종가일 때 시가 시장가)은 US에서만 개선되고 KR에서는 반기별로 엇갈린다.** US는 −7.1%"
    "(기준 −17.8%)로 건당 −0.4%까지 좋아지고 6~7월·8~9월 모두 기준보다 나았다. KR은 −15.6%로 6~7월은 나았지만 "
    "8~9월은 기준보다 나빴고 건당 수익률(−4.3%)은 기준(−4.6%)과 같은 수준이다. 반대 규칙(시가 < 전일 종가일 때만 "
    "진입)도 KR −12.6%, US −11.6%로 기준보다 '좋게' 나오는데, 두 규칙 모두 체결 수를 줄여 평균 비중을 33~45%로 "
    "낮춘 효과가 크다 (기대값이 음수라 덜 사면 덜 잃는다). 서로 반대인 두 규칙이 둘 다 개선으로 보이는 것은 비중 효과라는 "
    "증거다. 이 규칙은 실제로도 장 시작 직후 시가를 보고 시장가 주문을 내는 방식으로 실행할 수 있지만, 채택 근거는 US 4개월 "
    "표본뿐이다.",
    "**시가 시장가는 역선택을 없애지만 KR에서는 개선이 없다.** KR −18.3%(기준 −17.8%), US −14.4%. 미체결이던 종목까지 "
    "모두 사서 체결 수가 늘고, US에서는 건당 −1.3%로 기준(−2.2%)보다 나아졌으나 KR은 건당 −4.2%로 거의 같다. "
    "'미체결 시 다음 날 시가' 변형(KR −20.1%, US −16.0%)은 시가 시장가를 하루 늦춘 것과 같아서 결과도 비슷하며, "
    "하루 늦게 사는 만큼 보유 기한 여유가 줄어 KR에서는 가장 나빴다.",
    "**전일 종가 아래 지정가(−0.25/−0.5/−1.0 ATR)는 체결률을 떨어뜨리고 수량을 키우는 부작용이 있다.** 시뮬레이션은 "
    "목표·손절을 전일 종가 기준으로 두므로 진입가만 내리면 손절까지의 거리가 줄어 건당 위험 한도로 정하는 수량이 커진다. "
    "그래서 US −0.5 ATR은 체결이 63건으로 줄었는데도 평균 비중은 54%로 오르고 결과는 −20.3%로 기준보다 나빴다. "
    "−1.0 ATR은 진입가 괴리 5% 규칙(fact_check)에 걸려 KR에서 시나리오 212건 중 169건이 탈락하고 체결 4건에 그친다 "
    "(비중 1%, −4.0%는 안 산 결과일 뿐). 이 변형은 운영에 넣으려면 목표·손절을 진입가 기준으로 다시 잡아야 하고, "
    "그 경우 손익비가 달라져 결과도 달라진다.",
    "**지정가 유효 기간 연장(2·3거래일)은 효과가 시장에 따라 반대다.** KR은 −17.0%·−16.1%로 조금 나아지고 US는 "
    "−18.7%·−19.1%로 조금 나빠졌다. 체결 수는 거의 같고(늦게 체결되는 몇 건이 추가될 뿐) 보유 기한은 주문일 기준으로 "
    "고정이라 늦게 체결될수록 여유가 줄어든다. 두 시장 방향이 반대이므로 노이즈로 본다.",
    "**과최적화 위험.** 표본은 4개월(KR 82거래일, 체결 40~75건)이고 KR은 벤치마크 −18%의 하락장, US는 +1%의 횡보장이다. "
    "변형 간 수 %p 차이는 손절 몇 건 차이로도 생기는 크기이며, 반기별로 방향이 바뀌는 변형(확인 진입 KR, 유효 기간 연장)은 "
    "노이즈로 봐야 한다. 유니버스는 오늘 기준 랭킹의 합집합이라 생존·미래 편향이 있고, 이 편향은 모든 변형에 같은 방향으로 "
    "작용한다. 이 실험에서 가져갈 것은 (1) 진입 방식으로는 손실을 뒤집지 못한다, (2) 역선택은 실재하지만 그것을 피하려고 "
    "시장가로 바꾸면 '내리는 종목'뿐 아니라 '전체 종목'의 음수 기대값을 사게 된다, (3) 개선처럼 보이는 변형은 대부분 "
    "체결을 줄여 비중을 낮춘 효과라는 세 가지다.",
]

NOTES = [
    "기준 변형은 results/<시장>/summary.md의 '목표 4.0·손절 1.5 ATR'과 같은 설정이며, 스크립트가 기준 수익률이 "
    "KR −17.81%, US −17.76%와 일치하는지 확인한다.",
    "'시가 시장가' 계열은 진입 기준가(전일 종가)로 목표·손절·수량을 정하고 체결은 시가로 본다 (sim.py의 entry_mode=open과 같다). "
    "갭 상승분만큼 손절까지의 거리가 짧아지고 갭 하락이면 길어진다.",
    "확인 진입·역선택 확인·갭 상한 변형은 시가 조건에 맞지 않으면 그 주문을 미체결로 처리한다 (주문 수에는 포함, 체결 수에서 제외). "
    "확인 진입은 실제 운영에서도 장 시작 직후 시가를 확인하고 시장가 주문을 내는 방식으로 구현할 수 있다.",
    "'미체결 시 다음 날 시가' 변형은 지정가 유효 기간이 끝난 다음 거래일 시가에 시장가로 산다. 보유 기한은 원래 주문일 기준 그대로다.",
    "역선택 표는 기준 변형의 모든 시나리오(승인 여부 무관, 체결 결과는 시뮬레이션)를 대상으로 주문일 시가 → 10거래일 후 "
    "종가 수익률(비용 미반영)을 구한 것이다. '주문분'은 실제로 주문한 시나리오만 센 것이다. 10거래일 뒤 봉이 없는 "
    "기간 말 시나리오는 뺐다.",
    "기간이 4개월이고 유니버스에 생존·미래 편향이 있다 (backtest/README.md 한계 참고). 일봉 판정은 불리한 쪽으로 본다.",
]


def main() -> None:
    import json
    rows, adverse, per = {}, {}, {}
    for market in ("KR", "US"):
        print(f"[{market}] 캐시 읽는 중", file=sys.stderr)
        data = load_market(market)
        rows[market], adverse[market] = run_market(data)
        per[market] = per_trade(market, len(rows[market]))
    path = write_report("entry", "진입 방식", rows, notes=NOTES, findings=FINDINGS)
    # 비중과 무관한 건당 비교표와 역선택 표를 해석 앞에 끼워 넣는다
    extra = (["## 건당 수익률 (주문분 체결, 1주 기준, 비용 차감)", "",
              "평균 비중이 다른 변형끼리 비교하려고 건별 수익률을 따로 본다. 체결가−기준가는 체결가가 전일 종가에서 얼마나 떨어졌는지의 평균.",
              ""] + per_trade_table(rows, per) + ["",
              "## 역선택 검증: 주문일 시가 → 10거래일 후 종가 수익률 (기준 변형)", ""] + adverse_table(adverse) + [""])
    text = path.read_text().replace("## 해석", "\n".join(extra) + "\n## 해석", 1)
    path.write_text(text)
    json_path = path.with_name("summary.json")
    payload = {"variants": json.loads(json_path.read_text()), "perTrade": per, "adverseSelection": adverse}
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1, default=str))
    print(f"결과: {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
