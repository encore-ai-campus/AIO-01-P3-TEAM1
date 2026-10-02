"""모의매매 시뮬레이션. 일봉만으로 체결과 청산을 판정하며, 애매하면 불리한 쪽으로 본다.

- 진입: 지정가 매수. 저가가 진입가 이하로 내려온 날 체결. 시가가 진입가 이하면 시가에 체결.
- 청산: 손절가·목표가 도달 또는 보유 기간 만료(종가 청산). 갭으로 넘어서면 시가에 청산.
- 같은 봉에서 손절과 목표가 모두 닿으면 손절로 본다.
- 장중에 체결된 날은 목표가 도달을 인정하지 않는다 (체결 전 고가일 수 있음).
"""
from dataclasses import dataclass

FILL_WINDOW_DAYS = 5  # 이 거래일 안에 체결되지 않으면 미체결로 끝낸다

PENDING, OPEN = "PENDING", "OPEN"
TARGET, STOP, EXPIRED, UNFILLED = "TARGET", "STOP", "EXPIRED", "UNFILLED"
CLOSED = (TARGET, STOP, EXPIRED)


@dataclass(frozen=True)
class Outcome:
    status: str
    filled_at: str | None = None  # 날짜 (YYYY-MM-DD)
    fill_price: float | None = None
    closed_at: str | None = None
    exit_price: float | None = None


def simulate(entry: float, target: float, stop: float, holding_days: int,
             candles: list[dict]) -> Outcome:
    """candles는 시나리오 생성일 다음 거래일부터의 완성된 일봉 (과거 → 최신).

    각 봉은 {"date", "open", "high", "low", "close"}.
    """
    filled_at = fill_price = None
    held = 0
    for i, c in enumerate(candles):
        can_hit_target = True
        if fill_price is None:
            if i >= FILL_WINDOW_DAYS:
                return Outcome(UNFILLED)
            if c["low"] > entry:
                continue
            at_open = c["open"] <= entry
            filled_at, fill_price = c["date"], (c["open"] if at_open else entry)
            can_hit_target = at_open
        held += 1

        def closed(status, price):
            return Outcome(status, filled_at, fill_price, c["date"], price)

        # 체결된 날은 시가가 곧 체결가이므로 갭 판정은 다음 날부터 한다.
        if c["date"] != filled_at:
            if c["open"] <= stop:
                return closed(STOP, c["open"])
            if c["open"] >= target:
                return closed(TARGET, c["open"])
        if c["low"] <= stop:
            return closed(STOP, stop)
        if can_hit_target and c["high"] >= target:
            return closed(TARGET, target)
        if held >= holding_days:
            return closed(EXPIRED, c["close"])
    if fill_price is None:
        return Outcome(UNFILLED if len(candles) >= FILL_WINDOW_DAYS else PENDING)
    return Outcome(OPEN, filled_at, fill_price)


def pnl(quantity: int, fill_price: float, exit_price: float, commission_rate: float,
        sell_tax_rate: float) -> float:
    """비용을 뺀 손익 (거래 통화)."""
    return quantity * (exit_price * (1 - commission_rate - sell_tax_rate)
                       - fill_price * (1 + commission_rate))
