"""analysis 테스트 공용: 실행 기록 폴더(tmp), 가짜 엔진 설정, 로그인한 클라이언트, 실행 기록 만들기.

실행 기록은 엔진 cmd_analyze의 log 구조를 엔진의 Candidate·Scenario dataclass로 만든다 (dataclasses.asdict 한 실제 모양).
"""
import dataclasses
import json

import pytest
from paper_engine.config import Config, ModelSpec
from paper_engine.judge.reach import check_reach
from paper_engine.judge.risk import AccountContext, assess
from paper_engine.judge.scenario import Scenario
from paper_engine.judge.verdict import Approval, Candidate, Critique

from config import engine

ACCOUNT = AccountContext(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.0)
SECRET = "devpass-secret-value-123"


def ai_config(**changes) -> Config:
    base = Config(kiwoom_appkey="app-key-xyz", kiwoom_secretkey="kiwoom-secret-xyz", token_cache=None,
                  llm_api_key=SECRET, analysts=(ModelSpec("gpt", "medium"),), paper_capital_krw=10_000_000)
    return dataclasses.replace(base, **changes)


@pytest.fixture
def runs(tmp_path, monkeypatch):
    path = tmp_path / "runs"
    path.mkdir()
    monkeypatch.setattr(engine, "RUNS_DIR", path)
    return path


@pytest.fixture
def ai(monkeypatch):
    """AI 키와 증권사 키가 있는 엔진 설정. 다른 설정이 필요하면 set_config(...)."""
    state = {"cfg": ai_config()}
    monkeypatch.setattr(engine, "engine_config", lambda: state["cfg"])

    def set_config(**changes):
        state["cfg"] = ai_config(**changes)
    return set_config


@pytest.fixture
def limits(monkeypatch):
    monkeypatch.setenv("AI_DAILY_ANALYSES_PER_USER", "5")
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "10")


@pytest.fixture
def user(django_user_model):
    return django_user_model.objects.create_user(username="alice", password="pw-alice-123")


@pytest.fixture
def api(client, user):
    client.force_login(user)
    return client


def candidate(cid="S1", proposer="gpt", score=72.0, approved=True, entry=100_000, target=115_000, stop=95_000):
    s = Scenario(symbol="005930", currency="KRW", horizon="SWING", entry_price=entry, target_price=target,
                 stop_price=stop, probability=0.55, holding_days=10, analyst=proposer,
                 rationale=["20일선 위에서 거래량이 늘었다", "외국인 순매수 5일 연속"],
                 invalidation="종가가 20일선 아래로 내려가면 무효")
    final = dataclasses.replace(s, probability=0.5)
    return Candidate(id=cid, proposer=proposer, raw={}, scenario=s, final=final, proposer_score=80, score=score,
                     participation=1.0, consensus_probability=0.5, assessment=assess(final, ACCOUNT),
                     critiques=[Critique("gemini", score, 0.5, ["목표가가 직전 고점 바로 아래다"], "실행할 만하다")],
                     approval=Approval(approved, "근거가 데이터와 맞는다", ["환율"], "claude") if approved else None,
                     reach=check_reach(entry, target, 10, 4_000))


def fact_failed(cid="S9"):
    raw = {"horizon": "SWING", "entryPrice": 130_000, "targetPrice": 150_000, "stopPrice": 120_000,
           "probability": 0.6, "holdingDays": 7, "rationale": [{"claim": "근거 없는 주장"}], "invalidation": "없음"}
    return Candidate(id=cid, proposer="deepseek", raw=raw, fact_errors=["entryPrice가 현재가에서 5% 넘게 벗어남"])


def entry(symbol="005930", name="삼성전자", candidates=(), currency="KRW", last=100_000, cost=0.31, **extra):
    snapshot = {"symbol": symbol, "name": name, "market": "KOSPI" if currency == "KRW" else "NASDAQ",
                "marketCountry": "KR" if currency == "KRW" else "US", "currency": currency, "lastPrice": last,
                "indicators": {"rsi14": 55.0, "sma20": 98_000.5, "change5d": None},
                "news": [{"title": "수주 공시", "url": "https://example.com/1"}, {"title": "실적 전망"}],
                "webResearch": {"researchers": [{"id": "R1", "findings": [
                    {"claim": "수주 공시", "direction": "POSITIVE", "date": "2026-09-28", "sourceTitle": "출처",
                     "sourceUrl": "https://example.com", "sourceVerified": True}], "upcomingEvents": []}]}}
    return {"snapshot": snapshot, "research": {"researchers": {"R1": "gpt-research"}, "errors": [], "timedOut": []},
            "errors": ["검증 누락: S7"], "stages": [], "excluded": [], "costUsd": cost,
            "candidates": [dataclasses.asdict(c) | {"passed": c.passed, "selected": c.selected,
                                                    "rejectReasons": c.reject_reasons} for c in candidates]} | extra


def error_entry(symbol="000660", name="SK하이닉스"):
    return {"snapshot": {"symbol": symbol, "name": name, "marketCountry": "KR", "currency": "KRW",
                         "lastPrice": 200_000}, "modelResponseError": "gpt 시간 초과", "costUsd": 0.05}


def run_log(*entries, started="2026-10-02T09:00:00+09:00", requested_by="alice", strategy=None):
    return {"startedAt": started, "strategy": strategy, "tag": None, "paperBuy": False, "requestedBy": requested_by,
            "results": list(entries), "costUsd": 0.5}


def write_run(runs_dir, name, log) -> str:
    (runs_dir / name).write_text(json.dumps(log, ensure_ascii=False), encoding="utf-8")
    return f"runs/{name}"
