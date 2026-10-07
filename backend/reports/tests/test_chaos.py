"""장애 주입 (docs/tasks/04-autohealing.md T4-6, docs/tasks/00-공통.md 5절): 설정 검사(chaos.parse), 재현 가능한 판정(should_fail),
호출기의 실제 호출 직전 주입(주입 뒤는 진짜 복구 경로), 리포트 신청의 chaos, 장애 주입을 켠 리포트가 끝까지 나오는지."""
import pytest

from config import engine
from config.api import Rejected
from reports import chaos, healing, orchestrator, state
from reports.healing import ErrorType, LlmGaveUp
from reports.models import Report

from .conftest import SAMPLES, FakeWorker, fake_team, make_report

PRIMARY, FALLBACK = "gemini-3.8-flash", "gpt-5.6-luna"
WORKER = {"id": "market_agent", "provider": "devpass", "model": PRIMARY, "outputContract": "MarketResult"}
ANSWER = {"trend": "up"}
ALL = {"enabled": True, "probability": 1.0, "errorTypes": ["timeout"], "workers": None, "scope": "primary", "seed": 7}


# --- 설정 검사 ---

def test_parse_none_and_disabled():
    assert chaos.parse(None) is None
    assert chaos.parse({"enabled": False}) is None  # 끈 설정은 저장하지 않는다 (null = 끄기)


def test_parse_defaults(monkeypatch):
    monkeypatch.setattr(chaos.secrets, "randbits", lambda bits: 424242)
    assert chaos.parse({"enabled": True}) == {"enabled": True, "probability": 0.5,
                                              "errorTypes": ["timeout", "server_error", "bad_output"],
                                              "workers": None, "scope": "primary", "seed": 424242}


def test_parse_server_seed_is_31_bits():
    seeds = {chaos.parse({"enabled": True})["seed"] for _ in range(20)}
    assert all(0 <= seed < 2 ** 31 for seed in seeds) and len(seeds) > 1


def test_parse_full():
    body = {"enabled": True, "probability": 1, "errorTypes": ["bad_output", "timeout", "bad_output"],
            "workers": ["news_agent", "market_agent"], "scope": "all", "seed": 0}
    assert chaos.parse(body) == {"enabled": True, "probability": 1.0, "errorTypes": ["bad_output", "timeout"],
                                 "workers": ["news_agent", "market_agent"], "scope": "all", "seed": 0}


@pytest.mark.parametrize("body", [
    "on", ["enabled"], {}, {"enabled": "true"}, {"enabled": 1}, {"enabled": True, "extra": 1},
    {"enabled": True, "probability": -0.1}, {"enabled": True, "probability": 1.1}, {"enabled": True, "probability": "0.5"},
    {"enabled": True, "probability": True}, {"enabled": True, "probability": None},
    {"enabled": True, "errorTypes": []}, {"enabled": True, "errorTypes": ["unknown"]}, {"enabled": True, "errorTypes": "timeout"},
    {"enabled": True, "workers": []}, {"enabled": True, "workers": ["nope"]}, {"enabled": True, "workers": "market_agent"},
    {"enabled": True, "workers": ["selector_agent"]},  # 다른 팀(매매 종목 선정)의 Worker
    {"enabled": True, "scope": "fallback"}, {"enabled": True, "seed": -1}, {"enabled": True, "seed": 1.5},
    {"enabled": True, "seed": True}, {"enabled": True, "seed": "1"},
    {"enabled": False, "probability": 2},  # 꺼도 형식은 검사한다
])
def test_parse_rejects(body):
    with pytest.raises(Rejected):
        chaos.parse(body)


# --- 판정 ---

def test_should_fail_off():
    assert chaos.should_fail(None, "market_agent", PRIMARY, True, 1) is None
    assert chaos.should_fail({**ALL, "enabled": False}, "market_agent", PRIMARY, True, 1) is None


def test_should_fail_probability_edges():
    assert chaos.should_fail(ALL, "market_agent", PRIMARY, True, 1) == "timeout"
    assert chaos.should_fail({**ALL, "probability": 0.0}, "market_agent", PRIMARY, True, 1) is None


def test_should_fail_scope_and_workers():
    assert chaos.should_fail(ALL, "market_agent", FALLBACK, False, 3) is None  # primary: 대체 모델은 실패시키지 않는다
    assert chaos.should_fail({**ALL, "scope": "all"}, "market_agent", FALLBACK, False, 3) == "timeout"
    only_news = {**ALL, "workers": ["news_agent"]}
    assert chaos.should_fail(only_news, "market_agent", PRIMARY, True, 1) is None
    assert chaos.should_fail(only_news, "news_agent", PRIMARY, True, 1) == "timeout"


def test_should_fail_is_reproducible():
    config = {**ALL, "probability": 0.5, "errorTypes": ["timeout", "server_error", "bad_output"], "seed": 123456}

    def draw(seed):
        return [chaos.should_fail({**config, "seed": seed}, worker, model, True, attempt)
                for worker in ("market_agent", "news_agent") for model in (PRIMARY, FALLBACK) for attempt in range(1, 5)]
    first = draw(123456)
    assert draw(123456) == first  # 같은 seed → 같은 판정
    assert {None, "timeout", "server_error", "bad_output"} >= set(first) and None in first and len(set(first)) > 1
    assert any(draw(seed) != first for seed in range(1, 6))  # seed가 바뀌면 판정도 바뀐다


# --- 호출기에서 주입 ---

