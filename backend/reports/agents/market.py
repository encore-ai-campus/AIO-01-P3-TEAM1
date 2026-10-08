"""직전 정규장 종가와 완성 일봉만 사용하는 시세·차트 Worker."""

from __future__ import annotations

import math
import time
from typing import Any

from paper_engine.data import indicators
from trading import market

from reports.contracts import validate

from .base import WorkerContext, WorkerError
from .prompts import market_user_prompt, system_prompt

RECENT_CANDLES = 20


def _number(value: Any, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise WorkerError(f"완성 일봉의 {field} 값이 올바르지 않습니다.") from None
    if not math.isfinite(number):
        raise WorkerError(f"완성 일봉의 {field} 값이 올바르지 않습니다.")
    return number


def _deadline(ctx: WorkerContext) -> float:
    remaining = ctx.deadline - time.monotonic()
    if remaining <= 0:
        raise WorkerError("시세·차트 분석 제한 시간을 넘었습니다.")
    return remaining


def _source(candles: list[dict]) -> str:
    first = str(candles[0].get("timestamp") or "")[:10]
    last = str(candles[-1].get("timestamp") or "")[:10]
    return f"완성 일봉 {first}~{last} ({len(candles)}개)"


class MarketWorker:
    id = "market_agent"
    output_contract = "MarketResult"

    def run(self, ctx: WorkerContext) -> dict:
        _deadline(ctx)
        candles = market.completed_candles(ctx.symbol)
        if not candles:
            raise WorkerError("완성된 일봉이 없어 시세·차트 분석을 진행할 수 없습니다.")

        _deadline(ctx)
        close = market.closes([ctx.symbol]).get(market.norm_symbol(ctx.symbol))
        if not isinstance(close, dict) or close.get("price") is None:
            raise WorkerError("직전 정규장 종가를 조회할 수 없습니다.")

        closes = [_number(candle.get("closePrice"), "종가") for candle in candles]
        highs = [_number(candle.get("highPrice"), "고가") for candle in candles]
        lows = [_number(candle.get("lowPrice"), "저가") for candle in candles]
        price = _number(close["price"], "직전 종가")
        previous = close.get("prevClose")
        previous = _number(previous, "전 거래일 종가") if previous is not None else None
        change_pct = (price / previous - 1) * 100 if previous else None
        rsi = indicators.rsi(closes)
        volatility = indicators.volatility(closes)
        atr = indicators.atr(highs, lows, closes)
        window = candles[-RECENT_CANDLES:]
        window_highs = highs[-len(window):]
        window_lows = lows[-len(window):]

        facts = {
            "price": price,
            "prevClose": previous,
            "changePct": round(change_pct, 4) if change_pct is not None else None,
            "asOf": close.get("asOf"),
            "rsi": round(rsi, 2) if rsi is not None else None,
            "volatilityPct": round(volatility * 100, 4) if volatility is not None else None,
            "atr": round(atr, 4) if atr is not None else None,
            "support": min(window_lows),
            "resistance": max(window_highs),
            "volumeRank": None,
            "recentCandles": [
                {
                    "date": str(candle.get("timestamp") or "")[:10],
                    "open": _number(candle.get("openPrice"), "시가"),
                    "high": _number(candle.get("highPrice"), "고가"),
                    "low": _number(candle.get("lowPrice"), "저가"),
                    "close": _number(candle.get("closePrice"), "종가"),
                    "volume": _number(candle.get("volume"), "거래량"),
                }
                for candle in window
            ],
        }
        reply = ctx.llm(
            system_prompt(self.id),
            market_user_prompt(symbol=ctx.symbol, name=ctx.name, market=ctx.market, data=facts),
            contract=self.output_contract,
            timeout=_deadline(ctx),
        )
        result = dict(reply.data)
        result.update({
            "price": facts["price"],
            "changePct": facts["changePct"],
            "asOf": facts["asOf"],
            "rsi": facts["rsi"],
            "volatilityPct": facts["volatilityPct"],
            "volumeRank": facts["volumeRank"],
            "support": facts["support"],
            "resistance": facts["resistance"],
            "evidence": [_source(candles), *(result.get("evidence") or [])],
        })
        return validate(self.output_contract, result)


WORKER = MarketWorker()
