"""계획 진행 (docs/DECISIONS.md 12-3, docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림"). 판단은 전부 결정론적 코드다.

활성화 → 리스크 점검 → 진입 지정가 주문 → 체결 대기(그날 체결되지 않으면 진입 기한 안에서 다시 주문) → 보유 감시 → 청산.
주문은 웹 주문과 같은 trading.service로 내고 요청자는 plan:<계획 id>다. 체결·청산 판단은 모의 체결기(run_engine의 체결 확인)가 하고,
여기서는 연결된 주문의 상태를 읽어 계획을 따라가게 한다.

상태는 모두 "지금 상태가 X일 때만 Y로"인 조건부 UPDATE로 바꾼다. 웹 요청(활성화·중단)과 엔진 루프가 같은 계획을 동시에 진행해도
주문은 상태를 먼저 잡은 쪽만 낸다. 상태 전이와 그 사건은 한 트랜잭션으로 쓰고, 알림은 커밋된 뒤에 보낸다 (롤백되면 알림 없음).
"""
import logging
import math
from datetime import datetime, timedelta

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone
from notifications import service as notices
from paper_engine.data.kiwoom import KiwoomApiError
from paper_engine.records.account import CANCELED, CLOSED, ENTRY_PENDING, EXIT_WATCHING
from paper_engine.trading import MAX_MANAGED_DAYS
from trading import service
from trading.models import PaperOrder, Reservation
from trading.store import account_for

from config.api import Rejected, Unavailable

from . import risk
from .models import PlanEvent, Recommendation, TradePlan
from .text import money, qty_text, signed_money, when

logger = logging.getLogger(__name__)

# 엔진 PaperExecutor가 주문을 취소할 때 남기는 note (agents/executor.py)
DAY_END = "정규장이 끝날 때까지 지정가에 체결되지 않음"
USER_CANCEL = "사용자 취소"
TRANSIENT = (Unavailable, KiwoomApiError, OSError)  # 다음 번에 다시 시도한다
EXIT_LABEL = {"TARGET": "목표가 도달", "STOP": "손절", "EXPIRED": "보유 기한 만료", "MANUAL": "직접 매도"}
VIA_LABEL = {"web": "웹", "discord": "Discord 링크"}
MAX_STEPS = 4  # step 한 번에 이어서 바꿀 수 있는 상태 수 (주문 → 체결 → 청산)
RECOVER_AFTER = timedelta(minutes=5)  # entry_pending인데 주문이 없으면 이만큼 기다린 뒤 active로 되돌린다


def requester(plan: TradePlan) -> str:
    return f"plan:{plan.id}"


def order_days(holding_days: int) -> int:
    """보유 거래일 → 주문의 보유 기한 (달력 일수)."""
    return min(MAX_MANAGED_DAYS, math.ceil(holding_days * 7 / 5))


# --- 기록 ---

def _move(plan: TradePlan, frm, to: str | None = None, *, match: dict | None = None, **fields) -> bool:
    """지금 상태가 frm(하나 또는 여럿)이고 match(예: 연결된 주문)도 맞을 때만 to로 바꾸고 fields를 쓴다.

    바꿨으면 True. plan은 다시 읽는다.
    """
    frm = (frm,) if isinstance(frm, str) else tuple(frm)
    if to is not None:
        fields["status"] = to
    done = TradePlan.objects.filter(pk=plan.pk, status__in=frm, **(match or {})).update(
        updated_at=timezone.now(), **fields)
    plan.refresh_from_db()
    return bool(done)


def _event(plan: TradePlan, kind: str, message: str, details: dict | None = None,
           at: datetime | None = None) -> PlanEvent:
    """사건 하나. step은 계획별로 겹치지 않게 다음 번호를 쓴다 (동시에 쓰면 다시 센다)."""
    for _ in range(10):
        step = (PlanEvent.objects.filter(plan=plan).aggregate(top=Max("step"))["top"] or 0) + 1
        try:
            with transaction.atomic():
                return PlanEvent.objects.create(plan=plan, step=step, kind=kind, message=message,
                                                details=details or {}, at=at or timezone.now())
        except IntegrityError:
            continue
    raise RuntimeError(f"계획 #{plan.id} 사건 번호를 정하지 못함")


