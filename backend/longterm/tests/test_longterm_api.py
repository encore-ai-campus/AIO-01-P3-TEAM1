"""장기투자 API: 오늘의 내 종목 뉴스 목록·상세, 종목 펀더멘털 (docs/API.md "장기투자" 엔드포인트), 설정, OpenAPI 문서."""
from datetime import date, time

import pytest
from rest_framework.test import APIClient

from longterm import conf
from longterm.models import InvestmentThesis, ThesisCheck

from .conftest import FRIDAY, client_for, fund, hold, kst, make_note

pytestmark = pytest.mark.django_db
THURSDAY = date(2026, 10, 1)
DAILY_MOVE_KEYS = {"symbol", "name", "market", "date", "asOf", "close", "prevClose", "changeRate", "marketProxy",
                   "excessChangeRate", "sectorChangeRate", "volatility20", "flows", "headline", "summary", "drivers",
                   "uncertain", "method", "evidence", "missing", "createdAt"}


@pytest.fixture
def moves(alice, bob):
    """alice: 삼성전자·에코프로비엠·애플 보유, SK하이닉스는 체결 대기. 기록: 목요일 셋, 금요일 둘."""
    hold(alice, "005930", "삼성전자")
    hold(alice, "247540", "에코프로비엠")
    hold(alice, "AAPL", "Apple", market="US")
    hold(alice, "000660", "SK하이닉스", status="ENTRY_PENDING")
    hold(bob, "000660", "SK하이닉스")
    make_note("005930", "삼성전자", THURSDAY)
    make_note("247540", "에코프로비엠", THURSDAY, proxy_symbol="229200", proxy_name="KODEX 코스닥150")
    make_note("000660", "SK하이닉스", THURSDAY)
    make_note("005930", "삼성전자", FRIDAY, change_rate=0.01)
    make_note("000660", "SK하이닉스", FRIDAY)


def test_daily_moves_default_to_my_latest_day(moves, alice):
    body = client_for(alice).get("/api/longterm/daily-moves").json()
    assert body["date"] == "2026-10-02" and [m["symbol"] for m in body["results"]] == ["005930"]
    move = body["results"][0]
    assert set(move) == DAILY_MOVE_KEYS
    assert move["asOf"] == "2026-10-02T15:30:00+09:00" and move["changeRate"] == 0.01
    assert move["marketProxy"] == {"symbol": "069500", "name": "KODEX 200", "changeRate": 0.005}
    assert move["sectorChangeRate"] is None and move["market"] == "KR"


def test_daily_moves_for_a_date_sorted_by_name(moves, alice):
    body = client_for(alice).get("/api/longterm/daily-moves?date=2026-10-01").json()
    assert body["date"] == "2026-10-01"
    assert [m["name"] for m in body["results"]] == ["삼성전자", "에코프로비엠"]  # 체결 대기·다른 사람 종목은 빠진다
    assert client_for(alice).get("/api/longterm/daily-moves?date=2026-09-01").json() == {"date": "2026-09-01",
                                                                                      "results": []}


@pytest.mark.parametrize("value", ["2026-13-01", "20261002", "어제", "2026-1-2"])
def test_daily_moves_reject_bad_dates(moves, alice, value):
    response = client_for(alice).get(f"/api/longterm/daily-moves?date={value}")
    assert response.status_code == 400 and set(response.json()) == {"detail"}
    assert client_for(alice).get(f"/api/longterm/daily-moves/005930?date={value}").status_code == 400


def test_daily_moves_without_holdings(moves, django_user_model):
    carol = django_user_model.objects.create_user("carol", password="pw-carol-1234")
    assert client_for(carol).get("/api/longterm/daily-moves").json() == {"date": None, "results": []}


def test_daily_move_detail_is_shared_by_the_team(moves, alice):
    api = client_for(alice)
    latest = api.get("/api/longterm/daily-moves/000660").json()  # 보유하지 않아도 팀 공용 기록
    assert latest["date"] == "2026-10-02" and set(latest) == DAILY_MOVE_KEYS
    assert api.get("/api/longterm/daily-moves/000660?date=2026-10-01").json()["date"] == "2026-10-01"
    assert api.get("/api/longterm/daily-moves/247540?date=2026-10-02").status_code == 404
    assert api.get("/api/longterm/daily-moves/999999").status_code == 404


def test_endpoints_need_login():
    api = APIClient()
    for path in ("/api/longterm/daily-moves", "/api/longterm/daily-moves/005930", "/api/stocks/005930/fundamentals"):
        assert api.get(path).status_code == 401


# --- 종목 펀더멘털 ---

ROW_KEYS = {"key", "label", "axis", "value", "unit", "baseline", "change", "status", "note"}


def test_fundamentals_view_for_a_company(fake, dart, alice):
    body = client_for(alice).get("/api/stocks/005930/fundamentals").json()
    assert body["applicable"] is True and body["reason"] is None and body["overall"] == "solid"
    assert len(body["rows"]) == 9 and all(set(r) == ROW_KEYS for r in body["rows"])
    assert all(r["baseline"] is None and r["change"] is None for r in body["rows"])
    assert body["asOf"] == {"period": "2026 반기보고서", "receivedAt": "2026-08-14"}
    assert body["source"] == "금융감독원 OpenDART"
    assert body["caption"] == "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"
    assert body["thesis"] is None and body["name"] == "삼성전자" and body["market"] == "KR"


