from paper_engine.data import snapshot as snap_mod
from paper_engine.data.fina_stat import FinaStatClient, history_fundamentals, parse_history

from test_pipeline import SnapshotClient


def item(year, code, revenue, op, net, debt="50.0"):
    return {"bizYear": str(year), "basDt": f"{year}1231", "fnclDcd": code, "curCd": "KRW",
            "enpSaleAmt": str(revenue), "enpBzopPft": str(op), "enpCrtmNpf": str(net),
            "enpTastAmt": "300", "enpTdbtAmt": "100", "enpTcptAmt": "200", "fnclDebtRto": debt}


ITEMS = [
    item(2023, "110", 160, 20, 10), item(2023, "120", 1, 1, 1),
    item(2025, "120", 999, 999, 999),  # 연결이 있는 해는 별도를 쓰지 않는다
    item(2025, "110", 220, 30, 25, debt="27.9318978119"),
    item(2024, "120", 200, 25, 15, debt=""),  # 연결이 없는 해는 별도
]


def test_history_newest_first_prefers_consolidated():
    h = parse_history(ITEMS)
    assert h["source"] == "data.go.kr" and h["currency"] == "KRW"
    assert [(y["year"], y["basis"]) for y in h["years"]] == [(2025, "연결"), (2024, "별도"), (2023, "연결")]
    assert h["years"][0] == {"year": 2025, "basis": "연결", "revenue": 220, "operatingIncome": 30,
                             "netIncome": 25, "totalAssets": 300, "totalLiabilities": 100,
                             "totalEquity": 200, "debtRatio": 0.2793}
    assert h["years"][1]["debtRatio"] is None
    assert [y["year"] for y in parse_history(ITEMS, years=2)["years"]] == [2025, 2024]
    assert parse_history([]) is None


def test_history_fundamentals_uses_latest_two_years():
    f = history_fundamentals(parse_history(ITEMS), price=100)
    assert f["source"] == "data.go.kr" and f["annual"]["period"] == "2025.01.01 ~ 2025.12.31"
    assert f["ttm"] == {"revenue": 220, "operatingIncome": 30, "netIncome": 25}
    assert f["ratios"]["annualRevenueGrowth"] == 0.1  # 220 / 200 - 1
    assert f["ratios"]["per"] is None and f["perShare"]["epsTtm"] is None  # 주당 값이 없다
    assert f["annualHistory"]["years"][0]["year"] == 2025
    # 바로 전 해 자료가 없으면 성장률을 구하지 않는다
    gap = history_fundamentals(parse_history([item(2025, "110", 220, 30, 25), item(2022, "110", 1, 1, 1)]))
    assert gap["ratios"]["annualRevenueGrowth"] is None
    assert history_fundamentals(None) is None


def test_client_decodes_encoded_key():
    assert FinaStatClient("ab%2Bc%3D%3D")._api_key == "ab+c=="
    assert FinaStatClient("ab+c==")._api_key == "ab+c=="


class Dart:
    def __init__(self, fail=False):
        self.fail = fail

    def fundamentals(self, symbol, price, today):
        if self.fail:
            raise OSError("DART down")
        return {"source": "DART"}

    def disclosures(self, symbol, today):
        return None

    def jurir_no(self, symbol):
        return "1301110006246"


class Fina:
    def annual_history(self, crno):
        assert crno == "1301110006246"
        return parse_history(ITEMS)


KR = {"symbol": "005930", "name": "삼성전자", "market": "KOSPI", "currency": "KRW", "securityType": "STOCK"}


def test_snapshot_adds_history_and_falls_back_when_dart_fails(monkeypatch):
    monkeypatch.setattr(snap_mod, "fetch_news", lambda *a: [])
    monkeypatch.setattr(snap_mod, "stock_reports", lambda *a: [])
    got = snap_mod.build_snapshot(SnapshotClient(KR), "005930", Dart(), None, Fina())
    assert got["fundamentals"]["source"] == "DART"
    assert [y["year"] for y in got["fundamentals"]["annualHistory"]["years"]] == [2025, 2024, 2023]

    got = snap_mod.build_snapshot(SnapshotClient(KR), "005930", Dart(fail=True), None, Fina())
    assert "DART down" in got["fundamentalsError"]
    assert got["fundamentals"]["source"] == "data.go.kr"

    class Broken(Fina):
        def annual_history(self, crno):
            raise OSError("portal down")
    got = snap_mod.build_snapshot(SnapshotClient(KR), "005930", Dart(), None, Broken())
    assert got["fundamentals"] == {"source": "DART"} and "portal down" in got["annualHistoryError"]