@pytest.fixture
def clock(monkeypatch):
    now = {"t": 1000.0, "slept": []}

    def sleep(seconds):
        now["slept"].append(seconds)
        now["t"] += seconds
    monkeypatch.setattr(healing, "clock", lambda: now["t"])
    monkeypatch.setattr(healing, "sleep", sleep)
    return now


@pytest.fixture
def running(user):
    return state.start(make_report(user))


def injected_trace(report):
    return [(e.action, e.model, e.details.get("errorType"), e.details.get("injected"))
            for e in report.trace_events.order_by("step")]


@pytest.mark.django_db
def test_injected_primary_recovers_on_fallback(running, fake_llm, clock):
    client = fake_llm({FALLBACK: [ANSWER]}, cost=0.03)
    llm = healing.make_caller(running, WORKER, ALL, client, 2000.0)
    reply = llm("s", "u")
    assert (reply.model, reply.attempts, reply.recovered, reply.cost_usd) == (FALLBACK, 3, True, 0.03)
    assert [call[0] for call in client.calls] == [FALLBACK]  # 주입한 주 모델은 부르지 않았다 (비용 0)
    assert clock["t"] == 1000.0  # 주입한 timeout은 실제로 기다리지 않는다
    assert injected_trace(running) == [("agent_failed", PRIMARY, "timeout", True),
                                       ("agent_retry", PRIMARY, None, None),
                                       ("agent_failed", PRIMARY, "timeout", True),
                                       ("agent_failover", FALLBACK, None, None)]


@pytest.mark.django_db
def test_injected_scope_all_gives_up(running, fake_llm, clock):
    client = fake_llm({})
    llm = healing.make_caller(running, WORKER, {**ALL, "scope": "all", "errorTypes": ["bad_output"]}, client, 2000.0)
    with pytest.raises(LlmGaveUp) as caught:
        llm("s", "u")
    assert (caught.value.error_type, caught.value.attempts) == (ErrorType.BAD_OUTPUT, 4)
    assert client.calls == [] and llm.cost_usd == 0


@pytest.mark.django_db
def test_injected_server_error_takes_real_recovery_path(running, fake_llm, clock):
    config = {**ALL, "errorTypes": ["server_error"], "workers": ["market_agent"]}
    healing.make_caller(running, WORKER, config, fake_llm({FALLBACK: [ANSWER]}), 2000.0)("s", "u")
    assert clock["slept"] == [healing.RETRY_BACKOFF_SEC]  # 진짜 server_error처럼 쉬고 같은 모델 재시도


@pytest.mark.django_db
def test_injected_failures_count_for_circuit_breaker(running, fake_llm, clock):
    healing.breaker.failed(PRIMARY, clock["t"])
    healing.make_caller(running, WORKER, ALL, fake_llm({FALLBACK: [ANSWER]}), 2000.0)("s", "u")
    assert healing.breaker.is_open(PRIMARY, clock["t"])  # 앞선 1번 + 주입 2번 = 연속 3번


@pytest.mark.django_db
def test_other_worker_not_injected(running, fake_llm, clock):
    config = {**ALL, "workers": ["news_agent"]}
    reply = healing.make_caller(running, WORKER, config, fake_llm({PRIMARY: [ANSWER]}), 2000.0)("s", "u")
    assert (reply.model, reply.attempts) == (PRIMARY, 1)


# --- 리포트 신청 ---

@pytest.fixture
def report_limit(monkeypatch):
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "3")


def post(client, body):
    return client.post("/api/reports", body, content_type="application/json")


@pytest.mark.django_db
def test_post_saves_chaos(api, stocks, report_limit):
    response = post(api, {"symbol": "005930", "chaos": {"enabled": True, "probability": 0.3, "seed": 99}})
    assert response.status_code == 201
    body = response.json()
    expected = {"enabled": True, "probability": 0.3, "errorTypes": ["timeout", "server_error", "bad_output"],
                "workers": None, "scope": "primary", "seed": 99}
    assert body["chaos"] == expected and body["chaosEnabled"] is True
    assert Report.objects.get().chaos == expected


@pytest.mark.django_db
def test_post_without_or_disabled_chaos(api, stocks, report_limit):
    assert post(api, {"symbol": "005930"}).json()["chaos"] is None
    assert post(api, {"symbol": "AAPL", "chaos": {"enabled": False}}).json()["chaos"] is None


@pytest.mark.django_db
def test_post_bad_chaos_is_400(api, stocks, report_limit):
    response = post(api, {"symbol": "005930", "chaos": {"enabled": True, "scope": "everything"}})
    assert response.status_code == 400 and response.json() == {"detail": "chaos.scope는 primary 또는 all입니다."}
    assert not Report.objects.exists()


# --- 리포트 전체 ---

@pytest.mark.django_db
def test_report_with_chaos_still_completes(user, fake_llm, clock, inline_workers, monkeypatch):
    """조사 Worker의 주 모델을 모두 실패시켜도 대체 모델로 복구해 리포트가 완성된다 (DR-LLM-01 모양)."""
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    report = make_report(user, chaos={**ALL, "workers": ["market_agent"]})
    market = FakeWorker("market_agent", llm=True, contract="MarketResult")
    client = fake_llm({FALLBACK: [SAMPLES["MarketResult"]]})
    orchestrator.run_report(report, workers=fake_team(market_agent=market), llm_client=client)

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    done = report.trace_events.get(actor="market_agent", action="agent_completed")
    assert done.model == FALLBACK and done.details["recovered"] is True and done.details["attempts"] == 3
    failures = report.trace_events.filter(actor="market_agent", action="agent_failed")
    assert [f.details["injected"] for f in failures] == [True, True]
