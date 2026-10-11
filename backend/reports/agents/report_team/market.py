"""시세·차트 Worker `market_agent` (docs/tasks/02-worker.md T2-4, 00-공통.md 10절, docs/API.md 공통 규칙 "리포트 시세").

자료: 가격은 만들 때의 가격이다 — 기준일 뒤 정규장이 시작됐으면(`trading.market.traded_since_basis`, 장 중) 현재가(`live_prices`),
아니면(또는 현재가를 받지 못하면) `closes`의 직전 정규장 종가. 지표는 `completed_candles`(완성 봉만)로 코드가 계산한다.
LLM은 추세·신호·요약만 쓰고, 응답의 숫자(price·changePct·asOf·priceBasis·rsi·volatilityPct·support·resistance·volumeRank)는
자료 값으로 덮어쓴다 (LLM이 숫자를 지어내지 않게). 일봉·가격이 없으면 WorkerError.
stop은 코드가 정한 손절 가격이다 (엔진 judge/stops.py, 기준가 = price). 시세 LLM에는 보여 주지 않고 결과에만 넣는다.
작성 AI(report_agent)는 이 값을 손절 가격으로 받아 쓴다.
"""
import math
from datetime import datetime
from zoneinfo import ZoneInfo

from django.utils import timezone
from paper_engine.data import indicators
from paper_engine.judge import stops
from trading import market

from config.api import Unavailable

from ..base import WorkerContext, WorkerError
from ..prompts import system_prompt, user_prompt

KST = ZoneInfo("Asia/Seoul")
WINDOW = 20         # 변동성·지지·저항을 보는 최근 완성 봉 수
RECENT_ROWS = 20    # 프롬프트에 넣는 최근 일봉 수
MAX_EVIDENCE = 8    # MarketResult.evidence 상한
DATA_KEYS = ("price", "changePct", "asOf", "priceBasis", "rsi", "volatilityPct", "support", "resistance", "volumeRank",
             "stop")
CURRENCY = {"KR": "KRW", "US": "USD"}
CLOSE_KEYS = ("price", "prevClose", "changePct", "date", "asOf", "priceBasis")
HIDDEN_KEYS = ("stop",)  # 결과에만 넣고 시세 LLM의 프롬프트에는 넣지 않는 값

ROLE = ("너는 모의투자 서비스 '모매매'의 AI 리포트 팀에서 시세·차트를 맡은 조사 AI다. "
        "기준 가격(장 중이면 그때 가격, 아니면 직전 종가)과 완성된 일봉으로 코드가 계산한 지표를 보고 추세·변동성·가격대를 정리한다.")
RULES = """- price·changePct·asOf·priceBasis·rsi·volatilityPct·support·resistance·volumeRank는 "코드가 계산한 값"을 그대로 옮긴다 (자료에 없으면 null). 코드가 다시 덮어쓴다.
- trend는 이동평균(sma20·sma60)과 등락률(change5dPct·change20dPct)로 정한다: 오르는 흐름이면 up, 내리는 흐름이면 down, 뚜렷하지 않으면 sideways.
- signals는 자료로 확인되는 짧은 관찰 문장이다 (예: "종가가 20일 이동평균 위", "RSI 70 이상 과열권").
- summary는 두세 문장으로 쓰고 가격의 기준을 밝힌다: priceBasis가 live면 price는 asOf 시각의 장중 가격이고 changePct는 그 가격을 직전 정규장 종가(prevClose)와 비교한 값이다.
  close면 price는 date의 종가(장마감 기준)이고 changePct는 그 종가를 전 종가와 비교한 값이다. 지표는 모두 완성된 일봉으로 계산한 값이다.
- 매수·매도 의견은 내지 않는다 (의견은 작성 AI가 낸다).
- evidence에는 쓴 자료의 이름과 날짜 범위를 적는다 (예: "일봉 2026-09-01~2026-10-06", "RSI14 (완성 봉 기준)")."""


