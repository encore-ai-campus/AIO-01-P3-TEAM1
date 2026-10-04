"""모의 체결기의 보유 방식(style)과 단타 정리 (docs/API.md "보유 방식"·"청산 사유"·"단타 연습", docs/DECISIONS.md 14-3·14-4).

- style은 주문에 저장된다. long·day는 보유 기한이 없고, long은 목표·손절도 없다.
- day 주문의 세션 = 접수 시각의 KST 날짜. 그 세션 15:15 KST부터 체결 대기는 취소("단타 진입 마감"), 보유는 정규장 첫 확인에서
  2회 확인 없이 바로 판다(EOD). 장이 닫혀 놓친 보유는 다음 정규장 첫 확인에서 판다. 15:15부터 새 단타 매수는 day_entry_closed.
- 거절 문장(buy_blockers·modify)에는 장중 확인 가격이나 그것으로 계산한 금액을 넣지 않는다. 사유 코드는 문장과 같은 길이·순서.

시각은 모두 고정한다 (KST·UTC를 섞어 본다).
"""
from datetime import date, datetime, timedelta, timezone

import pytest

from paper_engine.agents import executor as ex
from paper_engine.records.store import Store
from test_executor import RATES, Notes

KST = timezone(timedelta(hours=9))
DAY0 = date(2026, 9, 29)                                   # 화요일, 국내 거래일
MORNING = datetime(2026, 9, 29, 10, 0, tzinfo=KST)
CUTOFF = datetime(2026, 9, 29, 15, 15, tzinfo=KST)
NEXT_OPEN = datetime(2026, 9, 30, 9, 0, 30, tzinfo=KST)


@pytest.fixture
def env(tmp_path):
    store, notes = Store(":memory:", capital_krw=10_000_000), Notes()
    return store, notes, ex.PaperExecutor(store, notes, tmp_path / "HALT", RATES)


def buy(agent, symbol="005930", qty=10, price=100_000, **kw):
    kw = {"name": "삼성전자", "market": "KR", "currency": "KRW", "fx_rate": None, "now": MORNING,
          "requested_by": "alice"} | kw
    return agent.buy(symbol, kw.pop("name"), kw.pop("market"), kw.pop("currency"), qty, price, kw.pop("fx_rate"),
                     kw.pop("now"), kw.pop("requested_by"), **kw)


def sync(agent, prices, now, open_=("KR",), close=None):
    return agent.sync(prices, now, set(open_), None, {"KR": close, "US": close})


def day_held(agent, **kw):
    """10:00에 시장가로 체결된 단타 보유 (목표 110,000 / 손절 95,000)."""
    return buy(agent, target=110_000, stop=95_000, style=ex.DAY, **kw)


# --- style 저장·보유 기한 ---

def test_style_is_stored_and_defaults_to_swing(env):
    store, _, agent = env
    swing = buy(agent, target=115_000, stop=95_000, expire_date="2026-10-29")
    long_ = buy(agent, "000660", price=200_000, name="SK하이닉스", style=ex.LONG, expire_date="2026-10-29")
    row = store.paper_order(swing)
    assert (row["style"], row["expire_date"]) == ("swing", "2026-10-29")
    row = store.paper_order(long_)
    assert (row["style"], row["expire_date"], row["target_price"], row["stop_price"]) == ("long", None, None, None)


def test_long_takes_no_levels_and_is_never_sold_automatically(env):
    store, notes, agent = env
    with pytest.raises(ex.OrderRejected, match="장기 보유는 목표가·손절가 없이") as e:
        buy(agent, style=ex.LONG, target=115_000, stop=95_000)
    assert e.value.codes == [ex.INVALID_ORDER]
    oid = buy(agent, style=ex.LONG)
    assert "장기 보유 (자동 매도 없음)" in notes.sent[-1]
    store.update_paper_order(oid, expire_date="2026-09-01")  # 예전 기록에 기한이 남아 있어도 보지 않는다
    for minute in (1, 2, 3):
        sync(agent, {"005930": 50_000}, MORNING + timedelta(days=60, minutes=minute))
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING


def test_unknown_style_is_rejected(env):
    store, _, agent = env
    with pytest.raises(ex.OrderRejected, match="모르는 보유 방식") as e:
        buy(agent, style="weekly")
    assert e.value.codes == [ex.INVALID_ORDER] and store.paper_orders() == []


