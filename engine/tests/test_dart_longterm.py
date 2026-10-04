"""DART 수집의 장기투자용 추가분: 영업현금흐름, 접수번호·접수일, 보고서 이름, 정기공시 쪽 조회, 업종 코드.

네트워크를 부르지 않는다 (DartClient._get을 가짜로 바꾼다).
"""
import json
from datetime import date

import pytest

from paper_engine.data import dart
from paper_engine.data.dart import (DartClient, DartError, build_fundamentals, disclosure_url, parse_cash_flow,
                                    parse_statement, received_date, report_info, summarize_disclosures,
                                    summarize_filings)


def row(name, this, this_add=None, prev=None, prev_add=None, fs_div="CFS", period="2026.01.01 ~ 2026.06.30",
        rcept_no="20260814000123"):
    return {"fs_div": fs_div, "account_nm": name, "thstrm_dt": period, "thstrm_amount": this,
            "thstrm_add_amount": this_add, "frmtrm_amount": prev, "frmtrm_add_amount": prev_add, "rcept_no": rcept_no}


INTERIM = [row("자산총계", "1,000", prev="800"), row("부채총계", "400", prev="300"), row("자본총계", "600", prev="500"),
           row("매출액", "60", "110", "40", "80"), row("영업이익", "12", "20", "5", "10"),
           row("당기순이익(손실)", "9", "15", "4", "8")]
ANNUAL = [row("자산총계", "800", prev="700", period="2025.12.31 현재", rcept_no="20260310000777"),
          row("부채총계", "300", prev="280", rcept_no="20260310000777"),
          row("자본총계", "500", prev="420", rcept_no="20260310000777"),
          row("매출액", "200", prev="160", period="2025.01.01 ~ 2025.12.31", rcept_no="20260310000777"),
          row("영업이익", "30", prev="25", rcept_no="20260310000777"),
          row("당기순이익(손실)", "20", prev="10", rcept_no="20260310000777")]


def cf_row(account_id, this, prev, sj_div="CF"):
    return {"account_id": account_id, "sj_div": sj_div, "thstrm_amount": this, "frmtrm_amount": prev}


def test_parse_statement_keeps_receipt_number():
    assert parse_statement(INTERIM)["rceptNo"] == "20260814000123"
    assert parse_statement([{**r, "rcept_no": None} for r in INTERIM])["rceptNo"] is None


def test_received_date_and_disclosure_url():
    assert received_date("20260814000123") == "2026-08-14"
    assert received_date(None) is None and received_date("abc") is None
    assert disclosure_url("20260814000123") == "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260814000123"
    assert disclosure_url(None) is None and disclosure_url("not-a-number") is None


def test_parse_cash_flow_reads_operating_cash_flow_from_cash_flow_statement():
    rows = [cf_row("ifrs-full_CashFlowsFromUsedInOperatingActivities", "999", "999", sj_div="IS"),  # 현금흐름표만
            cf_row("ifrs-full_CashFlowsFromUsedInOperatingActivities", "1,234", "-56"),
            cf_row("ifrs-full_CashFlowsFromUsedInOperatingActivities", "1", "1")]  # 첫 행만
    assert parse_cash_flow(rows) == {"current": 1234, "previous": -56}
    # 옛 택사노미의 계정 ID
    assert parse_cash_flow([cf_row("ifrs_CashFlowsFromUsedInOperatingActivities", "7", "8")])["current"] == 7
    assert parse_cash_flow([]) == {"current": None, "previous": None}


def test_cash_flow_pairs_with_net_income_of_the_same_cumulative_period():
    f = build_fundamentals(parse_statement(ANNUAL), parse_statement(INTERIM), "반기",
                           cash_flow={"current": -40, "previous": 30})
    assert f["cashFlow"] == {"period": "2026.01.01 ~ 2026.06.30", "operatingCashFlow": -40, "netIncome": 15,
                             "samePeriodLastYear": {"operatingCashFlow": 30, "netIncome": 8}}
    annual_only = build_fundamentals(parse_statement(ANNUAL), None, None, cash_flow={"current": 50, "previous": 9})
    assert annual_only["cashFlow"]["netIncome"] == 20  # 연간 보고서면 연간 순이익
    assert "cashFlow" not in build_fundamentals(parse_statement(ANNUAL), None, None,
                                                cash_flow={"current": None, "previous": None})


def test_disclosure_summary_keeps_receipt_number():
    rows = [{"rcept_dt": "20261002", "report_nm": "단일판매ㆍ공급계약체결", "flr_nm": "삼성전자",
             "rcept_no": "20261002000555"}]
    assert summarize_disclosures(rows)["items"][0]["rceptNo"] == "20261002000555"


