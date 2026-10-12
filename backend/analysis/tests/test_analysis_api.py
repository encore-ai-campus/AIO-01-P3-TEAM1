from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from analysis import quota
from analysis.models import Job

from .conftest import candidate, entry, error_entry, run_log, write_run

pytestmark = pytest.mark.django_db


def make_job(user, symbol="005930", status=Job.QUEUED, created_at=None):
    return Job.objects.create(user=user, payload={"symbol": symbol}, status=status,
                              created_at=created_at or timezone.now())


# --- 로그인 ---

@pytest.mark.parametrize("path", ["/api/analyses", "/api/analyses/1", "/api/analyses/quota", "/api/jobs/1"])
def test_login_required(client, path):
    response = client.get(path)
    assert response.status_code == 401 and response.json() == {"detail": "로그인이 필요합니다."}
    assert client.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").status_code == 401


# --- 목록 ---

def test_list_indexes_new_runs_and_filters(api, runs):
    write_run(runs, "20261001-090000.json", run_log(entry(candidates=[candidate()]),
                                                     started="2026-10-01T09:00:00+09:00"))
    write_run(runs, "20261002-090000.json", run_log(entry(candidates=[candidate(score=40.0)]), error_entry(),
                                                     started="2026-10-02T09:00:00+09:00"))
    body = api.get("/api/analyses").json()
    assert body["count"] == 3
    assert [(r["symbol"], r["analyzedAt"]) for r in body["results"]] == [  # 최신순 (같은 시각이면 나중에 색인한 것)
        ("000660", "2026-10-02T09:00:00+09:00"), ("005930", "2026-10-02T09:00:00+09:00"),
        ("005930", "2026-10-01T09:00:00+09:00")]
    first = body["results"][2]
    assert set(first) == {"id", "symbol", "name", "market", "currency", "analyzedAt", "verdict", "priceAtAnalysis",
                          "best", "scenarioCount", "requestedBy", "costUsd"}
    assert (first["verdict"], first["priceAtAnalysis"], first["scenarioCount"], first["requestedBy"],
            first["costUsd"], first["best"]["score"]) == ("BUY", 100_000, 1, "alice", 0.31, 72.0)

    assert [r["verdict"] for r in api.get("/api/analyses?verdict=buy").json()["results"]] == ["BUY"]
    assert api.get("/api/analyses?symbol=005930&verdict=PASS").json()["count"] == 1
    assert api.get("/api/analyses?symbol=035420").json() == {"count": 0, "results": []}
    assert api.get("/api/analyses?verdict=MAYBE").status_code == 400

    page = api.get("/api/analyses?limit=1&offset=1").json()
    assert page["count"] == 3 and [r["symbol"] for r in page["results"]] == ["005930"]

    write_run(runs, "20261002-100000.json", run_log(entry(symbol="035420", name="NAVER"),
                                                     started="2026-10-02T10:00:00+09:00"))
    assert api.get("/api/analyses").json()["results"][0]["symbol"] == "035420"  # 새 기록은 다음 목록 요청에 보인다


# --- 상세 ---

def test_detail_reads_run_file(api, runs):
    write_run(runs, "a.json", run_log(entry(candidates=[candidate("S1", score=40.0), candidate("S2", "claude")]),
                                       error_entry()))
    results = api.get("/api/analyses?symbol=005930").json()["results"]
    detail = api.get(f"/api/analyses/{results[0]['id']}").json()
    assert {k: detail[k] for k in results[0]} == results[0]
    assert [(s["proposer"], s["selected"]) for s in detail["scenarios"]] == [("gpt", False), ("claude", True)]
    assert detail["best"]["proposer"] == "claude"
    assert detail["news"] == ["수주 공시", "실적 전망"]
    assert detail["newsItems"] == [{"title": "수주 공시", "source": None, "publishedAt": None},  # 링크는 내지 않는다
                                   {"title": "실적 전망", "source": None, "publishedAt": None}]
    assert detail["newsProvider"] == "Google 뉴스 검색 결과" and detail["dataAsOf"] is None
    assert detail["research"] == [{"researcher": "gpt-research", "findings": [
        {"claim": "수주 공시", "direction": "POSITIVE", "date": "2026-09-28", "sourceTitle": "출처"}]}]
    assert detail["indicators"] == {"rsi14": 55.0, "sma20": 98_000.5, "change5d": None}
    assert detail["errors"] == ["검증 누락: S7"]

    hynix = api.get("/api/analyses?symbol=000660").json()["results"][0]
    detail = api.get(f"/api/analyses/{hynix['id']}").json()
    assert detail["errors"] == ["모델 응답 에러: gpt 시간 초과"] and detail["scenarios"] == []


