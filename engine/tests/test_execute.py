"""AI 시나리오의 모의 주문 경로 (__main__._execute): 기록만 / 모의 매수 / 중단 스위치 / 가격 없음 / 달러 대기 주문 환율.

독립 리뷰 M1·M7: 시나리오 통화 환율(국내 1.0)과 계좌 환산용 달러 환율을 섞지 않는지 확인한다.
"""
import dataclasses
from datetime import datetime
from types import SimpleNamespace

import pytest

import paper_engine.__main__ as main
from paper_engine.agents import executor as ex
from paper_engine.records.store import Store
from paper_engine.trading import Desk

from test_executor import RATES, Notes, candidate

NOW = datetime.now().astimezone()


class Client:
    def __init__(self, prices, rate="1400"):
        self.price_map, self.rate = prices, rate

    def confirmed_prices(self, symbols):
        return {s: self.price_map[s] for s in symbols if s in self.price_map}

    def prices(self, symbols):
        return [{"symbol": s, "lastPrice": str(self.price_map[s])} for s in symbols if s in self.price_map]

    def exchange_rate(self):
        return {"rate": self.rate}


@pytest.fixture
def desk(tmp_path):
    cfg = SimpleNamespace(commission=RATES, markets=("KR", "US"), max_total_invest_krw=None)
    return Desk(cfg, Store(":memory:", capital_krw=10_000_000), Notes(), Client({"005930": 100_000.0}),
                halt_file=tmp_path / "HALT")


def run(desk, c=None, buy=True):
    main._execute(c or candidate(), "삼성전자", 7, desk, NOW, 1.0, buy, "strategy:3")


def test_record_only_does_not_order(desk):
    run(desk, buy=False)
    assert desk.store.paper_orders() == [] and any("기록만 함" in t for t in desk.notifier.logged)


def test_buy_places_entry_limit_linked_to_trade_and_strategy(desk):
    run(desk)
    (row,) = desk.store.paper_orders(ex.ACTIVE)
    assert (row["symbol"], row["order_type"], row["limit_price"], row["trade_id"], row["requested_by"]) == (
        "005930", ex.LIMIT, 100_000, 7, "strategy:3")


def test_halt_or_missing_price_blocks(desk, tmp_path):
    (tmp_path / "HALT").write_text("x")
    run(desk)
    assert desk.store.paper_orders() == [] and "중단 스위치" in desk.notifier.sent[-1]
    (tmp_path / "HALT").unlink()
    desk.client.price_map = {}
    run(desk)
    assert desk.store.paper_orders() == [] and desk.notifier.sent[-1].endswith("현재가를 받지 못함")


def test_pending_usd_order_is_converted_at_usd_rate_not_scenario_rate(desk):
    # 달러 지정가 대기 $6,000 (약 840만원). 시나리오 환율 1.0으로 환산하면 6천원으로 보여 매수 가능액이 부풀려진다.
    desk.executor.buy("AAPL", "애플", "US", "USD", 30, 210.0, 1_400.0, NOW, "bob", limit_price=200.0)
    c = candidate()
    c.assessment = dataclasses.replace(c.assessment, quantity=50, amount=5_000_000)  # 국내 500만원 매수
    run(desk, c)
    assert [r["symbol"] for r in desk.store.paper_orders(ex.ACTIVE)] == ["AAPL"]
    assert "매수 가능 금액 부족" in desk.notifier.sent[-1]
