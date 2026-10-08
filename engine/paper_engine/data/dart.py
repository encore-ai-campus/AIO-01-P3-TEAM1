"""DART(전자공시) 재무·공시 수집. 국내 종목만 해당한다.

EPS, ROE, 부채비율 등은 DART가 공시한 값을 그대로 쓴다.
PER과 PBR은 주가에 따라 바뀌어 공시되지 않으므로 현재가와 공시된 주당 값으로 구한다.

장기투자(docs/API.md "장기투자")가 더 쓰는 것:
  - 현금흐름표의 영업활동현금흐름 (cashFlow, 펀더멘털 점검의 영업현금흐름)
  - 최신 보고서의 이름·접수번호·접수일 (report)
  - 공시의 접수번호 (rceptNo, 공시 원문 주소 disclosure_url)
  - 하루 동안 접수된 정기공시 목록 (periodic_filings, 공시검색 pblntf_ty=A, 마지막 쪽까지)
  - 회사 개황의 업종 코드 (industry_code, 금융업 가리기)
"""
import io
import json
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import date, timedelta
from pathlib import Path

BASE_URL = "https://opendart.fss.or.kr/api"
CORP_CODE_TTL_SEC = 30 * 24 * 3600
ANNUAL = "11011"
INTERIM = [("11014", "3분기"), ("11012", "반기"), ("11013", "1분기")]  # 최신 순
NO_DATA = "013"
# 건수가 많고 개별 내용이 비슷한 공시. 목록에서 빼고 건수만 센다.
INSIDER_REPORT = "임원ㆍ주요주주특정증권등소유상황보고서"

ACCOUNTS = {
    "매출액": "revenue", "영업이익": "operatingIncome", "당기순이익(손실)": "netIncome",
    "자산총계": "totalAssets", "부채총계": "totalLiabilities", "자본총계": "totalEquity",
}
FLOW = ("revenue", "operatingIncome", "netIncome")
# 전체 재무제표에서는 회사마다 계정 이름이 달라 표준 계정 ID로 찾는다.
EPS_ID = "ifrs-full_BasicEarningsLossPerShare"
OWNERS_EQUITY_ID = "ifrs-full_EquityAttributableToOwnersOfParent"
# 영업이익과 순이익 사이의 항목. 순이익이 영업 외 손익으로 크게 달라졌는지 보기 위해 넘긴다.
NON_OPERATING_IDS = {
    "ifrs-full_FinanceIncome": "financeIncome",
    "ifrs-full_FinanceCosts": "financeCosts",
    "dart_OtherGains": "otherGains",
    "dart_OtherLosses": "otherLosses",
    "ifrs-full_ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod":
        "equityMethodIncome",
    "dart_ProfitsOfAssociatesAndJointVenturesAccountedForUsingEquityMethod": "equityMethodIncome",
    "ifrs-full_ProfitLossBeforeTax": "pretaxIncome",
    "ifrs-full_IncomeTaxExpenseContinuingOperations": "incomeTax",
}
# 현금흐름표(sj_div CF)의 영업활동현금흐름. 옛 택사노미는 ifrs_ 접두사를 쓴다
OPERATING_CASH_FLOW_IDS = ("ifrs-full_CashFlowsFromUsedInOperatingActivities",
                           "ifrs_CashFlowsFromUsedInOperatingActivities")
REPORT_NAMES = {"11011": "사업보고서", "11012": "반기보고서", "11013": "1분기보고서", "11014": "3분기보고서"}
DISCLOSURE_URL = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo={}"
PERIODIC = "A"  # 공시검색의 공시 유형: 정기공시 (사업·반기·분기보고서)
MAX_PAGES = 50  # 공시검색 쪽 수 상한 (쪽당 100건. 하루 정기공시는 많아야 수천 건이다)
# 재무지표 API의 분류 코드와, 가져올 지표 이름
INDEX_GROUPS = {
    "M210000": {"ROE": "roe", "순이익률": "netMargin", "매출총이익률": "grossMargin"},
    "M220000": {"부채비율": "debtRatio", "유동비율": "currentRatio"},
}


