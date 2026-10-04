"""산 이유와 펀더멘털 점검 (docs/API.md "장기투자", docs/DECISIONS.md 14-3). 판정은 엔진 judge/fundamentals_check.py.

- 기준선: 산 이유를 처음 저장할 때 DART fundamentals로 잡는다 (자료가 없으면 {} — 다음 점검이 채운다, 그 점검의 기준선 비교는 na).
- active: 이 종목을 장기 보유(style long, 체결 대기·보유 중, 또는 장기 매수 예약) 중인지. 서버가 정한다 (sync_active).
- 점검 때(tick): THESIS_CHECK_AT(기본 18:00 KST) 이후 — 국내 거래일이면 그날 정기공시가 접수된 종목(trigger filing),
  월요일이면 active 전부(trigger weekly, 휴장일이어도). 산 이유마다 하루 한 번. 국내 일반 기업에만 적용한다.
- 알림 thesis_check (웹만): 새로 bad가 된 지표가 있거나 직전 점검보다 종합이 나빠졌을 때만 (첫 점검은 newBad로만). 매도 권유는 없다.
"""
from datetime import datetime, timedelta

from django.core.cache import cache
from notifications import service as notices
from paper_engine.judge import fundamentals_check as fc

from config.api import Unavailable
from trading import market
from trading.models import ACTIVE_STATUSES, LONG, PaperOrder, Reservation

from . import conf, sources, text
from .daily import KST, day_start
from .models import InvestmentThesis, ThesisCheck

PER_TICK = 5
MAX_ATTEMPTS = 3
RETRY_AFTER = timedelta(minutes=10)
KIND = "thesis_check"


def long_holdings(user_ids: list[int] | None = None) -> set[tuple[int, str]]:
    """장기 보유 중인 (사용자 id, 종목코드): style long 주문이 체결 대기·보유 중이거나 장기 매수 예약이 있다."""
    orders = PaperOrder.objects.filter(style=LONG, status__in=ACTIVE_STATUSES)
    reservations = Reservation.objects.filter(kind="BUY", style=LONG)
    if user_ids is not None:
        orders = orders.filter(account__user_id__in=user_ids)
        reservations = reservations.filter(account__user_id__in=user_ids)
    return ({(u, s) for u, s in orders.values_list("account__user_id", "symbol")}
            | {(u, s) for u, s in reservations.values_list("account__user_id", "symbol")})


def sync_active(theses) -> list[InvestmentThesis]:
    """산 이유들의 active를 지금 보유 상태로 맞춘다 (바뀐 것만 저장, updated_at은 그대로). 맞춘 목록을 돌려준다."""
    theses = list(theses)
    if not theses:
        return theses
    held = long_holdings(sorted({t.user_id for t in theses}))
    for thesis in theses:
        active = (thesis.user_id, thesis.symbol) in held
        if thesis.active != active:
            thesis.active = active
            InvestmentThesis.objects.filter(pk=thesis.pk).update(active=active)
    return theses


def baseline_for(item: dict, today) -> tuple[dict, str | None]:
    """새 산 이유의 (기준선, 기준선 보고서). 적용하지 않는 종목이거나 DART 자료를 받지 못하면 ({}, None)."""
    applicable, _ = sources.applicability(item)
    if not applicable:
        return {}, None
    try:
        data = sources.fundamentals(item["symbol"], today)
    except sources.DartUnavailable:
        return {}, None
    if not data:
        return {}, None
    result = fc.evaluate(data)
    return fc.baseline_from(result["rows"]), result["period"]


def last_check(thesis: InvestmentThesis) -> ThesisCheck | None:
    return thesis.checks.order_by("-checked_at", "-id").first()


def run_check(thesis: InvestmentThesis, trigger: str, now: datetime, *, fresh: bool = False) -> ThesisCheck:
    """산 이유 하나를 점검해 ThesisCheck를 남기고 필요하면 알린다. DART를 쓸 수 없으면 sources.DartUnavailable.

    기준선이 비어 있으면 이번 점검에서 채운다 (이번 기준선 비교는 na). "2개 보고서 연속" 조건은 다른 보고서 기간의
    직전 점검(facts)과 비교한다. newBad는 직전 점검(첫 점검이면 없음)에서 bad가 아니던 bad 지표.
    """
    data = sources.fundamentals(thesis.symbol, now.astimezone(KST).date(), fresh=fresh)
    previous = last_check(thesis)
    period = fc.report_label(data)
    earlier = None
    if period:
        earlier = (thesis.checks.exclude(period__isnull=True).exclude(period=period)
                   .order_by("-checked_at", "-id").first())
    fill = not thesis.baseline
    result = fc.evaluate(data, baseline=None if fill else thesis.baseline, previous=earlier.facts if earlier else None)
    rows, overall = result["rows"], result["overall"]
    before = {r["key"]: r["status"] for r in (previous.rows if previous else [])}
    new_bad = [r["key"] for r in rows if r["status"] == fc.BAD and before.get(r["key"]) != fc.BAD]
    worsened = previous is not None and fc.worse(overall, previous.overall)
    notify = bool(new_bad) or worsened
    check = ThesisCheck.objects.create(
        thesis=thesis, checked_at=now, trigger=trigger, period=period, received_at=result["receivedAt"],
        overall=overall, previous_overall=previous.overall if previous else None, rows=rows, new_bad=new_bad,
        notified=notify, facts=result["facts"])
    if fill and data:
        thesis.baseline = fc.baseline_from(rows)
        thesis.baseline_period = period
        InvestmentThesis.objects.filter(pk=thesis.pk).update(baseline=thesis.baseline,
                                                             baseline_period=period)
    if notify:
        title, body = text.thesis_notice(thesis.name, rows, new_bad, overall, check.previous_overall)
        notices.notify(thesis.user, KIND, title, body, link=f"/stocks/{thesis.symbol}", discord=False)
    return check