def _notify(plan: TradePlan, kind: str, title: str, body: str, discord: bool = True) -> None:
    try:
        notices.notify(plan.user, kind, title, body, link=f"/plans/{plan.id}", discord=discord)
    except Exception:  # 알림 실패가 매매를 막지 않게
        logger.exception("계획 #%s 알림 실패", plan.id)


def _record(plan: TradePlan, kind: str, message: str, details: dict, title: str | None = None,
            body: str | None = None, discord: bool = True) -> None:
    """사건을 남기고 (title이 있으면) 계획 주인에게 같은 kind로 알린다. 알림은 트랜잭션이 커밋된 뒤에 보낸다."""
    _event(plan, kind, message, details)
    if title:
        text = body or message
        transaction.on_commit(lambda: _notify(plan, kind, title, text, discord))


def _end(plan: TradePlan, frm, to: str, reason: str, details: dict | None = None, match: dict | None = None) -> bool:
    """끝난 상태(cancelled·expired·failed)로. 사건 kind와 알림 kind는 to와 같다."""
    title = {TradePlan.CANCELLED: "계획 중단", TradePlan.EXPIRED: "계획 만료", TradePlan.FAILED: "계획 실패"}[to]
    with transaction.atomic():
        if not _move(plan, frm, to, match=match, failure_reason=reason):
            return False
        _record(plan, to, reason, {"reason": reason} | (details or {}), f"{plan.name} {title}", reason)
    return True


# --- 활성화 ---

def activate(rec: Recommendation, user, budget_krw: float | None = None, via: str = "web",
             now: datetime | None = None) -> TradePlan:
    """리스크 엔진으로 수량을 정해 계획을 만들고 그 자리에서 한 번 진행한다(첫 주문). 활성화할 수 없으면 Rejected."""
    now = now or timezone.now()
    preview = risk.preview(rec, user, budget_krw, now)
    if not preview["activatable"]:
        raise Rejected("; ".join(preview["reasons"]))
    try:
        with transaction.atomic():
            plan = TradePlan.objects.create(
                recommendation=rec, user=user, symbol=rec.symbol, name=rec.name, market=rec.market,
                currency=rec.currency, status=TradePlan.ACTIVE, via=via, quantity=preview["quantity"],
                budget_krw=budget_krw, entry_price=rec.entry_price, target_price=rec.target_price,
                stop_price=rec.stop_price, holding_days=rec.holding_days, entry_deadline=rec.valid_until,
                activated_at=now, updated_at=timezone.now())
            c = plan.currency
            _event(plan, "activated", f"{VIA_LABEL.get(via, via)}에서 계획 활성화", {"via": via, "budgetKrw": budget_krw})
            _event(plan, "risk_checked",
                   f"리스크 엔진 통과: {qty_text(plan.quantity)} (수량을 정한 제약: {preview['limitedBy']}, "
                   f"손익비 {rec.reward_risk:.2f})",
                   {"approved": preview["approved"], "quantity": plan.quantity, "limitedBy": preview["limitedBy"],
                    "rewardRisk": rec.reward_risk, "reasons": preview["reasons"]})
            transaction.on_commit(lambda: _notify(
                plan, "plan_activated", f"{plan.name} 자동매매 계획 활성화",
                f"{qty_text(plan.quantity)} · 진입 {money(plan.entry_price, c)} 지정가 · "
                f"목표 {money(plan.target_price, c)} · 손절 {money(plan.stop_price, c)} · "
                f"진입 기한 {when(plan.entry_deadline)}"))
    except IntegrityError:
        raise Rejected("같은 종목에 진행 중인 내 계획이 있음") from None
    try:
        step(plan, now)
    except Exception:  # 활성화는 성공으로 두고 엔진 루프가 이어 간다
        logger.exception("계획 #%s 첫 진행 실패", plan.id)
    plan.refresh_from_db()
    return plan


# --- 진행 ---

