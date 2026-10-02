"""실험 5: 개선 요소 조합과 다른 기간 검증 (combo). 캐시 일봉만 쓰고 증권사 API·AI는 부르지 않는다.

    uv run python backtest/experiments/combo.py

1차 실험(entry, screen, exit, risk)에서 손실을 줄인 요소를 단계적으로 쌓는다.
  1. 기준 (운영 규칙: 목표 4.0·손절 1.5 ATR, 10거래일, 위험 1%, 전일 종가 지정가 DAY)
  2. 요소 하나씩 (1차 결과 재현 확인): 보유 5일, 손절 2.5 ATR(목표 6.0), 건당 위험 0.5%,
     연속 손절 2회 → 5거래일 휴식, 확인 진입(시가 ≥ 전일 종가일 때 시가 시장가), 체제 필터(벤치마크 5일 수익률 > 0)
  3. 누적 조합: 보유 5일 → +손절 2.5 → +위험 0.5% → +연속 손절 휴식 → +확인 진입 → +체제 필터
  4. 추가: 질 요소만(보유 5일 + 확인 진입, 위험 1%), 전체 조합에서 위험만 1%로, 시장별 조합(KR 체제 / US 확인 진입),
     사후 조합(두 기간 네 칸 모두 기준보다 나았던 단독 요소 4개. 표본 외 결과를 보고 골랐으므로 검증이 아니다)
같은 변형을 1차 실험 기간(2026-06-01 ~ 09-30)과 표본 외 기간(2026-02-09 ~ 05-29)에 돌린다.

손절 2.5 ATR은 목표 4.0이면 손익비 2.0 미만이라 리스크 엔진이 전부 거르므로, 1차 격자에서 통과한 목표 6.0과 짝지었다.
서브클래스는 entry.py(EntryBacktest, confirm_up)와 risk_regime.py(RecordingBacktest, BenchRegime, consecutive_stops)를
import해 합친다 (그 파일들은 수정하지 않는다). 결과: backtest/results/experiments/combo/
"""
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common  # noqa: E402
from common import RESULTS, Variant, load_market, run_variant, write_report, write_trades  # noqa: E402
from entry import EntryBacktest, confirm_up  # noqa: E402
from risk_regime import BenchRegime, RecordingBacktest, consecutive_stops, limits  # noqa: E402
from sim import Rule  # noqa: E402

NAME = "combo"
EXPECTED_BASE = {"KR": -17.81, "US": -17.76}  # results/<시장>/summary.md 의 기준 결과 (1차 기간)
# 1차 실험의 단독 결과 (재현 확인용, 1차 summary.md 에서 옮김)
FIRST_ROUND = {
    "보유 5일": {"KR": -15.9, "US": -12.6},
    "손절 2.5 ATR (목표 6.0)": {"KR": -8.6, "US": -8.8},
    "건당 위험 0.5%": {"KR": -7.87, "US": -5.59},
    "연속 손절 2회 → 5거래일 휴식": {"KR": -13.66, "US": -13.38},
    "확인 진입": {"KR": -15.62, "US": -7.1},
    "체제: 5일 수익률 > 0": {"KR": -12.16, "US": -17.74},
}
# (키, 제목, 시작, 끝, 반기 나누는 날, 반기 이름)
PERIODS = [
    ("in", "1차 기간 6~9월", "2026-06-01", "2026-09-30", "2026-08-01", ("6~7월", "8~9월")),
    ("oos", "표본 외 2~5월", "2026-02-09", "2026-05-29", "2026-04-01", ("2~3월", "4~5월")),
]
MARKETS = ("KR", "US")


class ComboBacktest(EntryBacktest, RecordingBacktest):
    """확인 진입(confirm)과 매매 기록 기반 휴식(pause_fn)을 함께 쓰는 백테스트.

    MRO: EntryBacktest._scenario → RecordingBacktest._scenario(기록) → Backtest._scenario. 기록되는 Trade는 같은 객체라
    확인 진입이 미체결로 바꾼 결과가 기록에도 반영된다. 인자가 없으면 기본 Backtest와 같다.
    주문 결과는 기간 끝(settings.end)까지의 봉으로만 계산한다. 표본 외 기간(5월 말 끝)에 6월 이후 봉으로 청산을 미리
    계산해 '보유중'이 손절·기한으로 잘못 분류되는 것을 막는다 (평가금액은 원래도 마지막 종가로 계산돼 같다).
    """

    def _from(self, symbol: str, day: str) -> list[dict]:
        return [c for c in super()._from(symbol, day) if c["date"] <= self.s.end]


