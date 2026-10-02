"""모의 체결기: 접수, 체결(시장가·지정가), 당일 미체결 취소, 2회 연속 확인 청산, 현금·수수료·세금, 중단 스위치, 계좌."""
from datetime import date, datetime, timedelta, timezone

import pytest

from paper_engine.agents import executor as ex
from paper_engine.judge.risk import AccountContext, assess
from paper_engine.judge.scenario import Scenario
from paper_engine.judge.verdict import Approval, Candidate
from paper_engine.records.store import Store

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 9, 29, 10, 0, tzinfo=KST)
CLOSE = datetime(2026, 9, 29, 15, 30, tzinfo=KST)
ACCOUNT = AccountContext(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.0,
                         max_total_krw=1_000_000)  # 총 금액 한도 100만원
RATES = {"KR": 0.00015, "US": 0.00025}
KR_SELL = 0.00015 + 0.002  # 국내 매도 수수료 + 거래세


def candidate(approved=True, **kw):
    base = dict(symbol="005930", currency="KRW", horizon="SWING", entry_price=100_050,
                target_price=115_080, stop_price=95_030, probability=0.5, holding_days=10)
    s = Scenario(**{**base, **kw})
    return Candidate(id="S1", proposer="m", raw={}, scenario=s, final=s, proposer_score=80,
                     score=70, participation=1.0, consensus_probability=0.5,
                     assessment=assess(s, ACCOUNT),
                     approval=Approval(approved, "사유", [], "boss"))


def checks(c, plan, last_price=100_000, analyzed_at=NOW, active=(), halted=False, fx=1.0):
    return ex.pre_trade_checks(c, plan, last_price, analyzed_at, NOW, fx, set(active), halted)


# --- 주문 계획과 실행 직전 점검 (원본과 같다) ---

def test_plan_rounds_to_tick_and_sets_expiry():
    plan = ex.make_plan(candidate(), date(2026, 9, 29))
    assert plan.entry_price == "100000" and plan.target_price == "115000"
    assert plan.stop_trigger == "95000"
    assert plan.stop_order_price == "94000"  # 1% 아래(94,050)를 호가 단위로 내림
    assert plan.quantity == 9
    assert plan.expire_date == "2026-10-15"  # 10거래일 → 달력 16일
    assert plan.amount == 900_000


def test_plan_us():
    c = candidate(symbol="AAPL", currency="USD", entry_price=337.617, target_price=365.009,
                  stop_price=322.0)
    plan = ex.make_plan(c, date(2026, 9, 29))
    assert (plan.entry_price, plan.target_price, plan.stop_trigger, plan.stop_order_price) == (
        "337.61", "365.00", "322.00", "318.78")


def test_pre_trade_checks_pass():
    c = candidate()
    assert checks(c, ex.make_plan(c, NOW.date())) == []


@pytest.mark.parametrize("kw,expected", [
    ({"halted": True}, "중단 스위치"),
    ({"analyzed_at": NOW - timedelta(minutes=31)}, "다시 분석 필요"),
    ({"last_price": 95_000}, "손절가"),
    ({"last_price": 115_000}, "목표가"),
    ({"last_price": 102_100}, "벗어남"),
    ({"last_price": 97_900}, "벗어남"),
    ({"active": ["005930"]}, "진행 중인 모의 주문"),
    ({"fx": 200.0}, "1억원"),
])
def test_pre_trade_checks_block(kw, expected):
    c = candidate()
    reasons = checks(c, ex.make_plan(c, NOW.date()), **kw)
    assert len(reasons) == 1 and expected in reasons[0]


def test_pre_trade_checks_block_unapproved_and_empty():
    c = candidate(approved=False)
    assert any("최종 컨펌" in r for r in checks(c, ex.make_plan(c, NOW.date())))
    c = candidate()
    c.assessment = assess(c.final, AccountContext(10_000_000, 50_000, 0.0))
    assert any("1주 미만" in r for r in checks(c, ex.make_plan(c, NOW.date())))