class DartError(Exception):
    pass


def _amount(text: str | None) -> float | None:
    text = (text or "").replace(",", "").strip()
    if not text or text == "-":
        return None
    return float(text)


def received_date(rcept_no: str | None) -> str | None:
    """접수번호(14자리, 앞 8자리가 접수일 YYYYMMDD) → 접수일 YYYY-MM-DD. 형식이 다르면 None."""
    text = (rcept_no or "").strip()
    if len(text) < 8 or not text[:8].isdigit():
        return None
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}"


def disclosure_url(rcept_no: str | None) -> str | None:
    """DART 공시 원문 주소 (접수번호로 만든다). 접수번호가 없으면 None."""
    text = (rcept_no or "").strip()
    return DISCLOSURE_URL.format(text) if text.isdigit() else None


def parse_statement(rows: list[dict]) -> dict | None:
    """주요계정 응답을 {current, previous, period, basis, rceptNo}로 정리한다.

    연결재무제표가 있으면 연결을, 없으면 별도를 쓴다. 분기·반기 보고서의 손익은 누적 금액을 쓴다.
    rceptNo는 그 보고서의 접수번호 (응답에 없으면 None).
    """
    for fs_div, basis in (("CFS", "연결"), ("OFS", "별도")):
        current, previous, period, rcept_no = {}, {}, None, None
        for r in rows:
            key = ACCOUNTS.get(r["account_nm"])
            if r["fs_div"] != fs_div or key is None or key in current:
                continue
            rcept_no = rcept_no or (r.get("rcept_no") or "").strip() or None
            if key in FLOW:
                current[key] = _amount(r.get("thstrm_add_amount")) or _amount(r.get("thstrm_amount"))
                previous[key] = _amount(r.get("frmtrm_add_amount")) or _amount(r.get("frmtrm_amount"))
                period = r.get("thstrm_dt")
            else:
                current[key] = _amount(r.get("thstrm_amount"))
                # 분기·반기 보고서의 재무상태표 비교 대상은 전기 말이다.
                previous[key] = _amount(r.get("frmtrm_amount"))
        if current:
            return {"basis": basis, "period": period, "current": current, "previous": previous,
                    "rceptNo": rcept_no}
    return None


def _cumulative(row: dict) -> tuple[float | None, float | None]:
    """전체 재무제표 행에서 (당기 누적, 전기 같은 기간 누적)을 꺼낸다."""
    current = _amount(row.get("thstrm_add_amount")) or _amount(row.get("thstrm_amount"))
    previous = (_amount(row.get("frmtrm_add_amount")) or _amount(row.get("frmtrm_q_amount"))
                or _amount(row.get("frmtrm_amount")))
    return current, previous


def parse_non_operating(rows: list[dict]) -> dict:
    """전체 재무제표에서 영업외 항목(누적)을 꺼낸다."""
    current, previous = {}, {}
    for r in rows:
        key = NON_OPERATING_IDS.get(r.get("account_id"))
        if key and key not in current and r.get("sj_div") in ("IS", "CIS"):
            current[key], previous[key] = _cumulative(r)
    return {"current": current, "previous": previous}


def parse_cash_flow(rows: list[dict]) -> dict:
    """전체 재무제표의 현금흐름표(sj_div CF)에서 영업활동현금흐름(누적)을 꺼낸다.

    {"current": 당기 누적, "previous": 전기 같은 기간 누적}. 없으면 둘 다 None.
    """
    for r in rows:
        if r.get("sj_div") == "CF" and r.get("account_id") in OPERATING_CASH_FLOW_IDS:
            current, previous = _cumulative(r)
            return {"current": current, "previous": previous}
    return {"current": None, "previous": None}


def parse_per_share(rows: list[dict]) -> dict:
    """전체 재무제표에서 공시된 EPS(누적)와 지배기업 소유주지분을 꺼낸다."""
    result = {"eps": None, "epsPrevious": None, "ownersEquity": None}
    for r in rows:
        if r.get("account_id") == EPS_ID and result["eps"] is None:
            result["eps"], result["epsPrevious"] = _cumulative(r)
        elif (r.get("account_id") == OWNERS_EQUITY_ID and r.get("sj_div") == "BS"
              and result["ownersEquity"] is None):
            result["ownersEquity"] = _amount(r.get("thstrm_amount"))
    return result


