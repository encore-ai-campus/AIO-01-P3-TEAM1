"""공공데이터포털(data.go.kr) 금융위원회_기업 재무정보. 국내 종목만 해당한다.

연간 요약재무제표만 있고 분기 자료는 없다. DART 재무를 대신하지 않고 여러 해의 실적 추이를 더한다.
DART 재무 조회가 실패했을 때만 최근 연간 실적으로 fundamentals를 대신 채운다.
조회 키는 법인등록번호(crno)라서 DART 기업개황에서 얻는다.
"""
import json
import urllib.parse
import urllib.request

from .dart import _amount, build_fundamentals

BASE_URL = "https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2"
SOURCE = "data.go.kr"
HISTORY_YEARS = 5
FIELDS = {
    "enpSaleAmt": "revenue", "enpBzopPft": "operatingIncome", "enpCrtmNpf": "netIncome",
    "enpTastAmt": "totalAssets", "enpTdbtAmt": "totalLiabilities", "enpTcptAmt": "totalEquity",
}
BASIS = {"110": "연결", "120": "별도"}  # 연결이 있으면 연결을 쓴다


class FinaStatError(Exception):
    pass


def parse_history(items: list[dict], years: int = HISTORY_YEARS) -> dict | None:
    """요약재무제표를 연도별로 정리한다 (최신 연도 먼저). 연도마다 연결이 있으면 연결, 없으면 별도."""
    by_year = {}
    for code in BASIS:
        for item in items:
            year = item.get("bizYear")
            if item.get("fnclDcd") == code and year and year not in by_year:
                by_year[year] = item
    if not by_year:
        return None
    rows = []
    for year in sorted(by_year, reverse=True)[:years]:
        item = by_year[year]
        try:
            debt_ratio = round(float(item["fnclDebtRto"]) / 100, 4)
        except (TypeError, ValueError, KeyError):
            debt_ratio = None
        rows.append({"year": int(year), "basis": BASIS[item["fnclDcd"]],
                     **{key: _amount(item.get(field)) for field, key in FIELDS.items()},
                     "debtRatio": debt_ratio})
    currency = by_year[max(by_year)].get("curCd") or "KRW"
    return {"source": SOURCE, "currency": currency, "years": rows}


def history_fundamentals(history: dict | None, price: float | None = None) -> dict | None:
    """DART 재무가 없을 때 쓸 fundamentals. 최근 연간 실적만 있어 주당 값과 PER·PBR은 없다."""
    if not history or not history["years"]:
        return None
    latest = history["years"][0]
    before = history["years"][1] if len(history["years"]) > 1 else {}
    if before.get("year") != latest["year"] - 1:
        before = {}
    keys = list(FIELDS.values())
    annual = {"basis": latest["basis"], "period": f"{latest['year']}.01.01 ~ {latest['year']}.12.31",
              "current": {k: latest.get(k) for k in keys},
              "previous": {k: before.get(k) for k in keys}}
    result = build_fundamentals(annual, None, None, price, source=SOURCE,
                                currency=history["currency"])
    result["annualHistory"] = history
    return result


class FinaStatClient:
    def __init__(self, api_key: str):
        # 포털은 인코딩된 키와 디코딩된 키를 같이 준다. 어느 쪽이든 디코딩해 두고 요청할 때 한 번만 인코딩한다.
        self._api_key = urllib.parse.unquote(api_key)

    def _items(self, operation: str, params: dict) -> list[dict]:
        query = urllib.parse.urlencode({"serviceKey": self._api_key, "resultType": "json",
                                        "pageNo": 1, **params})
        with urllib.request.urlopen(f"{BASE_URL}/{operation}?{query}", timeout=30) as res:
            body = json.loads(res.read())["response"]
        if body["header"]["resultCode"] != "00":
            raise FinaStatError(f"{operation}: {body['header']['resultCode']} "
                                f"{body['header']['resultMsg']}")
        items = (body["body"].get("items") or {}).get("item") or []
        return items if isinstance(items, list) else [items]

    def annual_history(self, crno: str, years: int = HISTORY_YEARS) -> dict | None:
        """법인등록번호로 최근 몇 해의 연간 요약재무를 가져온다. 자료가 없으면 None."""
        # 연도를 빼면 전체 연도가 온다 (연도마다 연결·별도 두 행).
        return parse_history(self._items("getSummFinaStat_V2", {"crno": crno, "numOfRows": 100}),
                             years)
