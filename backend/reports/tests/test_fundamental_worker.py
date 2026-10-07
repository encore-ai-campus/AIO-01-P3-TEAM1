"""재무 Worker는 조회 실패를 자료 없음으로 처리하고 사실 수치를 고정한다."""

from __future__ import annotations

import time
from types import SimpleNamespace

from paper_engine.config import Config

from reports.agents.base import WorkerContext
from reports.agents.fundamental import WORKER


class FakeLlm:
    def __init__(self, filings=None):
        self.calls = []
        self.cost_usd = 0.0
        self.filings = filings or []

    def __call__(self, system, user, *, contract=None, timeout=None):
        self.calls.append({"system": system, "user": user, "contract": contract, "timeout": timeout})
        return SimpleNamespace(data={
            "summary": "확인된 재무와 공시 자료를 요약했습니다.",
            "metrics": {"per": 999, "pbr": 999, "roe": 999,
                        "revenueGrowthPct": 999, "opMarginPct": 999},
            "recentFilings": self.filings,
            "evidence": ["AI가 만든 출처"],
        })


def context(llm, *, dart_key=None, data_key=None, market="KR"):
    return WorkerContext(
        report_id=1, task_id="report-1", symbol="005930", name="삼성전자", market=market,
        worker_id="fundamental_agent", attempt=1,
        inputs={"market_agent": {"price": 70_000}}, instructions=None, handoff=None, llm=llm,
        deadline=time.monotonic() + 10,
        cfg=Config(kiwoom_appkey=None, kiwoom_secretkey=None, token_cache=None,
                   dart_api_key=dart_key, data_gokr_api_key=data_key),
        client=None,
    )


def test_without_dart_key_calls_llm_with_no_data_and_null_metrics(monkeypatch):
    monkeypatch.setattr("reports.agents.fundamental.DartClient", lambda *args: (_ for _ in ()).throw(AssertionError()))
    llm = FakeLlm(filings=[{"date": "2026-10-01", "title": "가짜 공시", "impact": "positive"}])

    result = WORKER.run(context(llm))

    assert result["metrics"] is None
    assert result["recentFilings"] == []
    assert result["evidence"] == ["재무·공시 자료 없음 (DART_API_KEY가 없어 자료를 조회하지 못했습니다.)"]
    assert "DART_API_KEY가 없어" in llm.calls[0]["user"]
    assert llm.calls[0]["contract"] == "FundamentalResult"


def test_dart_failure_still_returns_result_with_null_metrics(monkeypatch):
    class BrokenDart:
        def __init__(self, *args):
            pass

        def fundamentals(self, *args):
            raise OSError("DART down")

        def disclosures(self, *args):
            raise AssertionError("fundamentals 실패 뒤에는 호출되지 않음")

    monkeypatch.setattr("reports.agents.fundamental.DartClient", BrokenDart)
    llm = FakeLlm()

    result = WORKER.run(context(llm, dart_key="test-key"))

    assert result["metrics"] is None and result["recentFilings"] == []
    assert "DART 조회 실패: OSError" in result["evidence"][0]
    assert "DART 조회 실패: OSError" in llm.calls[0]["user"]


def test_verified_dart_and_fina_facts_override_llm_values(monkeypatch):
    class Dart:
        def __init__(self, *args):
            pass

        def fundamentals(self, symbol, price, today):
            assert symbol == "005930" and price == 70_000
            return {
                "source": "DART", "report": {"label": "2026 반기보고서", "receivedAt": "2026-08-14"},
                "reported": {"roe": 0.1234},
                "ratios": {"per": 12.3, "pbr": 1.4, "annualRevenueGrowth": 0.15,
                           "operatingMargin": 0.08},
            }

        def disclosures(self, symbol, today):
            return {"items": [{"date": "2026-10-01", "title": "공급계약 체결", "filer": "삼성전자"}]}

        def jurir_no(self, symbol):
            return "1301110006246"

    class Fina:
        def __init__(self, key):
            assert key == "data-key"

        def annual_history(self, number):
            assert number == "1301110006246"
            return {"source": "data.go.kr", "years": [{"year": 2025}, {"year": 2024}]}

    monkeypatch.setattr("reports.agents.fundamental.DartClient", Dart)
    monkeypatch.setattr("reports.agents.fundamental.FinaStatClient", Fina)
    llm = FakeLlm(filings=[
        {"date": "2026-10-01", "title": "공급계약 체결", "impact": "positive"},
        {"date": "2026-10-02", "title": "가짜 공시", "impact": "negative"},
    ])

    result = WORKER.run(context(llm, dart_key="dart-key", data_key="data-key"))

    assert result["metrics"] == {
        "per": 12.3, "pbr": 1.4, "roe": 12.34, "revenueGrowthPct": 15.0, "opMarginPct": 8.0,
    }
    assert result["recentFilings"] == [
        {"date": "2026-10-01", "title": "공급계약 체결", "impact": "positive"},
    ]
    assert result["evidence"] == [
        "DART · 2026 반기보고서 · 2026-08-14",
        "data.go.kr 연간 재무 2024~2025",
        "공시 2026-10-01 · 공급계약 체결",
    ]
    assert '"annualHistory"' in llm.calls[0]["user"]


def test_us_market_is_no_data_without_creating_dart_client(monkeypatch):
    monkeypatch.setattr("reports.agents.fundamental.DartClient", lambda *args: (_ for _ in ()).throw(AssertionError()))
    result = WORKER.run(context(FakeLlm(), dart_key="dart-key", market="US"))
    assert result["metrics"] is None
    assert "국내 종목만 지원" in result["evidence"][0]
