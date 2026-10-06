"""계좌 하나로 범위를 좁힌 ORM 저장소 (docs/DECISIONS.md 8-1).

엔진 `records.store.Store`의 모의 계좌 메서드와 이름·인자·반환 형식이 같다 (엔진 열 이름을 키로 하는 dict, 시각은 ISO 문자열).
그래서 엔진의 `PaperExecutor`와 `records.account`가 고치지 않고 그대로 쓴다. 다른 계좌의 주문 번호는 없는 것으로 취급한다.
"""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from config import engine

from .models import PaperAccount, PaperFill, PaperOrder

KST = ZoneInfo("Asia/Seoul")
ORDER_COLUMNS = (
    "id", "account_id", "requested_by", "trade_id", "symbol", "name", "market", "currency", "order_type",
    "limit_price", "quantity", "entry_price", "target_price", "stop_price", "expire_date", "status",
    "filled_quantity", "fill_price", "fill_fx_rate", "filled_at", "exit_price", "exit_fx_rate", "exit_reason",
    "closed_at", "pnl", "pnl_krw", "signal_count", "note", "created_at", "style")
FILL_COLUMNS = ("id", "order_id", "side", "price", "quantity", "amount", "commission", "tax", "fx_rate",
                "cash_change_krw", "reason", "filled_at")
DATETIME_COLUMNS = {"filled_at", "closed_at", "created_at"}
DATE_COLUMNS = {"expire_date"}


def iso(value: datetime | date | None) -> str | None:
    """DB 값 → 엔진 Store와 같은 문자열 (시각은 한국 시간 ISO, 날짜는 YYYY-MM-DD)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return timezone.localtime(value).isoformat()
    return value.isoformat()


def _row(obj, columns) -> dict:
    return {c: iso(v) if c in DATETIME_COLUMNS or c in DATE_COLUMNS else v
            for c in columns for v in (getattr(obj, c),)}


def order_row(order: PaperOrder) -> dict:
    return _row(order, ORDER_COLUMNS)


def fill_row(fill: PaperFill) -> dict:
    return _row(fill, FILL_COLUMNS)


def _to_db(fields: dict) -> dict:
    """엔진이 넘기는 ISO 문자열을 DB 값으로 바꾼다."""
    out = {}
    for key, value in fields.items():
        if isinstance(value, str) and key in DATETIME_COLUMNS:
            value = datetime.fromisoformat(value)
        elif isinstance(value, str) and key in DATE_COLUMNS:
            value = date.fromisoformat(value)
        out[key] = value
    return out


def account_for(user) -> PaperAccount:
    """팀원의 모의 계좌. 없으면 PAPER_CAPITAL_KRW로 만든다."""
    account = PaperAccount.objects.filter(user=user).first()
    if account is None:
        capital = engine.engine_config().paper_capital_krw
        account, _ = PaperAccount.objects.get_or_create(
            user=user, defaults={"name": user.username, "initial_capital_krw": capital, "cash_krw": capital})
    return account


class AccountStore:
    """엔진 Store의 모의 계좌 부분을 계좌 하나에 대해 Django ORM으로 구현한다."""

    def __init__(self, account: PaperAccount):
        self.account_id = account.pk

    def _orders(self):
        return PaperOrder.objects.filter(account_id=self.account_id)

    def account(self) -> dict:
        a = PaperAccount.objects.get(pk=self.account_id)  # 현금은 체결마다 바뀌므로 매번 읽는다
        return {"id": a.id, "name": a.name, "initial_capital_krw": a.initial_capital_krw, "cash_krw": a.cash_krw,
                "created_at": iso(a.created_at)}

    def add_paper_order(self, **fields) -> int:
        """새 모의 주문. signal_count는 0으로 채운다. 계좌는 이 저장소의 계좌다."""
        fields = {"signal_count": 0} | fields
        fields.pop("account_id", None)
        return PaperOrder.objects.create(account_id=self.account_id, **_to_db(fields)).pk

    def update_paper_order(self, order_id: int, **fields) -> None:
        self._orders().filter(pk=order_id).update(**_to_db(fields))

    def paper_order(self, order_id: int) -> dict | None:
        order = self._orders().filter(pk=order_id).first()
        return None if order is None else order_row(order)

    def paper_orders(self, statuses: tuple[str, ...] | None = None) -> list[dict]:
        orders = self._orders()
        if statuses is not None:
            orders = orders.filter(status__in=statuses)
        return [order_row(o) for o in orders.order_by("id")]

    def add_fill(self, order_id: int, side: str, price: float, quantity: float, commission: float, tax: float,
                 fx_rate: float, cash_change_krw: float, reason: str, at: str, order_fields: dict) -> int:
        """체결 한 건: 체결 내역, 현금, 주문 상태(order_fields)를 한 트랜잭션으로 바꾼다. at은 체결 시각 (ISO)."""
        with transaction.atomic():
            if not self._orders().filter(pk=order_id).exists():
                raise ValueError(f"모의 주문 #{order_id}이(가) 이 계좌에 없음")
            fill = PaperFill.objects.create(
                account_id=self.account_id, order_id=order_id, side=side, price=price, quantity=quantity,
                amount=price * quantity, commission=commission, tax=tax, fx_rate=fx_rate,
                cash_change_krw=cash_change_krw, reason=reason, filled_at=datetime.fromisoformat(at))
            PaperAccount.objects.filter(pk=self.account_id).update(cash_krw=F("cash_krw") + cash_change_krw)
            if order_fields:
                self._orders().filter(pk=order_id).update(**_to_db(order_fields))
        return fill.pk

    def order_fills(self, order_id: int) -> list[dict]:
        fills = PaperFill.objects.filter(account_id=self.account_id, order_id=order_id).order_by("id")
        return [fill_row(f) for f in fills]

    def paper_today(self, day: str, style: str | None = None) -> tuple[int, float]:
        """(그 날(KST) 낸 모의 주문 수, 그 날 확정 손실 원화). 손실은 양수다.

        style(swing | long)을 주면 그 보유 방식의 주문만 센다 (스윙 계획의 한도는 style swing 주문만).
        """
        start = datetime.combine(date.fromisoformat(day), time.min, tzinfo=KST)
        end = start + timedelta(days=1)
        orders = self._orders() if style is None else self._orders().filter(style=style)
        count = orders.filter(created_at__gte=start, created_at__lt=end).count()
        loss = orders.filter(closed_at__gte=start, closed_at__lt=end, pnl_krw__lt=0).aggregate(
            total=Sum("pnl_krw"))["total"]
        return count, float(-loss) if loss else 0.0

    def last_fx_rate(self, currency: str = "USD") -> float | None:
        """그 통화 종목의 가장 최근 체결 환율. 환율 조회가 실패했을 때 평가에 쓴다."""
        return (PaperFill.objects.filter(account_id=self.account_id, order__currency=currency)
                .order_by("-id").values_list("fx_rate", flat=True).first())
