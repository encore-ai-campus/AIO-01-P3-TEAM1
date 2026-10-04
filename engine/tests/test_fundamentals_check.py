"""펀더멘털 점검 규칙 (docs/API.md "장기투자"의 "지표와 판정" 표). 표의 칸마다, 우선순위 bad > warn > ok, 기준선 없음, 연속 조건."""
import copy

import pytest

from paper_engine.judge import fundamentals_check as fc
from paper_engine.wording import forbidden_phrases

BASE = {
    "annual": {"period": "2025.01.01 ~ 2025.12.31", "revenue": 200, "operatingIncome": 30, "netIncome": 20,
               "previousYear": {"revenue": 160, "operatingIncome": 25, "netIncome": 10}},
    "interim": {"report": "반기", "period": "2026.01.01 ~ 2026.06.30", "revenue": 110, "operatingIncome": 20,
                "netIncome": 15, "samePeriodLastYear": {"revenue": 100, "operatingIncome": 18, "netIncome": 8}},
    "ttm": {"revenue": 210, "operatingIncome": 32, "netIncome": 30},
    "balance": {"totalAssets": 1000, "totalLiabilities": 400, "totalEquity": 600},
    "reported": {"period": "2026.01.01 ~ 2026.06.30", "annualized": False, "roe": 0.9, "debtRatio": 0.6,
                 "currentRatio": 1.5},
    "ratios": {"operatingMargin": 0.15, "netIncomeToOperatingIncome": 0.94, "nonOperatingShareOfPretaxIncome": 0.1},
    "nonOperating": {"period": "2026.01.01 ~ 2026.06.30", "financeCosts": 4, "pretaxIncome": 22},
    "cashFlow": {"period": "2026.01.01 ~ 2026.06.30", "operatingCashFlow": 25, "netIncome": 15,
                 "samePeriodLastYear": {"operatingCashFlow": 11, "netIncome": 8}},
    "report": {"label": "2026 반기보고서", "receivedAt": "2026-08-14"},
}
BASELINE = {"operatingMargin": 0.15, "roe": 0.05, "debtRatio": 0.6}


def fund(**changes) -> dict:
    """BASE를 복사해 "묶음.키" 값을 바꾼다: fund(**{"interim.revenue": 90})."""
    f = copy.deepcopy(BASE)
    for path, value in changes.items():
        *parents, last = path.split(".")
        target = f
        for p in parents:
            target = target[p]
        if value is DROP:
            target.pop(last, None)
        else:
            target[last] = value
    return f


DROP = object()


def row(result: dict, key: str) -> dict:
    return next(r for r in result["rows"] if r["key"] == key)


def status(f: dict, key: str, **options) -> str:
    return row(fc.evaluate(f, **options), key)["status"]


def test_rows_follow_the_table_order_and_shape():
    result = fc.evaluate(fund(), baseline=BASELINE)
    assert [r["key"] for r in result["rows"]] == list(fc.KEYS)
    r = row(result, "interestCoverage")
    assert r == {"key": "interestCoverage", "label": "이자보상배율(근사)", "axis": "balance_sheet", "value": 5.0,
                 "unit": "times", "baseline": None, "change": None, "status": "ok",
                 "note": "근사: 영업이익 ÷ 금융비용 (같은 누적 기간)"}
    assert {r["key"]: r["unit"] for r in result["rows"]}["operatingCashFlow"] == "krw"
    assert result["period"] == "2026 반기보고서" and result["receivedAt"] == "2026-08-14"
    assert result["overall"] == "solid"


def test_without_baseline_only_absolute_parts_are_judged():
    result = fc.evaluate(fund())
    assert all(r["baseline"] is None and r["change"] is None for r in result["rows"])
    assert row(result, "operatingMargin")["status"] == "na"
    assert row(result, "operatingMargin")["note"] == "기준선이 있어야 판정해요"
    assert row(result, "roe")["status"] == "na" and row(result, "debtRatio")["status"] == "na"
    # 절대 기준: 영업이익률 음수 → bad, ROE 0 이하 → bad
    assert status(fund(**{"ratios.operatingMargin": -0.02}), "operatingMargin") == "bad"
    assert status(fund(**{"ttm.netIncome": -5}), "roe") == "bad"


