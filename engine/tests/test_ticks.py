import pytest

from paper_engine.data.ticks import kr_tick, round_price


@pytest.mark.parametrize("price,tick", [
    (1_999, 1), (2_000, 5), (4_999, 5), (5_000, 10), (19_990, 10), (20_000, 50),
    (49_950, 50), (50_000, 100), (199_900, 100), (200_000, 500), (499_500, 500),
    (500_000, 1_000), (1_756_000, 1_000),
])
def test_kr_tick(price, tick):
    assert kr_tick(price) == tick


def test_round_price_kr():
    assert round_price(272_750, "KRW") == "272500"
    assert round_price(272_750, "KRW", up=True) == "273000"
    assert round_price(272_500, "KRW") == "272500"
    assert round_price(70_049.9, "KRW") == "70000"
    assert round_price(1_234.5, "KRW") == "1234"


def test_round_price_us():
    assert round_price(337.617, "USD") == "337.61"
    assert round_price(337.617, "USD", up=True) == "337.62"
    assert round_price(337.6, "USD") == "337.60"
    assert round_price(0.98765, "USD") == "0.9876"
    # 부동소수점 오차로 한 단위 어긋나지 않는다
    assert round_price(0.29, "USD") == "0.2900"
    assert round_price(329.5, "USD") == "329.50"
