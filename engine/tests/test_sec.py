from datetime import date

import pytest

from paper_engine.data.sec import parse_facts, summarize_filings


def flow(start, end, val, form="10-Q", fp="Q3", filed="2026-07-31"):
    return {"start": start, "end": end, "val": val, "form": form, "fp": fp, "filed": filed}


def point(end, val, filed="2026-07-31"):
    return {"end": end, "val": val, "form": "10-Q", "filed": filed}


def series(annual, prior_annual, ytd, prior_ytd, quarter):
    """회계연도가 9월 말에 끝나는 회사 (52주 회계연도라 날짜가 매년 조금씩 다르다)."""
    return [
        flow("2023-10-01", "2024-09-28", prior_annual, "10-K", "FY", "2024-11-01"),
        flow("2024-09-29", "2025-09-27", annual, "10-K", "FY", "2025-10-31"),
        flow("2024-09-29", "2025-06-28", prior_ytd, filed="2025-08-01"),
        flow("2025-09-28", "2026-06-27", ytd),
        flow("2026-03-29", "2026-06-27", quarter),  # 3개월 실적은 누적이 아니므로 쓰지 않는다
    ]


def facts(**overrides):
    gaap = {
        "RevenueFromContractWithCustomerExcludingAssessedTax": series(400, 380, 360, 300, 110),
        # 예전에 쓰다가 그만둔 태그
        "Revenues": [flow("2017-10-01", "2018-09-29", 265, "10-K", "FY", "2018-11-05")],
        "OperatingIncomeLoss": series(130, 120, 122, 100, 35),
        "NetIncomeLoss": series(110, 95, 101, 84, 29),
        "EarningsPerShareBasic": series(7.5, 6.1, 6.9, 5.6, 2.0),
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest":
            series(132, 123, 125, 101, 36),
        "IncomeTaxExpenseBenefit": series(22, 28, 24, 17, 7),
        "Assets": [point("2025-09-27", 359), point("2026-06-27", 383)],
        "Liabilities": [point("2025-09-27", 285), point("2026-06-27", 275)],
        "StockholdersEquity": [point("2025-09-27", 74), point("2026-06-27", 108)],
    }
    gaap |= overrides
    return {
        "us-gaap": {tag: {"units": {"USD": rows}} for tag, rows in gaap.items()},
        "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [
            point("2026-04-17", 15), point("2026-07-17", 14.4)]}}},
    }


def test_parse_facts_ttm_and_ratios():
    f = parse_facts(facts(), price=88)
    assert f["source"] == "SEC" and f["currency"] == "USD"
    assert f["annual"]["period"] == "2024-09-29 ~ 2025-09-27"
    assert f["annual"]["revenue"] == 400 and f["annual"]["previousYear"]["revenue"] == 380
    # 직전 연간 + 올해 누적 - 작년 같은 기간 누적
    assert f["ttm"] == {"revenue": 460, "operatingIncome": 152, "netIncome": 127}
    assert f["interim"]["report"] == "3분기"
    assert f["interim"]["period"] == "2025-09-28 ~ 2026-06-27"
    assert f["interim"]["samePeriodLastYear"]["netIncome"] == 84
    assert f["balance"] == {"totalAssets": 383, "totalLiabilities": 275, "totalEquity": 108}
    assert f["perShare"] == {"epsAnnual": 7.5, "epsTtm": pytest.approx(8.8), "bps": 7.5}
    assert f["reported"] == {}
    r = f["ratios"]
    assert r["per"] == 10.0
    assert r["pbr"] == pytest.approx(11.73)
    assert r["roe"] == pytest.approx(1.1759)
    assert r["netMargin"] == pytest.approx(0.2761)
    assert r["debtRatio"] == pytest.approx(2.5463)
    assert r["interimRevenueGrowth"] == 0.2
    n = f["nonOperating"]
    assert n["period"] == "2025-09-28 ~ 2026-06-27"
    assert n["pretaxIncome"] == 125 and n["incomeTax"] == 24
    assert n["nonOperatingNet"] == 3  # 세전이익 125 - 누적 영업이익 122
    assert n["samePeriodLastYear"]["nonOperatingNet"] == 1
    assert r["nonOperatingShareOfPretaxIncome"] == pytest.approx(0.024)


def test_parse_facts_right_after_annual_report():
    # 연간 보고서 직후라 새 회계연도의 분기 실적이 아직 없다
    gaap = {tag: v["units"]["USD"][:2] for tag, v in facts()["us-gaap"].items()
            if "start" in v["units"]["USD"][0]}
    f = parse_facts(facts(**gaap), price=75)
    assert "interim" not in f
    assert f["ttm"]["netIncome"] == 110 and f["ratios"]["per"] == 10.0


def test_parse_facts_negative_equity_and_missing_tags():
    f = parse_facts(facts(StockholdersEquity=[point("2026-06-27", -5)], OperatingIncomeLoss=[]), 88)
    assert f["ratios"]["roe"] is None and f["ratios"]["debtRatio"] is None
    assert f["ttm"]["operatingIncome"] is None and f["ratios"]["operatingMargin"] is None


def test_parse_facts_without_us_gaap():
    assert parse_facts({"ifrs-full": {}}, 100) is None


def test_summarize_filings():
    recent = {
        "filingDate": ["2026-09-24", "2026-09-01", "2026-08-01"],
        "form": ["4", "8-K", "10-Q"],
        "primaryDocDescription": ["FORM 4", "8-K", "10-Q"],
        "items": ["", "2.02,9.01", ""],
    }
    d = summarize_filings(recent, date(2026, 9, 29))
    assert d["insiderFilingCount"] == 1
    assert d["items"] == [{"date": "2026-09-01", "form": "8-K", "title": "수시공시",
                           "topics": ["실적 발표", "9.01"]}]


def test_implausible_book_value_is_dropped():
    # 주식 종류가 여러 개라 보고된 주식수가 실제보다 훨씬 적은 경우
    f = parse_facts(facts(StockholdersEquity=[point("2026-06-27", 108_000)]), price=88)
    assert f["perShare"]["bps"] is None and f["ratios"]["pbr"] is None
    assert f["ratios"]["per"] == 10.0