def test_only_baseline_metrics_carry_baseline_and_change():
    result = fc.evaluate(fund(**{"ratios.operatingMargin": 0.13}), baseline={**BASELINE, "revenueGrowth": 0.5})
    with_base = [r["key"] for r in result["rows"] if r["baseline"] is not None]
    assert with_base == ["operatingMargin", "roe", "debtRatio"]
    assert row(result, "operatingMargin")["change"] == pytest.approx(-0.02)
    assert row(result, "operatingMargin")["note"] == "기준선 대비 −2.0%p"


@pytest.mark.parametrize("revenue, expected", [(110, "ok"), (100, "ok"), (95, "warn"), (90, "warn"), (89, "bad")])
def test_revenue_growth_thresholds(revenue, expected):
    # 전년 같은 기간 100: 95 → −5% (warn), 90 → −10% (warn, −0.10 이상), 89 → −11% (bad)
    assert status(fund(**{"interim.revenue": revenue}), "revenueGrowth") == expected


def test_revenue_growth_uses_annual_when_no_interim():
    f = fund(**{"interim": DROP, "annual.revenue": 150})  # 160 → 150: −6.25%
    r = row(fc.evaluate(f), "revenueGrowth")
    assert r["value"] == pytest.approx(-0.0625) and r["status"] == "warn"


def test_revenue_decline_two_reports_in_a_row_is_bad():
    f = fund(**{"interim.revenue": 95})  # −5%: 혼자면 warn
    assert status(f, "revenueGrowth", previous={"revenueGrowth": -0.02}) == "bad"
    assert row(fc.evaluate(f, previous={"revenueGrowth": -0.02}), "revenueGrowth")["note"] == "2개 보고서 연속 감소"
    assert status(f, "revenueGrowth", previous={"revenueGrowth": 0.03}) == "warn"


@pytest.mark.parametrize("income, expected", [(20, "ok"), (16, "warn"), (14.4, "warn"), (14, "bad")])
def test_operating_income_growth_thresholds(income, expected):
    # 전년 같은 기간 18: 16 → −11% (warn), 14.4 → −20% (warn), 14 → −22% (bad)
    assert status(fund(**{"interim.operatingIncome": income}), "operatingIncomeGrowth") == expected


def test_operating_income_turning_to_loss_is_bad_with_null_value():
    r = row(fc.evaluate(fund(**{"interim.operatingIncome": -3})), "operatingIncomeGrowth")
    assert r["value"] is None and r["status"] == "bad" and r["note"] == "적자 전환"


def test_operating_income_growth_is_na_when_base_period_was_a_loss():
    r = row(fc.evaluate(fund(**{"interim.samePeriodLastYear.operatingIncome": -2})), "operatingIncomeGrowth")
    assert r["status"] == "na" and "0 이하" in r["note"]


@pytest.mark.parametrize("margin, expected", [(0.145, "ok"), (0.14, "ok"), (0.13, "warn"), (0.12, "warn"),
                                              (0.119, "bad")])
def test_operating_margin_against_baseline(margin, expected):
    assert status(fund(**{"ratios.operatingMargin": margin}), "operatingMargin", baseline=BASELINE) == expected


def test_negative_margin_is_bad_even_if_it_improved():
    # bad > warn > ok: 음수면 change와 상관없이 bad
    assert status(fund(**{"ratios.operatingMargin": -0.01}), "operatingMargin",
                  baseline={**BASELINE, "operatingMargin": -0.2}) == "bad"


def test_roe_is_ttm_net_income_over_closing_equity():
    r = row(fc.evaluate(fund(), baseline=BASELINE), "roe")
    assert r["value"] == pytest.approx(0.05)  # 30 / 600 — 공시 지표 reported.roe(0.9)를 쓰지 않는다
    assert r["status"] == "ok" and "기말 자본총계" in r["note"]
    assert status(fund(**{"ttm.netIncome": 17}), "roe", baseline=BASELINE) == "warn"  # 0.0283: −2.2%p
    assert status(fund(**{"ttm.netIncome": 0}), "roe", baseline=BASELINE) == "bad"
    assert row(fc.evaluate(fund(**{"balance.totalEquity": -10})), "roe")["value"] is None