def parse_indexes(rows: list[dict], names: dict) -> dict:
    """재무지표 응답(% 단위)을 비율로 바꾼다."""
    result = {}
    for r in rows:
        key = names.get(r.get("idx_nm"))
        try:
            if key:
                result[key] = round(float(r["idx_val"]) / 100, 4)
        except (TypeError, ValueError, KeyError):
            pass  # 값이 없거나 "#########"처럼 표시할 수 없는 지표
    return result


def parse_shares(rows: list[dict]) -> float | None:
    """유통주식수 합계 (보통주 + 우선주, 자기주식 제외)."""
    by_kind = {r.get("se"): _amount(r.get("distb_stock_co")) for r in rows}
    return by_kind.get("합계") or by_kind.get("보통주")


def _ratio(a: float | None, b: float | None, digits: int = 4) -> float | None:
    if a is None or not b:
        return None
    return round(a / b, digits)


def build_fundamentals(annual: dict | None, interim: dict | None, interim_name: str | None,
                       price: float | None = None, annual_per_share: dict | None = None,
                       interim_per_share: dict | None = None, shares: float | None = None,
                       reported: dict | None = None, source: str = "DART",
                       currency: str = "KRW", non_operating: dict | None = None,
                       cash_flow: dict | None = None) -> dict | None:
    """연간·분기 보고서를 합쳐 최근 12개월(TTM) 실적과 지표를 정리한다.

    non_operating은 최신 보고서의 영업외 항목 {"current": {...}, "previous": {...}}.
    cash_flow는 최신 보고서의 영업활동현금흐름 {"current", "previous"} (parse_cash_flow). 있으면 결과의 cashFlow에
    같은 누적 기간의 순이익과 함께 넣는다 (펀더멘털 점검이 둘을 비교한다).
    """
    if not annual:
        return None
    a = annual["current"]

    def ttm_of(annual_value, interim_value, interim_previous):
        # 직전 연간 + 올해 누적 - 작년 같은 기간 누적
        if interim and None not in (annual_value, interim_value, interim_previous):
            return annual_value + interim_value - interim_previous
        return annual_value

    ttm = {k: ttm_of(a.get(k), interim and interim["current"].get(k),
                     interim and interim["previous"].get(k)) for k in FLOW}
    latest = (interim or annual)["current"]
    aps, ips = annual_per_share or {}, interim_per_share or {}
    eps_ttm = ttm_of(aps.get("eps"), ips.get("eps"), ips.get("epsPrevious"))
    if eps_ttm is not None:
        eps_ttm = round(eps_ttm, 2)
    owners_equity = (ips if interim else aps).get("ownersEquity") or latest.get("totalEquity")
    bps = _ratio(owners_equity, shares, 0 if currency == "KRW" else 2)
    result = {
        "source": source,
        "basis": annual["basis"],
        "currency": currency,
        "annual": {"period": annual["period"], **{k: a.get(k) for k in FLOW},
                   "previousYear": {k: annual["previous"].get(k) for k in FLOW}},
        "ttm": ttm,
        "balance": {k: latest.get(k) for k in ("totalAssets", "totalLiabilities", "totalEquity")},
        "perShare": {"epsAnnual": aps.get("eps"), "epsTtm": eps_ttm, "bps": bps},
        # DART가 최신 보고서 기준으로 공시한 지표. 분기·반기 보고서면 그 기간 누적 실적 기준이다.
        "reported": {"period": (interim or annual)["period"],
                     "annualized": False, **reported} if reported else {},
        "ratios": {
            "per": _ratio(price, eps_ttm, 2) if (eps_ttm or 0) > 0 else None,
            "pbr": _ratio(price, bps, 2),
            "operatingMargin": _ratio(ttm["operatingIncome"], ttm["revenue"]),
            "annualRevenueGrowth": _growth(a.get("revenue"), annual["previous"].get("revenue")),
            "annualOperatingIncomeGrowth": _growth(a.get("operatingIncome"),
                                                   annual["previous"].get("operatingIncome")),
        },
    }
    if non_operating and non_operating["current"]:
        period = interim or annual
        now, before = non_operating["current"], non_operating["previous"]

        def net(values, operating_income):
            if None in (values.get("pretaxIncome"), operating_income):
                return None
            return values["pretaxIncome"] - operating_income

        gain = net(now, period["current"].get("operatingIncome"))
        # 영업이익과 세전이익의 차이가 곧 영업외 손익의 합이다.
        result["nonOperating"] = {
            "period": period["period"], **now, "nonOperatingNet": gain,
            "samePeriodLastYear": {
                **before, "nonOperatingNet": net(before, period["previous"].get("operatingIncome"))},
        }
        pretax = now.get("pretaxIncome")
        result["ratios"]["nonOperatingShareOfPretaxIncome"] = (
            _ratio(gain, pretax) if (pretax or 0) > 0 else None)
    if cash_flow and cash_flow.get("current") is not None:
        period = interim or annual
        result["cashFlow"] = {
            "period": period["period"], "operatingCashFlow": cash_flow["current"],
            "netIncome": period["current"].get("netIncome"),  # 같은 누적 기간의 순이익
            "samePeriodLastYear": {"operatingCashFlow": cash_flow.get("previous"),
                                   "netIncome": period["previous"].get("netIncome")},
        }
    result["ratios"]["netIncomeToOperatingIncome"] = (
        _ratio(ttm["netIncome"], ttm["operatingIncome"], 2)
        if (ttm["operatingIncome"] or 0) > 0 else None)
    if interim:
        c, p = interim["current"], interim["previous"]
        result["interim"] = {"report": interim_name, "period": interim["period"],
                             **{k: c.get(k) for k in FLOW},
                             "samePeriodLastYear": {k: p.get(k) for k in FLOW}}
        result["ratios"]["interimRevenueGrowth"] = _growth(c.get("revenue"), p.get("revenue"))
        result["ratios"]["interimOperatingIncomeGrowth"] = _growth(c.get("operatingIncome"),
                                                                   p.get("operatingIncome"))
    return result