common.Backtest = ComboBacktest  # run_variant가 쓰는 클래스 (risk_regime import가 바꿔 둔 것을 다시 바꾼다)


def variants(data, start: str, end: str) -> list[tuple[str, Variant]]:
    """(그룹, 변형). 그룹: base | single | cum | extra. 누적 ①은 단독 '보유 5일'과 같아 따로 돌리지 않는다."""
    S = lambda **kw: data.base_settings(start=start, end=end, **kw)  # noqa: E731
    base, h5, h5s = Rule("기준", 4.0, 1.5), Rule("보유 5일", 4.0, 1.5, holding_days=5), \
        Rule("보유 5일·손절 2.5", 6.0, 2.5, holding_days=5)
    half = limits(risk_per_trade=0.005)
    regime = BenchRegime(data.bench, "ret5")
    pause = consecutive_stops(2, 5)
    confirm = {"confirm": confirm_up}
    by_market = {"regime_fn": regime} if data.market == "KR" else confirm
    by_market_s = S(risk_limits=half) if data.market == "KR" else S(risk_limits=half, entry_mode="open")
    return [
        ("base", Variant("기준", S(), base)),
        ("single", Variant("단독: 보유 5일", S(), h5)),
        ("single", Variant("단독: 손절 2.5 ATR (목표 6.0)", S(), Rule("손절 2.5", 6.0, 2.5))),
        ("single", Variant("단독: 건당 위험 0.5%", S(risk_limits=half), base)),
        ("single", Variant("단독: 연속 손절 2회 → 5거래일 휴식", S(), base, {"pause_fn": pause})),
        ("single", Variant("단독: 확인 진입", S(entry_mode="open"), base, confirm)),
        ("single", Variant("단독: 체제 5일 수익률 > 0", S(), base, {"regime_fn": regime})),
        ("cum", Variant("누적 ②: 보유 5일 + 손절 2.5 (목표 6.0)", S(), h5s)),
        ("cum", Variant("누적 ③: ② + 위험 0.5%", S(risk_limits=half), h5s)),
        ("cum", Variant("누적 ④: ③ + 연속 손절 휴식", S(risk_limits=half), h5s, {"pause_fn": pause})),
        ("cum", Variant("누적 ⑤: ④ + 확인 진입", S(risk_limits=half, entry_mode="open"), h5s,
                        {"pause_fn": pause} | confirm)),
        ("cum", Variant("누적 ⑥: ⑤ + 체제 필터 (전체 조합)", S(risk_limits=half, entry_mode="open"), h5s,
                        {"pause_fn": pause, "regime_fn": regime} | confirm)),
        ("extra", Variant("추가: 질 요소만 (보유 5일 + 확인 진입, 손절 1.5, 위험 1%)", S(entry_mode="open"), h5, confirm)),
        ("extra", Variant("추가: 전체 조합에서 위험만 1%", S(entry_mode="open"), h5s,
                          {"pause_fn": pause, "regime_fn": regime} | confirm)),
        ("extra", Variant("추가: 시장별 조합 (④ + " + ("체제 필터" if data.market == "KR" else "확인 진입") + ")",
                          by_market_s, h5s, {"pause_fn": pause} | by_market)),
        # 표본 외 결과를 보고 고른 변형 (네 칸 모두 기준보다 나았던 단독 요소만). 검증이 아니라 사후 확인이다
        ("extra", Variant("사후: 손절 2.5 (목표 6.0) + 휴식 + 확인 진입 + 체제 (10일, 위험 1%)", S(entry_mode="open"),
                          Rule("손절 2.5", 6.0, 2.5), {"pause_fn": pause, "regime_fn": regime} | confirm)),
    ]


