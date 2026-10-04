"""자동 리포트의 선별 (reports/auto.py): 그날 파일, 점수 순 상위 N개, 증권사 키가 없으면 503. screen_market은 가짜다."""
import json
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from config import engine
from config.api import Unavailable
from reports import auto

KST = ZoneInfo("Asia/Seoul")
NOW = datetime(2026, 10, 5, 7, 50, tzinfo=KST)
PICKS = [{"symbol": "000660", "score": 50.0}, {"symbol": "005930", "score": 80.0},
         {"symbol": "035420", "score": 65.0}, {"symbol": "005380", "score": 70.0}]


@pytest.fixture
def screen(monkeypatch, tmp_path):
    calls = []
    cfg = object()

    def screen_market(config, market, candidates, **kw):
        calls.append((config, market, candidates))
        return {"market": market, "at": "2026-10-05T07:49:00+09:00", "rankedAt": None, "rankCount": 100,
                "eligibleCount": 70, "checked": candidates, "picks": [dict(p) for p in PICKS],
                "dropped": [{"symbol": "035720", "reason": "추세 아님"}], "excluded": [{"symbol": "069500", "reason": "ETF"}],
                "rules": "규칙"}

    monkeypatch.setattr(engine, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(engine, "engine_config", lambda: cfg)
    monkeypatch.setattr(engine, "broker_client", lambda: object())
    monkeypatch.setattr(auto, "screen_market", screen_market)
    return calls, cfg


def test_select_saves_top_picks_by_score(screen, tmp_path):
    calls, cfg = screen
    result = auto.select("KR", top=3, now=NOW)
    assert calls == [(cfg, "KR", auto.SCREEN_CANDIDATES)]
    assert [p["symbol"] for p in result["picks"]] == ["005930", "005380", "035420"]
    assert result["reportIds"] == [] and result["recommendationIds"] == []
    assert (result["rankCount"], result["eligibleCount"], result["checked"]) == (100, 70, auto.SCREEN_CANDIDATES)
    assert result["at"].startswith("2026-10-05T07:50:00")
    path = tmp_path / "runs" / "screening" / "2026-10-05-KR.json"
    assert json.loads(path.read_text(encoding="utf-8")) == result
    assert auto.load("KR", date(2026, 10, 5)) == result


def test_file_date_is_kst(screen, tmp_path):
    auto.select("KR", top=1, now=datetime(2026, 10, 4, 23, 30, tzinfo=ZoneInfo("UTC")))  # KST 10/5 08:30
    assert (tmp_path / "runs" / "screening" / "2026-10-05-KR.json").exists()


def test_save_updates_ids(screen):
    result = auto.select("KR", top=2, now=NOW)
    result["reportIds"] = [7]
    auto.save(result)
    assert auto.load("KR", date(2026, 10, 5))["reportIds"] == [7]


def test_load_missing_or_broken(screen, tmp_path):
    assert auto.load("KR", date(2026, 10, 5)) is None
    folder = tmp_path / "runs" / "screening"
    folder.mkdir(parents=True)
    (folder / "2026-10-05-KR.json").write_text("{", encoding="utf-8")
    assert auto.load("KR", date(2026, 10, 5)) is None


def test_select_without_broker_is_unavailable(screen, monkeypatch):
    calls, _ = screen
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    with pytest.raises(Unavailable):
        auto.select("KR", now=NOW)
    assert calls == []


# --- GET /api/reports/screening (T1-7) ---

@pytest.fixture
def screening_api(monkeypatch, tmp_path, django_user_model):
    from rest_framework.test import APIClient

    monkeypatch.setattr(engine, "RUNS_DIR", tmp_path / "runs")
    client = APIClient()
    client.force_authenticate(django_user_model.objects.create_user("alice", password="pw"))
    return client


def test_screening_api_reads_saved_file(screening_api):
    auto.save({"market": "KR", "at": "2026-10-05T07:50:00+09:00", "rankCount": 100, "eligibleCount": 70, "checked": 30,
               "picks": [{"symbol": "005930", "score": 80.0}], "dropped": [], "excluded": [], "reportIds": [],
               "recommendationIds": [7]})
    response = screening_api.get("/api/reports/screening?market=KR&date=2026-10-05")
    assert response.status_code == 200
    assert response.json()["picks"][0]["symbol"] == "005930" and response.json()["recommendationIds"] == [7]


def test_screening_api_404_and_bad_input(screening_api):
    assert screening_api.get("/api/reports/screening?date=2026-10-05").status_code == 404
    assert screening_api.get("/api/reports/screening?market=JP").status_code == 400
    assert screening_api.get("/api/reports/screening?date=10/05").status_code == 400


def test_screening_api_needs_login(db):
    from rest_framework.test import APIClient

    assert APIClient().get("/api/reports/screening").status_code == 401
