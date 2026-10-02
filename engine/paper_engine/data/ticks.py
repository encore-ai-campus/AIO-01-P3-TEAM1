"""호가 단위. 주문 가격은 호가 단위에 맞아야 접수된다."""
import math
from decimal import Decimal

# 국내 주식 호가 단위 (가격 상한, 단위). 코스피·코스닥 공통.
KR_TICKS = [(2_000, 1), (5_000, 5), (20_000, 10), (50_000, 50), (200_000, 100), (500_000, 500)]
KR_TICK_MAX = 1_000


def kr_tick(price: float) -> int:
    for limit, tick in KR_TICKS:
        if price < limit:
            return tick
    return KR_TICK_MAX


def round_price(price: float, currency: str, up: bool = False) -> str:
    """호가 단위에 맞춘 가격을 주문에 넣을 문자열로 돌려준다. 기본은 내림."""
    rounding = math.ceil if up else math.floor
    if currency == "KRW":
        tick = kr_tick(price)
        return str(int(rounding(round(price / tick, 6)) * tick))
    # 미국: 1달러 이상은 0.01, 미만은 0.0001 단위
    digits = 2 if price >= 1 else 4
    scaled = rounding(round(price * 10 ** digits, 6))
    return str(Decimal(scaled).scaleb(-digits).quantize(Decimal(10) ** -digits))
