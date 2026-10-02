"""실험 3: 청산과 시나리오 가격 (exit). AI 없음, 캐시만 읽는다.

    uv run python backtest/experiments/exit_rules.py

변형:
  1. 기준 (운영 규칙: 목표 4.0·손절 1.5 ATR, 보유 10거래일)
  2. ATR 격자: 목표 {3,4,5,6} × 손절 {1.0,1.5,2.0,2.5}
  3. 보유 기간 5 / 15 / 20 거래일
  4. 트레일링 손절 1.5 / 2.0 / 3.0 ATR (목표 4.0)
  5. 트레일링만: 목표 10 ATR + 트레일링 2.0 / 3.0, 보유 20일
  6. 가격 구조 시나리오: 목표 = 최근 20일 최고가, 손절 = 최근 10일 최저가
  7. 타이트 손절: 손절 = 전일 저가 − 0.5 ATR, 목표 = 진입 + 4 ATR
  8. 추가: 분할 청산(목표 도달 시 절반, 나머지 트레일링), 본전 손절(+1.5 ATR 후 손절을 진입가로), 타이트 손절 + 트레일링

sim.py에 없는 청산 규칙(분할, 본전)은 이 파일 안의 Backtest 서브클래스로 재현한다.
결과: backtest/results/experiments/exit/
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import Variant, load_market, run_variants, write_report  # noqa: E402
from sim import (EXPIRED, OPEN, STOP, TARGET, UNFILLED, Backtest, Rule, Trade, _f, expire_date,  # noqa: E402
                 net_return, plan_prices, simulate_trade)
from paper_engine.data import indicators  # noqa: E402
from paper_engine.data.ticks import round_price  # noqa: E402
from paper_engine.judge.fact_check import fact_check  # noqa: E402
from paper_engine.judge.risk import STOP_LIMIT_BUFFER  # noqa: E402

NAME = "exit"
GRID_TARGETS = (3.0, 4.0, 5.0, 6.0)
GRID_STOPS = (1.0, 1.5, 2.0, 2.5)


# --- 시나리오 가격 훅 ---

def structure_scenario(bars: list[dict], rule: Rule, atr: float):
    """진입 = 전일 종가, 목표 = 최근 20일 최고가, 손절 = 최근 10일 최저가 (전일까지). 순서가 안 맞으면 None."""
    entry = _f(bars[-1], "closePrice")
    target = max(_f(c, "highPrice") for c in bars[-20:])
    stop = min(_f(c, "lowPrice") for c in bars[-10:])
    if not stop < entry < target:
        return None
    return entry, target, stop


def tight_stop_scenario(bars: list[dict], rule: Rule, atr: float):
    """진입 = 전일 종가, 손절 = 전일 저가 − 0.5 ATR, 목표 = 진입 + target_atr × ATR."""
    entry = _f(bars[-1], "closePrice")
    return entry, entry + atr * rule.target_atr, _f(bars[-1], "lowPrice") - atr * 0.5


# --- 청산 규칙 서브클래스 ---

class ExitBacktest(Backtest):
    """sim.Backtest._scenario와 같되 체결·청산 계산을 simulate()로 뺀 것. 서브클래스가 청산 규칙을 바꾼다."""

    def simulate(self, bars, entry, target, stop_trigger, stop_order, expire, atr):
        s, rule = self.s, self.rule
        return simulate_trade(bars, entry, target, stop_trigger, stop_order, expire,
                              entry_mode=s.entry_mode, fill_window=s.fill_window_days,
                              trail=None if rule.trailing_atr is None else atr * rule.trailing_atr,
                              currency=s.currency)

    def _scenario(self, p, day):
        bars = self._before(p.symbol, day)
        closes = [_f(c, "closePrice") for c in bars]
        atr = indicators.atr([_f(c, "highPrice") for c in bars], [_f(c, "lowPrice") for c in bars], closes)
        last = closes[-1]
        rule, s = self.rule, self.s
        prices = self.scenario_fn(bars, rule, atr)
        if prices is None:
            return None
        entry_raw, target_raw, stop_raw = prices
        if s.entry_mode == "limit_below":
            entry_raw = entry_raw - atr * s.entry_offset_atr
        raw = {"horizon": "SWING", "holdingDays": rule.holding_days, "entryPrice": entry_raw}
        if fact_check({"lastPrice": last}, raw):
            return None
        entry, target, stop_trigger, stop_order = plan_prices(entry_raw, target_raw, stop_raw, s.currency)
        if not 0 < stop_trigger < entry < target:
            return None
        expire = expire_date(day, rule.holding_days)
        status, filled_at, fill, closed_at, exit_ = self.simulate(
            self._from(p.symbol, day), entry, target, stop_trigger, stop_order, expire, atr)
        t = Trade(day=day, symbol=p.symbol, name=p.name, score=p.score, entry=entry, target=target,
                  stop_trigger=stop_trigger, stop_order=stop_order, expire_date=expire,
                  probability=rule.probability, reward_risk=0.0, approved=False, reasons=[], atr=atr,
                  status=status, filled_at=filled_at, fill_price=fill, closed_at=closed_at, exit_price=exit_)
        if fill is not None:
            last_price = exit_ if exit_ is not None else _f(self.candles[p.symbol][-1], "closePrice")
            t.ret = net_return(fill, last_price, s.commission_rate, self.tax)
        return t


class PartialExitBacktest(ExitBacktest):
    """목표 도달 시 절반을 팔고 나머지는 트레일링 손절(rule.trailing_atr)로 끝까지 간다.

    두 다리(고정 목표 / 먼 목표 + 트레일링)를 따로 시뮬레이션해 합친다. 청산가는 두 다리의 평균,
    청산일은 늦은 쪽이다 (앞 다리의 현금은 늦은 쪽 청산일에 돌아오는 것으로 근사). 상태는 앞 다리가
    목표에 닿았으면 TARGET, 아니면 뒷 다리의 상태. 기간 끝에 한쪽이 보유중이면 전체를 보유중으로 본다.
    """
    FAR_TARGET_ATR = 100.0

    def simulate(self, bars, entry, target, stop_trigger, stop_order, expire, atr):
        s, rule = self.s, self.rule
        common = dict(entry_mode=s.entry_mode, fill_window=s.fill_window_days, currency=s.currency)
        leg1 = simulate_trade(bars, entry, target, stop_trigger, stop_order, expire, **common)
        if leg1[0] == UNFILLED:
            return leg1
        far = float(round_price(entry + atr * self.FAR_TARGET_ATR, s.currency))
        leg2 = simulate_trade(bars, entry, far, stop_trigger, stop_order, expire,
                              trail=atr * rule.trailing_atr, **common)
        st1, filled_at, fill, closed1, exit1 = leg1
        st2, _, _, closed2, exit2 = leg2
        if st1 == OPEN or st2 == OPEN:
            return OPEN, filled_at, fill, None, None
        closed_at = max(closed1, closed2)
        status = TARGET if st1 == TARGET else st2
        return status, filled_at, fill, closed_at, (exit1 + exit2) / 2


class BreakevenBacktest(ExitBacktest):
    """본전 손절: 전날까지의 최고가가 진입가 + trigger_atr × ATR 이상이면 손절 감시가를 진입가로 올린다."""
    trigger_atr = 1.5

    def simulate(self, bars, entry, target, stop_trigger, stop_order, expire, atr):
        s = self.s
        if not bars:
            return UNFILLED, None, None, None, None
        filled_at = fill = None
        at_open = False
        highest = 0.0
        for i, c in enumerate(bars):
            o, h, l = _f(c, "openPrice"), _f(c, "highPrice"), _f(c, "lowPrice")  # noqa: E741 (시가·고가·저가)
            if fill is None:
                if s.entry_mode == "open":
                    at_open = True
                else:
                    if i >= s.fill_window_days:
                        return UNFILLED, None, None, None, None
                    if l > entry:
                        continue
                    at_open = o <= entry
                filled_at, fill = c["date"], (o if at_open else entry)
                first_day = True
            else:
                first_day = False
            if highest >= fill + atr * self.trigger_atr and stop_trigger < fill:
                stop_trigger = float(round_price(fill, s.currency))
                stop_order = float(round_price(stop_trigger * (1 - STOP_LIMIT_BUFFER), s.currency))
            if not first_day:
                if c["date"] > expire:
                    return EXPIRED, filled_at, fill, c["date"], o
                if o <= stop_trigger:
                    return STOP, filled_at, fill, c["date"], o
                if o >= target:
                    return TARGET, filled_at, fill, c["date"], o
            if l <= stop_trigger:
                return STOP, filled_at, fill, c["date"], stop_order
            if (not first_day or at_open) and h >= target:
                return TARGET, filled_at, fill, c["date"], target
            highest = max(highest, h)
        if fill is None:
            return UNFILLED, None, None, None, None
        return OPEN, filled_at, fill, None, None


def backtest_with(cls, **kwargs):
    """Variant.backtest_kwargs로 서브클래스를 쓰기 위한 래퍼. common.run_variant는 Backtest(...)만 부른다."""
    return {"_cls": cls, **kwargs}


# --- 변형 목록 ---

def variants(data) -> list[Variant]:
    base = data.base_settings()
    vs = [Variant("기준 (목표 4.0·손절 1.5, 10일)", base, Rule("기준", 4.0, 1.5))]
    for t in GRID_TARGETS:
        for st in GRID_STOPS:
            vs.append(Variant(f"격자 목표 {t:.1f}·손절 {st:.1f}", base, Rule("격자", t, st)))
    for hd in (5, 15, 20):
        vs.append(Variant(f"보유 {hd}일 (목표 4.0·손절 1.5)", base, Rule("보유", 4.0, 1.5, holding_days=hd)))
    for tr in (1.5, 2.0, 3.0):
        vs.append(Variant(f"트레일링 {tr:.1f} ATR (목표 4.0·손절 1.5)", base,
                          Rule("트레일링", 4.0, 1.5, trailing_atr=tr)))
    for tr in (2.0, 3.0):
        vs.append(Variant(f"트레일링만 {tr:.1f} ATR (목표 10·손절 1.5, 20일)", base,
                          Rule("트레일링만", 10.0, 1.5, holding_days=20, trailing_atr=tr)))
    vs.append(Variant("구조 (목표 20일 고가·손절 10일 저가)", base, Rule("구조", 0.0, 0.0),
                      {"scenario_fn": structure_scenario}))
    vs.append(Variant("타이트 손절 (전일 저가 − 0.5 ATR·목표 4.0)", base, Rule("타이트", 4.0, 0.0),
                      {"scenario_fn": tight_stop_scenario}))
    vs.append(Variant("타이트 손절 + 트레일링 2.0", base, Rule("타이트+트레일링", 4.0, 0.0, trailing_atr=2.0),
                      {"scenario_fn": tight_stop_scenario}))
    vs.append(Variant("분할 청산 (목표 4.0 절반, 나머지 트레일링 2.0, 20일)", base,
                      Rule("분할", 4.0, 1.5, holding_days=20, trailing_atr=2.0),
                      backtest_with(PartialExitBacktest)))
    vs.append(Variant("본전 손절 (+1.5 ATR 후 손절 = 진입가, 목표 4.0·손절 1.5)", base,
                      Rule("본전", 4.0, 1.5), backtest_with(BreakevenBacktest)))
    return vs


def run_market(market: str) -> list[dict]:
    """common.run_variants를 쓰되, backtest_kwargs의 _cls로 서브클래스를 고른다."""
    import common
    data = load_market(market)
    vs = variants(data)
    original = common.Backtest

    class Dispatch:
        """Backtest(...) 호출을 가로채 서브클래스(_cls)나 ExitBacktest로 보낸다."""
        def __new__(cls, settings, rule, candles, names, **kw):
            target_cls = kw.pop("_cls", ExitBacktest)
            return target_cls(settings, rule, candles, names, **kw)

    common.Backtest = Dispatch
    try:
        rows = run_variants(data, vs, name=NAME)
    finally:
        common.Backtest = original
    for row, v in zip(rows, vs):
        row["group"] = v.rule.name
        row["targetAtr"], row["stopAtr"] = v.rule.target_atr, v.rule.stop_atr
        row["holdingDays"], row["trailingAtr"] = v.rule.holding_days, v.rule.trailing_atr
    return rows


# --- 추가 표 ---

def _pct(v, digits=1):
    return "-" if v is None else f"{v:+.{digits}f}%"


def grid_table(rows: list[dict]) -> list[str]:
    by = {(r["targetAtr"], r["stopAtr"]): r for r in rows if r["group"] == "격자"}
    lines = ["| 목표 \\ 손절 | " + " | ".join(f"{s:.1f}" for s in GRID_STOPS) + " |",
             "|---|" + "---|" * len(GRID_STOPS)]
    for t in GRID_TARGETS:
        cells = []
        for s in GRID_STOPS:
            r = by[(t, s)]
            pf = "-" if r["profitFactor"] is None else f"{r['profitFactor']:.2f}"
            cells.append(f"{_pct(r['returnPct'], 1)} / PF {pf} / {r['orders']}건")
        lines.append(f"| {t:.1f} | " + " | ".join(cells) + " |")
    return lines


def grid_half_table(rows: list[dict]) -> list[str]:
    by = {(r["targetAtr"], r["stopAtr"]): r for r in rows if r["group"] == "격자"}
    lines = ["| 목표 \\ 손절 | " + " | ".join(f"{s:.1f}" for s in GRID_STOPS) + " |",
             "|---|" + "---|" * len(GRID_STOPS)]
    for t in GRID_TARGETS:
        cells = []
        for s in GRID_STOPS:
            r = by[(t, s)]
            e = r["exits"]
            n = sum(e.values())
            hit = f"{e[TARGET] / n * 100:.0f}%" if n else "-"
            cells.append(f"{_pct(r['firstHalfPct'])} / {_pct(r['secondHalfPct'])} / 목표 {hit}")
        lines.append(f"| {t:.1f} | " + " | ".join(cells) + " |")
    return lines


def filter_table(rows: list[dict], labels: list[str]) -> list[str]:
    lines = ["| 변형 | 승인된 시나리오 | 탈락한 시나리오 | 전체 | 전체 목표 도달률 | 승인 − 탈락 |",
             "|---|---|---|---|---|---|"]
    for r in rows:
        if r["label"] not in labels:
            continue
        fc = r["filterCheck"]

        def cell(pair):
            v, n = pair
            return "-" if v is None else f"{v * 100:+.2f}% ({n}건)"
        a, b = fc["approved"][0], fc["rejected"][0]
        diff = "-" if a is None or b is None else f"{(a - b) * 100:+.2f}%p"
        rate = "-" if fc["allTargetRatePct"] is None else f"{fc['allTargetRatePct']:.0f}%"
        lines.append(f"| {r['label']} | {cell(fc['approved'])} | {cell(fc['rejected'])} | {cell(fc['all'])} | "
                     f"{rate} | {diff} |")
    return lines


def avg_hold_table(rows: list[dict], labels: list[str]) -> list[str]:
    lines = ["| 변형 | 평균 보유 (달력일) | 평균 수익 거래 | 평균 손실 거래 | 실현 손익 | 평가 손익 |",
             "|---|---|---|---|---|---|"]
    for r in rows:
        if r["label"] not in labels:
            continue
        hold = "-" if r["avgHoldDays"] is None else f"{r['avgHoldDays']:.1f}일"
        lines.append(f"| {r['label']} | {hold} | {_pct(r['avgWinPct'], 2)} | {_pct(r['avgLossPct'], 2)} | "
                     f"{r['realizedPnlKrw']:,.0f}원 | {r['openPnlKrw']:,.0f}원 |")
    return lines


def insert_before(path: Path, marker: str, text: str) -> None:
    body = path.read_text()
    i = body.index(marker)
    path.write_text(body[:i] + text + body[i:])


KEY_LABELS = ["기준 (목표 4.0·손절 1.5, 10일)", "격자 목표 3.0·손절 1.0", "격자 목표 5.0·손절 2.0",
              "격자 목표 6.0·손절 2.5", "격자 목표 6.0·손절 1.0", "보유 5일 (목표 4.0·손절 1.5)",
              "보유 20일 (목표 4.0·손절 1.5)", "트레일링 2.0 ATR (목표 4.0·손절 1.5)",
              "트레일링만 2.0 ATR (목표 10·손절 1.5, 20일)", "구조 (목표 20일 고가·손절 10일 저가)",
              "타이트 손절 (전일 저가 − 0.5 ATR·목표 4.0)", "타이트 손절 + 트레일링 2.0",
              "분할 청산 (목표 4.0 절반, 나머지 트레일링 2.0, 20일)",
              "본전 손절 (+1.5 ATR 후 손절 = 진입가, 목표 4.0·손절 1.5)"]


def main() -> None:
    rows = {m: run_market(m) for m in ("KR", "US")}
    for m in rows:
        base = rows[m][0]
        print(f"[{m}] 기준 {base['returnPct']:+.2f}%", file=sys.stderr)
    expected = {"KR": -17.81, "US": -17.76}
    for m, want in expected.items():
        got = rows[m][0]["returnPct"]
        if abs(got - want) > 0.05:
            raise SystemExit(f"{m} 기준 수익률 {got:+.2f}%가 예상 {want:+.2f}%와 다름. 멈춤.")

    findings = FINDINGS
    notes = NOTES
    path = write_report(NAME, "청산과 시나리오 가격", rows, notes, findings)

    extra = ["## ATR 격자 요약", "",
             "칸: 수익률 / 이익 계수(PF) / 주문 수. 손익비가 2.0에 못 미치는 조합(손절 주문가 −1% 반영)은 리스크 엔진이 전부 걸러 주문이 0건이다.", ""]
    for m in rows:
        extra += [f"### {m}", ""] + grid_table(rows[m]) + ["", f"{m} 반기별 (6~7월 / 8~9월 / 체결 건 중 목표 도달률):", ""] \
            + grid_half_table(rows[m]) + [""]
    extra += ["## 리스크 엔진 필터 평가 (승인 vs 탈락 시나리오)", "",
              "승인 여부와 관계없이 모든 시나리오를 1주씩 샀다고 보고, 체결된 것만 비용 차감 수익률 평균을 낸다. "
              "'승인 − 탈락'이 양수면 리스크 엔진이 거른 시나리오가 실제로 더 나빴다는 뜻이다. "
              "탈락 사유는 거의 전부 '매수 가능 수량이 1주 미만'(주가가 높거나 손절 폭이 좁아 1주도 못 사는 경우)이라, "
              "손익비·기대값 판단이 아니라 자본 크기가 만든 필터다.", ""]
    for m in rows:
        extra += [f"### {m}", ""] + filter_table(rows[m], KEY_LABELS) + [""]
    extra += ["## 보유 기간과 거래당 손익 (주요 변형)", ""]
    for m in rows:
        extra += [f"### {m}", ""] + avg_hold_table(rows[m], KEY_LABELS) + [""]
    insert_before(path, "## 주의", "\n".join(extra) + "\n")
    print(f"결과: {path}", file=sys.stderr)


FINDINGS: list[str] = [
    "**어떤 청산 규칙도 손실을 이익으로 바꾸지 못했다.** 29개 변형 × 2개 시장 전부 손실이고 PF는 최고 0.58(미국 보유 5일)이다. "
    "청산 규칙은 '얼마나 잃는가'만 바꿨고, 손실의 원인(선별 종목의 음의 추세와 지정가 진입의 역선택, 기준 결과 README 참고)은 청산으로 고칠 수 없다.",
    "**ATR 격자: 결과를 가르는 것은 목표가 아니라 손절 폭이다.** 목표 4 ATR 이상은 10거래일 안에 거의 닿지 않아(체결 건 중 목표 도달 0~3%) "
    "국내는 목표 5.0과 6.0 행이 같은 손절 열에서 수치까지 똑같다. 손절이 넓어질수록 손실이 줄어드는 방향은 두 시장·두 반기에서 모두 같다 "
    "(국내 손절 1.5→2.0→2.5: −17.8→−9.9→−8.6%, 미국 1.0→1.5→2.0→2.5: −25.0→−17.8→−13.5→−8.8%).",
    "**그러나 넓은 손절이 '좋은 청산'이라서가 아니다.** 건당 위험 1%가 고정이라 손절이 넓으면 수량이 줄고(평균 비중 국내 46→36%, 미국 50→33%), "
    "1% 손실 사건(손절)이 31→9건(국내), 41→21건(미국)으로 줄어 기대값이 음수인 전략의 활동량이 줄어든 효과다. "
    "기준 백테스트의 '총 한도 200만원' 결과와 같은 종류의 효과이며, 전략이 좋아지면 반대로 수익도 줄인다. PF는 0.4 근처로 변하지 않았다.",
    "**손익비 2.0 기준은 손절 주문가 −1%와 비용 때문에 실제로는 목표/손절 ≈ 2.3 이상을 요구한다.** 3.0·1.5, 4.0·2.0, 5.0·2.5(모두 비율 2.0)는 전부 탈락(주문 0건), "
    "6.0·2.5(비율 2.4)는 통과한다. 3.0·1.0(비율 3.0)도 ATR이 주가의 1~2%인 종목에서는 −1% 버퍼가 손절 폭과 비슷해져 국내 53건·미국 37건이 손익비로 탈락했다.",
    "**보유 기간은 짧을수록 덜 잃었지만 단조롭지 않다.** 5일이 두 시장 모두 기준보다 나았고(국내 −15.9, 미국 −12.6%) 두 반기에서 방향이 같다(국내 8~9월은 −2.2 대 −2.3%로 차이가 거의 없다). "
    "이유는 1주 수익률 평균이 5일 보유에서 국내 −2.7%, 미국 −1.1%로 10일(−4.5%, −2.1%)보다 나아서다. 즉 선별 종목이 진입 후 계속 내려가므로 일찍 끊을수록 덜 잃는다. "
    "15일은 두 시장 모두 10일보다 나쁘고 20일은 국내는 나쁘고 미국은 나은데(6건의 큰 수익, 평균 수익 거래 +15%), 60~90건 표본의 잡음으로 본다.",
    "**트레일링 손절(목표 4.0 유지)은 2.0 ATR만 두 시장에서 기준보다 나았다** (국내 −16.9, 미국 −15.4%). 그러나 국내 8~9월은 기준보다 나빴고(−3.6 대 −2.3%), "
    "1.5 ATR은 두 시장 모두 6~7월에 낫고 8~9월에 나쁘다(미국 8~9월 −7.9%). 트레일링은 손절 건수를 크게 늘리고(국내 31→48~62건) 기한 청산을 줄이는데, "
    "이 표본에서 그 교환이 유리한지가 반기마다 다르다. 차이 1~2%p는 규칙 효과로 보기 어렵다.",
    "**트레일링만(목표 10 ATR, 20일)은 두 시장 모두 기준보다 나빴다** (국내 −18.4/−18.6, 미국 −18.4/−17.8%). 목표가 없으니 오른 종목도 되돌림에서 팔린다 "
    "(트레일링 2.0의 국내 청산 62건 중 51건이 손절, 목표 0건). 평균 수익 거래가 기준보다 작아(국내 +4.8 대 +6.7%) 추세가 짧은 이 표본에서는 이익을 키우지 못했다.",
    "**가격 구조 시나리오(목표 20일 고가·손절 10일 저가)는 손실이 가장 작지만(국내 −2.4, 미국 −5.4%) 거래가 거의 없어서다.** "
    "20일 고가는 보통 1~2 ATR 안에 있고 10일 저가는 그보다 멀어서 손익비가 2.0에 못 미쳐 국내 191/209, 미국 233/252건이 리스크 엔진에서 탈락했다 "
    "(주문 12·14건, 평균 비중 9%·7%). 통과한 거래도 손실(PF 0.54·0.33, 미국 승률 9%)이라 비중을 같게 놓고 보면 기준보다 낫다고 할 수 없다. "
    "다만 1주 수익률로 본 목표 도달률은 42%·53%로 ATR 시나리오(1~3%)보다 훨씬 높다. 리스크 엔진이 요구하는 손익비를 낮추지 않는 한 쓸 수 없는 시나리오다.",
    "**타이트 손절(전일 저가 − 0.5 ATR)은 두 시장 모두 더 잃었고(−20.3%), 트레일링을 더하면 가장 나빴다(국내 −21.2, 미국 −25.4%).** "
    "손절 폭이 좁으면 같은 1% 위험에 수량이 커지고(미국 평균 비중 57%), 하루 변동에 자주 걸려 손절이 국내 40건, 미국 66건이다. 1주 수익률은 기준과 비슷한데 수량이 커서 계좌 손실이 커졌다. "
    "국내 8~9월 −9.0%(기준 −2.3%)처럼 횡보장에서 특히 나쁘다.",
    "**추가 아이디어 두 가지는 시장 간 방향이 갈렸다.** 분할 청산(절반 목표, 나머지 트레일링 2.0, 20일)은 국내 −15.9, 미국 −14.7%로 기준보다 낫지만, "
    "같은 보유 기간의 '보유 20일'과 비교하면 국내는 낫고(−18.1→−15.9) 미국은 나쁘다(−13.3→−14.7). 본전 손절(+1.5 ATR 후 손절 = 진입가)은 국내 −16.0(개선), 미국 −19.0%(악화)다. "
    "둘 다 근거로 삼을 만한 일관성이 없다.",
    "**리스크 엔진이 거른 시나리오가 실제로 더 나빴는지: 시장마다 다르고, 걸러진 이유가 '1주 미만'이라 품질 필터가 아니다.** "
    "기준에서 국내는 승인 −4.8% 대 탈락 −3.3%(탈락이 오히려 나음, 35건), 미국은 승인 −1.8% 대 탈락 −2.7%(탈락이 나쁨, 59건)다. "
    "ATR 시나리오의 탈락 사유는 거의 전부 '매수 가능 수량이 1주 미만'(고가 주식)이라 자본금 1000만원이 만든 필터이고, 손익비·기대값 판단은 격자의 탈락 칸처럼 전부 아니면 전무로 작동한다. "
    "손익비가 실제로 갈라 주는 구조 시나리오에서는 탈락이 더 나빴지만(국내 −1.7 대 −1.4%, 미국 −1.2 대 −0.4%) 승인 18·19건 중 체결이 14·16건뿐이라 결론을 내기엔 적다.",
    "**과최적화 경고.** 격자 16개와 변형 13개를 4개월 표본에서 골랐다. 두 시장·두 반기에서 방향이 같은 결과는 '넓은 손절 = 덜 잃음'과 '5일 보유 = 덜 잃음' 둘뿐이고, "
    "둘 다 활동량(수량, 보유 시간)을 줄여 음의 기대값에 덜 노출되는 효과다. 운영 규칙(목표 4.0·손절 1.5·10일)을 바꿀 근거가 되지 않으며, "
    "청산 규칙보다 선별과 진입(실험 1·2)에서 기대값을 양수로 만드는 것이 먼저다.",
]
NOTES: list[str] = [
    "표본이 4개월(2026-06-01 ~ 09-30)이고 국내는 그중 7월 한 달이 −21%인 급락장이다. 변형 간 차이의 상당 부분이 이 한 달에서 나온다.",
    "유니버스는 오늘 기준 거래대금 랭킹의 합집합이라 생존 편향과 미래 편향이 있다 (기간 중 뜬 종목이 미리 들어 있고 상장폐지 종목은 없다).",
    "격자 16개 + 변형 13개를 같은 표본에서 골랐으므로 가장 좋은 칸은 과최적화일 가능성이 높다. 격자에서 이웃 칸과 반기별 결과가 같은 방향일 때만 규칙으로 볼 것.",
    "일봉 판정이라 같은 봉에서 손절·목표가 모두 닿으면 손절, 장중 체결일의 목표가 도달은 인정하지 않는다. 손절은 감시가 −1%의 주문가에 판다고 본다 (보수적).",
    "트레일링과 본전 손절은 전날까지의 최고가만 본다 (운영에서 조건주문을 하루 한 번 갱신하는 것과 같다).",
    "분할 청산은 두 다리를 따로 시뮬레이션해 합친 근사다. 앞 다리의 현금은 늦은 쪽 청산일에 돌아오는 것으로 보고, 한쪽이라도 기간 끝에 보유중이면 전체를 마지막 종가로 평가한다. "
    "실제 운영에는 절반 수량이 홀수이거나 1주일 때의 처리, 조건주문 두 벌 관리가 필요하다.",
    "구조 시나리오는 순서(손절 < 진입 < 목표)가 안 맞는 날을 시나리오 없음(퍼널의 '시나리오' 수가 준다)으로 처리했다. 진입가가 20일 고가와 같거나 높을 때가 그 경우다.",
    "타이트 손절은 손절 폭이 좁아 건당 위험 한도로 산정한 수량이 커진다 (같은 1% 위험에 더 많은 주). 그래서 유동성·매수 가능 금액 제약에 더 자주 걸린다.",
    "AI 분석가·검증·최종 컨펌은 빠져 있다. 규칙 시나리오가 리스크 엔진을 통과하면 무조건 산다.",
]


if __name__ == "__main__":
    main()
