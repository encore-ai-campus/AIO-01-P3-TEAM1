"""reports 테스트 공용: 로그인한 클라이언트, 가짜 종목 확인(증권사를 부르지 않는다), 리포트 만들기, 가짜 LLM(fake_llm),
가짜 Worker(fake_worker·fake_team, 계약별 예시 결과 SAMPLES), 스레드 없는 Worker 실행(inline_workers)."""
import copy
import threading
import time

import pytest
from accounts.models import profile_of
from paper_engine.llm import LlmError, LlmTimeout
from trading import market

from config.api import Unavailable
from reports.autohealing import healing
from reports.orchestration import registry
from reports.models import Report

STOCKS = {
    "005930": {"symbol": "005930", "name": "삼성전자", "exchange": "KOSPI", "market": "KR"},
    "AAPL": {"symbol": "AAPL", "name": "Apple", "exchange": "NASDAQ", "market": "US"},
}


@pytest.fixture
def user(django_user_model):
    user = django_user_model.objects.create_user(username="alice", password="pw-alice-123")
    profile = profile_of(user)
    profile.nickname = "앨리스"
    profile.save()
    return user


@pytest.fixture
def other(django_user_model):
    return django_user_model.objects.create_user(username="bob", password="pw-bob-123")  # 닉네임은 기본값(아이디)


@pytest.fixture
def api(client, user):
    client.force_login(user)
    return client


@pytest.fixture
def stocks(monkeypatch):
    """trading.market.stock_item을 가짜로. broker_ready=False로 바꾸면 증권사 조회 불가(503)."""
    fake = {"broker_ready": True, "calls": []}

    def stock_item(symbol):
        fake["calls"].append(symbol)
        if not fake["broker_ready"]:
            raise Unavailable("증권사 조회 키가 없어 시세를 조회할 수 없습니다.")
        return STOCKS.get(symbol.strip().upper())
    monkeypatch.setattr(market, "stock_item", stock_item)
    return fake


def make_report(user, symbol="005930", **fields) -> Report:
    stock = STOCKS[symbol]
    return Report.objects.create(user=user, symbol=symbol, name=stock["name"], market=stock["market"], **fields)


class FakeLlm:
    """가짜 LLM 클라이언트 (담당 4, docs/tasks/00-공통.md 11절). `complete_json_once`와 같은 서명이다.

    script: 모델 이름 → 호출 순서대로의 결과 목록.
      - "timeout" → LlmTimeout, "server_error" → LlmError("HTTP 503 …"), "bad_output" → LlmError("JSON 객체가 없는 응답 …")
      - dict → 그 응답 (비용은 cost)
      - {"__delay__": 초} → 그만큼 걸린 뒤 다음 항목을 이 호출의 결과로 쓴다. 제한 시간보다 길면 제한 시간만큼 걸린 뒤 LlmTimeout
    calls: 받은 호출 (model, system, user, timeout) 순서대로. 대본에 없는 모델이나 다 쓴 대본을 부르면 AssertionError.
    """

    def __init__(self, script: dict[str, list], cost: float = 0.01, sleep=time.sleep):
        self.script = {model: list(items) for model, items in script.items()}
        self.cost, self.sleep = cost, sleep
        self.calls: list[tuple[str, str, str, float]] = []

    def complete_json_once(self, model: str, system: str, user: str, timeout: float) -> tuple[dict, float]:
        self.calls.append((model, system, user, timeout))
        item = self._next(model)
        if isinstance(item, dict) and "__delay__" in item:
            delay = item["__delay__"]
            if delay >= timeout:
                self.sleep(timeout)
                raise LlmTimeout(f"{timeout}초 안에 응답 없음")
            self.sleep(delay)
            item = self._next(model)
        if item == "timeout":
            raise LlmTimeout(f"{timeout}초 안에 응답 없음")
        if item == "server_error":
            raise LlmError("HTTP 503: 가짜 서버 오류")
        if item == "bad_output":
            raise LlmError("JSON 객체가 없는 응답: '가짜 응답'")
        assert isinstance(item, dict), f"FakeLlm 대본의 항목이 잘못됨: {item!r}"
        return dict(item), self.cost

    def _next(self, model: str):
        items = self.script.get(model)
        assert items, f"FakeLlm: {model}의 대본이 없거나 다 썼습니다"
        return items.pop(0)


@pytest.fixture(autouse=True)
def _reset_circuit_breaker():
    """Circuit Breaker는 프로세스 전역이라 테스트끼리 섞이지 않게 비운다."""
    healing.breaker.reset()
    yield
    healing.breaker.reset()


@pytest.fixture
def fake_llm():
    """FakeLlm 만들기: `client = fake_llm({"gemini-3.8-flash": ["timeout", {"trend": "up"}]})`."""
    return FakeLlm


