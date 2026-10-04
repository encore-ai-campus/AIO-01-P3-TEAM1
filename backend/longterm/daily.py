"""오늘의 내 종목 뉴스 작업 (docs/API.md "장기투자" 규칙, docs/DECISIONS.md 14-3). jobs.tick이 부른다.

- 때: 국내 거래일, KR 기준일이 오늘이 된 뒤(정규장 종료 + 10분) DAILY_MOVE_AT(기본 16:30 KST) 이후. 다음 날 0시가 되면 그날 것은 만들지 않는다.
- 대상: 팀원 누군가가 보유(EXIT_WATCHING) 중인 국내 종목의 합집합 (보유 방식과 무관). 종목·날짜당 한 번 (DailyMoveNote 유일).
  한 바퀴에 PER_TICK 종목까지 만든다 (엔진 루프를 오래 붙잡지 않게). 실패한 종목은 10분 뒤 다시, 3번 실패하면 그날은 건너뛴다.
- 알림: 대상 종목이 모두 끝나면(만들었거나 건너뜀) 그날 기록이 있는 보유 종목을 가진 사용자마다 daily_move 하나 (웹만).
  그날 이미 보낸 사용자는 건너뛴다 (엔진이 다시 떠도 한 번).
- LLM: 전용 LlmClient 하나 (비용 = 종목별 호출 전후 차이). 모델은 conf.daily_move_model(), 없거나 LLM 키가 없으면 템플릿.
"""
import threading
from datetime import datetime, time, timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import IntegrityError, transaction
from notifications import service as notices
from notifications.models import Notification
from paper_engine.data.calendar import close_basis_day, session_end_iso
from paper_engine.llm import LlmClient
from paper_engine.longterm import daily_move as dm

from config import engine
from config.api import Unavailable
from trading import market
from trading.models import PaperOrder

from . import conf, sources, text
from .models import DailyMoveNote

KST = market.KST
PER_TICK = 3
MAX_ATTEMPTS = 3
RETRY_AFTER = timedelta(minutes=10)
HELD = "EXIT_WATCHING"
KIND = "daily_move"
LINK = "/"

_lock = threading.Lock()
_llm: tuple[str, LlmClient] | None = None


class NotReady(Exception):
    """그날 종목 일봉이 아직 없음 (증권사가 봉을 아직 주지 않음·거래정지 등). 나중에 다시 해 본다."""


def llm_client() -> LlmClient | None:
    """오늘의 내 종목 뉴스 전용 LLM 클라이언트 (엔진 설정 DEVPASS_APIKEY). 키가 없으면 None."""
    global _llm
    key = engine.engine_config().llm_api_key
    if not key:
        return None
    with _lock:
        if _llm is None or _llm[0] != key:
            _llm = (key, LlmClient(key))
        return _llm[1]


def day_start(now: datetime) -> datetime:
    """now가 속한 KST 날짜의 0시."""
    return datetime.combine(now.astimezone(KST).date(), time(0), tzinfo=KST)


def due_day(now: datetime):
    """오늘의 내 종목 뉴스를 만들 날 (KST date) 또는 None (시각 전·거래일이 아님·기준일이 오늘이 아님·장 달력 없음)."""
    kst = now.astimezone(KST)
    if kst.time() < conf.daily_move_at():
        return None
    try:
        cal = market.calendar("KR")
        basis = close_basis_day(cal, "KR", now)
    except (Unavailable, KeyError, TypeError, ValueError):
        return None
    return kst.date() if basis == f"{kst.date()}" else None


def held_symbols() -> dict[str, str]:
    """팀원 누군가가 보유(EXIT_WATCHING) 중인 국내 종목 {종목코드: 이름}."""
    rows = PaperOrder.objects.filter(status=HELD, market="KR").order_by("symbol", "id").values_list("symbol", "name")
    found: dict[str, str] = {}
    for symbol, name in rows:
        found.setdefault(symbol, name)
    return found


def _fail_key(symbol: str, day) -> str:
    return f"longterm:daily-move-fail:{symbol}:{day}"


def _blocked(symbol: str, day, now: datetime) -> tuple[bool, bool]:
    """(지금은 기다림, 그날은 포기) — 실패 기록으로 정한다."""
    state = cache.get(_fail_key(symbol, day))
    if not state:
        return False, False
    if state["count"] >= MAX_ATTEMPTS:
        return True, True
    return now < datetime.fromisoformat(state["retryAt"]), False


def _failed(symbol: str, day, now: datetime) -> None:
    key = _fail_key(symbol, day)
    count = (cache.get(key) or {}).get("count", 0) + 1
    cache.set(key, {"count": count, "retryAt": (now + RETRY_AFTER).isoformat()}, 24 * 3600)


