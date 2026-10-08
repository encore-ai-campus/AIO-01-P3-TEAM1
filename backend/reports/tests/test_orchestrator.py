"""Orchestrator 정상 경로와 2026-10-08 Q3·Q4 결정."""

import copy

import pytest

from reports import orchestrator, registry
from reports.agents.base import WorkerError
from reports.tests.conftest import make_report


MARKET = {
    "trend": "up", "summary": "상승 흐름", "price": 70000, "changePct": 1.2,
    "rsi": 55, "volatilityPct": None, "volumeRank": 3, "support": 68000, "resistance": 72000,
    "signals": ["이동평균선 위"], "evidence": ["완성 일봉"],
}
FUNDAMENTAL = {
    "summary": "재무 요약",
    "metrics": {"per": 12, "pbr": 1.2, "roe": None, "revenueGrowthPct": 4, "opMarginPct": 8},
    "recentFilings": [], "evidence": ["전자공시"],
}
NEWS = {
    "sentiment": "neutral", "score": 0, "summary": "뉴스 요약", "headlines": [], "evidence": ["뉴스"],
}
DRAFT = {
    "title": "삼성전자 리포트", "verdict": "hold", "oneLiner": "AI 의견은 관망입니다.",
    "plainSummary": ["가격 흐름을 더 지켜봐야 한다는 의견이에요."], "markdown": "## 최종 본문",
    "reasons": ["확인된 자료"], "risks": ["이 의견이 틀리는 경우를 확인해야 합니다."],
    "targets": {"entry": None, "target": None, "stop": None, "holdingDays": None, "probability": None},
    "confidence": 70, "citations": ["완성 일봉"],
}
PASS = {"verdict": "PASS", "score": 90, "issues": [], "instructions": None, "handoff": None}


class SequenceWorker:
    def __init__(self, worker_id, output_contract, results):
        self.id = worker_id
        self.output_contract = output_contract
        self.results = list(results)
        self.calls = []

    def run(self, ctx):
        self.calls.append(ctx)
        return self.results.pop(0)


def workers(fake_worker, *, news_error=None, market_delay=0):
    return {
        "market_agent": fake_worker("market_agent", result=MARKET, delay=market_delay),
        "fundamental_agent": fake_worker("fundamental_agent", result=FUNDAMENTAL),
        "news_agent": fake_worker("news_agent", result=NEWS, error=news_error),
        "report_agent": fake_worker("report_agent", result=DRAFT),
        "review_agent": fake_worker("review_agent", result=PASS),
        "risk_agent": fake_worker("risk_agent", result={}),
    }


@pytest.mark.django_db(transaction=True)
def test_review_receives_latest_draft_and_all_research(user, fake_worker):
    report = make_report(user)
    worker_map = workers(fake_worker)

    orchestrator.run_report(report, workers=worker_map, llm_client=object())

    assert report.status == "completed"
    assert report.content == "## 최종 본문"
    assert list(worker_map["report_agent"].calls[0].inputs) == [
        "market_agent", "fundamental_agent", "news_agent",
    ]
    assert list(worker_map["review_agent"].calls[0].inputs) == [
        "market_agent", "fundamental_agent", "news_agent", "report_agent",
    ]


@pytest.mark.django_db(transaction=True)
def test_optional_news_failure_is_omitted_from_compose_and_review(user, fake_worker):
    report = make_report(user)
    worker_map = workers(fake_worker, news_error=WorkerError("뉴스 없음"))

    orchestrator.run_report(report, workers=worker_map, llm_client=object())

    assert report.status == "completed"
    assert list(worker_map["report_agent"].calls[0].inputs) == ["market_agent", "fundamental_agent"]
    assert list(worker_map["review_agent"].calls[0].inputs) == [
        "market_agent", "fundamental_agent", "report_agent",
    ]


@pytest.mark.django_db(transaction=True)
def test_required_worker_timeout_uses_timeout_reason(user, fake_worker, monkeypatch):
    plan = copy.deepcopy(registry.execution_plan())
    plan["steps"][0]["timeoutSec"] = 0.01
    monkeypatch.setattr(orchestrator.registry, "execution_plan", lambda: copy.deepcopy(plan))
    report = make_report(user)

    orchestrator.run_report(
        report,
        workers=workers(fake_worker, market_delay=0.05),
        llm_client=object(),
    )

    assert report.status == "failed"
    failed = report.trace_events.filter(action="workflow_failed").latest("step")
    assert failed.details["reason"] == "timeout"


@pytest.mark.django_db(transaction=True)
def test_review_retry_increments_worker_attempt_and_passes_instructions(user, fake_worker):
    report = make_report(user)
    worker_map = workers(fake_worker)
    retry = {
        "verdict": "RETRY", "score": 60,
        "issues": [{"claim": "주장", "problem": "근거 부족", "fix": "근거와 맞추기"}],
        "instructions": "근거와 맞게 다시 작성하세요.", "handoff": None,
    }
    worker_map["review_agent"] = SequenceWorker("review_agent", "ReviewResult", [retry, PASS])

    orchestrator.run_report(report, workers=worker_map, llm_client=object())

    assert report.status == "completed"
    assert [ctx.attempt for ctx in worker_map["report_agent"].calls] == [1, 2]
    assert worker_map["report_agent"].calls[1].instructions == "근거와 맞게 다시 작성하세요."
    started = list(report.trace_events.filter(actor="report_agent", action="agent_started").order_by("step"))
    assert [event.details["attempt"] for event in started] == [1, 2]


@pytest.mark.django_db(transaction=True)
def test_guard_metadata_is_kept_in_trace_not_public_result(user, fake_worker):
    report = make_report(user)
    worker_map = workers(fake_worker)
    worker_map["news_agent"].result = {**NEWS, "_guarded": ["news[0].title: 이전 지시 무시 문구 제거"]}

    orchestrator.run_report(report, workers=worker_map, llm_client=object())

    assert "_guarded" not in report.results["news_agent"]
    completed = report.trace_events.get(actor="news_agent", action="agent_completed")
    assert completed.details["guarded"] == ["news[0].title: 이전 지시 무시 문구 제거"]
