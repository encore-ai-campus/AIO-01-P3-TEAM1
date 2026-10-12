"""장애 주입 내부 API (docs/API.md "장애 주입 내부 API", docs/DECISIONS.md 35장 — reports/autohealing/control.py, views.ChaosRunsView):
기능 꺼짐 404 · 서명 401(틀림·시각 ±60초·다시 쓰기) · staff 403 · 종목·chaos 400 · 진행 중 409 · 팀 AI 예산 429 · 만들기 201 · options,
그리고 이미 있는 장애 주입 리포트를 source "chaos"로 옮기는 마이그레이션 0005.
Redis는 쓰지 않는다 (개발자 .env의 REDIS_URL과 상관없이 프로세스 메모리 경로 — Redis 경로는 가짜 저장소로 본다). 종목 확인은 가짜."""
import json
from importlib import import_module

import pytest
from django.apps import apps
from django.test import Client
from paper_engine.records.redis_client import RedisError

from reports.autohealing import chaos, control
from reports.models import Report
from reports.orchestration import registry, runner

from ..conftest import make_report

pytestmark = pytest.mark.django_db

SECRET = "test-chaos-secret"
NOW = 1_760_000_000
OPTIONS, RUNS = "/api/internal/chaos-runs/options", "/api/internal/chaos-runs"
BAD_SIGNATURE = {"detail": "서명이 맞지 않습니다."}
NOT_STAFF = {"detail": "관리자만 장애 주입을 신청할 수 있어요."}
NOT_ENABLED = {"detail": "chaos.enabled가 true여야 합니다."}
RUN = {"symbol": "005930", "chaos": {"enabled": True, "probability": 0.8, "scope": "primary"}, "requestedBy": "ops"}


@pytest.fixture(autouse=True)
def internal(settings, monkeypatch):
    settings.CHAOS_CONTROL_SECRET = SECRET
    monkeypatch.setattr(control, "redis_store", lambda: None)  # 개발자 .env의 Redis를 건드리지 않는다
    monkeypatch.setattr(control, "_seen", {})
    monkeypatch.setattr(control, "clock", lambda: NOW)
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "10")


@pytest.fixture
def admin(django_user_model):
    return django_user_model.objects.create_user(username="ops", password="pw-ops-123", is_staff=True)


def headers(body: bytes = b"", ts=NOW, secret=SECRET) -> dict:
    ts = str(ts)
    return {"X-Chaos-Timestamp": ts, "X-Chaos-Signature": control.sign(body, ts, secret)}


def options(client, signature=None):
    return client.get(OPTIONS, headers=headers() if signature is None else signature)


def request_run(client, payload=RUN, signature=None):
    body = json.dumps(payload).encode()
    return client.post(RUNS, body, content_type="application/json",
                       headers=headers(body) if signature is None else signature)


# --- 기능 꺼짐 · 서명 ---

@pytest.mark.parametrize("value", ["", "   "])
def test_off_is_404_like_unknown_route(client, settings, admin, stocks, value):
    """비밀 값이 비었으면 두 경로 모두 없는 경로와 같은 Django 404 (서명·메서드보다 먼저)."""
    settings.CHAOS_CONTROL_SECRET = value
    unknown = client.get("/api/internal/nope")
    for response in (options(client), request_run(client), client.get(RUNS), client.post(OPTIONS)):
        assert response.status_code == 404 == unknown.status_code
        assert response["Content-Type"] == unknown["Content-Type"]
    assert not Report.objects.exists() and stocks["calls"] == []


def test_options(client):
    response = options(client)
    assert response.status_code == 200
    body = response.json()
    plan = registry.execution_plan(registry.TEAM)
    assert body == {
        "workers": [{"id": worker["id"], "title": worker["title"]} for worker in plan["workers"]],
        "errorTypes": ["timeout", "server_error", "bad_output"], "scopes": ["primary", "all"],
        "defaults": {"probability": chaos.DEFAULT_PROBABILITY, "scope": "primary"},
    }
    assert [worker["id"] for worker in body["workers"]] == registry.worker_ids(registry.TEAM)
    assert all(isinstance(worker["title"], str) and worker["title"] for worker in body["workers"])


