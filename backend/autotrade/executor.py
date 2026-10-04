"""계획 진행 (docs/DECISIONS.md 12-3, docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림"). 판단은 전부 결정론적 코드다.

활성화 → 리스크 점검 → 진입 지정가 주문 → 체결 대기(그날 체결되지 않으면 진입 기한 안에서 다시 주문) → 보유 감시 → 청산.
주문은 웹 주문과 같은 trading.service로 내고 요청자는 plan:<계획 id>다. 체결·청산 판단은 모의 체결기(run_engine의 체결 확인)가 하고,
여기서는 연결된 주문의 상태를 읽어 계획을 따라가게 한다.

상태는 모두 "지금 상태가 X일 때만 Y로"인 조건부 UPDATE로 바꾼다. 웹 요청(활성화·중단)과 엔진 루프가 같은 계획을 동시에 진행해도
주문은 상태를 먼저 잡은 쪽만 낸다.
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
from trading.models import PaperOrder
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

def _move(plan: TradePlan, frm, to: str | None = None, **fields) -> bool:
    """지금 상태가 frm(하나 또는 여럿)일 때만 to로 바꾸고 fields를 쓴다. 바꿨으면 True. plan은 다시 읽는다."""
    frm = (frm,) if isinstance(frm, str) else tuple(frm)
    if to is not None:
        fields["status"] = to
    done = TradePlan.objects.filter(pk=plan.pk, status__in=frm).update(updated_at=timezone.now(), **fields)
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
    """사건을 남기고 (title이 있으면) 계획 주인에게 같은 kind로 알린다."""
    _event(plan, kind, message, details)
    if title:
        _notify(plan, kind, title, body or message, discord)


def _end(plan: TradePlan, frm, to: str, reason: str, details: dict | None = None) -> bool:
    """끝난 상태(cancelled·expired·failed)로. 사건 kind와 알림 kind는 to와 같다."""
    if not _move(plan, frm, to, failure_reason=reason):
        return False
    title = {TradePlan.CANCELLED: "계획 중단", TradePlan.EXPIRED: "계획 만료", TradePlan.FAILED: "계획 실패"}[to]
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
    except IntegrityError:
        raise Rejected("같은 종목에 진행 중인 내 계획이 있음") from None
    c = plan.currency
    _event(plan, "activated", f"{VIA_LABEL.get(via, via)}에서 계획 활성화", {"via": via, "budgetKrw": budget_krw})
    _event(plan, "risk_checked",
           f"리스크 엔진 통과: {qty_text(plan.quantity)} (수량을 정한 제약: {preview['limitedBy']}, 손익비 {rec.reward_risk:.2f})",
           {"approved": preview["approved"], "quantity": plan.quantity, "limitedBy": preview["limitedBy"],
            "rewardRisk": rec.reward_risk, "reasons": preview["reasons"]})
    _notify(plan, "plan_activated", f"{plan.name} 자동매매 계획 활성화",
            f"{qty_text(plan.quantity)} · 진입 {money(plan.entry_price, c)} 지정가 · 목표 {money(plan.target_price, c)} · "
            f"손절 {money(plan.stop_price, c)} · 진입 기한 {when(plan.entry_deadline)}")
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


def _place(plan: TradePlan, now: datetime, log, previous: int | None = None) -> None:
    """entry_pending(주문 없음)인 계획의 진입 지정가 주문. previous는 재주문일 때 앞 주문 번호."""
    account = account_for(plan.user)
    try:
        result = service.buy(account, requester(plan), plan.symbol, plan.quantity, service.LIMIT, plan.entry_price,
                             plan.target_price, plan.stop_price, order_days(plan.holding_days), now)
    except Rejected as e:
        if str(e.detail) != service.NO_PRICE:
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.FAILED, f"주문할 수 없음: {e.detail}")
            return
        error = e
    except TRANSIENT as e:
        error = e
    else:
        error = None
    if error is not None:  # 일시 오류: 되돌려 두고 다음 번에 다시
        if previous is None:
            _move(plan, TradePlan.ENTRY_PENDING, TradePlan.ACTIVE, order=None)
        else:
            TradePlan.objects.filter(pk=plan.pk, status=TradePlan.ENTRY_PENDING, order__isnull=True).update(
                order_id=previous, updated_at=timezone.now())
        log(f"[자동매매] 계획 #{plan.id} {plan.name} 주문 실패, 다음 번에 다시: {error}")
        return
    order_id = result["order"]["id"]
    TradePlan.objects.filter(pk=plan.pk).update(order_id=order_id, updated_at=timezone.now())
    plan.refresh_from_db()
    c = plan.currency
    what = f"{plan.name} {qty_text(plan.quantity)} {money(plan.entry_price, c)} 지정가 매수"
    if previous is None:
        _record(plan, "order_placed", f"{what} 주문 접수",
                {"orderId": order_id, "limitPrice": plan.entry_price, "quantity": plan.quantity},
                f"{plan.name} 진입 주문 접수", f"{what} 주문 접수 (모의 주문 #{order_id}). 진입 기한 {when(plan.entry_deadline)}")
    else:
        _record(plan, "order_requeued", f"{what} 다시 주문 (앞 주문 #{previous}이 그날 체결되지 않음)",
                {"orderId": order_id, "previousOrderId": previous}, f"{plan.name} 진입 주문 다시 접수",
                f"{what} 다시 주문 (모의 주문 #{order_id}). 진입 기한 {when(plan.entry_deadline)}", discord=False)
    log(f"[자동매매] 계획 #{plan.id} {what} 주문 #{order_id}")


def _watch_entry(plan: TradePlan, now: datetime, log) -> None:
    """entry_pending: 연결된 주문을 따라간다 (체결 → holding, 그날 미체결 → 재주문, 직접 취소 → cancelled, 기한 → expired)."""
    order = PaperOrder.objects.filter(pk=plan.order_id).first() if plan.order_id else None
    if order is None:
        _recover(plan)
        return
    if order.status in (EXIT_WATCHING, CLOSED):
        if _move(plan, TradePlan.ENTRY_PENDING, TradePlan.HOLDING, fill_price=order.fill_price,
                 filled_at=order.filled_at):
            c = plan.currency
            qty = order.filled_quantity or plan.quantity
            _record(plan, "filled", f"{plan.name} {qty_text(qty)} {money(order.fill_price, c)}에 진입 체결",
                    {"orderId": order.id, "fillPrice": order.fill_price, "quantity": qty},
                    f"{plan.name} 진입 체결",
                    f"{money(order.fill_price, c)} × {qty_text(qty)}. 목표 {money(plan.target_price, c)} / "
                    f"손절 {money(plan.stop_price, c)} 자동 감시")
        return
    if order.status == CANCELED:
        note = order.note or ""
        if note == DAY_END and now < plan.entry_deadline:
            _requeue(plan, order, now, log)
        elif now >= plan.entry_deadline and note in (DAY_END, f"{USER_CANCEL} ({requester(plan)})"):
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.EXPIRED, "진입 기한까지 지정가에 체결되지 않음",
                 {"orderId": order.id})
        elif note == f"{USER_CANCEL} ({requester(plan)})":
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.CANCELLED, "사용자가 계획을 중단함", {"orderId": order.id})
        elif note.startswith(USER_CANCEL):
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.CANCELLED, "모의 주문을 직접 취소함", {"orderId": order.id})
        else:
            _end(plan, TradePlan.ENTRY_PENDING, TradePlan.CANCELLED, f"모의 주문이 취소됨: {note or '사유 없음'}",
                 {"orderId": order.id})
        return
    if order.status == ENTRY_PENDING and now >= plan.entry_deadline:
        try:
            service.cancel(account_for(plan.user), requester(plan), order.id, now)
        except Rejected:
            return  # 그사이 체결됐다. 다음 번에 따라간다
        _end(plan, TradePlan.ENTRY_PENDING, TradePlan.EXPIRED, "진입 기한까지 지정가에 체결되지 않음",
             {"orderId": order.id})


def _requeue(plan: TradePlan, old: PaperOrder, now: datetime, log) -> None:
    """그날 체결되지 않아 취소된 진입 주문을 다시 낸다. 리스크 점검을 다시 해 안 되면 failed."""
    try:
        preview = risk.preview(plan.recommendation, plan.user, plan.budget_krw, now, plan=plan)
    except TRANSIENT as e:
        log(f"[자동매매] 계획 #{plan.id} {plan.name} 재주문 점검 실패, 다음 번에 다시: {e}")
        return
    if not preview["activatable"]:
        _end(plan, TradePlan.ENTRY_PENDING, TradePlan.FAILED, "다시 주문할 수 없음: " + "; ".join(preview["reasons"]),
             {"orderId": old.id})
        return
    claimed = TradePlan.objects.filter(pk=plan.pk, status=TradePlan.ENTRY_PENDING, order_id=old.id).update(
        order_id=None, updated_at=timezone.now())
    if claimed:
        plan.refresh_from_db()
        _place(plan, now, log, previous=old.id)


def _recover(plan: TradePlan) -> None:
    """entry_pending인데 연결된 주문이 없음 (주문을 내는 중이거나, 내다가 멈췄음): 이 계획의 가장 최근 주문을 다시 잇는다.

    아직 주문이 없으면 다른 쪽이 내는 중일 수 있으므로 RECOVER_AFTER가 지나서야 active로 되돌린다.
    """
    found = (PaperOrder.objects.filter(account__user=plan.user, requested_by=requester(plan))
             .order_by("-id").first())
    if found is not None:
        TradePlan.objects.filter(pk=plan.pk, status=TradePlan.ENTRY_PENDING, order__isnull=True).update(
            order_id=found.id, updated_at=timezone.now())
    elif timezone.now() - plan.updated_at > RECOVER_AFTER:
        _move(plan, TradePlan.ENTRY_PENDING, TradePlan.ACTIVE)



def _watch_exit(plan: TradePlan) -> None:
    """holding: 주문이 청산되면 closed (목표가·손절·기한·직접 매도)."""
    order = PaperOrder.objects.filter(pk=plan.order_id).first() if plan.order_id else None
    if order is None or order.status != CLOSED:
        return
    if not _move(plan, TradePlan.HOLDING, TradePlan.CLOSED, exit_price=order.exit_price,
                 exit_reason=order.exit_reason, closed_at=order.closed_at, pnl_krw=order.pnl_krw):
        return
    c = plan.currency
    label = EXIT_LABEL.get(order.exit_reason or "", order.exit_reason or "청산")
    pnl = "" if order.pnl_krw is None else f" · 실현 손익 {signed_money(order.pnl_krw, 'KRW')}"
    _record(plan, "closed", f"{plan.name} {money(order.exit_price, c)}에 청산 ({label}){pnl}",
            {"orderId": order.id, "exitReason": order.exit_reason, "exitPrice": order.exit_price,
             "pnlKrw": order.pnl_krw},
            f"{plan.name} 청산 · {label}", f"{money(order.exit_price, c)}에 전량 매도{pnl}")


# --- 중단 ---

def cancel(plan: TradePlan, user, now: datetime | None = None, _retry: int = 2) -> TradePlan:
    """사용자 중단. active·entry_pending이면 주문을 취소하고 cancelled, holding이면 전량 매도를 요청한다(정규장 밖이면 예약).

    끝난 계획이면 Rejected.
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
        if order.status == CANCELED and _end(plan, TradePlan.ENTRY_PENDING, TradePlan.CANCELLED, reason,
                                             {"orderId": order.id}):
            return plan
        step(plan, now)
    if plan.status == TradePlan.HOLDING:
        result = service.sell(account_for(user), requester(plan), plan.order_id, now)
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