def test_day_order_has_no_expiry_and_says_when_it_closes(env):
    store, notes, agent = env
    oid = buy(agent, limit_price=99_000, target=110_000, stop=95_000, style=ex.DAY, expire_date="2026-10-01",
              regular_open=False, now=datetime(2026, 9, 29, 8, 0, tzinfo=KST))   # 장 전 계획의 진입 주문
    row = store.paper_order(oid)
    assert (row["style"], row["expire_date"], row["status"]) == ("day", None, ex.ENTRY_PENDING)
    assert "15:15에 장 마감 전 정리" in notes.sent[-1]


# --- 단타 진입 마감 (day_entry_closed) ---

@pytest.mark.parametrize("now", [
    datetime(2026, 9, 29, 15, 15, tzinfo=KST),
    datetime(2026, 9, 29, 15, 29, tzinfo=KST),
    datetime(2026, 9, 29, 20, 0, tzinfo=KST),
    datetime(2026, 9, 29, 6, 20, tzinfo=timezone.utc),       # 15:20 KST
    datetime(2026, 9, 29, 15, 16),                           # 시간대 없음 → KST로 본다
])
def test_new_day_entry_is_closed_from_1515_kst(env, now):
    store, _, agent = env
    with pytest.raises(ex.OrderRejected, match="단타 진입 마감") as e:
        buy(agent, limit_price=99_000, target=110_000, stop=95_000, style=ex.DAY, now=now)
    assert e.value.codes == ["day_entry_closed"] and store.paper_orders() == []


@pytest.mark.parametrize("now", [
    datetime(2026, 9, 29, 15, 14, 59, tzinfo=KST),
    datetime(2026, 9, 29, 0, 0, tzinfo=KST),
    datetime(2026, 9, 28, 23, 30, tzinfo=timezone.utc),      # 09-29 08:30 KST (UTC 날짜는 하루 앞)
])
def test_day_entry_is_open_before_1515_kst(env, now):
    _, _, agent = env
    assert buy(agent, limit_price=99_000, target=110_000, stop=95_000, style=ex.DAY, now=now,
               regular_open=False) == 1


def test_day_entry_closed_does_not_touch_swing_orders(env):
    _, _, agent = env
    assert buy(agent, limit_price=99_000, now=datetime(2026, 9, 29, 15, 20, tzinfo=KST)) == 1


def test_day_style_is_korean_only(env):
    _, _, agent = env
    with pytest.raises(ex.OrderRejected, match="국내 종목만") as e:
        buy(agent, "AAPL", qty=1, price=200.0, name="애플", market="US", currency="USD", fx_rate=1_400.0,
            style=ex.DAY)
    assert e.value.codes == [ex.INVALID_ORDER]


# --- 사유 코드와 장중 가격 숫자 ---

def test_buy_checks_return_codes_in_reason_order(env, tmp_path):
    store, _, agent = env
    buy(agent, "000660", qty=90, price=100_000, name="SK하이닉스", limit_price=99_000)  # 약 891만원 대기
    (tmp_path / "HALT").touch()
    reasons, codes = agent.buy_checks("000660", "KR", "KRW", 50, 100_000, None, None, None, None, False,
                                      style=ex.DAY, now=CUTOFF)
    assert codes == ["halted", "day_entry_closed", ex.MARKET_CLOSED, "cash_short", "position_exists"]
    assert len(reasons) == len(codes) and reasons[3] == "매수 가능 금액 부족 (가능 1,088,664원)"
    assert agent.buy_blockers("000660", "KR", "KRW", 50, 100_000, None, None, None, None, False,
                              style=ex.DAY, now=CUTOFF) == reasons
    (tmp_path / "HALT").unlink()
    assert agent.buy_checks("005930", "KR", "KRW", 1, 100_000, None, None, None, None, True) == ([], [])


def test_rejections_from_buy_carry_codes(env):
    _, _, agent = env
    with pytest.raises(ex.OrderRejected) as e:
        buy(agent, qty=0, target=110_000)
    assert e.value.codes == [ex.INVALID_ORDER, ex.INVALID_ORDER]
    assert str(e.value) == "수량이 0 이하; 목표가와 손절가를 함께 지정해야 함"
    with pytest.raises(ex.OrderRejected) as e:
        buy(agent, qty=1_000, price=100_000_000)
    assert e.value.codes == [ex.ORDER_TOO_LARGE, "cash_short"]
    with pytest.raises(ex.OrderRejected) as e:
        buy(agent, "AAPL", qty=1, price=200.0, name="애플", market="US", currency="USD")
    assert e.value.codes == [ex.FX_UNAVAILABLE]