def fractional_candidate():
    s = Scenario(symbol="META", currency="USD", horizon="SWING", entry_price=723.2,
                 target_price=810, stop_price=690, probability=0.5, holding_days=10)
    account = AccountContext(equity_krw=2_100_000, buying_power=705.42, commission_rate=0.0, fx_rate=1_400,
                             max_total_krw=2_000_000)
    return Candidate(id="S1", proposer="m", raw={}, scenario=s, final=s, proposer_score=80,
                     score=70, participation=1.0, consensus_probability=0.5,
                     assessment=assess(s, account, fractional=True),
                     approval=Approval(True, "사유", [], "boss"))


def test_fractional_plan_and_checks():
    c = fractional_candidate()
    plan = ex.make_plan(c, NOW.date())
    assert plan.fractional and plan.entry_amount == 270.52 and plan.amount == 270.52
    assert (plan.entry_price, plan.target_price, plan.stop_trigger) == ("723.20", "810.00", "690.00")
    assert ex.pre_trade_checks(c, plan, 725.0, NOW, NOW, 1_400, set(), False) == []
    tiny = ex.OrderPlan("META", "USD", 0.001, "723.20", "810.00", "690.00", "683.10", "2026-10-15",
                        entry_amount=0.5)
    assert any("최소" in r for r in ex.pre_trade_checks(c, tiny, 725.0, NOW, NOW, 1_400, set(), False))


# --- 모의 체결 ---

class Notes:
    def __init__(self):
        self.sent, self.logged = [], []

    def send(self, text):
        self.sent.append(text)

    def log(self, text):
        self.logged.append(text)


@pytest.fixture
def env(tmp_path):
    store, notes = Store(":memory:", capital_krw=10_000_000), Notes()
    return store, notes, ex.PaperExecutor(store, notes, tmp_path / "HALT", RATES)


def cash(store) -> float:
    return store.account()["cash_krw"]


def sync(agent, prices, now, open_=("KR",), fx=None, close=None):
    return agent.sync(prices, now, set(open_), fx, {"KR": close, "US": close})


def buy(agent, symbol="005930", qty=10, price=100_000, **kw):
    kw = {"name": "삼성전자", "market": "KR", "currency": "KRW", "fx_rate": None, "now": NOW,
          "requested_by": "alice"} | kw
    return agent.buy(symbol, kw.pop("name"), kw.pop("market"), kw.pop("currency"), qty, price, kw.pop("fx_rate"),
                     kw.pop("now"), kw.pop("requested_by"), **kw)


def test_new_account_starts_with_capital(env):
    store, _, agent = env
    acc = store.account()
    assert (acc["id"], acc["name"], acc["initial_capital_krw"], acc["cash_krw"]) == (1, "팀 공용", 10_000_000, 10_000_000)
    assert Store(":memory:", capital_krw=3_000_000).account()["cash_krw"] == 3_000_000
    assert agent.buying_power_krw() == 10_000_000


def test_market_buy_in_session_fills_at_confirmed_price(env):
    store, notes, agent = env
    oid = buy(agent, target=115_000, stop=95_000, expire_date="2026-10-29")
    row = store.paper_order(oid)
    assert (row["status"], row["order_type"], row["filled_quantity"], row["fill_price"], row["fill_fx_rate"]) == (
        ex.EXIT_WATCHING, ex.MARKET, 10, 100_000, 1.0)
    assert (row["requested_by"], row["entry_price"], row["target_price"], row["stop_price"]) == (
        "alice", 100_000, 115_000, 95_000)
    assert cash(store) == pytest.approx(10_000_000 - 1_000_150)  # 금액 + 수수료 0.015%
    (fill,) = store.fills()
    assert (fill["side"], fill["price"], fill["quantity"], fill["amount"], fill["reason"]) == (
        "BUY", 100_000, 10, 1_000_000, "ENTRY")
    assert fill["commission"] == pytest.approx(150) and fill["cash_change_krw"] == pytest.approx(-1_000_150)
    assert notes.sent[0].startswith("[모의 주문 #1] 삼성전자 (005930) 10주 시장가 매수 접수 (요청 alice)")
    assert notes.sent[1].startswith("[모의 체결 #1] 삼성전자 (005930) 10주 매수 @ 100,000원")