def test_detail_news_items_and_data_as_of(api, runs):
    """U12 약관 대응: 뉴스 제목 + 매체 + 게시 시각(한국 시간 ISO)과 출처 표기. 지표 기준일은 스냅숏의 lastCandleDate."""
    e = entry(candidates=[candidate()])
    e["snapshot"]["news"] = [
        {"title": "수주 공시", "source": "연합뉴스", "publishedAt": "2026-10-01T23:30:00+00:00",
         "url": "https://example.com/1"},
        {"title": "", "source": "제목 없음"}, "문자열",
        {"title": "실적 전망", "source": "", "publishedAt": "시각 아님"}]
    e["snapshot"]["lastCandleDate"] = "2026-10-01"
    write_run(runs, "a.json", run_log(e))
    detail = api.get(f"/api/analyses/{api.get('/api/analyses').json()['results'][0]['id']}").json()
    assert detail["news"] == ["수주 공시", "실적 전망"]  # newsItems와 같은 항목·같은 순서
    assert detail["newsItems"] == [
        {"title": "수주 공시", "source": "연합뉴스", "publishedAt": "2026-10-02T08:30:00+09:00"},
        {"title": "실적 전망", "source": None, "publishedAt": None}]
    assert detail["newsProvider"] == "Google 뉴스 검색 결과"
    assert detail["dataAsOf"] == "2026-10-01"
    assert detail["priceAtAnalysis"] == 100_000  # 분석 시각 가격 그대로 (장마감 기준의 일부러 둔 예외)


@pytest.mark.parametrize("value", [None, 20261001, "어제", "2026-1"])
def test_data_as_of_ignores_bad_values(value):
    from analysis import index
    assert index.data_as_of({"lastCandleDate": value}) is None


def test_list_mine_filters_by_login_id(api, user, runs, django_user_model):
    from accounts.models import profile_of
    profile = profile_of(user)
    profile.nickname = "앨리스"
    profile.save()
    django_user_model.objects.create_user(username="bob", password="pw-bob-123")
    write_run(runs, "a.json", run_log(entry(symbol="005930"), requested_by="alice", started="2026-10-01T09:00:00+09:00"))
    write_run(runs, "b.json", run_log(entry(symbol="000660", name="SK하이닉스"), requested_by="bob"))
    write_run(runs, "c.json", run_log(entry(symbol="035420", name="NAVER"), requested_by=None,
                                      strategy={"id": 1, "name": "기본"}))
    write_run(runs, "d.json", run_log(entry(symbol="005380", name="현대차"), requested_by="cli",
                                      started="2026-10-02T10:00:00+09:00"))
    write_run(runs, "e.json", run_log(entry(symbol="035720", name="카카오"), requested_by="alice",
                                      started="2026-10-02T11:00:00+09:00"))
    assert api.get("/api/analyses").json()["count"] == 5
    mine = api.get("/api/analyses?mine=1").json()
    assert mine["count"] == 2
    assert [(r["symbol"], r["requestedBy"]) for r in mine["results"]] == [("035720", "앨리스"), ("005930", "앨리스")]
    assert api.get("/api/analyses?mine=true&symbol=005930").json()["count"] == 1
    assert api.get("/api/analyses?mine=0").json()["count"] == 5  # 1·true가 아니면 거르지 않는다