def test_market_order_sequence_text_has_no_intraday_price(env):
    """시장가 순서 검사의 현재가는 장중 가격이다. 문장에는 목표·손절만 넣는다 (docs/API.md)."""
    _, _, agent = env
    with pytest.raises(ex.OrderRejected) as e:
        buy(agent, price=123_400, target=120_000, stop=95_000)
    assert str(e.value) == "손절가 95,000 < 현재가 < 목표가 120,000 순서가 아님"
    assert "123" not in str(e.value) and e.value.codes == ["price_passed"]
    with pytest.raises(ex.OrderRejected) as e:  # 목표가가 손절가보다 낮은 입력 오류
        buy(agent, price=123_400, target=95_000, stop=120_000)
    assert e.value.codes == [ex.INVALID_ORDER] and "123" not in str(e.value)
    with pytest.raises(ex.OrderRejected) as e:  # 지정가는 사용자가 넣은 숫자라 그대로 보인다
        buy(agent, limit_price=96_000, target=110_000, stop=97_000)
    assert str(e.value) == "손절가 97,000 < 지정가 96,000 < 목표가 110,000 순서가 아님"
    assert e.value.codes == [ex.INVALID_ORDER]


def test_cash_short_text_has_no_needed_amount(env):
    _, _, agent = env
    with pytest.raises(ex.OrderRejected) as e:
        buy(agent, qty=102, price=98_765)
    assert str(e.value) == "매수 가능 금액 부족 (가능 10,000,000원)" and "필요" not in str(e.value)


def test_fill_time_cash_shortage_note_has_no_intraday_amount(env):
    store, _, agent = env
    oid = buy(agent, "000660", qty=90, price=101_000, limit_price=100_000, name="SK하이닉스")
    store.db.execute("UPDATE paper_account SET cash_krw = 1000")
    store.db.commit()
    sync(agent, {"000660": 99_123}, MORNING + timedelta(minutes=1))
    row = store.paper_order(oid)
    assert (row["status"], row["note"]) == (ex.CANCELED, "체결 시점 현금 부족 (현금 1,000원)")


def test_modify_text_has_no_intraday_price(env):
    _, _, agent = env
    oid = buy(agent, target=115_000, stop=95_000)
    with pytest.raises(ex.OrderRejected) as e:
        agent.modify(oid, 96_543, None, 97_000, None, MORNING)
    assert str(e.value) == "손절가 97,000 < 현재가 < 목표가 115,000 순서가 아님" and "96" not in str(e.value)


def test_modify_respects_style(env):
    store, _, agent = env
    long_ = buy(agent, style=ex.LONG)
    with pytest.raises(ex.OrderRejected, match="장기 보유 주문은 목표가·손절가·기한을 정하지 않음"):
        agent.modify(long_, 100_000, 110_000, 95_000, None, MORNING)
    with pytest.raises(ex.OrderRejected, match="장기 보유 주문"):
        agent.modify(long_, 100_000, None, None, "2026-12-31", MORNING)
    day = day_held(agent, symbol="000660", name="SK하이닉스", price=100_000)
    with pytest.raises(ex.OrderRejected, match="단타 주문은 보유 기한이 없음"):
        agent.modify(day, 100_000, None, None, "2026-12-31", MORNING)
    with pytest.raises(ex.OrderRejected, match="단타 계획에서 바꿔요"):
        agent.modify(day, 100_000, 120_000, None, None, MORNING)
    assert store.paper_order(day)["target_price"] == 110_000


def test_modify_expiry_uses_kst_date(env):
    """09:00 KST 전에는 UTC 날짜가 하루 앞이다. 기한이 지났는지는 KST 날짜로 본다."""
    _, _, agent = env
    oid = buy(agent, target=115_000, stop=95_000, expire_date="2026-10-29")
    early = datetime(2026, 9, 28, 23, 0, tzinfo=timezone.utc)   # 09-29 08:00 KST
    with pytest.raises(ex.OrderRejected, match="이미 지남"):
        agent.modify(oid, None, None, None, "2026-09-28", early)
    assert agent.modify(oid, None, None, None, "2026-09-29", early)["expire_date"] == "2026-09-29"


# --- 단타 정리 (sync) ---

def test_pending_day_entry_is_cancelled_at_1515_even_when_market_is_closed(env):
    store, notes, agent = env
    oid = buy(agent, limit_price=95_500, target=110_000, stop=90_000, style=ex.DAY)
    sync(agent, {"005930": 99_000}, CUTOFF - timedelta(seconds=1))
    assert store.paper_order(oid)["status"] == ex.ENTRY_PENDING
    sync(agent, {"005930": 95_000}, CUTOFF, open_=())   # 체결을 시도하지 않고 먼저 취소한다
    row = store.paper_order(oid)
    assert (row["status"], row["note"]) == (ex.CANCELED, ex.DAY_ENTRY_CLOSED) == (ex.CANCELED, "단타 진입 마감")
    assert store.fills() == [] and notes.sent[-1].endswith("취소: 단타 진입 마감")