def test_market_buy_off_hours_is_rejected(env):
    store, _, agent = env
    with pytest.raises(ex.OrderRejected, match="정규장 밖에서는 시장가"):
        buy(agent, regular_open=False)
    assert store.paper_orders() == []


def test_limit_buy_fills_only_at_or_below_limit_at_confirmed_price(env):
    store, notes, agent = env
    oid = buy(agent, price=101_000, limit_price=100_050)  # 호가 단위로 내림 → 100,000
    row = store.paper_order(oid)
    assert (row["status"], row["limit_price"], row["entry_price"]) == (ex.ENTRY_PENDING, 100_000, 100_000)
    assert agent.buying_power_krw() == pytest.approx(10_000_000 - 1_000_150)  # 대기 매수 금액을 뺀다
    sync(agent, {"005930": 100_500}, NOW + timedelta(minutes=1))
    assert store.paper_order(oid)["status"] == ex.ENTRY_PENDING
    sync(agent, {"005930": 99_800}, NOW + timedelta(minutes=2))
    row = store.paper_order(oid)
    assert row["status"] == ex.EXIT_WATCHING and row["fill_price"] == 99_800  # 지정가가 아니라 확인 가격
    assert cash(store) == pytest.approx(10_000_000 - 998_000 * 1.00015)
    assert "목표·손절 없이 보유" in notes.sent[-1]


def test_unfilled_limit_is_canceled_after_the_session_ends(env):
    store, notes, agent = env
    oid = buy(agent, price=101_000, limit_price=95_000)
    sync(agent, {"005930": 99_000}, CLOSE + timedelta(minutes=5), open_=(), close=NOW - timedelta(hours=19))
    assert store.paper_order(oid)["status"] == ex.ENTRY_PENDING  # 전날 마감 뒤에 접수했으니 오늘까지 유효
    sync(agent, {}, CLOSE + timedelta(minutes=10), open_=(), close=CLOSE)
    row = store.paper_order(oid)
    assert row["status"] == ex.CANCELED and "지정가에 체결되지 않음" in row["note"]
    assert cash(store) == 10_000_000 and store.fills() == [] and agent.buying_power_krw() == 10_000_000
    assert notes.sent[-1].startswith("[모의 주문 #1] 삼성전자 (005930) 취소: 정규장이 끝날 때까지")


def test_off_hours_limit_waits_for_next_session(env):
    store, _, agent = env
    evening = CLOSE + timedelta(hours=5)
    oid = buy(agent, now=evening, price=101_000, limit_price=100_000, regular_open=False)
    assert store.paper_order(oid)["status"] == ex.ENTRY_PENDING  # 정규장 밖이라 바로 체결하지 않는다
    sync(agent, {"005930": 99_000}, evening + timedelta(minutes=1), open_=(), close=CLOSE)
    assert store.paper_order(oid)["status"] == ex.ENTRY_PENDING  # 오늘 마감 전에 접수한 주문이 아니다
    next_open = NOW + timedelta(days=1)
    sync(agent, {"005930": 99_000}, next_open, close=CLOSE)
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING


def test_missing_price_or_closed_market_skips(env):
    store, notes, agent = env
    oid = buy(agent, price=101_000, limit_price=100_000)
    sync(agent, {}, NOW)
    assert "확인된 가격이 없어" in notes.logged[-1]
    sync(agent, {"005930": 90_000}, NOW, open_=())
    assert store.paper_order(oid)["status"] == ex.ENTRY_PENDING


def held(agent, **kw):
    return buy(agent, target=115_000, stop=95_000, expire_date="2026-10-29", **kw)