def trade_stats(res) -> dict:
    """건당 품질과 크기. ret은 1주 기준 비용 차감 수익률, 비중은 체결 금액 / 자본금."""
    s = res.settings
    filled = [t for t in res.trades if t.placed and t.fill_price is not None]
    rets = [t.ret for t in filled if t.ret is not None]
    sizes = [t.quantity * t.fill_price * s.fx_rate / s.capital_krw for t in filled]
    return {"avgRetPct": statistics.mean(rets) * 100 if rets else None,
            "medianRetPct": statistics.median(rets) * 100 if rets else None,
            "avgSizePct": statistics.mean(sizes) * 100 if sizes else None}


def monthly(res) -> dict[str, float]:
    """월별 수익률 % (전월 말 평가금액 대비)."""
    out, prev, last = {}, res.settings.capital_krw, {}
    for d, e, _ in res.equity:
        last[d[:7]] = e
    for m, e in last.items():
        out[m] = (e / prev - 1) * 100
        prev = e
    return out


def run_period(data, key: str, start: str, end: str, split: str) -> list[dict]:
    common.SPLIT = split  # split_returns가 모듈 전역을 본다
    rows = []
    for i, (group, v) in enumerate(variants(data, start, end), 1):
        res, sm = run_variant(data, v)
        sm.update(trade_stats(res), group=group, period=key, monthly=monthly(res),
                  perExposure=(sm["returnPct"] / sm["avgExposurePct"]) if sm["avgExposurePct"] else None)
        write_trades(RESULTS / "experiments" / NAME / f"{data.market}-{key}-trades-{i}.csv", res)
        rows.append(sm)
        print(f"  [{data.market} {key}] {v.label}: {sm['returnPct']:+.2f}% (주문 {sm['orders']}, 체결 {sm['filled']}, "
              f"비중 {sm['avgExposurePct']:.0f}%)", file=sys.stderr)
    common.SPLIT = "2026-08-01"
    return rows


# --- 보고서 ---

def _p(v, d=1):
    return "-" if v is None else f"{v:+.{d}f}%"


def _n(v, d=2):
    return "-" if v is None else f"{v:.{d}f}"


