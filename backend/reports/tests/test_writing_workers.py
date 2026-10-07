"""작성·검토·리스크 Worker의 입력 전달과 계약을 검증한다."""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from paper_engine.config import Config

from reports.agents.base import WorkerContext, WorkerError
from reports.agents.report import WORKER as REPORT
from reports.agents.review import WORKER as REVIEW
from reports.agents.risk import WORKER as RISK
from reports.contracts import ContractError


REPORT_DATA = {
    "title": "삼성전자 분석", "verdict": "hold", "oneLiner": "AI 의견은 관망입니다.",
    "plainSummary": ["실적은 안정적입니다.", "가격 흐름은 지켜볼 만합니다.", "위험도 확인이 필요합니다."],
    "markdown": "## 분석\n확인된 자료만 사용했습니다.",
    "reasons": ["확인된 실적"], "risks": ["이 의견이 틀리는 경우: 실적이 악화될 때"],
    "targets": {"entry": None, "target": None, "stop": None, "holdingDays": None, "probability": None},
    "confidence": None, "citations": ["DART 반기보고서"],
}


class FakeLlm:
    def __init__(self, data):
        self.data = data
        self.calls = []
        self.cost_usd = 0.0

    def __call__(self, system, user, *, contract=None, timeout=None):
        self.calls.append((system, user, contract, timeout))
        return SimpleNamespace(data=self.data)


def context(worker_id, llm, *, inputs=None, instructions=None, handoff=None, client=None, deadline=None):
    return WorkerContext(
        report_id=1, task_id="report-1", symbol="005930", name="삼성전자", market="KR",
        worker_id=worker_id, attempt=1, inputs=inputs or {}, instructions=instructions,
        handoff=handoff, llm=llm, deadline=deadline if deadline is not None else time.monotonic() + 10,
        cfg=Config(kiwoom_appkey=None, kiwoom_secretkey=None, token_cache=None), client=client,
    )


def test_report_receives_all_research_and_revision_instructions():
    research = {"market_agent": {"price": 70_000}, "fundamental_agent": {"summary": "실적"},
                "news_agent": {"summary": "뉴스"}}
    llm = FakeLlm(REPORT_DATA)
    result = REPORT.run(context("report_agent", llm, inputs=research, instructions="근거를 고치세요"))
    assert result["verdict"] == "hold"
    assert all(key in llm.calls[0][1] for key in research)
    assert "근거를 고치세요" in llm.calls[0][1]
    assert llm.calls[0][2] == "ReportDraft"


def test_report_rejects_numeric_plain_summary():
    llm = FakeLlm({**REPORT_DATA, "plainSummary": ["수익률은 5%입니다."]})
    with pytest.raises(ContractError, match="plainSummary"):
        REPORT.run(context("report_agent", llm))


def test_review_receives_draft_and_research_with_retry_instructions():
    inputs = {"report_agent": REPORT_DATA, "market_agent": {"price": 70_000},
              "fundamental_agent": {"summary": "실적"}, "news_agent": {"summary": "뉴스"}}
    llm = FakeLlm({"verdict": "RETRY", "score": 60, "issues": [],
                   "instructions": "쉬운 요약을 근거와 맞추세요.", "handoff": None})
    result = REVIEW.run(context("review_agent", llm, inputs=inputs))
    assert result["instructions"] == "쉬운 요약을 근거와 맞추세요."
    assert all(key in llm.calls[0][1] for key in inputs)
    assert llm.calls[0][2] == "ReviewResult"


def test_review_requires_draft():
    with pytest.raises(WorkerError, match="초안"):
        REVIEW.run(context("review_agent", FakeLlm({}), inputs={"market_agent": {}}))


def test_risk_uses_broker_and_snapshot_warnings_without_user_id():
    class Client:
        def warnings(self, symbol):
            assert symbol == "005930"
            return [{"warningType": "투자주의", "description": "시장 경고"}]

    llm = FakeLlm({"level": "high", "flags": ["투자주의"], "warnings": ["시장 경고"],
                   "summary": "투자 유의 정보가 있습니다."})
    result = RISK.run(context(
        "risk_agent", llm, inputs={"market_agent": {"warnings": ["변동성 주의"]}},
        handoff={"objective": "고위험 확인", "constraints": ["근거만 사용"], "user_id": 123}, client=Client(),
    ))
    assert result["level"] == "high"
    assert "변동성 주의" in llm.calls[0][1] and "투자주의" in llm.calls[0][1]
    assert "고위험 확인" in llm.calls[0][1]
    assert "user_id" not in llm.calls[0][1] and "123" not in llm.calls[0][1]
    assert llm.calls[0][2] == "RiskResult"


def test_risk_lookup_failure_is_worker_error():
    class Client:
        def warnings(self, symbol):
            raise OSError("broker down")

    with pytest.raises(WorkerError, match="투자 유의"):
        RISK.run(context("risk_agent", FakeLlm({}), client=Client()))