def _trading_day(today) -> bool:
    """오늘(KST)이 국내 거래일인지 (장 달력 today에 정규장이 있음). 장 달력을 받지 못하면 False."""
    try:
        entry = market.calendar("KR").get("today") or {}
    except Unavailable:
        return False
    regular = (entry.get("integrated") or {}).get("regularMarket")
    return entry.get("date") == f"{today}" and isinstance(regular, dict) and bool(regular.get("endTime"))


def _fail_key(thesis_id: int, day) -> str:
    return f"longterm:thesis-fail:{thesis_id}:{day}"


def _blocked(thesis_id: int, day, now: datetime) -> bool:
    state = cache.get(_fail_key(thesis_id, day))
    return bool(state) and (state["count"] >= MAX_ATTEMPTS or now < datetime.fromisoformat(state["retryAt"]))


def _failed(thesis_id: int, day, now: datetime, *, give_up: bool = False) -> None:
    key = _fail_key(thesis_id, day)
    count = MAX_ATTEMPTS if give_up else (cache.get(key) or {}).get("count", 0) + 1
    cache.set(key, {"count": count, "retryAt": (now + RETRY_AFTER).isoformat()}, 24 * 3600)


def _log_once(log, key: str, ttl: int, message: str) -> None:
    """같은 key로는 ttl초에 한 번만 남긴다 (엔진 루프는 몇 초마다 돈다)."""
    if cache.add(key, True, ttl):
        log(message)


def tick(now: datetime, log) -> None:
    kst = now.astimezone(KST)
    today = kst.date()
    if kst.time() < conf.thesis_check_at():
        return
    theses = [t for t in sync_active(InvestmentThesis.objects.filter(market="KR").select_related("user"))
              if t.active]
    if not theses:
        return
    start = day_start(now)
    checked = set(ThesisCheck.objects.filter(thesis__in=theses, checked_at__gte=start,
                                             checked_at__lt=start + timedelta(days=1))
                  .values_list("thesis_id", flat=True))
    due = [t for t in theses if t.pk not in checked and not _blocked(t.pk, today, now)]
    if not due:
        return
    filed: set[str] = set()
    if _trading_day(today):
        try:
            filed = sources.filings(today)
        except sources.DartUnavailable as e:
            # 키가 없으면 그날 한 번, 조회 실패면 실패 캐시(10분)마다 한 번 남긴다. 화~금에 공시가 없으면 산 이유가
            # 점검·포기로 끝나지 않아 루프마다 여기에 오므로, 매번 남기면 밤새 같은 줄이 쌓인다.
            no_key = str(e) == sources.NO_DART_KEY
            _log_once(log, f"longterm:thesis-filings-log:{today}:{'no-key' if no_key else 'failed'}",
                      sources.DAY_TTL if no_key else sources.FAIL_TTL, f"펀더멘털 점검: 정기공시 목록을 받지 못함 ({e})")
    monday = today.weekday() == 0
    work = [(t, "filing" if t.symbol in filed else "weekly") for t in due if t.symbol in filed or monday]
    for thesis, trigger in work[:PER_TICK]:
        item = {"symbol": thesis.symbol, "name": thesis.name, "market": thesis.market}
        applicable, reason = sources.applicability(item)
        if not applicable:
            _failed(thesis.pk, today, now, give_up=True)  # 그날은 다시 보지 않는다
            continue
        try:
            check = run_check(thesis, trigger, now, fresh=trigger == "filing")
        except sources.DartUnavailable as e:
            _failed(thesis.pk, today, now, give_up=str(e) == sources.NO_DART_KEY)
            log(f"펀더멘털 점검 {thesis.name}({thesis.symbol}) 건너뜀: {e}")
            continue
        except Exception as e:
            _failed(thesis.pk, today, now)
            log(f"펀더멘털 점검 {thesis.name}({thesis.symbol}) 실패: {type(e).__name__}: {e}")
            continue
        log(f"펀더멘털 점검 {thesis.name}({thesis.symbol}) {trigger} → {check.overall}"
            + (" (알림)" if check.notified else ""))