def step(plan: TradePlan, now: datetime, log=None) -> TradePlan:
    """계획을 지금 상태에서 할 수 있는 만큼 진행한다. 바뀐 계획을 돌려준다."""
    log = log or (lambda text: None)
    for _ in range(MAX_STEPS):
        plan.refresh_from_db()
        before = (plan.status, plan.order_id)
        if plan.status == TradePlan.ACTIVE:
            _enter(plan, now, log)
        elif plan.status == TradePlan.ENTRY_PENDING:
            _watch_entry(plan, now, log)
        elif plan.status == TradePlan.HOLDING:
            _watch_exit(plan)
        else:
            break
        plan.refresh_from_db()
        if (plan.status, plan.order_id) == before:
            break
    return plan


def tick(now: datetime, log) -> int:
    """진행 중 계획 전부를 진행한다 (엔진 루프의 "자동매매" 단계). 진행한 계획 수를 돌려준다."""
    plans = list(TradePlan.objects.filter(status__in=TradePlan.LIVE).order_by("id"))
    for plan in plans:
        try:
            step(plan, now, log)
        except Exception as e:  # 한 계획의 문제가 다른 계획을 막지 않게
            log(f"[자동매매] 계획 #{plan.id} {plan.name} 진행 실패: {e}")
    return len(plans)


def _enter(plan: TradePlan, now: datetime, log) -> None:
    """active: 기한이 지났으면 expired, 아니면 상태를 먼저 잡고(entry_pending) 진입 지정가 주문."""
    if now >= plan.entry_deadline:
        _end(plan, TradePlan.ACTIVE, TradePlan.EXPIRED, "진입 기한까지 주문하지 못함")
        return
    if not _move(plan, TradePlan.ACTIVE, TradePlan.ENTRY_PENDING):
        return  # 다른 쪽이 먼저 잡았다
    _place(plan, now, log)


def _place(plan: TradePlan, now: datetime, log, previous: int | None = None, quantity: float | None = None) -> None:
    """entry_pending(주문 없음)인 계획의 진입 지정가 주문. previous는 재주문일 때 앞 주문 번호.

    quantity: 재주문 때 리스크 점검으로 줄인 수량 (없으면 계획 수량). 주문을 계획에 이을 때 계획 수량도 이 값으로 바꾼다.
    """
    account = account_for(plan.user)
    qty = plan.quantity if quantity is None else quantity
    try:
        result = service.buy(account, requester(plan), plan.symbol, qty, service.LIMIT, plan.entry_price,
                             plan.target_price, plan.stop_price, order_days(plan.holding_days), now)
    except Rejected as e:
        if str(e.detail) != service.NO_PRICE:
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.FAILED, f"주문할 수 없음: {e.detail}",
                 match={"order__isnull": True})
            return
        error = e
    except TRANSIENT as e:
        error = e
    else:
        error = None
    if error is not None:  # 일시 오류: 되돌려 두고 다음 번에 다시
        if previous is None:
            _move(plan, TradePlan.ENTRY_PENDING, TradePlan.ACTIVE, match={"order__isnull": True})
        else:
            TradePlan.objects.filter(pk=plan.pk, status=TradePlan.ENTRY_PENDING, order__isnull=True).update(
                order_id=previous, updated_at=timezone.now())
        log(f"[자동매매] 계획 #{plan.id} {plan.name} 주문 실패, 다음 번에 다시: {error}")
        return
    order_id = result["order"]["id"]
    previous_qty = plan.quantity
    c = plan.currency
    what = f"{plan.name} {qty_text(qty)} {money(plan.entry_price, c)} 지정가 매수"
    with transaction.atomic():
        # 그사이 계획이 끝났거나(중단) 다른 쪽이 주문을 이었으면 잇지 않는다
        if not _move(plan, TradePlan.ENTRY_PENDING, match={"order__isnull": True}, order_id=order_id, quantity=qty):
            linked = False
        elif previous is None:
            linked = True
            _record(plan, "order_placed", f"{what} 주문 접수",
                    {"orderId": order_id, "limitPrice": plan.entry_price, "quantity": qty},
                    f"{plan.name} 진입 주문 접수",
                    f"{what} 주문 접수 (모의 주문 #{order_id}). 진입 기한 {when(plan.entry_deadline)}")
        else:
            linked = True
            details = {"orderId": order_id, "previousOrderId": previous}
            if qty < previous_qty:
                details |= {"quantity": qty, "previousQuantity": previous_qty}
            reduced = f", 리스크 점검으로 {qty_text(previous_qty)} → {qty_text(qty)}" if qty < previous_qty else ""
            _record(plan, "order_requeued", f"{what} 다시 주문 (앞 주문 #{previous}이 그날 체결되지 않음{reduced})",
                    details, f"{plan.name} 진입 주문 다시 접수",
                    f"{what} 다시 주문 (모의 주문 #{order_id}{reduced}). 진입 기한 {when(plan.entry_deadline)}",
                    discord=False)
    if not linked:
        _discard(plan, order_id, now, log)
        return
    log(f"[자동매매] 계획 #{plan.id} {what} 주문 #{order_id}")


