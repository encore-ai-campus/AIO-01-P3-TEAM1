"""장 시간 기준으로 도는 작업: 예약 주문 실행 시점과 종목 선별 시점을 정한다.

- 예약 주문: 정규장 밖에서 받은 시장가 모의 매수·매도. 예약한 뒤 처음 시작하는 정규장에 serve가 모의 체결한다
  (정규장 중에 예약하면 다음 정규장).
- 전략(strategies.py): 활성 전략마다 정규장 시작 SCAN_LEAD 전부터 시작 전까지 하루 한 번 돈다.
  휴장일에는 돌지 않는다.

장 시간은 장 운영 정보(data/calendar.py, 휴장·서머타임 반영)로 판단한다. 저장은 Redis(paper:*)에 한다.
"""
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta

from .records.redis_client import Redis

SCAN_LEAD = timedelta(hours=1)
KEY = "paper"


def regular_sessions(calendar: dict) -> list[tuple[datetime, datetime]]:
    """장 운영 정보(전일·당일·익일)의 정규장 (시작, 끝) 목록. 휴장일은 빠진다."""
    sessions = []
    for day in ("previousBusinessDay", "today", "nextBusinessDay"):
        info = calendar.get(day) or {}
        info = info.get("integrated") or info  # 국내는 integrated 아래, 해외는 바로 아래
        regular = info.get("regularMarket")
        if regular:
            sessions.append((datetime.fromisoformat(regular["startTime"]),
                             datetime.fromisoformat(regular["endTime"])))
    return sorted(set(sessions))


def trading_sessions(calendar: dict) -> list[tuple[datetime, datetime]]:
    """정규장과 시간외(장전·애프터마켓, 미국 주간거래)를 모두 포함한 거래 시간 목록."""
    sessions = []
    for day in ("previousBusinessDay", "today", "nextBusinessDay"):
        info = calendar.get(day) or {}
        info = info.get("integrated") or info
        for name in ("dayMarket", "preMarket", "regularMarket", "afterMarket"):
            s = info.get(name)
            if isinstance(s, dict) and s.get("startTime") and s.get("endTime"):
                sessions.append((datetime.fromisoformat(s["startTime"]), datetime.fromisoformat(s["endTime"])))
    return sorted(set(sessions))


def current_session(sessions, now: datetime) -> tuple[datetime, datetime] | None:
    return next(((s, e) for s, e in sessions if s <= now < e), None)


def upcoming_scan(sessions, now: datetime) -> datetime | None:
    """지금이 종목 선별을 돌릴 때면 그 정규장의 시작 시각."""
    return next((s for s, _ in sessions if s - SCAN_LEAD <= now < s), None)


def next_session_start(sessions, now: datetime) -> datetime | None:
    return next((s for s, _ in sessions if s > now), None)


def last_session_end(sessions, now: datetime) -> datetime | None:
    """지금까지 끝난 가장 최근 정규장의 종료 시각 (지정가 당일 미체결 취소에 쓴다)."""
    return max((e for _, e in sessions if e <= now), default=None)


# --- 예약 주문 ---

@dataclass
class Reservation:
    """정규장 밖에서 받은 시장가 모의 주문. 다음 정규장 시작 때 실행한다."""
    id: int
    market: str          # KR | US
    side: str            # BUY | SELL
    symbol: str
    name: str
    quantity: str        # 매수 수량 (매도는 포지션 전량이라 기록용)
    created_at: str      # ISO. 이 시각 이후에 시작하는 정규장에 실행한다
    reference_price: str  # 예약할 때의 가격. 매수는 실행 때 이 값에서 많이 벗어나면 취소한다
    requested_by: str    # 팀원 계정 이름, strategy:<번호>, cli
    order_id: int | None = None  # 매도할 모의 주문(포지션) 번호
    target: str | None = None  # 목표·손절을 주면 체결 후 자동 청산을 감시한다
    stop: str | None = None
    days: int | None = None  # 보유 기한 (실행일부터 달력 일수)

    @property
    def label(self) -> str:
        if self.side == "SELL":
            what = f"모의 주문 #{self.order_id} 전량 시장가 매도"
        else:
            managed = f" (목표 {self.target} / 손절 {self.stop}" + (f", {self.days}일)" if self.days else ")")
            what = f"{self.quantity}주 시장가 매수" + (managed if self.target else "")
        return f"#{self.id} {self.name} ({self.symbol}) {what} · 요청 {self.requested_by}"

    def is_due(self, sessions, now: datetime) -> bool:
        session = current_session(sessions, now)
        return bool(session) and session[0] > datetime.fromisoformat(self.created_at)


class ReservationBook:
    def __init__(self, redis: Redis):
        self.r = redis

    def add(self, **fields) -> Reservation:
        rid = self.r.incr(f"{KEY}:reservation:seq")
        res = Reservation(id=rid, **fields)
        self.r.set(f"{KEY}:reservation:{rid}", json.dumps(asdict(res), ensure_ascii=False))
        self.r.sadd(f"{KEY}:reservations", str(rid))
        return res

    def all(self) -> list[Reservation]:
        out = []
        for rid in self.r.smembers(f"{KEY}:reservations"):
            raw = self.r.get(f"{KEY}:reservation:{rid}")
            if raw:
                out.append(Reservation(**json.loads(raw)))
        return sorted(out, key=lambda x: x.id)

    def remove(self, rid: int) -> bool:
        """지웠으면 True. 실행과 취소가 겹쳐도 한쪽만 True를 받는다."""
        removed = self.r.srem(f"{KEY}:reservations", str(rid))
        self.r.delete(f"{KEY}:reservation:{rid}")
        return bool(removed)


def claim_scan(redis: Redis, strategy_id: int, session_start: datetime) -> bool:
    """이 정규장에서 이 전략을 처음 맡으면 True (전략마다 하루 한 번만 돌게 한다)."""
    return redis.set(f"{KEY}:scan:s{strategy_id}:{session_start:%Y-%m-%d}", datetime.now().isoformat(),
                     nx=True, ex=3 * 24 * 3600)


SCAN_RESULT_TTL = 30 * 24 * 3600


def save_scan_result(redis: Redis, strategy_id: int, result: dict) -> None:
    """전략 실행 결과 (웹·info 조회가 '왜 골랐는지' 보여 줄 때 읽는다)."""
    raw = json.dumps(result, ensure_ascii=False)
    redis.set(f"{KEY}:scanresult:s{strategy_id}:latest", raw)
    redis.set(f"{KEY}:scanresult:s{strategy_id}:{result['at'][:10]}", raw, ex=SCAN_RESULT_TTL)


def load_scan_result(redis: Redis, strategy_id: int, day: str = "latest") -> dict | None:
    raw = redis.get(f"{KEY}:scanresult:s{strategy_id}:{day}")
    return json.loads(raw) if raw else None
