import pytest

from paper_engine.data.dart import (EPS_ID, OWNERS_EQUITY_ID, build_fundamentals, parse_indexes,
                               parse_non_operating, parse_per_share, parse_shares, parse_statement,
                               summarize_disclosures)


def row(fs_div, name, this, this_add=None, prev=None, prev_add=None, period="2026.01.01 ~ 2026.06.30"):
    return {"fs_div": fs_div, "account_nm": name, "thstrm_dt": period, "thstrm_amount": this,
            "thstrm_add_amount": this_add, "frmtrm_amount": prev, "frmtrm_add_amount": prev_add}


INTERIM_ROWS = [
    row("CFS", "자산총계", "1,000", prev="800"),
    row("CFS", "부채총계", "400", prev="300"),
    row("CFS", "자본총계", "600", prev="500"),
    row("CFS", "매출액", "60", "110", "40", "80"),
    row("CFS", "영업이익", "12", "20", "5", "10"),
    row("CFS", "당기순이익(손실)", "9", "15", "4", "8"),
    row("CFS", "당기순이익(손실)", "999", "999", "999", "999"),  # 지배주주 귀속분 등 중복 행
    row("OFS", "매출액", "1", "2", "3", "4"),
]
ANNUAL_ROWS = [
    row("CFS", "자산총계", "800", prev="700", period="2025.12.31 현재"),
    row("CFS", "부채총계", "300", prev="280"),
    row("CFS", "자본총계", "500", prev="420"),
    row("CFS", "매출액", "200", prev="160", period="2025.01.01 ~ 2025.12.31"),
    row("CFS", "영업이익", "30", prev="-5"),
    row("CFS", "당기순이익(손실)", "20", prev="10"),
]


def test_parse_prefers_consolidated_and_cumulative():
    s = parse_statement(INTERIM_ROWS)
    assert s["basis"] == "연결"
    assert s["current"] == {"totalAssets": 1000, "totalLiabilities": 400, "totalEquity": 600,
                            "revenue": 110, "operatingIncome": 20, "netIncome": 15}
    assert s["previous"]["revenue"] == 80 and s["previous"]["totalEquity"] == 500
    assert s["period"] == "2026.01.01 ~ 2026.06.30"


def test_parse_falls_back_to_separate_statement():
    s = parse_statement([r for r in INTERIM_ROWS if r["fs_div"] == "OFS"])
    assert s["basis"] == "별도" and s["current"]["revenue"] == 2


def test_parse_empty():
    assert parse_statement([]) is None


def test_fundamentals_ttm_and_ratios():
    f = build_fundamentals(
        parse_statement(ANNUAL_ROWS), parse_statement(INTERIM_ROWS), "반기", price=900,
        annual_per_share={"eps": 60, "epsPrevious": 30, "ownersEquity": 480},
        interim_per_share={"eps": 50, "epsPrevious": 20, "ownersEquity": 570},
        shares=3, reported={"roe": 0.234, "debtRatio": 0.311})
    # 직전 연간 + 올해 누적 - 작년 같은 기간 누적
    assert f["ttm"] == {"revenue": 230, "operatingIncome": 40, "netIncome": 27}
    assert f["balance"]["totalEquity"] == 600  # 최신 보고서 기준
    assert f["perShare"] == {"epsAnnual": 60, "epsTtm": 90, "bps": 190}  # 지배지분 570 / 3주
    assert f["reported"] == {"period": "2026.01.01 ~ 2026.06.30", "annualized": False,
                             "roe": 0.234, "debtRatio": 0.311}
    r = f["ratios"]
    assert r["per"] == 10.0
    assert r["pbr"] == pytest.approx(4.74)
    assert r["operatingMargin"] == pytest.approx(0.1739)
    assert r["annualRevenueGrowth"] == 0.25
    assert r["annualOperatingIncomeGrowth"] is None  # 전기 적자라 증가율을 내지 않는다
    assert r["interimRevenueGrowth"] == 0.375
    assert f["interim"]["report"] == "반기"


def test_fundamentals_without_interim_uses_annual():
    f = build_fundamentals(parse_statement(ANNUAL_ROWS), None, None, price=1000,
                           annual_per_share={"eps": 50, "ownersEquity": None}, shares=5)
    assert f["perShare"]["epsTtm"] == 50 and f["ratios"]["per"] == 20.0
    assert f["perShare"]["bps"] == 100  # 지배지분이 없으면 자본총계 500 / 5주
    assert "interim" not in f


def test_per_is_none_when_loss_or_eps_missing():
    annual = parse_statement(ANNUAL_ROWS)
    assert build_fundamentals(annual, None, None, 1000,
                              annual_per_share={"eps": -50})["ratios"]["per"] is None
    f = build_fundamentals(annual, None, None, 1000)
    assert f["ratios"]["per"] is None and f["ratios"]["pbr"] is None


