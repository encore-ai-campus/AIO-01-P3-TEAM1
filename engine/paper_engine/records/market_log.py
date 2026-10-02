"""시장 기록. 정규장이 끝난 뒤 시장별로 하루 한 번 거래대금 상위 100, 등락률 상위·하위 30, 벤치마크, 환율을 남긴다.

목적:
  - 백테스트의 유니버스 편향 제거. 지금은 오늘 기준 랭킹으로 과거를 보므로 나중에 뜬 종목이 미리 들어간다
    (backtest/README.md). 매일 실제 랭킹을 쌓으면 그 날의 후보를 그대로 쓸 수 있다.
  - 일일 리포트의 시장 동향 (daily.py).

기록 시점: 정규장 종료 + RECORD_DELAY 이후 (1d 랭킹이 그 날 전체를 집계한 뒤). serve가 매 루프마다 due_day로 확인한다.
API 호출은 하루 시장당 5번 (랭킹 3, 종목 정보 1, 일봉 1) + 환율 1.
"""
from datetime import datetime, timedelta

from .store import Store

RECORD_DELAY = timedelta(minutes=15)
BENCHMARK = {"KR": "069500", "US": "SPY"}  # KODEX 200, SPDR S&P 500
AMOUNT, GAINERS, LOSERS = "AMOUNT", "GAINERS", "LOSERS"
TOP_MOVERS = 30  # 리포트는 ETF 등을 뺀 뒤 10개를 보여 주므로 넉넉히 받는다


def due_day(sessions: list[tuple[datetime, datetime]], now: datetime) -> str | None:
    """지금 기록할 거래일. 종료 + RECORD_DELAY가 지난 가장 최근 정규장의 날짜 (시장 현지 기준). 없으면 None.

    sessions는 장 운영 정보의 (시작, 끝) 목록 (전일·당일·익일). serve가 멈춰 있던 날은 다음 정규장 시작 전까지
    전일 것이 기록된다. 다음 정규장이 이미 시작했으면 None (랭킹이 그 날 값으로 바뀌어 전일 기록이 아니다).
    """
    done = [(start, end) for start, end in sessions if end + RECORD_DELAY <= now]
    if not done:
        return None
    start, end = max(done)
    if any(end < s <= now for s, _ in sessions):
        return None
    return f"{start.date()}"


def _f(value) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _usd_krw(client) -> float | None:
    """환율. 국내만 운영하면(MARKETS=KR) 없어도 되므로 조회 실패는 None으로 남기고 기록을 계속한다."""
    try:
        return _f(client.exchange_rate()["rate"])
    except Exception as e:  # 키움 오류, 미국 미지원, 네트워크 오류 모두 기록을 멈추지 않는다
        print(f"[시장 기록] 환율 조회 실패, 환율 없이 기록: {type(e).__name__}: {e}", flush=True)
        return None


def record_market(client, store: Store, market: str, day: str, now: datetime) -> dict:
    """하루치 시장 기록을 저장하고 요약 dict를 돌려준다. client는 증권사 조회 클라이언트 (조회만 쓴다)."""
    # 거래대금 상위는 운영 선별(screen_market)과 같은 조건으로 받는다 (투자 유의 종목 제외)
    amount, ranked_at = client.rankings_with_time("MARKET_TRADING_AMOUNT", market, "1d", count=100)
    lists = {AMOUNT: amount,
             GAINERS: client.rankings("TOP_GAINERS", market, "1d", count=TOP_MOVERS),
             LOSERS: client.rankings("TOP_LOSERS", market, "1d", count=TOP_MOVERS)}
    symbols = sorted({r["symbol"] for items in lists.values() for r in items})
    infos = {}
    for i in range(0, len(symbols), 100):
        infos.update({s["symbol"]: s for s in client.stocks(symbols[i:i + 100])})
    rows = []
    for type_, items in lists.items():
        for r in items:
            info = infos.get(r["symbol"], {})
            price = r.get("price") or {}
            rows.append({"type": type_, "rank": int(r["rank"]), "symbol": r["symbol"], "name": info.get("name"),
                         "security_type": info.get("securityType"), "last_price": _f(price.get("lastPrice")),
                         "change_rate": _f(price.get("changeRate")), "trading_amount": _f(r.get("tradingAmount")),
                         "trading_volume": _f(r.get("tradingVolume"))})
    bench = BENCHMARK[market]
    candles = client.daily_candles(bench, 2)
    closes = [_f(c["closePrice"]) for c in candles]
    bench_close = closes[-1] if closes else None
    bench_change = (closes[-1] / closes[-2] - 1) if len(closes) == 2 and closes[-2] else None
    usd_krw = _usd_krw(client)
    store.add_market_day(market, day, now.isoformat(), ranked_at, bench, bench_close, bench_change, usd_krw, rows)
    return {"market": market, "day": day, "amount": len(lists[AMOUNT]), "gainers": len(lists[GAINERS]),
            "losers": len(lists[LOSERS]), "benchClose": bench_close, "benchChange": bench_change, "usdKrw": usd_krw}
