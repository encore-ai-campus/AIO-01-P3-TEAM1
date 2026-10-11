"""매일 자동 추천 (시연, autotrade/recommend/auto.py): 켜기·시각·휴장일·하루 한 번·종목마다 시연 추천·선별 파일 기록.

선별(screen_market)과 장 달력은 가짜다. 실제 증권사를 부르지 않는다.
"""
import json
from datetime import datetime, timedelta
from io import StringIO

import pytest
from django.core.management import CommandError, call_command
from reports.autoreport import auto as screening
from trading import market

from autotrade.recommend import auto
from autotrade.models import Recommendation
from config import engine

from .conftest import KST

pytestmark = pytest.mark.django_db

NOW = datetime(2026, 10, 5, 9, 0, tzinfo=KST)  # 월요일 09:00
PICKS = [{"symbol": "000660", "name": "SK하이닉스", "score": 50.0},
         {"symbol": "005930", "name": "삼성전자", "score": 80.0},
         {"symbol": "999999", "name": "없는종목", "score": 60.0},
         {"symbol": "005935", "name": "삼성전자우", "score": 10.0}]


@pytest.fixture
def screen(monkeypatch, tmp_path, fake):
    """가짜 선별·실행 기록 폴더·장 달력(NOW 앞뒤 날짜에 정규장). calls에 선별 호출, holiday=True면 그날 정규장이 없다."""
    monkeypatch.setattr(engine, "RUNS_DIR", tmp_path / "runs")
    state = {"calls": [], "holiday": False, "fail": False}

    def screen_market(cfg, market_, candidates, **kw):
        state["calls"].append((market_, candidates))
        if state["fail"]:
            raise OSError("순위 조회 실패")
        return {"market": market_, "at": "2026-10-05T08:00:00+09:00", "rankedAt": None, "rankCount": 100,
                "eligibleCount": 80, "checked": candidates, "picks": [dict(p) for p in PICKS],
                "dropped": [{"symbol": "035720", "name": "카카오게임즈", "reason": "추세 아님"}], "excluded": []}

    def sessions(market_):  # 전일·당일·익일 정규장 (holiday면 NOW 날짜만 뺀다)
        days = [NOW.date() + timedelta(days=d) for d in (-1, 0, 1, 2)]
        starts = [datetime.combine(d, datetime.min.time(), KST).replace(hour=9) for d in days
                  if not (state["holiday"] and d == NOW.date())]
        return [(s, s + timedelta(hours=6, minutes=30)) for s in starts]

    monkeypatch.setattr(screening, "screen_market", screen_market)
    monkeypatch.setattr(market, "sessions", sessions)
    for key, value in {"AUTO_RECOMMEND": "demo", "AUTO_RECOMMEND_TOP": "3", "AUTO_RECOMMEND_AT": "08:00"}.items():
        monkeypatch.setenv(key, value)
    return state


class Log(list):
    def __call__(self, text):
        self.append(text)


def screening_file(tmp_path) -> dict:
    return json.loads((tmp_path / "runs" / "screening" / "2026-10-05-KR.json").read_text(encoding="utf-8"))


def test_off_does_nothing(screen, monkeypatch):
    monkeypatch.setenv("AUTO_RECOMMEND", "off")
    assert auto.tick(NOW, Log()) == 0
    assert screen["calls"] == [] and not Recommendation.objects.exists()


def test_not_before_configured_time(screen, monkeypatch):
    monkeypatch.setenv("AUTO_RECOMMEND_AT", "09:30")
    assert auto.tick(NOW, Log()) == 0
    assert screen["calls"] == []
    assert auto.tick(NOW.replace(hour=9, minute=30), Log()) == 2


def test_not_on_holiday(screen):
    screen["holiday"] = True
    assert auto.tick(NOW, Log()) == 0
    assert screen["calls"] == [] and not Recommendation.objects.exists()


def test_demo_recommendation_per_pick_and_ids_saved(screen, sent, tmp_path):
    log = Log()
    assert auto.tick(NOW, log) == 2
    assert screen["calls"] == [("KR", screening.SCREEN_CANDIDATES)]
    recs = list(Recommendation.objects.order_by("id"))
    assert [(r.symbol, r.source, r.requested_by) for r in recs] == [("005930", "demo", None), ("000660", "demo", None)]
    assert all(r.created_at == NOW for r in recs)
    data = screening_file(tmp_path)
    assert [p["symbol"] for p in data["picks"]] == ["005930", "999999", "000660"]  # 점수 순 상위 3
    assert data["recommendationIds"] == [r.id for r in recs] and data["reportIds"] == []
    assert sent.kinds == ["recommendation", "recommendation"] and all(c["users"] is None for c in sent.calls)  # 팀 전체
    assert any("없는종목(999999)" in line and "만들지 못함" in line for line in log)  # 한 종목 실패는 로그만


def test_runs_once_a_day(screen):
    assert auto.tick(NOW, Log()) == 2
    assert auto.tick(NOW + timedelta(hours=1), Log()) == 0
    assert len(screen["calls"]) == 1 and Recommendation.objects.count() == 2
    assert auto.tick(NOW + timedelta(days=1), Log()) == 2  # 다음 날은 다시
    assert len(screen["calls"]) == 2


def test_failed_screening_is_not_retried_same_day(screen, tmp_path):
    screen["fail"] = True
    log = Log()
    assert auto.tick(NOW, log) == 0
    assert any("선별 실패" in line and "순위 조회 실패" in line for line in log)
    marker = json.loads((tmp_path / "runs" / "autotrade" / "recommend-2026-10-05-KR.json").read_text(encoding="utf-8"))
    assert marker["status"] == "failed"
    screen["fail"] = False
    assert auto.tick(NOW + timedelta(minutes=5), Log()) == 0
    assert len(screen["calls"]) == 1


def test_uses_existing_screening_file(screen, tmp_path):
    screening.select("KR", 2, NOW)  # 자동 리포트가 먼저 선별했다
    assert auto.tick(NOW, Log()) == 1  # 파일의 상위 2개(005930, 999999) 중 하나
    assert len(screen["calls"]) == 1
    assert screening_file(tmp_path)["recommendationIds"] == [Recommendation.objects.get().id]


def test_command_respects_conditions_unless_forced(screen, monkeypatch):
    monkeypatch.setattr("trading.service.now", lambda: NOW.replace(hour=7))
    with pytest.raises(CommandError, match="08:00"):
        call_command("auto_recommend", stdout=StringIO())
    out = StringIO()
    call_command("auto_recommend", "--force", "--top", "1", stdout=out)
    assert "시연 추천 1개" in out.getvalue()
    assert Recommendation.objects.get().symbol == "005930"


def test_command_needs_broker(screen, monkeypatch):
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    with pytest.raises(CommandError, match="증권사"):
        call_command("auto_recommend", "--force", stdout=StringIO())