class MarketAgent:
    id = "market_agent"
    output_contract = "MarketResult"

    def run(self, ctx: WorkerContext) -> dict:
        data = gather(ctx.symbol, ctx.market)
        stock = {"symbol": ctx.symbol, "name": ctx.name, "market": ctx.market}
        prompt = user_prompt({
            "종목": stock,
            "기준 가격 (코드가 계산한 값)": data["close"],
            "지표 (완성 봉 기준, 코드가 계산한 값)": data["indicators"],
            f"최근 일봉 {RECENT_ROWS}개 (과거 → 최신)": data["recent"],
        })
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), prompt, contract=self.output_contract)
        return finish(reply.data, data, ctx.market)


def gather(symbol: str, market_code: str) -> dict:
    """기준 가격(장 중이면 현재가, 아니면 직전 정규장 종가)·지표·최근 일봉. 증권사 조회 실패·완성 봉 없음·가격 없음은 WorkerError."""
    key = market.norm_symbol(symbol)
    try:
        close = market.closes([key]).get(key)
        rows = _rows(market.completed_candles(key))
    except Unavailable as e:
        raise WorkerError(f"시세를 받지 못했습니다: {e}") from None
    if not rows:
        raise WorkerError("완성된 일봉이 없어 시세를 정리할 수 없습니다.")
    if close is None:  # closes가 아직 받지 않은 종목 (CLOSE_BATCH) → 같은 완성 봉으로 정한다
        prev = rows[-2]["close"] if len(rows) > 1 else None
        close = {"price": rows[-1]["close"], "prevClose": prev, "date": rows[-1]["date"],
                 "asOf": _session_end(market_code, rows[-1]["date"])}
    basis = _live(key, market_code, rows[-1]["close"]) or {**close, "priceBasis": market.BASIS_CLOSE}
    price, prev = _finite(basis.get("price")), _finite(basis.get("prevClose"))
    if price is None or price <= 0:
        raise WorkerError("직전 정규장 종가가 없어 시세를 정리할 수 없습니다.")
    values = _indicators(rows)
    values |= {"price": price, "prevClose": prev, "date": basis.get("date"), "asOf": basis.get("asOf"),
               "priceBasis": basis["priceBasis"],
               "changePct": _round((price / prev - 1) * 100) if prev else None,
               "volumeRank": volume_rank(key, market_code),
               "stop": stops.swing_stop(price, [r["low"] for r in rows], values["atr14"],
                                        CURRENCY.get(market_code, "KRW"))}
    return {
        "values": values,
        "close": {k: values[k] for k in CLOSE_KEYS},
        "indicators": {k: v for k, v in values.items() if k not in CLOSE_KEYS + HIDDEN_KEYS},
        "recent": rows[-RECENT_ROWS:],
        "range": (rows[0]["date"], rows[-1]["date"], len(rows)),
    }


def _live(symbol: str, market_code: str, last_close: float) -> dict | None:
    """장 중(기준일 뒤 정규장이 시작됨)이면 현재가 {"price", "prevClose", "date", "asOf", "priceBasis": "live"}, 아니면 None.

    prevClose = 직전 정규장 종가 = 마지막 완성 봉의 종가 (기준일 뒤 정규장이 시작됐으므로 완성 봉의 마지막이 직전 거래일이다).
    현재가를 받지 못하면 None (종가로 정리한다).
    """
    if not market.traded_since_basis(market_code):
        return None
    try:
        found = market.live_prices([symbol]).get(symbol)
    except Unavailable:
        return None
    price = _finite(found[0]) if found else None
    if price is None or price <= 0:
        return None
    today = timezone.now().astimezone(market.MARKET_TZ.get(market_code, KST)).date()
    return {"price": price, "prevClose": last_close, "date": f"{today}", "asOf": found[1],
            "priceBasis": market.BASIS_LIVE}


def finish(answer: dict, data: dict, market_code: str = "KR") -> dict:
    """LLM 응답의 숫자를 자료 값으로 덮어쓰고, 코드가 만든 출처 한 줄을 evidence 맨 앞에 둔다."""
    result = dict(answer)
    values = data["values"]
    for key in DATA_KEYS:
        result[key] = values.get(key)
    first, last, count = data["range"]
    if values["priceBasis"] == market.BASIS_LIVE:
        at = _clock(values["asOf"], market_code)
        price = f"{values['date']} {at + ' ' if at else ''}장중 가격 {_text(values['price'])}"
    else:
        price = f"{values['date']} 종가 {_text(values['price'])} (장마감 기준)"
    source = f"일봉 {first}~{last} 완성 봉 {count}개 · {price}"
    result["evidence"] = [source, *[e for e in result.get("evidence") or [] if e != source]][:MAX_EVIDENCE]
    return result


