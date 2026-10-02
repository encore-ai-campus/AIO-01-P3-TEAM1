"""SEC EDGAR 재무·공시 수집. 미국 상장사만 해당한다.

매출, 이익, EPS, 자본 등은 회사가 SEC에 제출한 값(XBRL)을 그대로 쓴다.
SEC는 ROE 같은 비율을 제공하지 않으므로 비율은 제출된 값으로 구한다.
"""
import gzip
import json
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from .dart import _ratio, build_fundamentals

TICKER_TTL_SEC = 30 * 24 * 3600
ANNUAL_FORMS = ("10-K", "10-K/A")
# 회사마다 쓰는 태그가 달라 후보 중 가장 최근 연간 실적이 있는 태그를 고른다.
TAGS = {
    "revenue": ("RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues",
                "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"),
    "operatingIncome": ("OperatingIncomeLoss",),
    "netIncome": ("NetIncomeLoss",),
    "eps": ("EarningsPerShareBasic",),
    "pretaxIncome": (
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ),
    "incomeTax": ("IncomeTaxExpenseBenefit",),
    "totalAssets": ("Assets",),
    "totalLiabilities": ("Liabilities",),
    "totalEquity": ("StockholdersEquity",
                    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
}
FLOW = ("revenue", "operatingIncome", "netIncome", "eps", "pretaxIncome", "incomeTax")
BALANCE = ("totalAssets", "totalLiabilities", "totalEquity")
INTERIM_NAME = {"Q1": "1분기", "Q2": "반기", "Q3": "3분기"}
INSIDER_FORMS = ("3", "4", "5", "144", "3/A", "4/A", "5/A", "144/A")
FORM_NAME = {
    "10-K": "연간보고서", "10-Q": "분기보고서", "8-K": "수시공시", "6-K": "해외기업 수시공시",
    "20-F": "해외기업 연간보고서", "DEF 14A": "주주총회 소집 공고", "S-3": "증권 발행 신고",
}
MIN_PLAUSIBLE_PBR = 0.05
ITEM_8K = {
    "1.01": "중요 계약 체결", "2.01": "자산 취득·처분 완료", "2.02": "실적 발표",
    "2.05": "구조조정 비용", "5.02": "임원 선임·퇴임", "5.07": "주주총회 표결 결과",
    "7.01": "공정공시", "8.01": "기타 중요 사항",
}


def _day(text: str) -> date:
    return date.fromisoformat(text)


def _days(row: dict) -> int:
    return (_day(row["end"]) - _day(row["start"])).days


def _near(a: str, b: date, tolerance: int = 10) -> bool:
    return abs((_day(a) - b).days) <= tolerance


def _rows(facts: dict, tag: str) -> list[dict]:
    units = facts.get("us-gaap", {}).get(tag, {}).get("units", {})
    return [r for rows in units.values() for r in rows]


def pick_annual(rows: list[dict]) -> dict | None:
    """가장 최근 회계연도 전체(약 1년) 실적."""
    annual = [r for r in rows if r.get("form") in ANNUAL_FORMS and "start" in r
              and 350 <= _days(r) <= 380]
    return max(annual, key=lambda r: (r["end"], r["filed"]), default=None)


def pick_period(rows: list[dict], start: date, end: date) -> dict | None:
    """시작일과 종료일이 (며칠 오차 안에서) 일치하는 실적."""
    found = [r for r in rows if "start" in r and _near(r["start"], start) and _near(r["end"], end)]
    return max(found, key=lambda r: r["filed"], default=None)


def pick_ytd(rows: list[dict], annual_end: date) -> dict | None:
    """직전 회계연도 종료 다음 날부터 시작하는 누적 실적 중 가장 최근 것."""
    ytd = [r for r in rows if "start" in r and _near(r["start"], annual_end + timedelta(days=1))
           and _day(r["end"]) > annual_end and _days(r) < 350]
    return max(ytd, key=lambda r: (r["end"], r["filed"]), default=None)


def pick_latest(rows: list[dict]) -> dict | None:
    return max(rows, key=lambda r: (r["end"], r["filed"]), default=None)


def _best_rows(facts: dict, key: str) -> list[dict]:
    candidates = [_rows(facts, tag) for tag in TAGS[key]]
    if key in BALANCE:
        return max(candidates, key=lambda rows: (pick_latest(rows) or {}).get("end", ""))
    return max(candidates, key=lambda rows: (pick_annual(rows) or {}).get("end", ""))


def _year_before(d: date) -> date:
    return d - timedelta(days=364)  # 52주 회계연도에 맞춘다. 오차는 _near가 흡수한다.


def parse_facts(facts: dict, price: float | None) -> dict | None:
    """companyfacts 응답으로 재무 요약을 만든다. 미국 회계기준(us-gaap) 자료가 없으면 None."""
    rows = {key: _best_rows(facts, key) for key in TAGS}
    annual_rows = {k: pick_annual(rows[k]) for k in FLOW}
    base = annual_rows["netIncome"] or annual_rows["revenue"]
    if not base:
        return None
    start, end = _day(base["start"]), _day(base["end"])

    def value(row):
        return row["val"] if row else None

    def flows(period_start, period_end):
        return {k: value(pick_period(rows[k], period_start, period_end)) for k in FLOW}

    def balance(at: date):
        return {k: value(max((r for r in rows[k] if _near(r["end"], at, 5)),
                             key=lambda r: r["filed"], default=None)) for k in BALANCE}

    annual_now = flows(start, end)
    annual_before = flows(_year_before(start), _year_before(end))
    annual = {"basis": "연결", "period": f"{start} ~ {end}",
              "current": {**annual_now, **balance(end)}, "previous": annual_before}

    def extra(current, previous):
        keys = ("pretaxIncome", "incomeTax")
        return {"current": {k: current[k] for k in keys if current[k] is not None},
                "previous": {k: previous[k] for k in keys}}

    non_operating = extra(annual_now, annual_before)
    interim = interim_name = interim_eps = None
    ytd = pick_ytd(rows["netIncome"], end) or pick_ytd(rows["revenue"], end)
    if ytd:
        ytd_start, ytd_end = _day(ytd["start"]), _day(ytd["end"])
        now = flows(ytd_start, ytd_end)
        before = flows(_year_before(ytd_start), _year_before(ytd_end))
        interim = {"basis": "연결", "period": f"{ytd_start} ~ {ytd_end}",
                   "current": {**now, **balance(ytd_end)}, "previous": before}
        interim_name = INTERIM_NAME.get(ytd.get("fp"), "분기")
        interim_eps = {"eps": now["eps"], "epsPrevious": before["eps"]}
        non_operating = extra(now, before)

    shares_rows = [r for rows_ in facts.get("dei", {}).get("EntityCommonStockSharesOutstanding", {})
                   .get("units", {}).values() for r in rows_]
    result = build_fundamentals(
        annual, interim, interim_name, price,
        annual_per_share={"eps": annual_now["eps"]}, interim_per_share=interim_eps,
        shares=value(pick_latest(shares_rows)), source="SEC", currency="USD",
        non_operating=non_operating)
    # 주식 종류가 여러 개인 회사(버크셔 등)는 보고된 주식수가 일부 종류만이라 주당순자산이 맞지 않는다.
    if (result["ratios"]["pbr"] or 0) < MIN_PLAUSIBLE_PBR:
        result["perShare"]["bps"] = result["ratios"]["pbr"] = None
    # SEC는 비율을 제공하지 않는다. 제출된 값으로 구한 최근 12개월 기준 값이다.
    equity, liabilities = result["balance"]["totalEquity"], result["balance"]["totalLiabilities"]
    result["ratios"] |= {
        "roe": _ratio(result["ttm"]["netIncome"], equity) if (equity or 0) > 0 else None,
        "netMargin": _ratio(result["ttm"]["netIncome"], result["ttm"]["revenue"]),
        "debtRatio": _ratio(liabilities, equity) if (equity or 0) > 0 else None,
    }
    return result


def summarize_filings(recent: dict, today: date, days: int = 30, limit: int = 15) -> dict:
    since = f"{today - timedelta(days=days)}"
    items, insider = [], 0
    for filed, form, desc, codes in zip(recent["filingDate"], recent["form"],
                                        recent["primaryDocDescription"], recent["items"]):
        if filed < since:
            continue
        if form in INSIDER_FORMS:
            insider += 1
            continue
        topics = [ITEM_8K.get(c, c) for c in codes.split(",") if c]
        base = form.removesuffix("/A")
        title = FORM_NAME.get(base, desc or form) + (" (정정)" if form.endswith("/A") else "")
        items.append({"date": filed, "form": form, "title": title, "topics": topics})
    return {"items": items[:limit], "insiderFilingCount": insider}


class SecClient:
    def __init__(self, contact_email: str, cache_dir: Path):
        # SEC는 요청자를 식별할 수 있는 User-Agent를 요구한다.
        self._user_agent = f"paper_engine {contact_email}"
        self._ticker_cache = cache_dir / "sec_tickers.json"
        self._ciks = None

    def _get(self, url: str) -> dict:
        req = urllib.request.Request(url, headers={"User-Agent": self._user_agent,
                                                   "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return json.loads(raw)

    def cik(self, symbol: str) -> str | None:
        if self._ciks is None:
            cache = self._ticker_cache
            if cache.exists() and time.time() - cache.stat().st_mtime < TICKER_TTL_SEC:
                self._ciks = json.loads(cache.read_text())
            else:
                data = self._get("https://www.sec.gov/files/company_tickers.json")
                self._ciks = {c["ticker"]: f"{c['cik_str']:010d}" for c in data.values()}
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(self._ciks))
        # SEC는 BRK.B를 BRK-B로 적는다.
        return self._ciks.get(symbol.upper().replace(".", "-"))

    def fundamentals(self, symbol: str, price: float | None) -> dict | None:
        """SEC에 등록된 회사가 아니면(ETF 등) None."""
        cik = self.cik(symbol)
        if not cik:
            return None
        try:
            data = self._get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json")
        except urllib.error.HTTPError as e:
            if e.code == 404:  # ETF처럼 재무제표를 내지 않는 등록자
                return None
            raise
        return parse_facts(data["facts"], price)

    def disclosures(self, symbol: str, today: date) -> dict | None:
        cik = self.cik(symbol)
        if not cik:
            return None
        data = self._get(f"https://data.sec.gov/submissions/CIK{cik}.json")
        return summarize_filings(data["filings"]["recent"], today)