def _growth(current: float | None, previous: float | None) -> float | None:
    # 전기 실적이 0 이하면 증가율이 의미가 없다.
    if current is None or previous is None or previous <= 0:
        return None
    return round(current / previous - 1, 4)


def summarize_disclosures(rows: list[dict], limit: int = 15) -> dict:
    """공시 목록 → {"items": [{date, title, filer, rceptNo}], "insiderOwnershipReportCount"}.

    rceptNo는 접수번호 (공시 원문 주소를 만든다, disclosure_url). 응답에 없으면 None.
    """
    items = [{"date": f"{r['rcept_dt'][:4]}-{r['rcept_dt'][4:6]}-{r['rcept_dt'][6:]}",
              "title": r["report_nm"].strip(), "filer": r["flr_nm"],
              "rceptNo": (r.get("rcept_no") or "").strip() or None} for r in rows]
    insider = [i for i in items if i["title"] == INSIDER_REPORT]
    others = [i for i in items if i["title"] != INSIDER_REPORT]
    return {"items": others[:limit], "insiderOwnershipReportCount": len(insider)}


def summarize_filings(rows: list[dict]) -> list[dict]:
    """공시검색 응답 → 상장 종목의 공시 [{symbol, corpName, title, rceptNo, date}] (종목코드가 없는 회사는 뺀다)."""
    out = []
    for r in rows:
        symbol = (r.get("stock_code") or "").strip()
        if not symbol:
            continue
        day = (r.get("rcept_dt") or "").strip()
        out.append({"symbol": symbol, "corpName": (r.get("corp_name") or "").strip(),
                    "title": " ".join((r.get("report_nm") or "").split()),
                    "rceptNo": (r.get("rcept_no") or "").strip() or None,
                    "date": f"{day[:4]}-{day[4:6]}-{day[6:8]}" if len(day) == 8 else None})
    return out