def test_target_needs_two_consecutive_confirmations(env):
    store, notes, agent = env
    oid = held(agent)
    sync(agent, {"005930": 116_000}, NOW + timedelta(minutes=1))
    assert store.paper_order(oid)["signal_count"] == 1 and "1/2회 확인" in notes.logged[-1]
    sync(agent, {"005930": 110_000}, NOW + timedelta(minutes=2))  # 튀는 가격: 다시 처음부터
    assert store.paper_order(oid)["signal_count"] == 0
    sync(agent, {"005930": 115_000}, NOW + timedelta(minutes=3))
    sync(agent, {"005930": 115_500}, NOW + timedelta(minutes=4))
    row = store.paper_order(oid)
    assert (row["status"], row["exit_reason"], row["exit_price"], row["signal_count"]) == (
        ex.CLOSED, "TARGET", 115_500, 2)
    proceeds = 1_155_000 * (1 - KR_SELL)
    assert row["pnl"] == pytest.approx(proceeds - 1_000_150) and row["pnl_krw"] == pytest.approx(row["pnl"])
    assert cash(store) == pytest.approx(10_000_000 - 1_000_150 + proceeds)
    sell = store.fills()[0]
    assert (sell["side"], sell["reason"]) == ("SELL", "TARGET")
    assert sell["tax"] == pytest.approx(1_155_000 * 0.002) and sell["commission"] == pytest.approx(1_155_000 * 0.00015)
    assert notes.sent[-1].startswith("[모의 청산 #1] 삼성전자 (005930) 목표가 도달: 10주 매도 @ 115,500원")


def test_stop_closes_with_loss_and_counts_for_daily_loss(env):
    store, _, agent = env
    oid = held(agent)
    sync(agent, {"005930": 94_000}, NOW + timedelta(minutes=1))
    sync(agent, {"005930": 93_500}, NOW + timedelta(minutes=2))
    row = store.paper_order(oid)
    assert (row["status"], row["exit_reason"], row["exit_price"]) == (ex.CLOSED, "STOP", 93_500)
    assert row["pnl"] == pytest.approx(935_000 * (1 - KR_SELL) - 1_000_150)
    count, loss = store.paper_today("2026-09-29")
    assert count == 1 and loss == pytest.approx(-row["pnl_krw"])


def test_no_exit_outside_regular_session(env):
    store, _, agent = env
    oid = held(agent)
    for minute in (1, 2, 3):
        sync(agent, {"005930": 90_000}, NOW + timedelta(hours=8, minutes=minute), open_=(), close=CLOSE)
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING  # 정규장에서만 청산한다


def test_expiry_sells_in_first_session_after_expire_date(env):
    store, _, agent = env
    oid = held(agent)
    sync(agent, {"005930": 105_000}, datetime(2026, 10, 29, 10, 0, tzinfo=KST))
    assert store.paper_order(oid)["signal_count"] == 0  # 기한 당일은 아직
    later = datetime(2026, 10, 30, 9, 1, tzinfo=KST)
    sync(agent, {"005930": 105_000}, later)
    sync(agent, {"005930": 104_000}, later + timedelta(minutes=1))
    row = store.paper_order(oid)
    assert (row["status"], row["exit_reason"], row["exit_price"]) == (ex.CLOSED, "EXPIRED", 104_000)


def test_position_without_levels_is_just_held(env):
    store, _, agent = env
    oid = buy(agent)
    for minute in (1, 2, 3):
        sync(agent, {"005930": 50_000}, NOW + timedelta(minutes=minute))
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING


def test_halt_blocks_new_buys_but_not_fills_or_exits(env, tmp_path):
    store, _, agent = env
    pending = buy(agent, "000660", price=101_000, limit_price=100_000, name="SK하이닉스")
    watching = held(agent)
    (tmp_path / "HALT").write_text("on")
    with pytest.raises(ex.OrderRejected, match="중단 스위치"):
        buy(agent, "035420", name="NAVER")
    sync(agent, {"000660": 99_000, "005930": 120_000}, NOW + timedelta(minutes=1))
    sync(agent, {"000660": 99_000, "005930": 120_000}, NOW + timedelta(minutes=2))
    assert store.paper_order(pending)["status"] == ex.EXIT_WATCHING
    assert store.paper_order(watching)["status"] == ex.CLOSED