def _discard(plan: TradePlan, order_id: int, now: datetime, log) -> None:
    """계획에 잇지 못한 주문(주문을 내는 사이 계획이 끝났거나 다른 쪽이 주문을 이었음)을 취소한다. 사건·알림은 남기지 않는다.

    그사이 체결됐으면(지정가에 바로 닿음) 어떤 계획도 따라가지 않는 포지션이 되지 않게 바로 전량 매도한다.
    """
    account = account_for(plan.user)
    try:
        service.cancel(account, requester(plan), order_id, now)
        log(f"[자동매매] 계획 #{plan.id} {plan.name} 상태가 바뀌어 방금 낸 주문 #{order_id}을 취소함")
        return
    except Rejected:
        pass  # 이미 체결됐다
    try:
        service.sell(account, requester(plan), order_id, now)
        log(f"[자동매매] 계획 #{plan.id} {plan.name} 상태가 바뀌어 방금 체결된 주문 #{order_id}을 전량 매도함")
    except (Rejected, *TRANSIENT) as e:
        log(f"[자동매매] 계획 #{plan.id} {plan.name} 계획에 잇지 못한 주문 #{order_id}을 취소·매도하지 못함: {e}")


def _watch_entry(plan: TradePlan, now: datetime, log) -> None:
    """entry_pending: 연결된 주문을 따라간다 (체결 → holding, 그날 미체결 → 재주문, 직접 취소 → cancelled, 기한 → expired,
    엔진이 취소(현금 부족 등) → failed)."""
    order = PaperOrder.objects.filter(pk=plan.order_id).first() if plan.order_id else None
    if order is None:
        _recover(plan)
        return
    linked = {"order_id": order.id}  # 그사이 다른 주문으로 바뀌었으면 바꾸지 않는다
    if order.status in (EXIT_WATCHING, CLOSED):
        c = plan.currency
        qty = order.filled_quantity or plan.quantity
        with transaction.atomic():
            if _move(plan, TradePlan.ENTRY_PENDING, TradePlan.HOLDING, match=linked, fill_price=order.fill_price,
                     filled_at=order.filled_at):
                _record(plan, "filled", f"{plan.name} {qty_text(qty)} {money(order.fill_price, c)}에 진입 체결",
                        {"orderId": order.id, "fillPrice": order.fill_price, "quantity": qty},
                        f"{plan.name} 진입 체결",
                        f"{money(order.fill_price, c)} × {qty_text(qty)}. 목표 {money(plan.target_price, c)} / "
                        f"손절 {money(plan.stop_price, c)} 자동 감시")
        return
    if order.status == CANCELED:
        note = order.note or ""
        details = {"orderId": order.id}
        if note == DAY_END and now < plan.entry_deadline:
            _requeue(plan, order, now, log)
        elif now >= plan.entry_deadline and note in (DAY_END, f"{USER_CANCEL} ({requester(plan)})"):
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.EXPIRED, "진입 기한까지 지정가에 체결되지 않음", details,
                 linked)
        elif note == f"{USER_CANCEL} ({requester(plan)})":
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.CANCELLED, "사용자가 계획을 중단함", details, linked)
        elif note.startswith(USER_CANCEL):
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.CANCELLED, "모의 주문을 직접 취소함", details, linked)
        else:  # 사용자가 하지 않은 취소 (체결 시점 현금 부족 등): 주문할 수 없었다
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.FAILED, f"모의 주문이 취소됨: {note or '사유 없음'}",
                 details, linked)
        return
    if order.status == ENTRY_PENDING and now >= plan.entry_deadline:
        try:
            service.cancel(account_for(plan.user), requester(plan), order.id, now)
        except Rejected:
            return  # 그사이 체결됐다. 다음 번에 따라간다
        _end(plan, TradePlan.ENTRY_PENDING, TradePlan.EXPIRED, "진입 기한까지 지정가에 체결되지 않음",
             {"orderId": order.id}, linked)