@pytest.mark.parametrize("debt, expected", [(0.8, "ok"), (0.9, "warn"), (1.1, "warn"), (1.11, "bad")])
def test_debt_ratio_change_against_baseline(debt, expected):
    assert status(fund(**{"reported.debtRatio": debt}), "debtRatio", baseline=BASELINE) == expected


@pytest.mark.parametrize("ratio, expected", [(1.0, "ok"), (0.9, "warn"), (0.8, "warn"), (0.79, "bad")])
def test_current_ratio_thresholds(ratio, expected):
    assert status(fund(**{"reported.currentRatio": ratio}), "currentRatio") == expected


def test_interest_coverage_uses_the_same_cumulative_period():
    # 반기 영업이익 20 ÷ 반기 금융비용 4 = 5 (TTM 영업이익 32를 쓰지 않는다)
    assert row(fc.evaluate(fund()), "interestCoverage")["value"] == 5.0
    assert status(fund(**{"nonOperating.financeCosts": 10}), "interestCoverage") == "warn"  # 2
    assert status(fund(**{"nonOperating.financeCosts": 40}), "interestCoverage") == "bad"  # 0.5
    r = row(fc.evaluate(fund(**{"nonOperating.financeCosts": 0})), "interestCoverage")
    assert r["value"] is None and r["status"] == "na"
    annual = fund(**{"interim": DROP, "nonOperating.financeCosts": 3})
    assert row(fc.evaluate(annual), "interestCoverage")["value"] == 10.0  # 연간 영업이익 30 ÷ 3


@pytest.mark.parametrize("net, cash, expected", [(15, 25, "ok"), (15, 0, "warn"), (15, -5, "warn"),
                                                 (-1, 5, "warn"), (0, 5, "warn"), (-1, -1, "bad"), (0, 0, "bad")])
def test_operating_cash_flow_cases(net, cash, expected):
    f = fund(**{"cashFlow.netIncome": net, "cashFlow.operatingCashFlow": cash})
    assert status(f, "operatingCashFlow") == expected


def test_profit_with_negative_cash_flow_two_reports_in_a_row_is_bad():
    f = fund(**{"cashFlow.operatingCashFlow": -5})
    short = {"netIncomeSamePeriod": 7, "operatingCashFlow": -2}
    assert status(f, "operatingCashFlow", previous=short) == "bad"
    # 직전 보고서가 적자였거나 현금흐름이 플러스였으면 처음으로 본다 (warn)
    assert status(f, "operatingCashFlow", previous={"netIncomeSamePeriod": -1, "operatingCashFlow": -2}) == "warn"
    assert status(f, "operatingCashFlow", previous={"netIncomeSamePeriod": 7, "operatingCashFlow": 3}) == "warn"


def test_operating_cash_flow_needs_both_values():
    assert status(fund(**{"cashFlow": DROP}), "operatingCashFlow") == "na"
    assert status(fund(**{"cashFlow.netIncome": None}), "operatingCashFlow") == "na"


def test_earnings_quality_is_judged_by_non_operating_share():
    r = row(fc.evaluate(fund(**{"ratios.nonOperatingShareOfPretaxIncome": 0.62})), "earningsQuality")
    assert r["value"] == 0.94 and r["status"] == "warn"
    assert r["note"] == "판정: 영업외 손익이 세전이익의 62%"
    assert status(fund(**{"ratios.nonOperatingShareOfPretaxIncome": -0.55}), "earningsQuality") == "warn"
    assert status(fund(**{"ratios.nonOperatingShareOfPretaxIncome": 0.49}), "earningsQuality") == "ok"
    # 보이는 값이 있어도 판정 지표가 없으면 na. warn이 최악 (bad 없음)
    assert status(fund(**{"ratios.nonOperatingShareOfPretaxIncome": None}), "earningsQuality") == "na"
    assert status(fund(**{"ratios.nonOperatingShareOfPretaxIncome": 0.99}), "earningsQuality") == "warn"