@pytest.mark.parametrize("kw,expected", [
    ({"qty": 0}, "0 이하"),
    ({"qty": 1.5}, "정수 주"),
    ({"qty": 200}, "매수 가능 금액 부족"),
    ({"target": 110_000}, "함께 지정"),
    ({"target": 99_000, "stop": 95_000}, "순서가 아님"),
    ({"limit_price": 96_000, "target": 110_000, "stop": 97_000}, "지정가 96,000"),
    ({"qty": 1_000, "price": 100_000_000}, "1억원"),
])
def test_buy_blockers(env, kw, expected):
    store, _, agent = env
    with pytest.raises(ex.OrderRejected, match=expected):
        buy(agent, **kw)
    assert store.paper_orders() == [] and cash(store) == 10_000_000


def test_one_active_order_per_symbol(env):
    store, _, agent = env
    held(agent)
    with pytest.raises(ex.OrderRejected, match="같은 종목"):
        buy(agent, qty=1)
    agent.sell(1, 101_000, None, NOW, "alice")
    assert buy(agent, qty=1) == 2  # 청산한 뒤에는 다시 살 수 있다


def test_buying_power_counts_pending_orders(env):
    store, _, agent = env
    buy(agent, "000660", qty=60, price=101_000, limit_price=100_000, name="SK하이닉스")  # 약 600만원 대기
    with pytest.raises(ex.OrderRejected, match="매수 가능 금액 부족"):
        buy(agent, qty=50)  # 현금은 1천만원이지만 대기 주문을 빼면 400만원
    assert buy(agent, qty=39) == 2


def test_cash_shortage_at_fill_cancels(env):
    store, _, agent = env
    oid = buy(agent, "000660", qty=90, price=101_000, limit_price=100_000, name="SK하이닉스")
    store.db.execute("UPDATE paper_account SET cash_krw = 1000")  # 다른 체결로 현금이 줄었다고 친다
    store.db.commit()
    sync(agent, {"000660": 99_000}, NOW + timedelta(minutes=1))
    row = store.paper_order(oid)
    assert row["status"] == ex.CANCELED and "현금 부족" in row["note"] and store.fills() == []


def test_usd_order_converts_with_fill_rate_and_allows_fractions(env):
    store, notes, agent = env
    oid = buy(agent, "AAPL", qty=0.5, price=200.0, name="애플", market="US", currency="USD", fx_rate=1_400.0,
              target=250.0, stop=180.0)
    row = store.paper_order(oid)
    assert (row["filled_quantity"], row["fill_fx_rate"]) == (0.5, 1_400)
    buy_krw = 100 * 1.00025 * 1_400
    assert cash(store) == pytest.approx(10_000_000 - buy_krw)
    assert "0.5000주 매수 @ $200.00" in notes.sent[-1]
    for minute in (1, 2):
        sync(agent, {"AAPL": 260.0}, NOW + timedelta(minutes=minute), open_=("US",), fx=1_300.0)
    row = store.paper_order(oid)
    proceeds = 130 * (1 - 0.00025)  # 미국은 거래세 없음
    assert row["pnl"] == pytest.approx(proceeds - 100 * 1.00025)
    assert row["pnl_krw"] == pytest.approx(proceeds * 1_300 - buy_krw)  # 환율 변화가 원화 손익에 들어간다
    assert row["exit_fx_rate"] == 1_300 and "원)" in notes.sent[-1]


def test_usd_order_without_any_rate_is_rejected(env):
    _, _, agent = env
    with pytest.raises(ex.OrderRejected, match="환율"):
        buy(agent, "AAPL", qty=1, price=200.0, name="애플", market="US", currency="USD")


