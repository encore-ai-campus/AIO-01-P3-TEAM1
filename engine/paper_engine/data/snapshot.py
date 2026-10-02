"""AI에 넘길 종목 스냅샷. 숫자는 모두 여기서 코드로 계산한다."""
from datetime import date

from . import indicators
from .dart import DartClient
from .fina_stat import FinaStatClient, history_fundamentals
from .sec import SecClient
from .broker_reports import stock_reports
from .news import fetch_news
from .broker import BrokerClient

LIQUIDITY_DAYS = 20


def _round(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(value, digits)


def build_snapshot(client: BrokerClient, symbol: str, dart: DartClient | None = None,
                   sec: SecClient | None = None, fina: FinaStatClient | None = None) -> dict:
    info = client.stocks([symbol])[0]
    is_kr = info["currency"] == "KRW"
    candles = client.completed_daily_candles(symbol, "KR" if is_kr else "US")
    closes = [float(c["closePrice"]) for c in candles]
    highs = [float(c["highPrice"]) for c in candles]
    lows = [float(c["lowPrice"]) for c in candles]
    volumes = [float(c["volume"]) for c in candles]

    recent = list(zip(closes, volumes))[-LIQUIDITY_DAYS:]
    snapshot = {
        "symbol": info["symbol"],
        "name": info["name"],
        "market": info["market"],
        "marketCountry": "KR" if is_kr else "US",
        "currency": info["currency"],
        "securityType": info["securityType"],
        "lastPrice": float(client.prices([symbol])[0]["lastPrice"]),
        "candleCount": len(candles),
        # 지표와 recentCandles는 정규장이 끝난 봉만 쓴다. lastPrice만 실시간 값이다.
        "lastCandleDate": candles[-1]["timestamp"][:10] if candles else None,
        "indicators": {
            "sma20": _round(indicators.sma(closes, 20), 2),
            "sma60": _round(indicators.sma(closes, 60), 2),
            "sma120": _round(indicators.sma(closes, 120), 2),
            "rsi14": _round(indicators.rsi(closes), 2),
            "atr14": _round(indicators.atr(highs, lows, closes), 2),
            "volatility20": _round(indicators.volatility(closes)),
            "change5d": _round(indicators.change_rate(closes, 5)),
            "change20d": _round(indicators.change_rate(closes, 20)),
            "change60d": _round(indicators.change_rate(closes, 60)),
            "periodHigh": max(highs) if highs else None,
            "periodLow": min(lows) if lows else None,
        },
        "avgDailyTradingAmount": _round(sum(c * v for c, v in recent) / len(recent), 0) if recent else None,
        "warnings": [w["warningType"] for w in client.warnings(symbol)],
        "recentCandles": [
            {"date": c["timestamp"][:10], "open": float(c["openPrice"]), "high": float(c["highPrice"]),
             "low": float(c["lowPrice"]), "close": float(c["closePrice"]), "volume": float(c["volume"])}
            for c in candles[-20:]
        ],
    }
    try:
        query = info["name"] if is_kr else f'{info["englishName"]} {info["symbol"]} stock'
        snapshot["news"] = fetch_news(query, snapshot["marketCountry"])
    except Exception as e:  # 뉴스는 보조 자료라 실패해도 분석은 계속한다
        snapshot["news"] = []
        snapshot["newsError"] = f"{type(e).__name__}: {e}"
    # 증권사 리포트 헤드라인 (목표가·방향). 실패하면 빈 리스트다.
    snapshot["brokerReports"] = stock_reports(info["name"] if is_kr else info.get("englishName") or info["symbol"],
                                              info["symbol"], snapshot["marketCountry"])
    try:
        # 재무와 공시는 국내는 DART, 미국은 SEC에서 가져온다.
        if is_kr and dart:
            snapshot["fundamentals"] = dart.fundamentals(symbol, snapshot["lastPrice"],
                                                         date.today())
            snapshot["disclosures"] = dart.disclosures(symbol, date.today())
        elif not is_kr and sec:
            snapshot["fundamentals"] = sec.fundamentals(symbol, snapshot["lastPrice"])
            snapshot["disclosures"] = sec.disclosures(symbol, date.today())
    except Exception as e:  # 재무는 보조 자료라 실패해도 분석은 계속한다
        snapshot.setdefault("fundamentals", None)
        snapshot["fundamentalsError"] = f"{type(e).__name__}: {e}"
    if is_kr and dart and fina:
        # 여러 해의 연간 실적 추이 (data.go.kr). DART 재무가 없으면 최근 연간 실적으로 대신 채운다.
        try:
            crno = dart.jurir_no(symbol)
            history = fina.annual_history(crno) if crno else None
            if snapshot.get("fundamentals"):
                if history:
                    snapshot["fundamentals"]["annualHistory"] = history
            elif "fundamentalsError" in snapshot:
                snapshot["fundamentals"] = history_fundamentals(history, snapshot["lastPrice"])
        except Exception as e:  # 보조 자료라 실패해도 분석은 계속한다
            snapshot["annualHistoryError"] = f"{type(e).__name__}: {e}"
    if is_kr:
        snapshot["investorTrading"] = [
            {"date": r["date"],
             **{k: float(r[k]["netBuyVolume"]) if r.get(k) else None
                for k in ("individual", "foreigner", "institution")}}
            for r in client.investor_trading(symbol, 10)
        ]
    return snapshot
