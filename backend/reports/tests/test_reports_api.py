"""AI 리포트 API: 실행 계획, 신청, 목록(?mine=1 — B8), 상세(Snapshot), 목록·상세의 AI 의견·한 줄 요약(B3),
팀(team: 종목 리포트 stock_report · 매매 종목 선정 stock_selection) 구분과 ?team=·?source= 필터.
종목 확인은 가짜 (증권사를 부르지 않는다). 하루 한도(D-7)는 test_quota.py."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from reports.orchestration import registry, state
from reports.models import Report

from .conftest import make_report

pytestmark = pytest.mark.django_db

SUMMARY_KEYS = {"id", "symbol", "name", "market", "status", "currentStep", "requestedBy", "opinion", "oneLiner",
                "createdAt", "startedAt", "finishedAt", "source", "team", "chaosEnabled", "costUsd", "hasPdf",
                "canDelete"}
KST = ZoneInfo("Asia/Seoul")
DRAFT = {"title": "삼성전자 리포트", "verdict": "buy", "oneLiner": "단기 반등 구간, 분할 접근", "markdown": "# x",
         "plainSummary": ["거래가 늘고 있어요", "실적이 나아지고 있어요", "환율이 바뀌면 손실이 날 수 있어요"],
         "reasons": [], "risks": [], "targets": {}, "confidence": 70, "citations": []}


@pytest.fixture(autouse=True)
def report_limit(monkeypatch):
    """하루 리포트 한도를 기본값으로 고정한다 (개발자 .env의 값과 상관없이)."""
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "3")


def post(client, body):
    return client.post("/api/reports", body, content_type="application/json")


def selection_run(user=None, source=Report.AUTO, **fields) -> Report:
    """매매 종목 선정 실행 (엔진이 만드는 모양: 신청자 없음 · 자동 · symbol은 시장 코드)."""
    fields = {"symbol": "KR", "name": "오늘의 매매 종목 선정", "market": "KR"} | fields
    return Report.objects.create(user=user, source=source, team=Report.STOCK_SELECTION, **fields)


@pytest.mark.parametrize("path", ["/api/reports/plan", "/api/reports", "/api/reports/1"])
def test_login_required(client, path):
    response = client.get(path)
    assert response.status_code == 401 and response.json() == {"detail": "로그인이 필요합니다."}


def test_post_login_required(client, stocks):
    response = post(client, {"symbol": "005930"})
    assert response.status_code == 401 and response.json() == {"detail": "로그인이 필요합니다."}
    assert stocks["calls"] == [] and not Report.objects.exists()


def test_plan(api):
    assert api.get("/api/reports/plan").json() == registry.execution_plan()


@pytest.mark.parametrize("query, team", [("stock_report", "stock_report"), ("stock_selection", "stock_selection"),
                                         (" Stock_Selection ", "stock_selection"), ("", "stock_report")])
def test_plan_of_team(api, query, team):
    body = api.get(f"/api/reports/plan?team={query}").json()
    assert body == registry.execution_plan(team) and body["team"] == team


@pytest.mark.parametrize("query", ["x", "stock", "all"])
def test_plan_of_unknown_team_is_400(api, query):
    response = api.get(f"/api/reports/plan?team={query}")
    assert response.status_code == 400
    assert response.json() == {"detail": "team은 stock_report 또는 stock_selection입니다."}


def test_plan_error_is_json_500(api, monkeypatch):
    def broken(team="stock_report"):
        raise registry.PlanError("step id가 겹칩니다: x")
    monkeypatch.setattr(registry, "execution_plan", broken)
    response = api.get("/api/reports/plan")
    assert response.status_code == 500
    assert response.json() == {"detail": "실행 계획이 잘못되었습니다: step id가 겹칩니다: x"}


# --- 신청 ---

def test_create_report(api, user, stocks):
    response = post(api, {"symbol": " 005930 "})
    assert response.status_code == 201
    body = response.json()
    assert set(body) == SUMMARY_KEYS | {"content", "state", "trace", "plan", "chaos", "recovery"}
    assert (body["symbol"], body["name"], body["market"], body["status"], body["currentStep"], body["requestedBy"]) == (
        "005930", "삼성전자", "KR", "requested", None, "앨리스")
    assert body["startedAt"] is None and body["finishedAt"] is None and body["createdAt"].endswith("+09:00")
    assert body["opinion"] is None and body["oneLiner"] is None  # 완성 전
    assert body["content"] is None and body["trace"] == []
    assert body["state"] == {"taskId": f"report-{body['id']}", "status": "requested", "currentStep": None,
                             "results": {}, "errors": {}, "completedAgents": [], "failedAgents": []}
    assert body["plan"] == registry.execution_plan() and body["plan"]["team"] == "stock_report"
    assert body["team"] == "stock_report" and body["source"] == "user"
    report = Report.objects.get(pk=body["id"])
    assert (report.user, report.status, report.started_at) == (user, "requested", None)  # 실행은 시작하지 않는다
    assert report.team == Report.STOCK_REPORT


def test_create_ignores_active_selection_run(api, user, stocks):
    """같은 사람·같은 symbol이라도 선정 실행은 '진행 중인 같은 리포트'가 아니다 (신청은 늘 종목 리포트)."""
    selection = selection_run(user, source=Report.USER, symbol="005930", status=Report.RUNNING)
    response = post(api, {"symbol": "005930"})
    assert response.status_code == 201 and response.json()["id"] != selection.id
    assert response.json()["team"] == "stock_report"


def test_create_returns_active_report_of_same_user(api, user, other, stocks):
    first = post(api, {"symbol": "005930"}).json()
    again = post(api, {"symbol": "005930"})
    assert again.status_code == 200 and again.json()["id"] == first["id"]

    state.start(Report.objects.get(pk=first["id"]))  # 실행 중이어도 같은 리포트
    assert post(api, {"symbol": "005930"}).json()["id"] == first["id"]

    make_report(other)  # 다른 사람의 리포트는 상관없다
    assert post(api, {"symbol": "005930"}).json()["id"] == first["id"]
    assert post(api, {"symbol": "AAPL"}).status_code == 201  # 다른 종목은 새로

    state.finish(Report.objects.get(pk=first["id"]), "completed")  # 끝났으면 새로 만든다
    fresh = post(api, {"symbol": "005930"})
    assert fresh.status_code == 201 and fresh.json()["id"] != first["id"]
    assert Report.objects.filter(user=user, symbol="005930").count() == 2


@pytest.mark.parametrize("body, message", [
    ({"symbol": "999999"}, "종목을 찾을 수 없습니다."),
    ({"symbol": ""}, "종목코드를 입력하세요."),
    ({"symbol": 5930}, "종목코드를 입력하세요."),
    ({}, "종목코드를 입력하세요."),
])
def test_create_rejects_bad_symbol(api, stocks, body, message):
    response = post(api, body)
    assert response.status_code == 400 and response.json() == {"detail": message}
    assert not Report.objects.exists()


def test_create_without_broker_is_503(api, stocks):
    stocks["broker_ready"] = False
    response = post(api, {"symbol": "005930"})
    assert response.status_code == 503 and "증권사" in response.json()["detail"]
    assert not Report.objects.exists()


# --- 목록 ---

def test_list_filter_page_and_nickname(api, user, other):
    now = timezone.now()
    old = make_report(user, created_at=now - timedelta(hours=2))
    apple = make_report(other, "AAPL", created_at=now - timedelta(hours=1))
    new = make_report(user, created_at=now)
    state.start(new)
    state.set_step(new, "parallel_research")

    body = api.get("/api/reports").json()
    assert body["count"] == 3
    assert [r["id"] for r in body["results"]] == [new.id, apple.id, old.id]  # 팀 공용, 최신순
    first = body["results"][0]
    assert set(first) == SUMMARY_KEYS
    assert (first["status"], first["currentStep"], first["requestedBy"]) == ("running", "parallel_research", "앨리스")
    assert first["startedAt"] is not None
    assert body["results"][1]["requestedBy"] == "bob"  # 닉네임 기본값은 아이디

    assert [r["id"] for r in api.get("/api/reports?symbol=aapl").json()["results"]] == [apple.id]
    assert api.get("/api/reports?symbol=000660").json() == {"count": 0, "results": []}
    page = api.get("/api/reports?limit=1&offset=1").json()
    assert page["count"] == 3 and [r["id"] for r in page["results"]] == [apple.id]


def test_list_mine(api, user, other):
    """B8: ?mine=1이면 내가 신청한 것만 (종목과 같이 쓸 수 있다). 1이 아닌 값은 팀 전체."""
    now = timezone.now()
    mine_kr = make_report(user, created_at=now - timedelta(hours=3))
    theirs = make_report(other, created_at=now - timedelta(hours=2))
    mine_us = make_report(user, "AAPL", created_at=now - timedelta(hours=1))

    assert [r["id"] for r in api.get("/api/reports?mine=1").json()["results"]] == [mine_us.id, mine_kr.id]
    assert api.get("/api/reports?mine=1").json()["count"] == 2
    assert [r["id"] for r in api.get("/api/reports?mine=1&symbol=005930").json()["results"]] == [mine_kr.id]
    assert api.get("/api/reports?mine=1&symbol=000660").json() == {"count": 0, "results": []}
    for value in ("0", "", "true"):
        assert api.get(f"/api/reports?mine={value}").json()["count"] == 3, value
    assert [r["id"] for r in api.get("/api/reports?mine=1&limit=1&offset=1").json()["results"]] == [mine_kr.id]
    assert theirs.id not in [r["id"] for r in api.get("/api/reports?mine=1").json()["results"]]


def test_list_default_leaves_out_selection_runs(api, user):
    """기본 목록은 종목 리포트만 — 선정 실행은 팀 목록·홈 최근 리포트·?symbol=KR에 섞이지 않는다."""
    now = timezone.now()
    report = make_report(user, created_at=now - timedelta(hours=1))
    selection = selection_run(created_at=now)
    body = api.get("/api/reports").json()
    assert body["count"] == 1 and [r["id"] for r in body["results"]] == [report.id]
    assert body["results"][0]["team"] == "stock_report"
    assert api.get("/api/reports?symbol=KR").json() == {"count": 0, "results": []}
    assert api.get("/api/reports?team=stock_report").json()["count"] == 1

    picked = api.get("/api/reports?team=stock_selection").json()
    assert picked["count"] == 1 and [r["id"] for r in picked["results"]] == [selection.id]
    first = picked["results"][0]
    assert set(first) == SUMMARY_KEYS
    assert (first["team"], first["source"], first["requestedBy"], first["symbol"]) == (
        "stock_selection", "auto", "자동", "KR")
    assert (first["opinion"], first["oneLiner"]) == (None, None)
    assert api.get("/api/reports?team=stock_selection&mine=1").json()["count"] == 0  # 신청자가 없다


def test_list_source_filter(api, user):
    """?source=user|auto (예전에는 무시돼 '자동' 필터가 전부를 보였다). team·mine·symbol과 같이 쓴다."""
    now = timezone.now()
    mine = make_report(user, created_at=now - timedelta(hours=3))
    auto_kr = make_report(None, source=Report.AUTO, created_at=now - timedelta(hours=2))
    auto_us = make_report(None, "AAPL", source=Report.AUTO, created_at=now - timedelta(hours=1))
    selection = selection_run(created_at=now)

    def ids(query):
        return [r["id"] for r in api.get(f"/api/reports{query}").json()["results"]]
    assert ids("") == [auto_us.id, auto_kr.id, mine.id]
    assert ids("?source=auto") == [auto_us.id, auto_kr.id]
    assert ids("?source=AUTO") == [auto_us.id, auto_kr.id]
    assert ids("?source=user") == [mine.id]
    assert ids("?source=") == [auto_us.id, auto_kr.id, mine.id]  # 비면 전부
    assert ids("?source=auto&symbol=005930") == [auto_kr.id]
    assert ids("?source=auto&mine=1") == []
    assert ids("?source=auto&team=stock_selection") == [selection.id]
    assert ids("?source=user&team=stock_selection") == []
    assert api.get("/api/reports?source=auto&limit=1").json() == {
        "count": 2, "results": [api.get("/api/reports?source=auto").json()["results"][0]]}


@pytest.mark.parametrize("query, message", [
    ("team=x", "team은 stock_report 또는 stock_selection입니다."),
    ("team=all", "team은 stock_report 또는 stock_selection입니다."),
    ("source=robot", "source는 user 또는 auto입니다."),
    ("source=auto&team=selection", "team은 stock_report 또는 stock_selection입니다."),
])
def test_list_bad_filter_is_400(api, user, query, message):
    make_report(user)
    response = api.get(f"/api/reports?{query}")
    assert response.status_code == 400 and response.json() == {"detail": message}


# --- AI 의견·한 줄 요약 (B3) ---

def test_opinion_and_one_liner_only_when_completed(api, user):
    """대기·실행 중·실패면 report_agent 결과가 있어도 null, completed일 때만 verdict·oneLiner 그대로 (목록·상세 같은 값)."""
    report = make_report(user, results={"report_agent": DRAFT})
    pending = api.get(f"/api/reports/{report.id}").json()
    assert (pending["status"], pending["opinion"], pending["oneLiner"]) == ("requested", None, None)

    state.start(report)
    running = api.get(f"/api/reports/{report.id}").json()
    assert (running["status"], running["opinion"], running["oneLiner"]) == ("running", None, None)

    state.finish(report, "completed", content="# 삼성전자 리포트")
    done = api.get(f"/api/reports/{report.id}").json()
    assert (done["opinion"], done["oneLiner"]) == ("buy", "단기 반등 구간, 분할 접근")
    listed = api.get("/api/reports").json()["results"][0]
    assert (listed["id"], listed["opinion"], listed["oneLiner"]) == (report.id, "buy", "단기 반등 구간, 분할 접근")

    failed = make_report(user, "AAPL", results={"report_agent": DRAFT | {"verdict": "avoid"}})
    state.finish(failed, "failed")  # 검토를 통과하지 못한 초안은 내지 않는다
    body = api.get(f"/api/reports/{failed.id}").json()
    assert (body["status"], body["opinion"], body["oneLiner"]) == ("failed", None, None)


@pytest.mark.parametrize("draft, expected", [
    ({"verdict": "hold", "oneLiner": "  지켜보기  "}, ("hold", "지켜보기")),
    ({"verdict": "avoid", "oneLiner": "가" * 90}, ("avoid", "가" * 80)),       # 80자까지
    ({"verdict": "BUY", "oneLiner": "   "}, (None, None)),                      # 모르는 의견·빈 문장
    ({"verdict": None, "oneLiner": 123}, (None, None)),                         # 문자열이 아님
    ({}, (None, None)),
    ("초안이 dict가 아님", (None, None)),
])
def test_opinion_tolerates_bad_shapes(api, user, draft, expected):
    report = make_report(user, status=Report.COMPLETED, results={"report_agent": draft})
    body = api.get(f"/api/reports/{report.id}").json()
    assert (body["opinion"], body["oneLiner"]) == expected


def test_opinion_without_report_agent_result(api, user):
    report = make_report(user, status=Report.COMPLETED, results={"market_agent": {"trend": "up"}})
    body = api.get(f"/api/reports/{report.id}").json()
    assert (body["opinion"], body["oneLiner"]) == (None, None)
    Report.objects.filter(pk=report.pk).update(results=[])  # 결과 열이 dict가 아니어도 깨지지 않는다
    assert api.get(f"/api/reports/{report.id}").json()["opinion"] is None


def test_created_at_is_kst(api, user, stocks, monkeypatch):
    """신청 시각은 한도를 센 시각과 같다 (KST로 낸다)."""
    fixed = datetime(2026, 10, 5, 0, 30, tzinfo=KST)  # KST 자정 직후 = UTC로는 전날
    monkeypatch.setattr(timezone, "now", lambda: fixed)
    body = post(api, {"symbol": "005930"}).json()
    assert body["createdAt"] == "2026-10-05T00:30:00+09:00"
    assert Report.objects.get(pk=body["id"]).created_at == fixed


# --- 상세 (Snapshot) ---

def test_detail_snapshot(api, user):
    report = make_report(user)
    state.start(report)
    state.set_step(report, "parallel_research")
    state.record(report, "orchestrator", "workflow_started", "started")
    state.record(report, "market_agent", "agent_completed", "completed", provider="openai", model="gpt-x",
                 latency_ms=850, details={"note": "ok"})
    state.add_result(report, "market_agent", {"trend": "up"})
    state.record(report, "news_agent", "agent_failed", "failed", details={"error": "시간 초과"})
    state.add_error(report, "news_agent", "시간 초과")

    body = api.get(f"/api/reports/{report.id}").json()
    assert (body["status"], body["currentStep"], body["content"]) == ("running", "parallel_research", None)
    assert body["state"] == {"taskId": f"report-{report.id}", "status": "running", "currentStep": "parallel_research",
                             "results": {"market_agent": {"trend": "up"}}, "errors": {"news_agent": "시간 초과"},
                             "completedAgents": ["market_agent"], "failedAgents": ["news_agent"]}
    assert [e["step"] for e in body["trace"]] == [1, 2, 3]
    event = body["trace"][1]
    assert set(event) == {"step", "actor", "action", "status", "provider", "model", "latencyMs", "details", "at"}
    assert (event["actor"], event["action"], event["status"], event["provider"], event["model"], event["latencyMs"],
            event["details"]) == ("market_agent", "agent_completed", "completed", "openai", "gpt-x", 850, {"note": "ok"})
    assert body["trace"][0]["provider"] is None and body["trace"][0]["at"].endswith("+09:00")
    assert body["plan"]["team"] == "stock_report"

    state.finish(report, "completed", content="# 삼성전자 리포트")
    done = api.get(f"/api/reports/{report.id}").json()
    assert (done["status"], done["currentStep"], done["content"]) == ("completed", None, "# 삼성전자 리포트")
    assert done["finishedAt"] is not None and done["state"]["currentStep"] is None


def test_detail_of_selection_run_has_its_own_plan(api, user):
    """ReportDetail.plan은 그 리포트 팀의 계획 (선정 실행이면 선정 팀 계획)."""
    selection = selection_run(results={"selector_agent": {"summary": "x", "picks": []}})
    state.start(selection)
    state.set_step(selection, "candidate_research")
    body = api.get(f"/api/reports/{selection.id}").json()
    assert body["plan"] == registry.execution_plan("stock_selection") and body["plan"]["team"] == "stock_selection"
    assert (body["team"], body["currentStep"], body["requestedBy"]) == ("stock_selection", "candidate_research", "자동")
    assert body["plan"]["steps"][0]["id"] == "candidate_research"
    state.finish(selection, "completed", content="# 오늘의 선정")
    done = api.get(f"/api/reports/{selection.id}").json()
    assert (done["opinion"], done["oneLiner"], done["content"]) == (None, None, "# 오늘의 선정")  # report_agent가 없다

    stock = make_report(user)
    assert api.get(f"/api/reports/{stock.id}").json()["plan"] == registry.execution_plan()


def test_detail_not_found(api):
    response = api.get("/api/reports/999")
    assert response.status_code == 404 and response.json() == {"detail": "리포트를 찾을 수 없습니다."}


def test_admin_pages(client, django_user_model, user):
    report = state.start(make_report(user))
    state.record(report, "orchestrator", "workflow_started", "started")
    client.force_login(django_user_model.objects.create_superuser("root", password="pw-root-123"))
    for path in ("/admin/reports/report/", f"/admin/reports/report/{report.id}/change/", "/admin/reports/traceevent/",
                 f"/admin/reports/traceevent/{report.trace_events.get().id}/change/"):
        assert client.get(path).status_code == 200, path