def test_sell_cancel_and_their_limits(env):
    store, notes, agent = env
    watching = held(agent)
    pending = buy(agent, "000660", price=101_000, limit_price=100_000, name="SK하이닉스")
    with pytest.raises(ex.OrderRejected, match="보유 중인 포지션은 매도"):
        agent.cancel(watching, NOW)
    agent.sell(pending, 99_000, None, NOW, "bob")  # 체결 대기 주문의 매도는 취소
    assert store.paper_order(pending)["status"] == ex.CANCELED and "bob" in store.paper_order(pending)["note"]
    agent.sell(watching, 101_000, None, NOW, "bob")
    row = store.paper_order(watching)
    assert (row["status"], row["exit_reason"], row["exit_price"], row["note"]) == (ex.CLOSED, "MANUAL", 101_000,
                                                                                    "bob 매도")
    with pytest.raises(ex.OrderRejected, match="이미 종료"):
        agent.sell(watching, 101_000, None, NOW, "bob")
    with pytest.raises(ex.OrderRejected, match="#9이\\(가\\) 없음"):
        agent.cancel(9, NOW)
    assert notes.sent[-1].startswith("[모의 청산 #1] 삼성전자 (005930) 사용자 매도")


def test_modify_updates_levels_and_resets_confirmations(env):
    store, notes, agent = env
    oid = held(agent)
    sync(agent, {"005930": 116_000}, NOW + timedelta(minutes=1))
    assert store.paper_order(oid)["signal_count"] == 1
    new = agent.modify(oid, 116_000, 120_050, None, "2026-11-30", NOW + timedelta(minutes=2))
    assert new == {"target_price": 120_000, "stop_price": 95_000, "expire_date": "2026-11-30"}
    row = store.paper_order(oid)
    assert (row["target_price"], row["signal_count"]) == (120_000, 0)
    assert "수정: 목표 120,000원 / 손절 95,000원 / 기한 2026-11-30" in notes.sent[-1]


@pytest.mark.parametrize("price,target,stop,expire,expected", [
    (100_000, None, 101_000, None, "순서가 아님"),
    (100_000, None, None, "2026-09-01", "이미 지남"),
    (100_000, 115_000, None, None, "바뀌는 값이 없음"),
])
def test_modify_blocked(env, price, target, stop, expire, expected):
    store, _, agent = env
    oid = held(agent)
    with pytest.raises(ex.OrderRejected, match=expected):
        agent.modify(oid, price, target, stop, expire, NOW)
    assert store.paper_order(oid)["target_price"] == 115_000


def test_modify_needs_both_levels_on_plain_position(env):
    _, _, agent = env
    oid = buy(agent)
    with pytest.raises(ex.OrderRejected, match="함께 지정"):
        agent.modify(oid, 100_000, 110_000, None, None, NOW)
    assert agent.modify(oid, 100_000, 110_000, 95_000, None, NOW)["stop_price"] == 95_000


def test_submit_plan_places_entry_limit_for_ai_scenario(env):
    store, notes, agent = env
    c = candidate()
    plan = ex.make_plan(c, NOW.date())
    oid = agent.submit_plan(c, plan, "삼성전자", 7, "strategy:2", NOW)
    row = store.paper_order(oid)
    assert (row["order_type"], row["limit_price"], row["quantity"], row["trade_id"], row["requested_by"]) == (
        ex.LIMIT, 100_000, 9, 7, "strategy:2")
    assert (row["target_price"], row["stop_price"], row["expire_date"], row["status"]) == (
        115_000, 95_000, "2026-10-15", ex.ENTRY_PENDING)
    assert notes.sent[-1].startswith("[모의 주문 #1] 삼성전자 (005930) 9주 지정가 100,000원 매수 접수 (AI 시나리오")
    with pytest.raises(ex.OrderRejected, match="같은 종목"):
        agent.submit_plan(c, plan, "삼성전자", 8, "strategy:2", NOW)


def test_expected_pnl_and_money_text():
    row = {"filled_quantity": None, "fill_price": None, "quantity": 10, "limit_price": 100_000.0,
           "entry_price": 101_000.0, "target_price": 115_000.0, "stop_price": 95_000.0}
    assert ex.expected_pnl(row) == (150_000, -50_000)  # 체결 전에는 지정가 기준
    filled = row | {"filled_quantity": 0.4, "fill_price": 100_500.0}
    assert ex.expected_pnl(filled) == pytest.approx((0.4 * 14_500, -0.4 * 5_500))
    assert ex.expected_pnl(row | {"target_price": None, "stop_price": None}) == (None, None)
    assert ex.signed_money(-17.5, "USD") == "-$17.50" and ex.signed_money(1950, "KRW") == "+1,950원"