def test_detail_without_run_file_uses_summary_only(api, runs):
    write_run(runs, "a.json", run_log(entry(candidates=[candidate()])))
    summary = api.get("/api/analyses").json()["results"][0]
    (runs / "a.json").unlink()
    detail = api.get(f"/api/analyses/{summary['id']}").json()
    assert detail == summary | {"scenarios": [], "news": [], "newsItems": [], "newsProvider": "Google 뉴스 검색 결과",
                                "dataAsOf": None, "research": [], "indicators": {}, "errors": []}
    assert api.get("/api/analyses/999").status_code == 404


# --- 한도 ---

def test_quota(api, user, ai, limits, django_user_model, monkeypatch):
    other = django_user_model.objects.create_user(username="bob", password="pw-bob-123")
    make_job(user, status=Job.DONE)
    make_job(user, status=Job.FAILED)                                          # 실패는 세지 않는다
    make_job(user, created_at=quota.today_start() - timedelta(seconds=1))     # 어제(KST)
    make_job(other)
    assert api.get("/api/analyses/quota").json() == {
        "usedToday": 1, "limitPerUser": 5, "remaining": 4, "estimatedCostUsd": 0.3, "enabled": True}

    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0.9")  # 전체 3회, 이미 2회 → 1회 남음
    assert api.get("/api/analyses/quota").json()["remaining"] == 1
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "2.4")  # 2.4 ÷ 0.3 = 8 (소수 오차 없이)
    assert quota.total_limit() == 8

    ai(llm_api_key=None)
    assert api.get("/api/analyses/quota").json()["enabled"] is False


def test_today_start_is_kst_midnight():
    now = datetime(2026, 10, 1, 15, 30, tzinfo=UTC)  # KST 10-02 00:30
    assert quota.today_start(now).isoformat() == "2026-10-02T00:00:00+09:00"


# --- 분석 요청 ---

def test_request_creates_queued_job(api, user, ai, limits):
    response = api.post("/api/analyses", {"symbol": " 005930 "}, content_type="application/json")
    assert response.status_code == 202
    job = Job.objects.get(id=response.json()["jobId"])
    assert (job.user, job.type, job.payload, job.status) == (user, "analyze", {"symbol": "005930"}, "QUEUED")
    for symbol in ("aapl", "BRK.B", "BF-B", "0001A0"):
        assert api.post("/api/analyses", {"symbol": symbol}, content_type="application/json").status_code == 202


@pytest.mark.parametrize("body", [{}, {"symbol": ""}, {"symbol": 5930}, {"symbol": "12345"}, {"symbol": "-x"},
                                  {"symbol": "ABCDEFG"}, {"symbol": "005930; rm"}, {"symbol": ".A"}])
def test_request_rejects_bad_symbols(api, ai, limits, body):
    response = api.post("/api/analyses", body, content_type="application/json")
    assert response.status_code == 400 and "종목코드" in response.json()["detail"]
    assert not Job.objects.exists()


@pytest.mark.parametrize("changes", [{"llm_api_key": None}, {"analysts": ()}, {"kiwoom_appkey": None}])
def test_request_unavailable_without_keys(api, ai, limits, changes):
    ai(**changes)
    response = api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json")
    assert response.status_code == 503 and response.json()["detail"]
    assert not Job.objects.exists()


def test_duplicate_request_returns_same_job(api, user, ai, limits):
    first = api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").json()["jobId"]
    assert api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").json()["jobId"] == first
    Job.objects.filter(id=first).update(status=Job.RUNNING)
    assert api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").json()["jobId"] == first
    Job.objects.filter(id=first).update(status=Job.DONE)
    assert api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").json()["jobId"] != first