def bad_headers():
    body = json.dumps(RUN).encode()
    good = headers(body)
    return {
        "헤더 없음": {},
        "서명 없음": {"X-Chaos-Timestamp": str(NOW)},
        "시각 없음": {"X-Chaos-Signature": good["X-Chaos-Signature"]},
        "다른 비밀 값": headers(body, secret="other-secret"),
        "다른 본문의 서명": headers(b'{"symbol": "000660"}'),
        "시각이 숫자가 아님": {**good, "X-Chaos-Timestamp": f"{NOW}.0"},
        "시각을 바꿈": {**good, "X-Chaos-Timestamp": str(NOW + 1)},
        "61초 전": headers(body, ts=NOW - 61),
        "61초 뒤": headers(body, ts=NOW + 61),
        "음수 시각": headers(body, ts=-NOW),
        "서명이 hex가 아님": {**good, "X-Chaos-Signature": "서명" * 32},
    }


@pytest.mark.parametrize("case", list(bad_headers()))
def test_bad_signature_is_401(client, admin, stocks, case):
    """서명이 틀리거나 시각이 ±60초 밖이면 401 — staff·종목 확인보다 먼저 (아무것도 만들지 않는다)."""
    response = request_run(client, signature=bad_headers()[case])
    assert response.status_code == 401 and response.json() == BAD_SIGNATURE
    assert not Report.objects.exists() and stocks["calls"] == []
    assert options(client, signature={}).status_code == 401


@pytest.mark.parametrize("skew", [-60, 60])
def test_signature_within_60_seconds(client, skew):
    response = options(client, signature={**headers(ts=NOW + skew)})
    assert response.status_code == 200


def test_upper_case_signature_is_the_same_signature(client):
    sent = headers()
    assert options(client, signature={**sent, "X-Chaos-Signature": sent["X-Chaos-Signature"].upper()}).status_code == 200
    assert options(client, signature=sent).status_code == 401  # 대소문자만 바꾼 것은 같은 서명 → 다시 쓰기


def test_replay_is_401(client, admin, stocks):
    """같은 서명을 120초 안에 다시 쓰면 401 (요청을 그대로 다시 보내도 실행이 두 번 생기지 않는다)."""
    body = json.dumps(RUN).encode()
    sent = headers(body)
    assert request_run(client, signature=sent).status_code == 201
    again = request_run(client, signature=sent)
    assert again.status_code == 401 and again.json() == BAD_SIGNATURE
    assert Report.objects.count() == 1
    first = headers()
    assert options(client, signature=first).status_code == 200
    assert options(client, signature=first).status_code == 401


def test_first_use_forgets_after_ttl():
    assert control.first_use("ab", NOW) is True
    assert control.first_use("ab", NOW + control.REPLAY_TTL_SEC - 1) is False
    assert control.first_use("ab", NOW + control.REPLAY_TTL_SEC) is True   # 잊은 뒤 (그 시각의 서명은 이미 ±60초 밖이다)
    assert control.first_use("cd", NOW) is True


class FakeRedis:
    def __init__(self, error=None):
        self.keys, self.calls, self.error = {}, [], error

    def set(self, key, value, nx=False, ex=None):
        self.calls.append((key, value, nx, ex))
        if self.error:
            raise self.error
        if nx and key in self.keys:
            return False
        self.keys[key] = value
        return True


def test_replay_uses_redis_key(client, monkeypatch):
    store = FakeRedis()
    monkeypatch.setattr(control, "redis_store", lambda: store)
    sent = headers()
    assert options(client, signature=sent).status_code == 200
    assert options(client, signature=sent).status_code == 401
    key = f"paper:chaos:sig:{sent['X-Chaos-Signature']}"
    assert store.calls == [(key, "1", True, 120)] * 2 and control._seen == {}


@pytest.mark.parametrize("error", [RedisError("Redis 연결 실패"), OSError("끊김")])
def test_replay_falls_back_to_memory_without_redis(client, monkeypatch, error):
    monkeypatch.setattr(control, "redis_store", lambda: FakeRedis(error))
    sent = headers()
    assert options(client, signature=sent).status_code == 200
    assert options(client, signature=sent).status_code == 401


# --- staff · 입력 ---

