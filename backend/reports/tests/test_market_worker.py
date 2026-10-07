"""시세 Worker는 장마감 자료를 계산하고 LLM 수치를 사실값으로 덮어쓴다."""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from paper_engine.config import Config

from reports.agents.base import WorkerContext, WorkerError
from reports.agents.market import WORKER


def candle(day: int, close: float) -> dict:
    return {
        "timestamp": f"2026-09-{day:02d}T00:00:00+09:00",
        "openPrice": str(close - 1), "highPrice": str(close + 2), "lowPrice": str(close - 2),
        "closePrice": str(close), "volume": "1000",
    }


class FakeLlm:
    def __init__(self):
        self.calls = []
        self.cost_usd = 0.0

    def __call__(self, system, user, *, contract=None, timeout=None):
        self.calls.append({"system": system, "user": user, "contract": contract, "timeout": timeout})
        return SimpleNamespace(data={
            "trend": "up", "summary": "완성 일봉 기준으로 상승 흐름입니다.",
            "price": 1, "changePct": 999, "asOf": "잘못된 값", "rsi": 1,
            "volatilityPct": 1, "volumeRank": 1, "support": 1, "resistance": 1,
            "signals": ["종가 흐름이 이동평균선 위에 있습니다."], "evidence": ["AI가 적은 근거"],
        })


def context(llm, *, deadline=None):
    return WorkerContext(
        report_id=1, task_id="report-1", symbol="005930", name="삼성전자", market="KR",
        worker_id="market_agent", attempt=1, inputs={}, instructions=None, handoff=None, llm=llm,
        deadline=deadline or time.monotonic() + 10,
        cfg=Config(kiwoom_appkey=None, kiwoom_secretkey=None, token_cache=None), client=None,
    )


def test_market_worker_uses_completed_close_data_and_overwrites_llm_numbers(monkeypatch):
    rows = [candle(day, 100 + day) for day in range(1, 26)]
    monkeypatch.setattr("reports.agents.market.market.completed_candles", lambda symbol: rows)
    monkeypatch.setattr("reports.agents.market.market.closes", lambda symbols: {
        "005930": {"price": 125.0, "prevClose": 124.0, "date": "2026-09-25",
                   "asOf": "2026-09-25T15:30:00+09:00"},
    })
    llm = FakeLlm()

    result = WORKER.run(context(llm))

    assert result["price"] == 125.0
    assert result["changePct"] == pytest.approx((125 / 124 - 1) * 100, abs=0.0001)
    assert result["asOf"] == "2026-09-25T15:30:00+09:00"
    assert result["rsi"] == 100.0
    assert result["volumeRank"] is None
    assert (result["support"], result["resistance"]) == (104.0, 127.0)
    assert result["evidence"][0] == "완성 일봉 2026-09-01~2026-09-25 (25개)"
    assert llm.calls[0]["contract"] == "MarketResult"
    assert '"recentCandles"' in llm.calls[0]["user"]
    assert "current_prices" not in llm.calls[0]["user"]


def test_market_worker_raises_when_completed_candles_are_missing(monkeypatch):
    monkeypatch.setattr("reports.agents.market.market.completed_candles", lambda symbol: [])
    with pytest.raises(WorkerError, match="완성된 일봉"):
        WORKER.run(context(FakeLlm()))


def test_market_worker_raises_when_close_is_missing(monkeypatch):
    monkeypatch.setattr("reports.agents.market.market.completed_candles", lambda symbol: [candle(1, 100)])
    monkeypatch.setattr("reports.agents.market.market.closes", lambda symbols: {})
    with pytest.raises(WorkerError, match="직전 정규장 종가"):
        WORKER.run(context(FakeLlm()))


def test_market_worker_stops_before_lookup_after_deadline():
    with pytest.raises(WorkerError, match="제한 시간"):
        WORKER.run(context(FakeLlm(), deadline=time.monotonic() - 1))