def _requeue(plan: TradePlan, old: PaperOrder, now: datetime, log) -> None:
    """그날 체결되지 않아 취소된 진입 주문을 다시 낸다. 리스크 점검을 다시 해 안 되면 failed.

    수량은 점검이 새로 정한 수량을 넘지 않게 줄인다 (늘리지는 않는다). 1주 미만(미국 종목은 0)이 되면 failed.
    """
    try:
        preview = risk.preview(plan.recommendation, plan.user, plan.budget_krw, now, plan=plan)
    except TRANSIENT as e:
        log(f"[자동매매] 계획 #{plan.id} {plan.name} 재주문 점검 실패, 다음 번에 다시: {e}")
        return
    linked = {"order_id": old.id}
    if not preview["activatable"]:
        _end(plan, TradePlan.ENTRY_PENDING, TradePlan.FAILED, "다시 주문할 수 없음: " + "; ".join(preview["reasons"]),
             {"orderId": old.id}, linked)
        return
    quantity = min(plan.quantity, preview["quantity"])
    if quantity <= 0 or (plan.market != "US" and quantity < 1):
        _end(plan, TradePlan.ENTRY_PENDING, TradePlan.FAILED, "다시 주문할 수 없음: 리스크 엔진이 정한 수량이 1주 미만",
             {"orderId": old.id, "quantity": quantity}, linked)
        return
    claimed = TradePlan.objects.filter(pk=plan.pk, status=TradePlan.ENTRY_PENDING, order_id=old.id).update(
        order_id=None, updated_at=timezone.now())
    if claimed:
        plan.refresh_from_db()
        _place(plan, now, log, previous=old.id, quantity=quantity)


def _recover(plan: TradePlan) -> None:
    """entry_pending인데 연결된 주문이 없음 (주문을 내는 중이거나, 내다가 멈췄음): 이 계획의 가장 최근 주문을 다시 잇는다.

    다시 이은 주문에 주문 사건이 없으면(주문을 낸 뒤 잇기 전에 멈췄음) order_placed를 남긴다.
    아직 주문이 없으면 다른 쪽이 내는 중일 수 있으므로 RECOVER_AFTER가 지나서야 active로 되돌린다.
    """
    found = (PaperOrder.objects.filter(account__user=plan.user, requested_by=requester(plan))
             .order_by("-id").first())
    if found is None:
        if timezone.now() - plan.updated_at > RECOVER_AFTER:
            _move(plan, TradePlan.ENTRY_PENDING, TradePlan.ACTIVE, match={"order__isnull": True})
        return
    recorded = any(e.details.get("orderId") == found.id for e in
                   PlanEvent.objects.filter(plan=plan, kind__in=("order_placed", "order_requeued")))
    c = plan.currency
    what = f"{plan.name} {qty_text(found.quantity)} {money(plan.entry_price, c)} 지정가 매수"
    with transaction.atomic():
        if not _move(plan, TradePlan.ENTRY_PENDING, match={"order__isnull": True}, order_id=found.id,
                     quantity=found.quantity):
            return
        if not recorded:
            _record(plan, "order_placed", f"{what} 주문 접수 (주문을 낸 뒤 계획에 잇지 못해 다시 이음)",
                    {"orderId": found.id, "limitPrice": plan.entry_price, "quantity": found.quantity},
                    f"{plan.name} 진입 주문 접수",
                    f"{what} 주문 접수 (모의 주문 #{found.id}). 진입 기한 {when(plan.entry_deadline)}")