def report_info(report: dict, statement: dict | None) -> dict:
    """보고서 조회 인자({bsns_year, reprt_code})와 주요계정 정리 결과 → {code, name, year, label, rceptNo, receivedAt}.

    label은 화면에 보이는 이름 ("2026 반기보고서", "2025 사업보고서").
    """
    code = report["reprt_code"]
    name = REPORT_NAMES.get(code, code)
    rcept_no = (statement or {}).get("rceptNo")
    return {"code": code, "name": name, "year": int(report["bsns_year"]), "label": f"{report['bsns_year']} {name}",
            "rceptNo": rcept_no, "receivedAt": received_date(rcept_no)}


class DartClient:
    def __init__(self, api_key: str, cache_dir: Path):
        self._api_key = api_key
        self._corp_cache = cache_dir / "dart_corp_codes.json"
        self._corp_codes = None
        self._jurir_cache = cache_dir / "dart_jurir_no.json"
        self._company_cache = cache_dir / "dart_company.json"

    def _get(self, path: str, params: dict) -> bytes:
        query = urllib.parse.urlencode({"crtfc_key": self._api_key, **params})
        with urllib.request.urlopen(f"{BASE_URL}/{path}?{query}", timeout=60) as res:
            return res.read()

    def _get_body(self, path: str, params: dict) -> dict:
        """응답 본문 전체 (목록과 쪽 정보). 자료 없음(013)은 빈 목록, 그 밖의 오류 상태는 DartError."""
        body = json.loads(self._get(path, params))
        if body["status"] == NO_DATA:
            return {**body, "list": [], "total_page": 0}
        if body["status"] != "000":
            raise DartError(f"{path}: {body['status']} {body['message']}")
        return body

    def _get_json(self, path: str, params: dict) -> list[dict]:
        return self._get_body(path, params)["list"]

    def corp_code(self, symbol: str) -> str | None:
        """종목코드로 DART 고유번호를 찾는다. 전체 목록을 받아 캐시한다."""
        if self._corp_codes is None:
            cache = self._corp_cache
            if cache.exists() and time.time() - cache.stat().st_mtime < CORP_CODE_TTL_SEC:
                self._corp_codes = json.loads(cache.read_text())
            else:
                archive = zipfile.ZipFile(io.BytesIO(self._get("corpCode.xml", {})))
                root = ET.fromstring(archive.read(archive.namelist()[0]))
                self._corp_codes = {
                    (c.findtext("stock_code") or "").strip(): c.findtext("corp_code")
                    for c in root.findall("list") if (c.findtext("stock_code") or "").strip()}
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(self._corp_codes))
        return self._corp_codes.get(symbol)

    def jurir_no(self, symbol: str) -> str | None:
        """종목코드로 법인등록번호를 찾는다 (기업개황). 바뀌지 않는 값이라 기한 없이 캐시한다."""
        corp_code = self.corp_code(symbol)
        if not corp_code:
            return None
        cache = self._jurir_cache
        known = json.loads(cache.read_text()) if cache.exists() else {}
        if corp_code not in known:
            body = json.loads(self._get("company.json", {"corp_code": corp_code}))
            if body["status"] != "000":
                raise DartError(f"company.json: {body['status']} {body['message']}")
            known[corp_code] = (body.get("jurir_no") or "").strip() or None
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(known))
        return known[corp_code]

    def industry_code(self, symbol: str) -> str | None:
        """종목코드로 회사 개황의 업종 코드(한국표준산업분류, induty_code)를 찾는다. 바뀌는 일이 드물어 기한 없이 캐시한다."""
        corp_code = self.corp_code(symbol)
        if not corp_code:
            return None
        cache = self._company_cache
        known = json.loads(cache.read_text()) if cache.exists() else {}
        if corp_code not in known:
            body = json.loads(self._get("company.json", {"corp_code": corp_code}))
            if body["status"] != "000":
                raise DartError(f"company.json: {body['status']} {body['message']}")
            known[corp_code] = {"indutyCode": (body.get("induty_code") or "").strip() or None}
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(known))
        return known[corp_code]["indutyCode"]

    def _statement(self, corp_code: str, year: int, report_code: str) -> dict | None:
        return parse_statement(self._get_json("fnlttSinglAcnt.json", {
            "corp_code": corp_code, "bsns_year": year, "reprt_code": report_code}))

    def _optional(self, path: str, params: dict) -> list[dict]:
        """보조 데이터 조회. 실패해도 나머지 재무 데이터는 쓸 수 있게 빈 목록을 돌려준다."""
        try:
            return self._get_json(path, params)
        except Exception:
            return []

    def _full_statement(self, report: dict, basis: str) -> list[dict]:
        return self._optional("fnlttSinglAcntAll.json", {
            **report, "fs_div": "CFS" if basis == "연결" else "OFS"})

    def fundamentals(self, symbol: str, price: float | None, today: date) -> dict | None:
        """상장사가 아니거나(ETF 등) 재무제표가 없으면 None.

        결과의 report는 최신 보고서(분기·반기가 있으면 그것, 없으면 사업보고서)의 이름·접수번호·접수일 (report_info).
        """
        corp_code = self.corp_code(symbol)
        if not corp_code:
            return None
        annual = annual_report = None
        for year in (today.year - 1, today.year - 2):
            annual = self._statement(corp_code, year, ANNUAL)
            if annual:
                annual_report = {"corp_code": corp_code, "bsns_year": year, "reprt_code": ANNUAL}
                break
        if not annual:
            return None
        interim = interim_name = interim_report = None
        for code, name in INTERIM:
            year = annual_report["bsns_year"] + 1
            interim = self._statement(corp_code, year, code)
            if interim:
                interim_name = name
                interim_report = {"corp_code": corp_code, "bsns_year": year, "reprt_code": code}
                break
        latest = interim_report or annual_report
        reported = {}
        for group, names in INDEX_GROUPS.items():
            reported |= parse_indexes(
                self._optional("fnlttSinglIndx.json", {**latest, "idx_cl_code": group}), names)
        annual_rows = self._full_statement(annual_report, annual["basis"])
        interim_rows = self._full_statement(interim_report, annual["basis"]) if interim else None
        latest_rows = interim_rows if interim else annual_rows
        result = build_fundamentals(
            annual, interim, interim_name, price,
            annual_per_share=parse_per_share(annual_rows),
            interim_per_share=parse_per_share(interim_rows) if interim else None,
            shares=parse_shares(self._optional("stockTotqySttus.json", latest)),
            reported=reported,
            non_operating=parse_non_operating(latest_rows),
            cash_flow=parse_cash_flow(latest_rows))
        result["report"] = report_info(latest, interim or annual)
        return result

    def disclosures(self, symbol: str, today: date, days: int = 30, limit: int = 15) -> dict | None:
        """최근 days일 공시 (최신순, 내부자 지분 보고 뺀 limit개 — summarize_disclosures). 고유번호가 없으면 None."""
        corp_code = self.corp_code(symbol)
        if not corp_code:
            return None
        rows = self._get_json("list.json", {
            "corp_code": corp_code, "bgn_de": f"{today - timedelta(days=days):%Y%m%d}",
            "end_de": f"{today:%Y%m%d}", "page_count": 100})
        return summarize_disclosures(rows, limit=limit)

    def periodic_filings(self, day: date) -> list[dict]:
        """그날(day) 접수된 정기공시(사업·반기·분기보고서, pblntf_ty=A) 전체를 마지막 쪽까지 (summarize_filings 형식).

        고유번호 없이 검색하므로 모든 회사가 대상이다 (공시검색은 이때 기간 3개월 제한 — 하루라 괜찮다).
        """
        rows, page = [], 1
        while True:
            body = self._get_body("list.json", {
                "bgn_de": f"{day:%Y%m%d}", "end_de": f"{day:%Y%m%d}", "pblntf_ty": PERIODIC,
                "page_no": page, "page_count": 100})
            rows += body["list"]
            if page >= int(body.get("total_page") or 0) or page >= MAX_PAGES:
                break
            page += 1
        return summarize_filings(rows)