def test_per_user_limit(api, user, ai, limits, monkeypatch, django_user_model):
    monkeypatch.setenv("AI_DAILY_ANALYSES_PER_USER", "2")
    make_job(user, "000660", status=Job.DONE)
    make_job(user, "035420", status=Job.FAILED)                                # 실패는 세지 않는다
    make_job(user, "035720", created_at=quota.today_start() - timedelta(hours=1))  # 어제
    assert api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").status_code == 202
    response = api.post("/api/analyses", {"symbol": "005380"}, content_type="application/json")
    assert response.status_code == 429 and response.json() == {"detail": "오늘 분석 요청 한도(2회)를 다 썼습니다."}
    # 이미 기다리는 종목은 한도와 상관없이 같은 작업 번호
    assert api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").status_code == 202
    other = django_user_model.objects.create_user(username="bob", password="pw-bob-123")
    api.force_login(other)
    assert api.post("/api/analyses", {"symbol": "005380"}, content_type="application/json").status_code == 202


def test_team_limit(api, user, ai, limits, monkeypatch, django_user_model):
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0.6")  # 하루 전체 2회
    other = django_user_model.objects.create_user(username="bob", password="pw-bob-123")
    make_job(other, "000660", status=Job.DONE)
    make_job(other, "035420", status=Job.FAILED)
    assert api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").status_code == 202
    response = api.post("/api/analyses", {"symbol": "005380"}, content_type="application/json")
    assert response.status_code == 429 and "팀 전체" in response.json()["detail"]
    assert api.get("/api/analyses/quota").json()["remaining"] == 0


def test_team_budget_includes_report_cost(api, user, ai, limits, monkeypatch):
    """팀 전체 예산은 리포트와 같이 쓴다: 리포트 실제 비용(자동 리포트 포함)을 빼고 남은 만큼만 분석 (2026-10-08)."""
    from reports.models import Report

    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0.9")  # 리포트가 없으면 3회
    Report.objects.create(source=Report.AUTO, symbol="005930", name="삼성전자", market="KR", cost_usd=0.5)
    Report.objects.create(user=user, symbol="000660", name="SK하이닉스", market="KR", cost_usd=0.3,
                          created_at=quota.today_start() - timedelta(seconds=1))  # 어제는 세지 않는다
    assert quota.usage(user, Decimal("0.5")).remaining == 1
    assert api.get("/api/analyses/quota").json()["remaining"] == 1  # (0.9 − 0.5) ÷ 0.3 → 1회
    assert api.post("/api/analyses", {"symbol": "005930"}, content_type="application/json").status_code == 202
    response = api.post("/api/analyses", {"symbol": "005380"}, content_type="application/json")
    assert response.status_code == 429 and "팀 전체 AI 비용 예산" in response.json()["detail"]
    assert api.get("/api/analyses/quota").json()["remaining"] == 0


# --- 작업 상태 ---

def test_job_status_only_for_owner(api, user, django_user_model):
    job = make_job(user)
    Job.objects.filter(id=job.id).update(status=Job.DONE, result={"analysisIds": [3]},
                                         started_at=job.created_at, finished_at=job.created_at)
    body = api.get(f"/api/jobs/{job.id}").json()
    assert body == {"id": job.id, "type": "analyze", "status": "DONE", "result": {"analysisIds": [3]}, "error": None,
                    "createdAt": body["createdAt"], "startedAt": body["createdAt"], "finishedAt": body["createdAt"]}
    assert body["createdAt"].endswith("+09:00")

    queued = api.get(f"/api/jobs/{make_job(user).id}").json()
    assert (queued["status"], queued["result"], queued["startedAt"], queued["finishedAt"]) == ("QUEUED", None, None,
                                                                                              None)
    other = make_job(django_user_model.objects.create_user(username="bob", password="pw-bob-123"))
    assert api.get(f"/api/jobs/{other.id}").status_code == 404
    assert api.get("/api/jobs/999").status_code == 404