def test_account_summary_and_context(env):
    store, _, agent = env
    held(agent)  # 10주 @ 100,000
    buy(agent, "000660", qty=5, price=201_000, limit_price=200_000, name="SK하이닉스")
    s = agent.account_summary({"005930": 110_000}, None)
    assert s["holdingsValueKrw"] == 1_100_000 and s["cashKrw"] == pytest.approx(10_000_000 - 1_000_150)
    assert s["equityKrw"] == pytest.approx(10_000_000 - 1_000_150 + 1_100_000)
    assert s["pendingKrw"] == pytest.approx(1_000_000 * 1.00015)
    assert s["buyingPowerKrw"] == pytest.approx(s["cashKrw"] - s["pendingKrw"])
    (h,) = s["holdings"]
    assert (h["unrealized"], h["priced"], h["requestedBy"]) == (100_000, True, "alice")
    assert agent.account_summary({}, None)["holdings"][0]["value"] == 1_000_000  # 가격이 없으면 체결가

    ctx = agent.account_context("005930", "KRW", None, {"005930": 110_000}, 5e9, ["경고"], 3_000_000, 500_000,
                                NOW.date())
    assert ctx.equity_krw == pytest.approx(s["equityKrw"]) and ctx.buying_power == 500_000  # 종목당 한도
    assert (ctx.commission_rate, ctx.fx_rate, ctx.position_value, ctx.daily_trades) == (0.00015, 1.0, 1_100_000, 2)
    assert ctx.invested_krw == 1_000_000 + 1_000_000 and ctx.max_total_krw == 3_000_000
    assert ctx.warnings == ["경고"] and ctx.avg_daily_trading_amount == 5e9 and ctx.daily_loss_krw == 0


# --- 혼합 통화 매수 가능액과 주문 잠금 (독립 리뷰 M1·M3) ---

def test_pending_usd_order_counts_at_usd_rate_in_buying_power(env):
    store, _, agent = env
    # 달러 지정가 대기 $6,000 (환율 1400이면 약 840만원)
    buy(agent, "AAPL", qty=30, price=210.0, name="애플", market="US", currency="USD", fx_rate=1_400.0,
        limit_price=200.0)
    assert agent.buying_power_krw(1_400.0) == pytest.approx(10_000_000 - 6_000 * 1.00025 * 1_400)
    with pytest.raises(ex.OrderRejected, match="매수 가능 금액 부족"):
        buy(agent, qty=50, fx_rate=1_400.0)  # 국내 500만원: 대기 달러 주문을 환율로 빼면 모자란다


def test_order_lock_serializes_check_and_insert_across_threads(tmp_path):
    import threading
    import time

    class SlowCheck(ex.PaperExecutor):
        def buy_blockers(self, *args, **kwargs):
            reasons = super().buy_blockers(*args, **kwargs)
            time.sleep(0.05)  # 점검과 기록 사이에 다른 스레드가 끼어들 틈을 만든다
            return reasons

    db = tmp_path / "t.db"
    Store(db, capital_krw=10_000_000)
    results = []

    def worker():
        agent = SlowCheck(Store(db, capital_krw=10_000_000), Notes(), tmp_path / "HALT", RATES)
        try:
            results.append(buy(agent, qty=10, limit_price=99_000))
        except ex.OrderRejected as e:
            results.append(str(e))

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results, key=str)[0] == 1 and "같은 종목" in str(results)
    assert len(Store(db).paper_orders(ex.ACTIVE)) == 1  # 같은 종목은 포지션 하나만


def test_order_lock_is_a_file_lock_for_other_processes(env, tmp_path):
    import fcntl
    _, _, agent = env
    with agent.lock, open(tmp_path / "paper.lock", "a") as other:  # 다른 프로세스가 잡으려는 것과 같다
        with pytest.raises(BlockingIOError):
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with open(tmp_path / "paper.lock", "a") as other:  # 풀린 뒤에는 잡힌다
        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(other, fcntl.LOCK_UN)