def stage_table(rows: list[dict]) -> list[str]:
    """누적 단계별 변화. 누적 ①은 단독 '보유 5일' 행."""
    stages = [rows[0], rows[1]] + [r for r in rows if r["group"] == "cum"]
    names = ["기준", "① 보유 5일", "② + 손절 2.5 (목표 6.0)", "③ + 위험 0.5%", "④ + 연속 손절 휴식", "⑤ + 확인 진입",
             "⑥ + 체제 필터"]
    lines = ["| 단계 | 수익률 | 직전 대비 | 평균 비중 | 같은 비중 지수 | 건당 투입 | 주문/체결 | 승률 | PF | 건당 1주 수익률 | "
             "비중당 수익률 | MDD |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    prev = None
    for name, r in zip(names, stages):
        delta = "-" if prev is None else f"{r['returnPct'] - prev:+.1f}%p"
        win = "-" if r["winRatePct"] is None else f"{r['winRatePct']:.0f}%"
        lines.append(f"| {name} | {_p(r['returnPct'], 2)} | {delta} | {r['avgExposurePct']:.0f}% | "
                     f"{_p(r['benchmarkPct'] * r['avgExposurePct'] / 100)} | {_p(r['avgSizePct']).lstrip('+')} | {r['orders']}/{r['filled']} | {win} | "
                     f"{_n(r['profitFactor'])} | {_p(r['avgRetPct'], 2)} | {_n(r['perExposure'])} | {_p(r['mddPct'])} |")
        prev = r["returnPct"]
    return lines


def quality_table(rows: list[dict]) -> list[str]:
    lines = ["| 변형 | 수익률 | 평균 비중 | 건당 투입 | 건당 1주 수익률 (평균/중앙) | 비중당 수익률 | 평균 보유 |",
             "|---|---|---|---|---|---|---|"]
    for r in rows:
        hold = "-" if r["avgHoldDays"] is None else f"{r['avgHoldDays']:.1f}일"
        lines.append(f"| {r['label']} | {_p(r['returnPct'], 2)} | {r['avgExposurePct']:.0f}% | "
                     f"{_p(r['avgSizePct']).lstrip('+')} | {_p(r['avgRetPct'], 2)} / {_p(r['medianRetPct'], 2)} | "
                     f"{_n(r['perExposure'])} | {hold} |")
    return lines


def reproduce_table(rows_in: dict[str, list[dict]]) -> list[str]:
    lines = ["| 요소 | KR 이번 | KR 1차 | US 이번 | US 1차 |", "|---|---|---|---|---|"]
    singles = {m: [r for r in rows_in[m] if r["group"] == "single"] for m in MARKETS}
    for i, (name, ref) in enumerate(FIRST_ROUND.items()):
        kr, us = singles["KR"][i], singles["US"][i]
        lines.append(f"| {name} | {_p(kr['returnPct'], 2)} | {_p(ref['KR'], 2)} | {_p(us['returnPct'], 2)} | "
                     f"{_p(ref['US'], 2)} |")
    return lines


def both_periods_table(rows: dict[tuple[str, str], list[dict]]) -> list[str]:
    """변형별로 두 기간·두 시장 수익률을 한 줄에. 네 칸 모두 플러스인지 표시."""
    lines = ["| 변형 | KR 6~9월 | KR 2~5월 | US 6~9월 | US 2~5월 | 플러스 칸 |", "|---|---|---|---|---|---|"]
    n = len(rows[("KR", "in")])
    for i in range(n):
        cells = [rows[(m, k)][i] for m in MARKETS for k in ("in", "oos")]
        label = cells[0]["label"] if cells[0]["label"] == cells[2]["label"] else \
            cells[0]["label"].split(" (")[0] + " (시장별)"
        plus = sum(1 for c in cells if c["returnPct"] > 0)
        lines.append(f"| {label} | " + " | ".join(_p(c["returnPct"], 2) for c in cells) + f" | {plus}/4 |")
    bench = [rows[(m, k)][0]["benchmarkPct"] for m in MARKETS for k in ("in", "oos")]
    lines.append("| (벤치마크 KODEX 200 / SPY) | " + " | ".join(_p(b, 2) for b in bench) + " | |")
    ew = [rows[(m, k)][0]["universeEwPct"] for m in MARKETS for k in ("in", "oos")]
    lines.append("| (유니버스 동일가중 보유) | " + " | ".join(_p(b, 2) for b in ew) + " | |")
    return lines


def universe_ew(data, start: str, end: str) -> float:
    """유니버스 종목을 기간 첫 거래일 시가에 같은 금액씩 사서 마지막 종가까지 들고 있었을 때의 평균 수익률 % (비용 없음).

    첫 거래일에 봉이 있는 종목만 센다. 유니버스 편향(오늘 기준 랭킹)의 크기를 가늠하는 기준선이다.
    """
    first = min(c["date"] for bars in data.candles.values() for c in bars if c["date"] >= start)
    rets = []
    for bars in data.candles.values():
        p = [c for c in bars if start <= c["date"] <= end]
        if p and p[0]["date"] == first:
            rets.append(float(p[-1]["closePrice"]) / float(p[0]["openPrice"]) - 1)
    return statistics.mean(rets) * 100


def monthly_table(rows: dict[tuple[str, str], list[dict]], market: str) -> list[str]:
    pick = [0, 1, 8, 11, 12, 15]  # 기준, 보유 5일, 누적 ③, 누적 ⑥, 질 요소만, 사후
    months = sorted({m for k in ("oos", "in") for m in rows[(market, k)][0]["monthly"]})
    lines = ["| 변형 | " + " | ".join(months) + " |", "|---|" + "---|" * len(months)]
    for i in pick:
        r_oos, r_in = rows[(market, "oos")][i], rows[(market, "in")][i]
        mo = r_oos["monthly"] | r_in["monthly"]
        lines.append(f"| {r_in['label']} | " + " | ".join(_p(mo.get(m)) for m in months) + " |")
    bench = monthly_bench(rows[(market, "in")][0]["_bench"])
    lines.append("| (벤치마크) | " + " | ".join(_p(bench.get(m)) for m in months) + " |")
    return lines


def monthly_bench(bench: list[dict]) -> dict[str, float]:
    """기간별 벤치마크 월 수익률 %. 기간 첫 달은 기간 첫 시가부터 (전략의 월별 수익률과 같은 구간)."""
    out = {}
    for _, _, start, end, _, _ in PERIODS:
        p = [c for c in bench if start <= c["date"] <= end]
        prev, last = float(p[0]["openPrice"]), {}
        for c in p:
            last[c["date"][:7]] = float(c["closePrice"])
        for m in sorted(last):
            out[m] = (last[m] / prev - 1) * 100
            prev = last[m]
    return out


def rewrite_report(path: Path, rows: dict[tuple[str, str], list[dict]], notes_sections: list[str]) -> None:
    """write_report가 쓴 summary.md를 고친다: 기간 문구, 표본 외 구간의 반기 열 이름, 추가 표 삽입."""
    text = path.read_text()
    text = text.replace(f"기간 {common.START} ~ {common.END}, 자본금 1000만원, AI 없음. 기준(운영 규칙)은 첫 행.",
                        "기간 두 개: 1차 실험 기간 2026-06-01 ~ 09-30, 표본 외 기간 2026-02-09 ~ 05-29. 자본금 1000만원, "
                        "AI 없음. 각 표의 첫 행은 기준(운영 규칙). 표본 외 구간 표의 반기 열은 2~3월 / 4~5월 "
                        "(2026-04-01에서 나눔)이다.")
    parts = text.split("\n## ")
    for i, part in enumerate(parts):
        if "2~5월" in part.split("\n")[0]:
            parts[i] = part.replace("| 6~7월 | 8~9월 |", "| 2~3월 | 4~5월 |")
    text = "\n## ".join(parts)
    extra = "\n".join(notes_sections)
    marker = "\n## 해석\n" if "\n## 해석\n" in text else "\n## 주의\n"
    text = text.replace(marker, "\n" + extra + "\n" + marker, 1)
    text = text.replace("파일: `<시장>-trades-N.csv` (N은 표의 행 순서)",
                        "파일: `<시장>-<in|oos>-trades-N.csv` (in = 6~9월, oos = 2~5월, N은 표의 행 순서)")
    path.write_text(text)


def main() -> None:
    markets = {m: load_market(m) for m in MARKETS}
    (RESULTS / "experiments" / NAME).mkdir(parents=True, exist_ok=True)
    rows: dict[tuple[str, str], list[dict]] = {}
    for key, title, start, end, split, _ in PERIODS:
        for m, data in markets.items():
            print(f"[{m} {title}]", file=sys.stderr)
            rows[(m, key)] = run_period(data, key, start, end, split)
            rows[(m, key)][0]["universeEwPct"] = universe_ew(data, start, end)
    base = {m: rows[(m, "in")][0]["returnPct"] for m in MARKETS}
    for m in MARKETS:
        if abs(base[m] - EXPECTED_BASE[m]) > 0.05:
            raise SystemExit(f"[{m}] 기준 결과 {base[m]:+.2f}%가 예상 {EXPECTED_BASE[m]:+.2f}%와 다름")
    for m, data in markets.items():
        rows[(m, "in")][0]["_bench"] = data.bench  # 월별 벤치마크 계산용 (json에는 넣지 않는다)

    sections = ["## 1차 결과 재현 (1차 기간, 단독 요소)", ""] + reproduce_table(
        {m: rows[(m, "in")] for m in MARKETS})
    for key, title, *_ in PERIODS:
        for m in MARKETS:
            sections += ["", f"## 누적 단계: {m} · {title}", ""] + stage_table(rows[(m, key)])
    sections += ["", "열 설명: 건당 투입 = 체결 금액 / 자본금 평균, 건당 1주 수익률 = 주문·체결된 거래의 1주 기준 비용 차감 수익률 평균 "
                 "(보유중은 기간 끝 종가), 비중당 수익률 = 수익률 ÷ 평균 비중 (비중을 같게 놓았을 때의 거래 질; 비중만 줄인 "
                 "변형은 이 값이 기준과 비슷하다), 같은 비중 지수 = 벤치마크 수익률 × 평균 비중 (같은 평균 비중으로 지수를 "
                 "들고 있었다면의 대략값)."]
    for key, title, *_ in PERIODS:
        for m in MARKETS:
            sections += ["", f"## 거래 질: {m} · {title}", ""] + quality_table(rows[(m, key)])
    sections += ["", "## 두 기간 비교", ""] + both_periods_table(rows)
    for m in MARKETS:
        sections += ["", f"## 월별 수익률: {m}", ""] + monthly_table(rows, m)
    sections += ["", "월별 표의 2월은 2026-02-09부터, 6월은 06-01부터다 (벤치마크도 같은 구간). 1~5월과 6~9월은 따로 돌린 결과다."]
    for m in MARKETS:
        rows[(m, "in")][0].pop("_bench")

    notes = [
        "기준은 운영 규칙(목표 4.0·손절 1.5 ATR, 10거래일, 손익비 2.0, 건당 위험 1%, 전일 종가 지정가 DAY)이고 1차 기간 "
        f"결과가 KR {EXPECTED_BASE['KR']:+.2f}%, US {EXPECTED_BASE['US']:+.2f}%와 일치하는지 스크립트가 확인한다.",
        "손절 2.5 ATR은 목표 4.0과 짝지으면 손익비가 2.0 미만(손절 주문가 −1% 반영)이라 리스크 엔진이 전부 거른다. 1차 격자에서 "
        "통과한 목표 6.0과 짝지었다. 보유 5일과 함께 쓰면 목표 6 ATR은 사실상 닿지 않으므로 '손절 폭 확대 + 기한 청산' 규칙이다.",
        "연속 손절 휴식은 1차에서 더 나았던 '2회 → 5거래일'을, 체제 필터는 벤치마크(KODEX 200, SPY) 5일 수익률 > 0을 썼다. "
        "둘 다 1차 기간에서 고른 값이다.",
        "확인 진입은 시가가 전일 종가 이상인 날만 시가 시장가로 산다. 조건이 안 맞으면 주문 수에는 들어가고 체결에서 빠진다. "
        "목표·손절·수량은 전일 종가 기준이다 (entry.py와 같다).",
        "표본 외 기간은 2026-02-09 ~ 05-29 (캐시 일봉은 2025-11-03부터). 선별 점수는 일봉 60개 이상이어야 계산되므로 그보다 "
        "늦게 상장한 종목은 자동으로 빠진다. 주문 결과는 기간 끝까지의 봉으로만 계산하고 끝에 보유 중인 종목은 마지막 종가로 평가한다. "
        "표본 외 구간의 반기 열은 2026-04-01에서 나눴다 (common.SPLIT을 그 구간에서만 바꿔 계산).",
        "환율·수수료율은 1차 실험과 같은 값(results/<시장>/summary.json)을 두 기간 모두에 썼다. 벤치마크 수익률은 각 기간 첫 시가 → "
        "마지막 종가다.",
        "유니버스는 오늘(2026-09-30) 기준 거래대금 랭킹의 합집합이다. 기간 중에 뜬 종목이 미리 들어가 있고 상장폐지 종목은 없다. "
        "표본 외 기간은 유니버스 기준일과 더 멀어서 이 편향이 더 클 수 있다 (2~5월에 조용하다가 이후 거래가 늘어난 종목이 "
        "'거래대금 상위'로 들어가 있다).",
        "일봉 판정은 불리한 쪽(같은 봉에서 손절·목표 동시 도달이면 손절, 손절은 감시가 −1% 주문가)이다. AI 판단은 빠져 있다.",
    ]
    rows_by_market = {f"{m} · {title}": rows[(m, key)] for key, title, *_ in PERIODS for m in MARKETS}
    path = write_report(NAME, "개선 요소 조합과 다른 기간 검증", rows_by_market, notes, FINDINGS)
    rewrite_report(path, rows, sections)
    print(f"결과: {path}", file=sys.stderr)


FINDINGS = [
    "**핵심 질문의 답: 두 기간 모두에서 이익인 조합은 없다.** 16개 변형 × 2개 시장 중 6~9월에 플러스인 것은 하나도 없다 "
    "(가장 나은 것이 KR −2.26% 시장별 조합, US −1.44% 누적 ⑤). 2~5월에는 KR 16개 전부(기준 +16.45%), US 16개 중 11개가 플러스다. "
    "가장 많이 플러스인 변형도 네 칸 중 두 칸(2~5월의 두 시장)이다. 부호를 가른 것은 규칙이 아니라 시장이다: KODEX 200은 6~9월 "
    "−18.4%, 2~5월 +72.8%, SPY는 +1.2%, +9.7%였다.",
    "**어느 기간에도 지수를 이기지 못했다.** 2~5월 KR 기준 +16.45%는 KODEX 200 +72.8%, 유니버스 동일가중 보유 +64.0%에 크게 "
    "못 미치고, 평균 비중(47%)만큼 지수를 들고 있었을 때(+34.0%)의 절반이다. US 기준 −4.63%는 SPY +9.7%, 유니버스 +41.1%인 "
    "기간의 손실이다. 6~9월에는 모든 변형이 '같은 비중 지수'보다 나빴다 (누적 ⑥ KR −2.33% 대 −0.9%). 같은 비중 지수를 넘은 변형은 "
    "2~5월에만 있다 (KR 손절 2.5 단독, 질 요소만, 위험만 1%, 사후 조합; US 체제 단독, 누적 ③~⑥ 등). 선별 → 진입 → 청산 전체가 "
    "'지수를 그만큼 들고 있기'보다 못하다는 1차 결론(손실의 원인은 선별 규칙)이 표본 외 강세장에서도 유지된다.",
    "**6~9월 누적 조합의 개선(−17.8% → KR −2.3%, US −3.4%)은 대부분 '덜 사서 덜 잃은' 효과다.** 단계별 개선은 ① 보유 5일 "
    "+2.0/+5.2%p(KR/US), ② 손절 2.5 +5.4/+5.6%p, ③ 위험 0.5% +6.8/+3.5%p, ④ 휴식 +0.1/+0.1%p, ⑤ 확인 진입 +0.2/+2.0%p, "
    "⑥ 체제 +1.0/−1.9%p다. 평균 비중이 KR 46 → 5%, US 50 → 4%로 줄었고, 비중당 수익률은 KR −0.39 → −0.48, US −0.35 → −0.94로 "
    "오히려 나빠졌다. 승률(KR 22 → 30%)·PF(0.25 → 0.36)가 오른 것은 보유 5일과 넓은 손절로 청산이 손절에서 기한 청산으로 바뀐 "
    "결과이고(KR 손절 31 → 3건), 건당 1주 수익률은 −4.63% → −4.08%로 그대로다. ③은 정의상 크기만 바꾸고, ④는 보유 5일·넓은 손절에서 "
    "연속 손절이 드물어 거의 걸리지 않았다 (쉰 날 KR 6일, 단독일 때 33일). US ⑥은 체제 필터가 진입 날을 나쁜 쪽으로 옮겨 "
    "(체결 16건, 건당 −5.6%) 1차 결과처럼 US에서는 해로웠다.",
    "**거래 질이 좋아진 요소는 두 개였고, 표본 외에서 유지된 것은 없다.** 보유 5일은 6~9월 건당 1주 수익률을 KR −4.63 → −2.76%, "
    "US −2.22 → −1.20%로 올렸지만 2~5월에는 KR +1.98 → +0.86%, US −0.80 → −0.76%로 개선이 없거나 반대였다 (비중당 수익률은 "
    "네 칸 모두 기준과 비슷). '짧게 들수록 낫다'는 선별 종목이 내리는 국면에서만 맞고, 오르는 국면에서는 이익을 일찍 끊는다. "
    "US 확인 진입(④ → ⑤: 건당 −2.19 → −0.24%, PF 0.42 → 0.73)은 1차와 같지만, 2~5월 US 단독 확인 진입은 건당 −0.80 → −1.90%로 "
    "나빠졌고 개선은 오히려 KR(+16.45 → +22.44%)에서 컸다. 1차의 'US에서만 효과'는 재현되지 않았다.",
    "**네 칸(두 기간 × 두 시장) 모두 기준보다 수익률이 나았던 단독 요소는 손절 2.5(목표 6.0), 연속 손절 휴식, 확인 진입, 체제 필터 "
    "넷이다** (체제 필터의 US 6~9월은 −17.74 대 −17.76%로 사실상 같다). 이 중 비중당 수익률까지 네 칸 모두 나아진 것은 손절 2.5뿐이다 "
    "(KR −0.39 → −0.24, 0.35 → 0.81; US −0.35 → −0.26, −0.08 → +0.08). 1.5 ATR 손절은 주문가 −1%까지 더해져 하루 흔들림에 잘리는 "
    "일이 많았고 (2~5월 KR 손절 33 → 12건), 넓히면 수량이 줄고 같은 종목이 기한까지 살아남는다. 휴식·체제·확인 진입은 두 기간 모두 "
    "한 달짜리 급락(6~9월의 7월 KODEX −21%, 2~5월의 3월 KODEX −20%·SPY −5%)에 덜 사서 나아졌다 (2~3월 반기: 기준 KR −8.6%·US −14.9% → "
    "체제 +2.2%·−4.9%, 휴식 −2.0%·−9.1%). '급락 구간에 신규 진입을 멈추는 장치'로는 두 기간에서 같은 방향이지만, 기대값의 부호를 "
    "바꾸지는 못했다.",
    "**2~5월에는 요소를 쌓을수록 수익이 줄었다 ('덜 사서 덜 번다').** KR 기준 +16.45% → ③ +2.73% → ⑥ +4.42%인데 손절 2.5 단독은 "
    "+31.07%다. 6~9월에 손실을 줄인 주된 장치(보유 5일, 위험 0.5%, 전반적인 비중 축소)가 오르는 장에서는 수익을 같은 식으로 깎는다. "
    "비중당 수익률도 2~5월에는 조합이 기준보다 좋고(KR 0.35 → ⑤ 0.69, US −0.08 → ⑥ 0.33) 6~9월에는 나빠(KR −0.48, US −0.94) 조합의 "
    "'질'마저 국면에 따라 뒤집힌다. 누적 조합은 사실상 비중 조절 다이얼이고, 전략 수익이 시장 방향을 따라가는 한 어느 쪽이 유리했는지는 "
    "지나고 나서야 안다.",
    "**사후 조합(손절 2.5 + 휴식 + 확인 진입 + 체제, 10일, 위험 1%)도 6~9월 KR −4.14%, US −9.35%로 손실이다.** 네 칸 모두 기준보다 "
    "나았던 요소만 모았는데 US 6~9월은 단독 요소들(−7.1~−8.8%)보다도 나빴다 (체결 21건, 건당 −6.6%). 2~5월은 KR +20.3%, US +8.5%다. "
    "표본 외 결과를 보고 고른 변형이라 검증이 아니며, 그렇게 골라도 6~9월 이익이 나지 않는다는 점이 결론을 강화한다.",
    "**두 반기 일관성.** 6~9월: 모든 변형이 6~7월에 손실이고 8~9월은 −5.7~+0.7%다. 조합 ③~⑥은 두 반기 모두 소폭 손실이다 "
    "(KR ③ −3.0/−0.7%, ⑥ −1.6/−0.8%). 2~5월: 기준은 2~3월 손실(KR −8.6%, US −14.9%), 4~5월 이익(+27.4%, +12.1%)이고, 체제·휴식·"
    "확인 진입·손절 2.5가 들어간 조합은 2~3월 손실을 0% 근처로 줄이는 대신 4~5월 이익도 비중만큼 줄였다. 어느 변형도 6~7월에 이익이 "
    "아니고, 한 시장의 네 반기 모두 플러스인 변형은 없다.",
    "**과최적화와 편향.** 요소는 6~9월(4개월, KR 82거래일)에서 골랐고 표본 외 2~5월도 4개월(약 75거래일)이다. 두 기간 모두 극단적인 "
    "시장(KR −18% 급락장, +73% 급등장)이라 보통 시장을 대표하지 않는다. 변형당 체결 16~73건이라 몇 %p 차이는 종목 몇 개로 뒤집힌다 "
    "(누적 ⑥ US는 체결 16·22건). 유니버스 편향은 2~5월에 특히 크다: 유니버스 동일가중 보유가 US +41.1%(SPY +9.7%), KR +64.0%로, "
    "오늘 거래대금 상위 종목이 그 기간에 크게 오른 종목들이라는 뜻이다. 2~5월의 플러스는 실제보다 좋게 나왔을 가능성이 크고, 그런데도 "
    "전략은 유니버스 단순 보유에 크게 뒤진다. 운영 규칙 변경 근거로 쓸 만한 것은 '손절 1.5 ATR(+주문가 −1%)이 너무 좁다'는 방향 하나이고, "
    "그것도 격자 한 점(목표 6.0·손절 2.5, 이웃 5.0·2.0도 같은 방향)의 결과다. 기대값을 양수로 만드는 일은 조합이 아니라 선별 규칙에서 "
    "먼저 풀어야 한다.",
]


if __name__ == "__main__":
    main()