def test_overall_rules():
    rows = lambda *statuses: [{"status": s} for s in statuses]  # noqa: E731
    assert fc.overall_of(rows("ok", "bad", "warn")) == "review"
    assert fc.overall_of(rows("ok", "warn", "warn")) == "caution"
    assert fc.overall_of(rows("ok", "warn", "na", "na")) == "solid"
    assert fc.overall_of(rows("na", "na")) == "na"
    assert fc.overall_of([]) == "na"


def test_overall_from_evaluate():
    two_warnings = fund(**{"interim.revenue": 95, "reported.currentRatio": 0.9})
    assert fc.evaluate(two_warnings)["overall"] == "caution"
    assert fc.evaluate(fund(**{"interim.operatingIncome": -3}))["overall"] == "review"


def test_no_fundamentals_means_all_na():
    result = fc.evaluate(None)
    assert len(result["rows"]) == 9 and all(r["status"] == "na" and r["value"] is None for r in result["rows"])
    assert result["overall"] == "na" and result["period"] is None


def test_facts_for_the_next_check():
    facts = fc.evaluate(fund(**{"interim.revenue": 95}))["facts"]
    assert facts == {"period": "2026 반기보고서", "revenueGrowth": -0.05, "operatingCashFlow": 25,
                     "netIncomeSamePeriod": 15}


def test_worse_compares_only_judged_overalls():
    assert fc.worse("caution", "solid") and fc.worse("review", "caution")
    assert not fc.worse("solid", "caution") and not fc.worse("caution", "caution")
    assert not fc.worse("review", "na") and not fc.worse("na", "solid") and not fc.worse("review", None)


@pytest.mark.parametrize("args, applicable, reason", [
    (("US", "STOCK"), False, "미국 종목은 국내 일반 기업용 점검을 적용하지 않아요"),
    (("KR", "ETF"), False, "ETF·ETN은 일반 기업용 점검을 적용하지 않아요"),
    (("KR", "ETN"), False, "ETF·ETN은 일반 기업용 점검을 적용하지 않아요"),
    (("KR", "REIT"), False, "리츠는 일반 기업용 점검을 적용하지 않아요"),
    (("KR", "STOCK", "제이알글로벌리츠"), False, "리츠는 일반 기업용 점검을 적용하지 않아요"),
    (("KR", "ELW"), False, "일반 기업 주식이 아니라 일반 기업용 점검을 적용하지 않아요"),
    (("KR", "STOCK", "KB금융", "64992"), False, "금융업은 일반 기업용 점검을 적용하지 않아요"),
    (("KR", "STOCK", "삼성생명", "651"), False, "금융업은 일반 기업용 점검을 적용하지 않아요"),
    (("KR", "STOCK", "삼성전자", "264"), True, None),
    (("KR", None, "모르는 종목", None), True, None),
])
def test_applicability(args, applicable, reason):
    assert fc.applicability(*args) == (applicable, reason)


def test_neutral_labels_and_caption():
    assert fc.OVERALL_LABELS == {"solid": "기준 충족", "caution": "주의", "review": "확인 필요", "na": "적용하지 않음"}
    assert fc.CAPTION == "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"
    texts = [*fc.OVERALL_LABELS.values(), fc.CAPTION, *fc.NOT_APPLICABLE.values()]
    texts += [r["note"] or "" for r in fc.evaluate(fund(**{"interim.operatingIncome": -3}), baseline=BASELINE)["rows"]]
    assert all(forbidden_phrases(t, causal=True) == [] for t in texts)
    assert "견조" not in "".join(texts) and "점검 필요" not in "".join(texts)


def test_baseline_from_rows_keeps_all_nine_values():
    baseline = fc.baseline_from(fc.evaluate(fund())["rows"])
    assert list(baseline) == list(fc.KEYS)
    assert baseline["roe"] == pytest.approx(0.05) and baseline["operatingIncomeGrowth"] == pytest.approx(0.1111)


def test_value_text():
    assert fc.value_text(0.123, "ratio") == "12.3%"
    assert fc.value_text(4.56, "times") == "4.6배"
    assert fc.value_text(123_400_000_000, "krw") == "1,234억원"
    assert fc.value_text(None, "ratio") == "자료 없음"
