"""장기투자가 쓰는 바깥 자료 (docs/API.md "장기투자" 자료 줄). 테스트는 이 모듈의 함수를 가짜로 바꾼다.

- 일봉·수급: 증권사 조회 (config.engine.broker_client() — 로컬 개발은 토스, 운영은 키움). 일봉은 trading.market.candles 캐시를 같이 쓴다.
- 공시·재무·업종: OpenDART (엔진 설정 DART_API_KEY). 재무는 종목·날짜별 하루 캐시, 실패는 10분 캐시.
- 뉴스 제목·증권사 목표가 헤드라인: Google 뉴스 RSS (키 없음, 엔진 data/news.py·data/broker_reports.py).
자료가 없으면 그 칸을 비우고 이유 한 줄을 남긴다 (오늘의 내 종목 뉴스 missing, 펀더멘털 reason·note).
"""
import threading
from datetime import date

from django.core.cache import cache
from paper_engine.data import broker_reports, news
from paper_engine.data.dart import DartClient
from paper_engine.data.kiwoom import KiwoomApiError
from paper_engine.judge import fundamentals_check

from config import engine
from config.api import Unavailable
from trading import market

DAY_TTL, FAIL_TTL = 24 * 3600, 10 * 60
NO_DART_KEY = "DART 키가 없어 공시 자료를 받지 못했어요"
DART_FAILED = "공시 자료를 받지 못했어요"
NO_FILINGS = "공시 재무 자료가 없어요"
INVESTOR_ROWS = 5
NEWS_LIMIT = 15

_lock = threading.Lock()
_dart: tuple[str, DartClient] | None = None


class DartUnavailable(Exception):
    """DART를 쓸 수 없음 (키 없음·조회 실패). 메시지는 화면에 그대로 보일 이유 한 줄."""


def dart_client() -> DartClient | None:
    """DART 클라이언트. 엔진 설정에 DART_API_KEY가 없으면 None. 프로세스에 하나 (회사 코드 목록을 메모리에 둔다)."""
    global _dart
    key = engine.engine_config().dart_api_key
    if not key:
        return None
    with _lock:
        if _dart is None or _dart[0] != key:
            _dart = (key, DartClient(key, engine.CACHE_DIR))
        return _dart[1]


def fundamentals(symbol: str, today: date, *, fresh: bool = False) -> dict | None:
    """DART fundamentals (data/dart.py 형식, report·cashFlow 포함). 재무제표가 없는 종목이면 None.

    종목·날짜별 하루 캐시 (fresh면 캐시를 건너뛰고 새로 받는다 — 그날 정기공시가 나온 종목의 점검).
    DART 키가 없거나 조회가 실패하면 DartUnavailable(이유). 실패는 10분 캐시한다 (같은 실패로 DART를 거듭 부르지 않게).
    """
    key = f"longterm:fundamentals:{symbol}:{today}"
    if not fresh:
        found = cache.get(key)
        if found is not None:
            if found.get("error"):
                raise DartUnavailable(found["error"])
            return found["data"]
    dart = dart_client()
    if dart is None:
        raise DartUnavailable(NO_DART_KEY)
    try:
        data = dart.fundamentals(symbol, None, today)
    except Exception as e:  # 네트워크·응답 오류 (DartError, OSError, ValueError 등)
        cache.set(key, {"error": DART_FAILED, "detail": f"{type(e).__name__}: {e}"}, FAIL_TTL)
        raise DartUnavailable(DART_FAILED) from e
    cache.set(key, {"data": data}, DAY_TTL)
    return data


def industry_code(symbol: str) -> str | None:
    """DART 회사 개황의 업종 코드. 키가 없거나 조회하지 못하면 None (금융업인지 모른다 — 점검을 적용한다)."""
    key = f"longterm:industry:{symbol}"
    found = cache.get(key)
    if found is not None:
        return found or None
    dart = dart_client()
    if dart is None:
        return None
    try:
        code = dart.industry_code(symbol)
    except Exception:
        cache.set(key, "", FAIL_TTL)
        return None
    cache.set(key, code or "", DAY_TTL)
    return code


def security_type(symbol: str) -> str | None:
    """종목 유형 (STOCK·ETF·ETN·REIT…). 조회하지 못하면 None."""
    try:
        info = market.stock_info(symbol)
    except Unavailable:
        return None
    return (info or {}).get("securityType")


def applicability(item: dict) -> tuple[bool, str | None]:
    """종목(StockItem)에 일반 기업용 펀더멘털 점검을 적용하는지 (fundamentals_check.applicability)."""
    if item["market"] != "KR":
        return fundamentals_check.applicability(item["market"])
    kind = security_type(item["symbol"])
    ok, reason = fundamentals_check.applicability("KR", kind, item.get("name") or "")
    if not ok:
        return ok, reason
    return fundamentals_check.applicability("KR", kind, item.get("name") or "", industry_code(item["symbol"]))


def filings(day: date) -> set[str]:
    """그날 정기공시(사업·반기·분기보고서)가 접수된 종목코드. 하루 캐시. 키가 없거나 실패하면 DartUnavailable (실패는 10분 캐시)."""
    key = f"longterm:filings:{day}"
    found = cache.get(key)
    if found is not None:
        if isinstance(found, dict):
            raise DartUnavailable(found["error"])
        return set(found)
    dart = dart_client()
    if dart is None:
        raise DartUnavailable(NO_DART_KEY)
    try:
        symbols = sorted({f["symbol"] for f in dart.periodic_filings(day)})
    except Exception as e:
        cache.set(key, {"error": DART_FAILED}, FAIL_TTL)
        raise DartUnavailable(DART_FAILED) from e
    cache.set(key, symbols, DAY_TTL)
    return set(symbols)


def disclosures(symbol: str, day: date) -> list[dict]:
    """그날 공시 (dart.summarize_disclosures items — 날짜·제목·제출인·접수번호). 키가 없거나 실패하면 DartUnavailable."""
    dart = dart_client()
    if dart is None:
        raise DartUnavailable("DART 키가 없어 받지 못했어요")
    try:
        found = dart.disclosures(symbol, day, days=0)
    except Exception as e:
        raise DartUnavailable("DART 조회에 실패했어요") from e
    return (found or {}).get("items") or []


def candles(symbol: str) -> list[dict]:
    """일봉 최근 120개 (trading.market 캐시). 조회 실패는 Unavailable."""
    return market.candles(symbol)


def investor_rows(symbol: str) -> list[dict]:
    """투자자별 매매동향 (최근 몇 거래일, 조회 클라이언트 형식). 조회 실패는 Unavailable."""
    client = market.client()
    try:
        return client.investor_trading(symbol, INVESTOR_ROWS)
    except (KiwoomApiError, OSError, ValueError, KeyError) as e:
        raise Unavailable(f"수급 조회 실패: {e}") from None


def broker_headlines(name: str, symbol: str) -> list[dict]:
    """최근 하루의 증권사 목표가 헤드라인 (실패하면 [] — broker_reports.stock_reports가 오류를 삼킨다)."""
    return broker_reports.stock_reports(name, symbol, "KR", days=1)


def news_items(name: str) -> list[dict]:
    """최근 하루의 뉴스 제목 (Google 뉴스 RSS). 실패는 예외 그대로 (부르는 쪽이 이유를 남긴다)."""
    return news.fetch_news(f'"{name}"', "KR", days=1, limit=NEWS_LIMIT)
