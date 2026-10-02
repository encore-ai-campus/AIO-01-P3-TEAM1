"""응답 형식 (docs/API.md 타입). 키는 camelCase, 숫자는 number, 시각은 오프셋이 붙은 ISO 문자열."""
from .models import PaperFill, Reservation
from .store import iso


def order_json(row: dict) -> dict:
    """Order. row는 저장소의 주문 dict (엔진 열 이름)."""
    return {
        "id": row["id"], "symbol": row["symbol"], "name": row["name"], "market": row["market"],
        "currency": row["currency"], "orderType": row["order_type"], "limitPrice": row["limit_price"],
        "quantity": row["quantity"], "status": row["status"], "entryPrice": row["entry_price"],
        "fillPrice": row["fill_price"], "filledAt": row["filled_at"], "targetPrice": row["target_price"],
        "stopPrice": row["stop_price"], "expireDate": row["expire_date"], "exitPrice": row["exit_price"],
        "exitReason": row["exit_reason"], "closedAt": row["closed_at"], "pnlKrw": row["pnl_krw"],
        "note": row["note"], "createdAt": row["created_at"],
    }


def fill_json(fill: PaperFill) -> dict:
    order = fill.order
    return {
        "id": fill.id, "orderId": fill.order_id, "symbol": order.symbol, "name": order.name,
        "currency": order.currency, "side": fill.side, "price": fill.price, "quantity": fill.quantity,
        "amount": fill.amount, "commission": fill.commission, "tax": fill.tax, "cashChangeKrw": fill.cash_change_krw,
        "reason": fill.reason, "filledAt": iso(fill.filled_at),
    }


def reservation_json(r: Reservation, run_at: str | None) -> dict:
    return {
        "id": r.id, "kind": r.kind, "symbol": r.symbol, "name": r.name, "market": r.market, "quantity": r.quantity,
        "orderId": r.order_id, "targetPrice": r.target_price, "stopPrice": r.stop_price, "days": r.days,
        "runAt": run_at, "createdAt": iso(r.created_at),
    }


def position_json(holding: dict, order: dict) -> dict:
    """Position. holding은 records.account.holdings 항목, order는 그 주문 dict (체결 환율로 원금을 계산한다)."""
    cost = order["filled_quantity"] * order["fill_price"] * (order["fill_fx_rate"] or 1.0)
    value = holding["valueKrw"]
    return {
        "orderId": holding["id"], "symbol": holding["symbol"], "name": holding["name"], "market": holding["market"],
        "currency": holding["currency"], "quantity": holding["quantity"], "avgPrice": holding["fillPrice"],
        "lastPrice": holding["lastPrice"], "costKrw": cost, "valueKrw": value, "profitKrw": value - cost,
        "profitRate": value / cost - 1 if cost else None, "targetPrice": holding["target"],
        "stopPrice": holding["stop"], "expireDate": holding["expireDate"], "filledAt": holding["filledAt"],
    }