def build(symbol: str, name: str, day, *, llm=None, model: str | None = None) -> dict:
    """종목 하나의 그날 기록 (DailyMoveNote 필드). 그날 일봉이 아직 없으면 NotReady, 일봉 조회 실패는 Unavailable."""
    iso_day = f"{day}"
    item = market.stock_item(symbol)
    proxy_symbol, proxy_name = dm.proxy_of((item or {}).get("exchange"))
    missing: list[str] = []
    candles = sources.candles(symbol)
    try:
        proxy_candles = sources.candles(proxy_symbol)
    except Unavailable:
        proxy_candles = []
    try:
        investors = sources.investor_rows(symbol)
    except Unavailable:
        investors = []
    decomp = dm.decompose(candles, proxy_candles, iso_day, investors)
    if decomp is None:
        raise NotReady(f"{iso_day} 일봉이 아직 없음")
    if decomp["proxyChangeRate"] is None:
        missing.append(f"시장: {proxy_name} 종가를 받지 못했어요")
    missing.append(dm.MISSING_SECTOR)
    if decomp["volatility20"] is None:
        missing.append("변동성: 일봉이 21개보다 적어 계산하지 않았어요")
    if decomp["flows"] is None:
        missing.append("수급: 그날 투자자별 매매 자료를 받지 못했어요")
    try:
        disclosures = sources.disclosures(symbol, day)
    except sources.DartUnavailable as e:
        disclosures = []
        missing.append(f"공시: {e}")
    broker = sources.broker_headlines(name, symbol)
    try:
        news = sources.news_items(name)
    except Exception:  # 뉴스는 보조 자료 (RSS 실패해도 기록은 만든다)
        news = []
        missing.append("뉴스: Google 뉴스 검색 결과를 받지 못했어요")
    evidence = dm.build_evidence(day=iso_day, name=name, quote_provider=market.quote_provider(),
                                 disclosures=disclosures, flows=decomp["flows"], broker=broker, news=news)
    said = dm.explain(llm, model, name=name, symbol=symbol, day=iso_day, proxy_name=proxy_name, decomp=decomp,
                      evidence=evidence)
    cal = market.calendar("KR")
    return {
        "symbol": symbol, "name": name, "market": "KR", "day": day,
        "as_of": datetime.fromisoformat(session_end_iso(cal, "KR", iso_day)),
        "close": decomp["close"], "prev_close": decomp["prevClose"], "change_rate": decomp["changeRate"],
        "proxy_symbol": proxy_symbol, "proxy_name": proxy_name, "proxy_change_rate": decomp["proxyChangeRate"],
        "excess_change_rate": decomp["excessChangeRate"], "volatility20": decomp["volatility20"],
        "flows": decomp["flows"], "headline": said["headline"], "summary": said["summary"],
        "drivers": said["drivers"], "uncertain": said["uncertain"], "method": said["method"],
        "evidence": evidence, "missing": missing, "llm_model": said["model"], "cost_usd": said["cost"],
        "_violations": said["violations"],
    }


def tick(now: datetime, log) -> None:
    day = due_day(now)
    if day is None:
        return
    targets = held_symbols()
    if not targets:
        return
    llm, model = llm_client(), conf.daily_move_model()
    done = set(DailyMoveNote.objects.filter(day=day, symbol__in=list(targets)).values_list("symbol", flat=True))
    made = 0
    for symbol, name in targets.items():
        if symbol in done or made >= PER_TICK:
            continue
        waiting, _ = _blocked(symbol, day, now)
        if waiting:
            continue
        made += 1
        try:
            fields = build(symbol, name, day, llm=llm, model=model)
        except Exception as e:  # 한 종목의 실패가 다른 종목을 막지 않게
            _failed(symbol, day, now)
            log(f"오늘의 내 종목 뉴스 {name}({symbol}) 실패: {type(e).__name__}: {e}")
            continue
        violations = fields.pop("_violations")
        try:
            with transaction.atomic():
                DailyMoveNote.objects.create(**fields, created_at=now)
        except IntegrityError:  # 이미 있음 (다른 실행이 먼저 만들었다)
            pass
        done.add(symbol)
        extra = f" (AI 설명 검사 위반 → 템플릿: {'; '.join(violations)})" if violations else ""
        log(f"오늘의 내 종목 뉴스 {name}({symbol}) {fields['method']}{extra}")
    settled = all(s in done or _blocked(s, day, now)[1] for s in targets)
    if settled:
        sent = notify_users(day, now)
        if sent:
            log(f"오늘의 내 종목 뉴스 알림 {sent}명")


def notify_users(day, now: datetime) -> int:
    """그날 기록이 있는 국내 보유 종목을 가진 사용자마다 daily_move 알림 하나 (웹만). 그날 이미 보낸 사용자는 건너뛴다."""
    notes = {n.symbol: n for n in DailyMoveNote.objects.filter(day=day)}
    holdings: dict[int, dict] = {}
    for user_id, symbol in (PaperOrder.objects.filter(status=HELD, market="KR", symbol__in=list(notes))
                            .values_list("account__user_id", "symbol")):
        holdings.setdefault(user_id, {})[symbol] = notes[symbol]
    if not holdings:
        return 0
    already = set(Notification.objects.filter(kind=KIND, user_id__in=list(holdings), created_at__gte=day_start(now))
                  .values_list("user_id", flat=True))
    sent = 0
    waiting = [u for u in holdings if u not in already]
    for user in get_user_model().objects.filter(pk__in=waiting, is_active=True).order_by("id"):
        title, body = text.daily_move_notice(list(holdings[user.pk].values()))
        notices.notify(user, KIND, title, body, link=LINK, discord=False)
        sent += 1
    return sent