def _watch_exit(plan: TradePlan) -> None:
    """holding: 주문이 청산되면 closed (목표가·손절·기한·직접 매도)."""
    order = PaperOrder.objects.filter(pk=plan.order_id).first() if plan.order_id else None
    if order is None or order.status != CLOSED:
        return
    c = plan.currency
    label = EXIT_LABEL.get(order.exit_reason or "", order.exit_reason or "청산")
    pnl = "" if order.pnl_krw is None else f" · 실현 손익 {signed_money(order.pnl_krw, 'KRW')}"
    with transaction.atomic():
        if _move(plan, TradePlan.HOLDING, TradePlan.CLOSED, match={"order_id": order.id},
                 exit_price=order.exit_price, exit_reason=order.exit_reason, closed_at=order.closed_at,
                 pnl_krw=order.pnl_krw):
            _record(plan, "closed", f"{plan.name} {money(order.exit_price, c)}에 청산 ({label}){pnl}",
                    {"orderId": order.id, "exitReason": order.exit_reason, "exitPrice": order.exit_price,
                     "pnlKrw": order.pnl_krw},
                    f"{plan.name} 청산 · {label}", f"{money(order.exit_price, c)}에 전량 매도{pnl}")


# --- 중단 ---

def cancel(plan: TradePlan, user, now: datetime | None = None, _retry: int = 2) -> TradePlan:
    """사용자 중단. active·entry_pending이면 주문을 취소하고 cancelled, holding이면 전량 매도를 요청한다(정규장 밖이면 예약).

    매도 예약이 이미 있으면(정규장 밖에서 두 번 중단) 지금 계획을 그대로 돌려준다. 끝난 계획이면 Rejected.
    """
    now = now or timezone.now()
    plan.refresh_from_db()
    reason = "사용자가 계획을 중단함"
    if plan.status == TradePlan.ACTIVE and _end(plan, TradePlan.ACTIVE, TradePlan.CANCELLED, reason):
        return plan
    if plan.status == TradePlan.ENTRY_PENDING:
        order = PaperOrder.objects.filter(pk=plan.order_id).first() if plan.order_id else None
        if order is None:
            raise Rejected("진입 주문을 내는 중입니다. 잠시 뒤 다시 시도하세요.")
        if order.status == ENTRY_PENDING:
            try:
                service.cancel(account_for(user), requester(plan), order.id, now)
            except Rejected:
                pass  # 그사이 체결됐다. 아래에서 따라간다
            order.refresh_from_db()
        # 읽은 주문이 아직 계획에 이어져 있을 때만 끝낸다 (그사이 엔진이 다시 주문했으면 그 주문을 다시 취소한다)
        if order.status == CANCELED and _end(plan, TradePlan.ENTRY_PENDING, TradePlan.CANCELLED, reason,
                                             {"orderId": order.id}, {"order_id": order.id}):
            return plan
        step(plan, now)
    if plan.status == TradePlan.HOLDING:
        account = account_for(user)
        if Reservation.objects.filter(account=account, kind="SELL", order_id=plan.order_id).exists():
            return plan  # 이미 매도 예약이 있다 (다음 정규장 시작 때 매도)
        result = service.sell(account, requester(plan), plan.order_id, now)
        reservation = result["reservation"]
        message = (f"{plan.name} 정규장 밖이라 다음 정규장 시작 때 전량 매도 예약 (예약 #{reservation['id']})"
                   if reservation else f"{plan.name} 전량 매도 요청")
        _record(plan, "exit_requested", message,
                {"orderId": plan.order_id, "reservationId": reservation["id"] if reservation else None})
        return step(plan, now)
    if plan.status in TradePlan.LIVE and _retry:  # 그사이 상태가 바뀌었다
        return cancel(plan, user, now, _retry - 1)
    if plan.status in TradePlan.LIVE:
        raise Rejected("계획 상태가 바뀌는 중입니다. 잠시 뒤 다시 시도하세요.")
    raise Rejected(f"이미 끝난 계획입니다 ({plan.status}).")