@pytest.mark.parametrize("requested_by", [None, "", "nobody", "bob", "retired", 7, ["ops"], "OPS"])
def test_requested_by_must_be_active_staff(client, admin, other, django_user_model, stocks, requested_by):
    """requestedBy가 서비스의 활성 staff 아이디가 아니면 403 (종목 확인 전 — 증권사를 부르지 않는다)."""
    django_user_model.objects.create_user(username="retired", password="pw-retired-1", is_staff=True, is_active=False)
    payload = {key: value for key, value in RUN.items() if key != "requestedBy"}
    if requested_by is not None:
        payload["requestedBy"] = requested_by
    response = request_run(client, payload)
    assert response.status_code == 403 and response.json() == NOT_STAFF
    assert not Report.objects.exists() and stocks["calls"] == []


def test_body_not_object_is_403(client, admin):
    response = request_run(client, ["ops"])
    assert response.status_code == 403 and response.json() == NOT_STAFF


@pytest.mark.parametrize("symbol, message", [("999999", "종목을 찾을 수 없습니다."), ("", "종목코드를 입력하세요."),
                                             (5930, "종목코드를 입력하세요.")])
def test_bad_symbol_is_400(client, admin, stocks, symbol, message):
    response = request_run(client, RUN | {"symbol": symbol})
    assert response.status_code == 400 and response.json() == {"detail": message}
    assert not Report.objects.exists()


def test_without_broker_is_503(client, admin, stocks):
    stocks["broker_ready"] = False
    assert request_run(client).status_code == 503 and not Report.objects.exists()


@pytest.mark.parametrize("config, detail", [
    ("missing", NOT_ENABLED["detail"]),
    (None, NOT_ENABLED["detail"]),
    ({"enabled": False}, NOT_ENABLED["detail"]),
    ({"enabled": False, "probability": 2}, "chaos.probability는 0~1 사이의 숫자입니다."),
    ({"enabled": True, "scope": "everything"}, "chaos.scope는 primary 또는 all입니다."),
    ({"enabled": True, "requestedBy": "ops"}, "chaos에 모르는 항목이 있습니다: requestedBy"),
    ({"enabled": True, "workers": ["selector_agent"]}, None),
    ({"enabled": True, "seed": -1}, "chaos.seed는 0 이상 2^53 미만의 정수입니다."),
    ("on", "chaos는 객체여야 합니다."),
])
def test_bad_chaos_is_400(client, admin, stocks, config, detail):
    """chaos.parse 그대로 (대상은 종목 리포트 팀 Worker). 없거나 끈 설정은 만들 실행이 없어 400."""
    payload = {key: value for key, value in RUN.items() if key != "chaos"}
    if config != "missing":
        payload["chaos"] = config
    response = request_run(client, payload)
    assert response.status_code == 400
    expected = detail or f"chaos.workers는 null이거나 이 Worker 중 하나 이상입니다: {', '.join(registry.worker_ids())}"
    assert response.json() == {"detail": expected}
    assert not Report.objects.exists()


# --- 진행 중 · 예산 · 만들기 ---

@pytest.mark.parametrize("status", [Report.REQUESTED, Report.RUNNING])
def test_active_chaos_run_is_409(client, admin, user, stocks, status):
    """진행 중인 장애 주입 실행이 있으면 409 {"detail", "id"} (실행기가 1건씩이라 사용자 리포트를 오래 막지 않게).
    끝난 장애 주입 실행·진행 중인 사용자 리포트는 막지 않는다."""
    make_report(None, source=Report.CHAOS, status=Report.COMPLETED, chaos={"enabled": True})
    make_report(user, status=Report.RUNNING)
    active = make_report(None, "AAPL", source=Report.CHAOS, status=status, chaos={"enabled": True})
    response = request_run(client)
    assert response.status_code == 409
    assert response.json() == {"detail": "진행 중인 장애 주입 실행이 있어요. 끝난 뒤에 다시 신청해 주세요.", "id": active.id}
    assert Report.objects.filter(source=Report.CHAOS).count() == 2

    Report.objects.filter(pk=active.pk).update(status=Report.FAILED)
    assert request_run(client, RUN | {"symbol": "AAPL"}).status_code == 201