def volume_rank(symbol: str, market_code: str) -> int | None:
    """오늘(KST) 선별 파일의 거래대금 순위 (후보·선정 종목에 있을 때만). 파일이 없거나 종목이 없으면 None."""
    try:
        from reports.autoreport import auto  # 선별 파일 읽기 (엔진 선별 모듈을 끌어오므로 쓸 때만)

        found = auto.load(market_code, timezone.now().astimezone(KST).date()) or {}
        for pick in [*(found.get("candidates") or []), *(found.get("picks") or [])]:
            if isinstance(pick, dict) and pick.get("symbol") == symbol:
                rank = pick.get("tradingAmountRank")
                return rank if isinstance(rank, int) and not isinstance(rank, bool) and rank > 0 else None
    except Exception:  # 순위는 보조 자료다. 읽지 못하면 없음으로
        return None
    return None


def _indicators(rows: list[dict]) -> dict:
    closes = [r["close"] for r in rows]
    window = rows[-WINDOW:]
    change = {days: indicators.change_rate(closes, days) for days in (5, 20)}
    volumes = [r["volume"] for r in window if r["volume"] is not None]
    return {
        "rsi": _round(indicators.rsi(closes, 14)),
        "volatilityPct": volatility_pct(closes),
        "support": min(r["low"] for r in window),
        "resistance": max(r["high"] for r in window),
        "sma20": _round(indicators.sma(closes, 20)),
        "sma60": _round(indicators.sma(closes, 60)),
        "atr14": _round(indicators.atr([r["high"] for r in rows], [r["low"] for r in rows], closes, 14)),
        "change5dPct": _round(change[5] * 100) if change[5] is not None else None,
        "change20dPct": _round(change[20] * 100) if change[20] is not None else None,
        "avgVolume20": _round(sum(volumes) / len(volumes)) if volumes else None,
        "lastVolume": rows[-1]["volume"],
    }


def volatility_pct(closes: list[float], period: int = WINDOW) -> float | None:
    """최근 period일 일간 수익률의 표준편차 (%, 연율화하지 않은 하루 변동성). 봉이 period+1개보다 적으면 None."""
    if len(closes) < period + 1:
        return None
    window = closes[-period - 1:]
    returns = [b / a - 1 for a, b in zip(window, window[1:]) if a]
    if len(returns) < 2:
        return None
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return _round(math.sqrt(variance) * 100)


def _rows(candles: list[dict]) -> list[dict]:
    """증권사 일봉(문자열) → {date, open, high, low, close, volume} (숫자). 읽을 수 없는 봉은 뺀다."""
    rows = []
    for c in candles or []:
        try:
            row = {"date": c["timestamp"][:10], "open": float(c["openPrice"]), "high": float(c["highPrice"]),
                   "low": float(c["lowPrice"]), "close": float(c["closePrice"])}
        except (KeyError, TypeError, ValueError):
            continue
        if all(math.isfinite(v) and v > 0 for k, v in row.items() if k != "date"):
            row["volume"] = _finite(c.get("volume"))
            rows.append(row)
    return rows


def _clock(as_of, market_code: str) -> str | None:
    """받은 시각 ISO → 그 시장 현지 시각 "15:23" (미국은 "11:20(뉴욕)" — date와 같은 시간대). 읽지 못하면 None."""
    try:
        at = datetime.fromisoformat(str(as_of)).astimezone(market.MARKET_TZ.get(market_code, KST))
    except (TypeError, ValueError):
        return None
    return f"{at:%H:%M}{'(뉴욕)' if market_code == 'US' else ''}"


def _session_end(market_code: str, day: str) -> str | None:
    try:
        return market.session_end(market_code, day)
    except Exception:  # 기준 시각은 보조 값 (장 달력을 받지 못하면 기본 시각을 쓰는 함수지만 모르는 시장 등)
        return None


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value, digits)


def _text(price: float) -> str:
    return f"{price:,.0f}" if price >= 1000 or price.is_integer() else f"{price:,.2f}"