# 출력 계약마다 계약을 통과하는 예시 결과 (가짜 Worker의 기본 결과). 고쳐 쓸 때는 copy.deepcopy로
SAMPLES = {
    "MarketResult": {"trend": "up", "summary": "20일 이동평균 위에서 오르는 흐름", "price": 70000, "changePct": 1.5,
                     "asOf": "2026-10-06T15:30:00+09:00", "rsi": 58.2, "volatilityPct": 1.8, "volumeRank": 3,
                     "support": 68000, "resistance": 72000, "stop": 66000, "priceBasis": "close", "signals": ["20일선 위"],
                     "evidence": ["일봉 120개"]},
    "FundamentalResult": {"summary": "영업이익이 늘었다", "metrics": {"per": 12.0, "pbr": 1.1, "roe": 9.5,
                                                               "revenueGrowthPct": 5.0, "opMarginPct": 11.0},
                          "recentFilings": [{"date": "2026-09-30", "title": "분기보고서", "impact": "neutral"}],
                          "evidence": ["DART 분기보고서"]},
    "NewsResult": {"sentiment": "positive", "score": 0.4, "summary": "신제품 기사가 많다",
                   "headlines": [{"date": "2026-10-05", "title": "신제품 발표", "source": "연합뉴스", "impact": "positive"}],
                   "evidence": ["연합뉴스 2026-10-05"]},
    "ReportDraft": {"title": "삼성전자 종목 리포트", "verdict": "hold", "oneLiner": "AI 의견은 지켜보기",
                    "plainSummary": ["주가가 오르는 흐름이에요", "실적은 안정적이에요"], "markdown": "# 삼성전자\n\n본문",
                    "reasons": ["추세 상승"], "risks": ["가격이 크게 오르내릴 수 있음"],
                    "targets": {"entry": 70000, "target": 77000, "stop": 66000, "holdingDays": 10, "probability": 0.5},
                    "confidence": 60, "citations": ["일봉"]},
    "ReviewResult": {"verdict": "PASS", "score": 85, "issues": [], "instructions": None, "handoff": None},
    "RiskResult": {"level": "high", "flags": ["투자경고"], "warnings": ["투자경고 종목입니다"], "summary": "투자경고 지정"},
    "CandidateNewsResult": {"summary": "후보 뉴스 정리", "items": [
        {"symbol": "005930", "sentiment": "positive", "materials": ["신제품"], "concerns": [], "theme": "반도체",
         "evidence": ["연합뉴스"]}]},
    "FilingCheckResult": {"summary": "공시 점검", "items": [
        {"symbol": "005930", "severity": "none", "signals": [], "evidence": []}]},
    "FlowResult": {"summary": "수급 해석", "items": [{"symbol": "005930", "signal": "accumulating", "note": "외국인 순매수"}]},
    "SelectionDraft": {"summary": "반도체 중심으로 골랐다", "picks": [
        {"symbol": "005930", "rank": 1, "reason": "신제품 재료", "evidence": ["뉴스"]},
        {"symbol": "000660", "rank": 2, "reason": "수급 개선", "evidence": []}]},
}
RETRY_REVIEW = {"verdict": "RETRY", "score": 60, "issues": [{"claim": "목표가 77000원", "problem": "근거가 없다",
                                                            "fix": "조사 결과에서 인용한다"}],
                "instructions": "목표가 근거를 조사 결과에서 인용하세요", "handoff": None}
FAIL_REVIEW = {"verdict": "FAIL", "score": 20, "issues": [], "instructions": None, "handoff": None}


class FakeWorker:
    """가짜 Worker (담당 3, T3-2). 정해진 결과를 돌려주거나 예외를 내고, 받은 ctx를 calls에 남긴다
    (테스트가 attempt·instructions·inputs·handoff·team_inputs를 확인한다).

    result: dict(복사본을 돌려준다) · 예외(그것을 낸다) · 함수(ctx → dict). error: 실행마다 낼 예외 (result보다 먼저).
    script: 실행마다 하나씩 쓰는 결과 목록 (다 쓰면 error·result). 검토 RETRY → PASS처럼 시도마다 다른 결과.
    delay: 실제로 쉬는 초. gate: threading.Event — set될 때까지(최대 10초) 기다린다 (시간 초과 시험).
    llm: True면 ctx.llm(...)을 출력 계약과 함께 한 번 부르고 그 응답(data)을 결과로 쓴다 (healing 호출기와 같이 시험).
    finished: run이 끝나면(성공·예외) set된다.
    """

    def __init__(self, id, result=None, *, error=None, script=None, delay=0.0, gate=None, llm=False, contract=""):
        self.id, self.output_contract = id, contract
        self.result, self.error, self.script = result, error, list(script or [])
        self.delay, self.gate, self.llm = delay, gate, llm
        self.calls: list = []
        self.finished = threading.Event()

    def run(self, ctx) -> dict:
        self.calls.append(ctx)
        try:
            if self.gate is not None:
                self.gate.wait(10)
            if self.delay:
                time.sleep(self.delay)
            item = self.script.pop(0) if self.script else (self.error if self.error is not None else self.result)
            if isinstance(item, BaseException):
                raise item
            if self.llm:
                return ctx.llm(f"{self.id} 역할", f"{self.id} 자료", contract=self.output_contract or None).data
            if callable(item):
                item = item(ctx)
            return copy.deepcopy(item)
        finally:
            self.finished.set()


def fake_team(team: str = registry.TEAM, **overrides) -> dict:
    """팀 실행 계획의 Worker 전부를 가짜로 (기본 결과는 계약별 SAMPLES). overrides: Worker id → FakeWorker 또는 result 값."""
    workers = {}
    for worker in registry.execution_plan(team)["workers"]:
        wid, contract = worker["id"], worker["outputContract"]
        value = overrides.pop(wid, SAMPLES[contract])
        workers[wid] = value if isinstance(value, FakeWorker) else FakeWorker(wid, value, contract=contract)
    assert not overrides, f"계획에 없는 Worker: {sorted(overrides)}"
    return workers


@pytest.fixture
def fake_worker():
    """FakeWorker 만들기: `fake_worker("market_agent", {...})`, `fake_worker("news_agent", error=WorkerError("..."))`."""
    return FakeWorker


@pytest.fixture
def inline_workers(monkeypatch):
    """Orchestrator가 Worker를 스레드 없이 부른 스레드에서 돌리게 한다 (테스트 DB 트랜잭션 안에서 돈다)."""
    from reports.orchestration import orchestrator

    monkeypatch.setattr(orchestrator, "make_executor", lambda workers: orchestrator.InlineExecutor())