def test_day_holding_is_sold_at_1515_without_two_confirmations(env):
    store, notes, agent = env
    oid = day_held(agent)
    sync(agent, {"005930": 101_000}, CUTOFF - timedelta(minutes=1))
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING
    sync(agent, {"005930": 101_000}, CUTOFF)
    row = store.paper_order(oid)
    assert (row["status"], row["exit_reason"], row["exit_price"]) == (ex.CLOSED, "EOD", 101_000)
    assert [f["reason"] for f in store.order_fills(oid)] == ["ENTRY", "EOD"]
    assert "장 마감 전 정리: 10주 매도 @ 101,000원" in notes.sent[-1]
    assert ex.EXIT_LABEL["EOD"] == "장 마감 전 정리" and len("EOD") <= 8


def test_day_holding_before_cutoff_still_needs_two_confirmations(env):
    store, _, agent = env
    oid = day_held(agent)
    sync(agent, {"005930": 111_000}, MORNING + timedelta(minutes=1))
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING
    sync(agent, {"005930": 111_000}, MORNING + timedelta(minutes=2))
    assert store.paper_order(oid)["exit_reason"] == "TARGET"


def test_missed_day_holding_is_sold_at_next_session_first_check(env):
    store, notes, agent = env
    oid = day_held(agent)
    sync(agent, {}, datetime(2026, 9, 29, 15, 40, tzinfo=KST), open_=())    # 장이 닫혀 있다 → 못 판다
    sync(agent, {}, datetime(2026, 9, 30, 8, 0, tzinfo=KST), open_=())
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING
    sync(agent, {}, NEXT_OPEN)                                               # 확인 가격이 없으면 다음 확인에서
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING
    assert "장 마감 전 정리를 다음 확인에서" in notes.logged[-1]
    sync(agent, {"005930": 97_000}, NEXT_OPEN + timedelta(seconds=5))
    row = store.paper_order(oid)
    assert (row["status"], row["exit_reason"], row["exit_price"]) == (ex.CLOSED, "EOD", 97_000)
    assert row["closed_at"].startswith("2026-09-30T09:00:35")


def test_day_session_is_the_kst_date_of_created_at(env):
    """접수 시각이 UTC로 저장돼도 세션은 KST 날짜다 (09-29 08:30 KST 접수 → 09-29 15:15 정리)."""
    store, _, agent = env
    created = datetime(2026, 9, 28, 23, 30, tzinfo=timezone.utc)
    oid = buy(agent, limit_price=95_000, target=110_000, stop=90_000, style=ex.DAY, now=created, regular_open=False)
    assert ex.day_session(store.paper_order(oid)["created_at"]) == DAY0
    assert ex.day_cutoff(store.paper_order(oid)["created_at"]) == CUTOFF
    sync(agent, {"005930": 99_000}, datetime(2026, 9, 29, 6, 14, tzinfo=timezone.utc))   # 15:14 KST
    assert store.paper_order(oid)["status"] == ex.ENTRY_PENDING
    sync(agent, {"005930": 99_000}, datetime(2026, 9, 29, 6, 15, tzinfo=timezone.utc))   # 15:15 KST
    assert store.paper_order(oid)["note"] == "단타 진입 마감"
    assert ex.day_session("2026-09-29T15:20:00") == DAY0   # 시간대 없는 기록은 KST로 본다


def test_swing_holding_is_not_closed_at_1515(env):
    store, _, agent = env
    oid = buy(agent, target=115_000, stop=95_000)
    sync(agent, {"005930": 101_000}, CUTOFF + timedelta(minutes=5))
    assert store.paper_order(oid)["status"] == ex.EXIT_WATCHING


# --- 하루 한도는 style별로 센다 ---

def test_account_context_counts_daily_trades_by_style(env):
    _, _, agent = env
    buy(agent, limit_price=99_000, regular_open=False)
    buy(agent, "000660", price=200_000, name="SK하이닉스", limit_price=150_000, target=170_000, stop=140_000,
        style=ex.DAY, regular_open=False)
    args = ("005930", "KRW", None, {}, None, [], None, None, DAY0)
    assert agent.account_context(*args).daily_trades == 2
    assert agent.account_context(*args, style=ex.DAY).daily_trades == 1
    assert agent.account_context(*args, style=ex.SWING).daily_trades == 1
    assert agent.account_context(*args, style=ex.LONG).daily_trades == 0
