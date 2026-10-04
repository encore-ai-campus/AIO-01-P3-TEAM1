"""단타 연습의 세션 (docs/API.md "단타 연습" 세션 규칙, docs/DECISIONS.md 14-4).

단타 계획은 **국내 거래일의 0시부터 15:15 KST 전까지만** 만든다 (장 전 계획 포함). 그래서 계획·주문의 세션은 늘 만든 날(KST)이고,
진입 기한(추천 validUntil = 계획 entryDeadline)은 그날 15:15다. 그 밖(15:15 이후·주말·휴장일)은 만들 수 없다 (day_entry_closed).
국내 거래일은 장 달력(market.calendar("KR"))으로 보고, 장 달력을 받지 못하면 주말만 거른다.
acceptingPlans 판정과 15:15(엔진 DAY_CLOSE_AT)는 trading.market.day_entry_open·day_entry_cutoff 하나를 쓴다
(autotrade.risk의 day_entry_closed, trading.service의 style day 접수도 같은 함수).
"""
from datetime import date, datetime, time, timedelta

from paper_engine.data.calendar import CLOSE_SETTLE_MIN, KR_SESSIONS, KST, session_end_iso
from paper_engine.scheduler import current_session, regular_sessions
from trading import market

from config.api import Unavailable

# 장 달력을 받지 못할 때 쓰는 국내 정규장 09:00~15:30 (KST)
REGULAR_OPEN, REGULAR_CLOSE = (time.fromisoformat(t) for t in KR_SESSIONS["regularMarket"])


def kst_date(now: datetime) -> date:
    return now.astimezone(KST).date()


# 그 세션의 단타 진입 마감 = day 15:15 KST (엔진 DAY_CLOSE_AT — 체결 대기 단타 주문 취소·보유 정리와 같은 시각)
cutoff_at = market.day_entry_cutoff


def day_bounds(day: date) -> tuple[datetime, datetime]:
    """day(KST) 0시부터 다음 날 0시까지 (KST)."""
    start = datetime.combine(day, time.min, tzinfo=KST)
    return start, start + timedelta(days=1)


def _calendar() -> dict | None:
    """국내 장 달력 (60초 캐시). 받지 못하면 None — 그때는 주말만 거른다."""
    try:
        cal = market.calendar("KR")
    except Unavailable:
        return None
    return cal if isinstance(cal, dict) else None


def _entry(cal: dict | None, day: date) -> dict | None:
    """장 달력(전일·당일·익일)에서 day의 항목."""
    for key in ("previousBusinessDay", "today", "nextBusinessDay"):
        entry = (cal or {}).get(key)
        if isinstance(entry, dict) and entry.get("date") == f"{day}":
            return entry
    return None


def _previous_weekday(day: date) -> date:
    day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def _is_open(cal: dict | None, now: datetime) -> bool:
    """지금 국내 정규장 중인지. 장 달력이 없으면 평일 09:00~15:30 (KST)."""
    if cal is not None:
        return bool(current_session(regular_sessions(cal), now))
    local = now.astimezone(KST)
    return local.weekday() < 5 and REGULAR_OPEN <= local.time() < REGULAR_CLOSE


def session(now: datetime) -> dict:
    """DaySession: 지금 단타 계획을 만들 수 있는지(acceptingPlans)와 그 세션.

    acceptingPlans = 오늘이 국내 거래일이고 지금이 15:15 KST 전. 그러면 세션은 오늘, 아니면 다음 국내 거래일
    (그날 0시부터 만들 수 있다). opensAt·closeAt은 장 달력의 그 날짜 정규장 (없으면 09:00·15:30 KST).
    """
    cal = _calendar()
    accepting = market.day_entry_open(now)
    day = kst_date(now) if accepting else market.kr_trading_day(now)[1]
    regular = market.regular_market(_entry(cal, day))
    opens = regular["startTime"] if regular else datetime.combine(day, REGULAR_OPEN, tzinfo=KST).isoformat()
    return {
        "date": f"{day}", "acceptingPlans": accepting, "opensAt": opens,
        "entryCutoffAt": cutoff_at(day).isoformat(), "closeAt": session_end_iso(cal or {}, "KR", f"{day}"),
        "isOpen": _is_open(cal, now),
    }


def basis_day(now: datetime) -> date:
    """국내 장마감 기준일 (market.basis). 장 달력을 받지 못하면 평일 15:40 KST(정규장 종료 + 10분) 규칙으로 정한다."""
    found = market.basis("KR")
    if found and found.get("date"):
        return date.fromisoformat(found["date"])
    local = now.astimezone(KST)
    settled = (datetime.combine(local.date(), REGULAR_CLOSE, tzinfo=KST) + timedelta(minutes=CLOSE_SETTLE_MIN))
    if local.weekday() < 5 and now >= settled:
        return local.date()
    return _previous_weekday(local.date())