def test_legacy_chaos_report_in_progress_is_409(client, admin, user, stocks):
    """마이그레이션으로 옮긴 옛 장애 주입 리포트(신청자 있음)도 진행 중이면 장애 주입 실행이다."""
    legacy = make_report(user, source=Report.CHAOS, status=Report.RUNNING, chaos={"enabled": True})
    assert request_run(client).json()["id"] == legacy.id


def test_budget_exceeded_is_429_after_409(client, admin, stocks, monkeypatch):
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0")
    response = request_run(client)
    assert response.status_code == 429
    assert response.json() == {"detail": "오늘 AI 비용 예산을 다 썼어요. 내일 0시에 다시 신청할 수 있어요."}
    assert not Report.objects.exists()
    active = make_report(None, source=Report.CHAOS, chaos={"enabled": True})
    assert request_run(client, RUN | {"symbol": "AAPL"}).json()["id"] == active.id  # 진행 중(409)이 예산보다 먼저


def test_create_chaos_run(client, admin, user, api, stocks, monkeypatch):
    """201 ChaosRun: source "chaos" · 신청자 없음 · 종목 리포트 팀 · chaos = parse 결과(기본값·seed) + requestedBy.
    서비스의 사용자 경로에는 나오지 않고(목록·상세·하루 한도), 같은 실행기 줄에 선다. 같은 설정(seed 포함)으로 다시 보내면 같은 설정이다."""
    monkeypatch.setattr(chaos.secrets, "randbits", lambda bits: 424242)
    response = request_run(client)
    assert response.status_code == 201
    body = response.json()
    expected = {"enabled": True, "probability": 0.8, "errorTypes": ["timeout", "server_error", "bad_output"],
                "workers": None, "scope": "primary", "seed": 424242, "requestedBy": "ops"}
    assert body == {"id": body["id"], "status": "requested", "symbol": "005930", "name": "삼성전자", "chaos": expected}
    run = Report.objects.get(pk=body["id"])
    assert (run.source, run.user, run.team, run.market, run.status, run.chaos) == (
        Report.CHAOS, None, Report.STOCK_REPORT, "KR", Report.REQUESTED, expected)

    assert api.get("/api/reports").json() == {"count": 0, "results": []}
    assert api.get(f"/api/reports/{run.id}").status_code == 404
    assert api.get("/api/reports/quota").json()["used"] == 0
    assert runner._claim() == run.id  # 엔진 루프가 1건씩 실행기에서 차례로 돌린다

    Report.objects.filter(pk=run.pk).update(status=Report.COMPLETED)
    again = {key: value for key, value in expected.items() if key != "requestedBy"}   # 관리자 화면의 "같은 설정으로 다시"
    repeat = request_run(client, {"symbol": "005930", "chaos": again, "requestedBy": "ops"})
    assert repeat.status_code == 201 and repeat.json()["chaos"] == expected


def test_no_session_or_csrf_needed(admin, stocks):
    """세션 인증을 쓰지 않는 뷰라 CSRF 토큰 없이 서명만으로 된다."""
    client = Client(enforce_csrf_checks=True)
    assert request_run(client).status_code == 201


# --- 마이그레이션 0005 ---

def test_migration_moves_existing_chaos_reports(user):
    """이미 있는 장애 주입 리포트(chaos.enabled가 true)만 source "chaos"로 (user는 그대로). 되돌리면 신청자가 있으면 user, 없으면 auto."""
    migration = import_module("reports.migrations.0005_source_chaos")
    on = make_report(user, status=Report.FAILED, chaos={"enabled": True, "probability": 0.5, "seed": 1})
    off = make_report(user, chaos={"enabled": False})
    plain = make_report(user)
    odd = make_report(user, chaos={"enabled": "yes"})
    auto = make_report(None, source=Report.AUTO)
    run = make_report(None, source=Report.CHAOS, chaos={"enabled": True})

    migration.chaos_reports_to_chaos_source(apps, None)
    sources = dict(Report.objects.values_list("id", "source"))
    assert sources == {on.id: "chaos", off.id: "user", plain.id: "user", odd.id: "user", auto.id: "auto", run.id: "chaos"}
    on.refresh_from_db()
    assert on.user == user and on.chaos == {"enabled": True, "probability": 0.5, "seed": 1}

    migration.chaos_source_back(apps, None)
    assert dict(Report.objects.values_list("id", "source")) == sources | {on.id: "user", run.id: "auto"}