def test_fundamentals_view_includes_my_thesis(fake, dart, alice, bob):
    thesis = InvestmentThesis.objects.create(user=alice, symbol="005930", name="삼성전자", market="KR",
                                             reasons=["a"], baseline={"operatingMargin": 0.2})
    ThesisCheck.objects.create(thesis=thesis, checked_at=kst(FRIDAY, 18), trigger="filing", overall="review",
                               rows=[], new_bad=["operatingMargin"])
    mine = client_for(alice).get("/api/stocks/005930/fundamentals").json()["thesis"]
    assert mine["reasons"] == ["a"] and mine["lastCheck"]["overall"] == "review" and mine["active"] is False
    assert client_for(bob).get("/api/stocks/005930/fundamentals").json()["thesis"] is None


@pytest.mark.parametrize("symbol, reason", [
    ("069500", "ETF·ETN은 일반 기업용 점검을 적용하지 않아요"),
    ("105560", "금융업은 일반 기업용 점검을 적용하지 않아요"),
    ("AAPL", "미국 종목은 국내 일반 기업용 점검을 적용하지 않아요"),
])
def test_fundamentals_not_applicable(fake, dart, alice, symbol, reason):
    body = client_for(alice).get(f"/api/stocks/{symbol}/fundamentals").json()
    assert body["applicable"] is False and body["reason"] == reason
    assert body["rows"] == [] and body["overall"] == "na" and body["asOf"] is None
    assert body["caption"] == "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"


def test_fundamentals_without_dart_key_is_still_200(fake, alice):
    response = client_for(alice).get("/api/stocks/005930/fundamentals")
    body = response.json()
    assert response.status_code == 200 and body["applicable"] is True
    assert body["reason"] == "DART 키가 없어 공시 자료를 받지 못했어요"
    assert len(body["rows"]) == 9 and all(r["value"] is None and r["status"] == "na" for r in body["rows"])
    assert body["overall"] == "na" and body["asOf"] is None


def test_fundamentals_dart_failure_and_no_statements(fake, dart, alice):
    dart.fail = True
    assert client_for(alice).get("/api/stocks/005930/fundamentals").json()["reason"] == "공시 자료를 받지 못했어요"
    dart.fail = False
    dart.funds["000660"] = None
    assert client_for(alice).get("/api/stocks/000660/fundamentals").json()["reason"] == "공시 재무 자료가 없어요"


def test_fundamentals_are_cached_per_symbol_for_the_day(fake, dart, alice):
    api = client_for(alice)
    api.get("/api/stocks/005930/fundamentals")
    dart.funds["005930"] = fund(**{"ratios.operatingMargin": -0.5})
    body = api.get("/api/stocks/005930/fundamentals").json()
    assert dart.calls.count("fundamentals:005930") == 1 and body["overall"] == "solid"


def test_fundamentals_unknown_symbol(fake, alice):
    assert client_for(alice).get("/api/stocks/999999/fundamentals").status_code == 404


def test_fundamentals_route_does_not_shadow_stock_detail(fake, dart, alice):
    # trading의 stocks/<symbol>은 그대로 trading이 받는다 (여기서는 우리 경로가 따로 잡히는지만 본다)
    from django.urls import resolve
    assert resolve("/api/stocks/005930/fundamentals").func.view_class.__name__ == "FundamentalsView"
    assert resolve("/api/stocks/005930").func.view_class.__name__ == "StockDetailView"


# --- 설정 ---

def test_conf_defaults_and_parsing(monkeypatch):
    monkeypatch.delenv("LONGTERM_JOBS")  # 루트 conftest.py가 off로 둔 것을 지우면 기본값 on
    assert conf.jobs_enabled() is True
    assert conf.daily_move_at() == time(16, 30) and conf.thesis_check_at() == time(18, 0)
    assert conf.daily_move_model() is None  # DAILY_MOVE_MODEL·APPROVER 둘 다 없음 → 템플릿만
    monkeypatch.setenv("LONGTERM_JOBS", "off")
    monkeypatch.setenv("DAILY_MOVE_AT", "17:05")
    monkeypatch.setenv("THESIS_CHECK_AT", "25:00")  # 잘못된 값 → 기본값
    monkeypatch.setenv("DAILY_MOVE_MODEL", "fast-model")
    assert conf.jobs_enabled() is False and conf.daily_move_at() == time(17, 5)
    assert conf.thesis_check_at() == time(18, 0) and conf.daily_move_model() == "fast-model"


def test_conf_model_falls_back_to_approver(llm):
    assert conf.daily_move_model() == "approver-model"


def test_schema_lists_longterm_paths(alice):
    response = client_for(alice).get("/api/schema/", HTTP_ACCEPT="application/vnd.oai.openapi+json")
    assert response.status_code == 200
    text = response.content.decode()
    for path in ("/api/longterm/daily-moves", "/api/longterm/daily-moves/{symbol}", "/api/longterm/theses",
                 "/api/longterm/theses/{symbol}", "/api/stocks/{symbol}/fundamentals"):
        assert path in text