def test_parse_per_share_uses_cumulative_and_standard_ids():
    rows = [
        {"account_id": EPS_ID, "sj_div": "IS", "account_nm": "기본주당이익(손실)",
         "thstrm_amount": "10,849", "thstrm_add_amount": "17,950",
         "frmtrm_q_amount": "737", "frmtrm_add_amount": "1,929"},
        {"account_id": OWNERS_EQUITY_ID, "sj_div": "BS", "thstrm_amount": "565"},
        {"account_id": OWNERS_EQUITY_ID, "sj_div": "CIS", "thstrm_amount": "84"},  # 포괄손익 귀속분
    ]
    assert parse_per_share(rows) == {"eps": 17950, "epsPrevious": 1929, "ownersEquity": 565}
    annual = [{"account_id": EPS_ID, "thstrm_amount": "6,605", "frmtrm_amount": "4,950"}]
    assert parse_per_share(annual)["eps"] == 6605
    assert parse_per_share([])["eps"] is None


def test_parse_indexes_converts_percent_and_skips_bad_values():
    rows = [{"idx_nm": "ROE", "idx_val": "23.404"}, {"idx_nm": "순이익률", "idx_val": None},
            {"idx_nm": "매출총이익률", "idx_val": "#########"}, {"idx_nm": "판관비율", "idx_val": "17"}]
    names = {"ROE": "roe", "순이익률": "netMargin", "매출총이익률": "grossMargin"}
    assert parse_indexes(rows, names) == {"roe": 0.234}


def test_parse_shares():
    rows = [{"se": "보통주", "distb_stock_co": "5,764"}, {"se": "우선주", "distb_stock_co": "802"},
            {"se": "합계", "distb_stock_co": "6,566"}, {"se": "비고", "distb_stock_co": "-"}]
    assert parse_shares(rows) == 6566
    assert parse_shares(rows[:1]) == 5764
    assert parse_shares([]) is None


def test_no_annual_statement():
    assert build_fundamentals(None, None, None, 1000) is None


def test_disclosures_separate_insider_reports():
    rows = [
        {"rcept_dt": "20260922", "report_nm": "임원ㆍ주요주주특정증권등소유상황보고서", "flr_nm": "홍길동"},
        {"rcept_dt": "20260918", "report_nm": "최대주주등소유주식변동신고서      ", "flr_nm": "삼성전자"},
    ]
    d = summarize_disclosures(rows)
    assert d["insiderOwnershipReportCount"] == 1
    assert d["items"] == [{"date": "2026-09-18", "title": "최대주주등소유주식변동신고서", "filer": "삼성전자",
                           "rceptNo": None}]  # 응답에 접수번호가 없으면 None


def full_row(account_id, this_add, prev_add, sj_div="CIS"):
    return {"account_id": account_id, "sj_div": sj_div, "thstrm_amount": "1",
            "thstrm_add_amount": this_add, "frmtrm_q_amount": "1", "frmtrm_add_amount": prev_add}


def test_non_operating_items_explain_gap_between_operating_and_net_income():
    rows = [
        full_row("ifrs-full_FinanceIncome", "83", "4"),
        full_row("ifrs-full_FinanceCosts", "7", "3"),
        full_row("ifrs-full_ProfitLossBeforeTax", "96", "11"),
        full_row("ifrs-full_IncomeTaxExpenseContinuingOperations", "40", "3"),
        full_row("ifrs-full_FinanceIncome", "999", "999", sj_div="CF"),  # 현금흐름표 항목은 제외
    ]
    parsed = parse_non_operating(rows)
    assert parsed["current"] == {"financeIncome": 83, "financeCosts": 7, "pretaxIncome": 96,
                                 "incomeTax": 40}
    f = build_fundamentals(parse_statement(ANNUAL_ROWS), parse_statement(INTERIM_ROWS), "반기",
                           non_operating=parsed)
    n = f["nonOperating"]
    assert n["period"] == "2026.01.01 ~ 2026.06.30"
    assert n["financeIncome"] == 83
    assert n["nonOperatingNet"] == 76  # 세전이익 96 - 반기 영업이익 20
    assert n["samePeriodLastYear"]["nonOperatingNet"] == 1  # 11 - 10
    assert f["ratios"]["nonOperatingShareOfPretaxIncome"] == pytest.approx(0.7917)
    assert f["ratios"]["netIncomeToOperatingIncome"] == pytest.approx(0.68)  # TTM 27 / 40


def test_non_operating_is_omitted_when_unavailable():
    f = build_fundamentals(parse_statement(ANNUAL_ROWS), None, None,
                           non_operating=parse_non_operating([]))
    assert "nonOperating" not in f
    assert "nonOperatingShareOfPretaxIncome" not in f["ratios"]