def test_summarize_filings_keeps_listed_companies_only():
    rows = [{"stock_code": "005930", "corp_name": "삼성전자", "report_nm": "반기보고서  (2026.06)",
             "rcept_no": "20260814000123", "rcept_dt": "20260814"},
            {"stock_code": " ", "corp_name": "비상장", "report_nm": "사업보고서", "rcept_no": "1", "rcept_dt": "20260814"}]
    assert summarize_filings(rows) == [{"symbol": "005930", "corpName": "삼성전자", "title": "반기보고서 (2026.06)",
                                        "rceptNo": "20260814000123", "date": "2026-08-14"}]


def test_report_info_names_the_report():
    info = report_info({"bsns_year": 2026, "reprt_code": "11012"}, parse_statement(INTERIM))
    assert info == {"code": "11012", "name": "반기보고서", "year": 2026, "label": "2026 반기보고서",
                    "rceptNo": "20260814000123", "receivedAt": "2026-08-14"}
    assert report_info({"bsns_year": 2025, "reprt_code": "11011"}, None)["label"] == "2025 사업보고서"


class FakeDart(DartClient):
    """_get을 가짜로: (경로, 인자) → 응답 본문. 부른 기록을 남긴다."""

    def __init__(self, tmp_path, responses):
        super().__init__("test-key", tmp_path)
        self._corp_codes = {"005930": "00126380"}
        self.responses = responses
        self.calls = []

    def _get(self, path, params):
        self.calls.append((path, dict(params)))
        body = self.responses(path, params)
        return json.dumps(body).encode()


def test_periodic_filings_reads_every_page(tmp_path):
    def responses(path, params):
        page = params["page_no"]
        assert path == "list.json" and params["pblntf_ty"] == "A"
        assert params["bgn_de"] == params["end_de"] == "20261002"
        return {"status": "000", "message": "정상", "page_no": page, "total_page": 3,
                "list": [{"stock_code": f"00000{page}", "corp_name": "회사", "report_nm": "분기보고서",
                          "rcept_no": f"2026100200000{page}", "rcept_dt": "20261002"}]}
    client = FakeDart(tmp_path, responses)
    found = client.periodic_filings(date(2026, 10, 2))
    assert [f["symbol"] for f in found] == ["000001", "000002", "000003"]
    assert [c[1]["page_no"] for c in client.calls] == [1, 2, 3]


def test_periodic_filings_without_data_is_empty(tmp_path):
    client = FakeDart(tmp_path, lambda path, params: {"status": "013", "message": "조회된 데이타가 없습니다."})
    assert client.periodic_filings(date(2026, 10, 3)) == []
    assert len(client.calls) == 1


def test_periodic_filings_raises_on_error_status(tmp_path):
    client = FakeDart(tmp_path, lambda path, params: {"status": "020", "message": "요청 제한을 초과하였습니다."})
    with pytest.raises(DartError):
        client.periodic_filings(date(2026, 10, 2))


def test_industry_code_is_cached_on_disk(tmp_path):
    client = FakeDart(tmp_path, lambda path, params: {"status": "000", "induty_code": "264", "jurir_no": "1"})
    assert client.industry_code("005930") == "264"
    assert client.industry_code("005930") == "264"
    assert [c[0] for c in client.calls] == ["company.json"]
    again = FakeDart(tmp_path, lambda path, params: pytest.fail("디스크 캐시를 써야 한다"))
    assert again.industry_code("005930") == "264"
    assert client.industry_code("999999") is None  # 회사 코드가 없는 종목


def test_industry_code_error_status(tmp_path):
    client = FakeDart(tmp_path, lambda path, params: {"status": "100", "message": "필드 오류"})
    with pytest.raises(DartError):
        client.industry_code("005930")


def test_fundamentals_carries_report_and_cash_flow(tmp_path):
    cf = [cf_row("ifrs-full_CashFlowsFromUsedInOperatingActivities", "25", "11")]

    def responses(path, params):
        if path == "fnlttSinglAcnt.json":
            if params["reprt_code"] == dart.ANNUAL and params["bsns_year"] == 2025:
                return {"status": "000", "list": ANNUAL}
            if params["reprt_code"] == "11012" and params["bsns_year"] == 2026:
                return {"status": "000", "list": INTERIM}
            return {"status": "013", "message": "없음"}
        if path == "fnlttSinglAcntAll.json":
            return {"status": "000", "list": cf if params["reprt_code"] == "11012" else []}
        return {"status": "013", "message": "없음"}  # 지표·주식 수
    f = FakeDart(tmp_path, responses).fundamentals("005930", None, date(2026, 10, 2))
    assert f["report"]["label"] == "2026 반기보고서" and f["report"]["receivedAt"] == "2026-08-14"
    assert f["cashFlow"]["operatingCashFlow"] == 25 and f["cashFlow"]["netIncome"] == 15
    assert f["ttm"]["netIncome"] == 27 and f["balance"]["totalEquity"] == 600  # TTM ROE의 입력
