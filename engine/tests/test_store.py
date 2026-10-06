import pytest

from paper_engine.records import paper
from paper_engine.judge.verdict import Approval, Candidate, Critique
from paper_engine.records.paper import Outcome
from paper_engine.judge.risk import AccountContext, assess
from paper_engine.judge.scenario import Scenario
from paper_engine.records.store import Store

ACCOUNT = AccountContext(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.0,
                         max_total_krw=1_000_000)  # 총 금액 한도 100만원


def candidate(proposer_p=0.6, critics=(("openai", 70, 0.5), ("google", 40, 0.4)), approved=True):
    s = Scenario(symbol="005930", currency="KRW", horizon="SWING", entry_price=100_000,
                 target_price=115_000, stop_price=95_000, probability=proposer_p, holding_days=10)
    final = Scenario(**{**s.__dict__, "probability": 0.5})
    score = 0.5 * 80 + sum({"openai": 0.3, "google": 0.2}[a] * v for a, v, _ in critics)
    approval = Approval(approved, "사유", [], "approver-model") if score >= 60 else None
    return Candidate(id="S1", proposer="claude", raw={}, scenario=s, final=final,
                     consensus_probability=0.5, proposer_score=80, score=score, participation=1.0,
                     approval=approval, critiques=[Critique(a, v, p, [], "") for a, v, p in critics],
                     assessment=assess(final, ACCOUNT))


def add(store, c):
    return store.add_candidate(c, "삼성전자", "2026-09-29T12:00:00+09:00", "2026-09-28", 0.0, 0.002)


def test_add_and_list_active():
    store = Store(":memory:")
    tid = add(store, candidate())
    (t,) = store.active_trades()
    assert t["id"] == tid and t["status"] == paper.PENDING
    assert t["selected"] == 1 and t["quantity"] == 10
    assert t["score"] == pytest.approx(69)
    assert t["created_date"] == "2026-09-28"


def test_records_rejection_reason_for_unselected():
    store = Store(":memory:")
    add(store, candidate(critics=(("openai", 30, 0.5),)))
    (t,) = store.trades()
    assert t["selected"] == 0 and t["passed"] == 0 and t["approved"] is None
    assert "교차검증 점수" in t["reject_reasons"]


def test_records_approval():
    store = Store(":memory:")
    add(store, candidate())
    add(store, candidate(approved=False))
    ok, rejected = store.trades()
    assert (ok["passed"], ok["approved"], ok["selected"]) == (1, 1, 1)
    assert ok["approver"] == "approver-model"
    assert (rejected["passed"], rejected["approved"], rejected["selected"]) == (1, 0, 0)
    assert "최종 컨펌 거부" in rejected["reject_reasons"]


def test_outcome_update_and_stats():
    store = Store(":memory:")
    win, lose = add(store, candidate()), add(store, candidate(proposer_p=0.8))
    store.update_outcome(win, Outcome(paper.TARGET, "2026-09-30", 100_000, "2026-10-02", 115_000), 148_000)
    store.update_outcome(lose, Outcome(paper.STOP, "2026-09-30", 100_000, "2026-10-01", 95_000), -52_000)
    assert store.active_trades() == []

    (summary,) = store.summary()
    assert summary["target"] == 1 and summary["stop"] == 1 and summary["pnl"] == 96_000

    stats = {r["analyst"]: r for r in store.model_stats()}
    assert stats["claude"]["n"] == 2 and stats["claude"]["hit_rate"] == 0.5
    # claude: (0.6-1)^2=0.16, (0.8-0)^2=0.64 → 평균 0.40
    assert stats["claude"]["brier"] == pytest.approx(0.40)
    assert stats["openai"]["brier"] == pytest.approx(0.25)


def test_prediction_summary():
    store = Store(":memory:")
    assert store.prediction_summary() == {"total": 0, "selected": 0, "active": 0, "closed": 0, "resolved": 0,
                                          "target": 0, "avg_probability": None, "hit_rate": None}
    a, b, c, d = (add(store, candidate()) for _ in range(4))
    s = store.prediction_summary()
    assert (s["total"], s["active"], s["closed"], s["hit_rate"]) == (4, 4, 0, None)
    store.update_outcome(a, Outcome(paper.TARGET, "2026-09-30", 100_000, "2026-10-02", 115_000), 1.0)
    store.update_outcome(b, Outcome(paper.STOP, "2026-09-30", 100_000, "2026-10-01", 95_000), -1.0)
    store.update_outcome(c, Outcome(paper.UNFILLED), None)
    s = store.prediction_summary()
    assert (s["total"], s["active"], s["closed"], s["resolved"], s["target"]) == (4, 1, 3, 2, 1)
    assert s["hit_rate"] == 0.5 and s["avg_probability"] == pytest.approx(0.5)


def test_stats_ignore_unfinished_trades():
    store = Store(":memory:")
    add(store, candidate())
    assert store.model_stats() == []


def test_migrates_database_from_vote_schema(tmp_path):
    import sqlite3
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE trades (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL,
            created_date TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL,
            currency TEXT NOT NULL, horizon TEXT NOT NULL, proposer TEXT NOT NULL,
            entry_price REAL NOT NULL, target_price REAL NOT NULL, stop_price REAL NOT NULL,
            holding_days INTEGER NOT NULL, consensus_probability REAL NOT NULL,
            agree_count INTEGER NOT NULL, agree_weight REAL NOT NULL,
            critic_count INTEGER NOT NULL, selected INTEGER NOT NULL,
            reject_reasons TEXT NOT NULL, quantity INTEGER NOT NULL,
            commission_rate REAL NOT NULL, sell_tax_rate REAL NOT NULL, status TEXT NOT NULL,
            filled_at TEXT, fill_price REAL, closed_at TEXT, exit_price REAL, pnl REAL,
            run_file TEXT);
        CREATE TABLE predictions (trade_id INTEGER NOT NULL, analyst TEXT NOT NULL,
            role TEXT NOT NULL, probability REAL NOT NULL, verdict TEXT);
        INSERT INTO trades VALUES (1,'t','2026-09-28','AAPL','애플','USD','SWING','claude',
            337,348,329,15,0.45,0,0.5,2,0,'x',2,0.0,0.0,'PENDING',NULL,NULL,NULL,NULL,NULL,'r');
        INSERT INTO predictions VALUES (1,'claude','PROPOSER',0.47,NULL);
    """)
    db.commit()
    db.close()

    store = Store(path)
    (old,) = store.trades()
    assert old["symbol"] == "AAPL" and old["score"] is None
    add(store, candidate())
    old, new = store.trades()
    assert (old["score"], old["passed"]) == (None, None)
    assert new["score"] == pytest.approx(69) and new["passed"] == 1
    assert len(store.active_trades()) == 2


# --- 시장 기록과 리포트용 조회 ---

def market_day(store, market, day, close):
    store.add_market_day(market, day, f"{day}T16:00:00+09:00", None, "069500", close, 0.01, 1390.0,
                         [{"type": "AMOUNT", "rank": r, "symbol": f"S{r}", "name": f"종목{r}"} for r in (2, 1, 3)])


def test_market_days_in_order_with_limit_and_rankings():
    store = Store(":memory:")
    for day, close in (("2026-09-28", 100.0), ("2026-09-30", 102.0), ("2026-09-29", 101.0)):
        market_day(store, "KR", day, close)
    market_day(store, "US", "2026-09-29", 500.0)
    assert [d["day"] for d in store.market_days("KR")] == ["2026-09-28", "2026-09-29", "2026-09-30"]
    assert [d["day"] for d in store.market_days("KR", 2)] == ["2026-09-29", "2026-09-30"]  # 최근 2개, 과거 → 최신
    assert store.market_day_count("KR") == 3 and store.market_day_count("US") == 1
    assert [r["rank"] for r in store.rankings("KR", "2026-09-30", "AMOUNT")] == [1, 2, 3]
    assert [r["symbol"] for r in store.rankings("KR", "2026-09-30", "AMOUNT", 2)] == ["S1", "S2"]
    assert store.rankings("KR", "2026-09-30", "GAINERS") == []


def paper_order(store, created_at, status="ENTRY_PENDING", **fields):
    base = dict(requested_by="alice", trade_id=None, symbol="005930", name="삼성전자", market="KR", currency="KRW",
                order_type="LIMIT", limit_price=100_000.0, quantity=10, entry_price=100_000.0, target_price=115_000.0,
                stop_price=95_000.0, expire_date="2026-10-29", status=status, created_at=created_at)
    return store.add_paper_order(**(base | fields))


def test_paper_tables_follow_decisions():
    store = Store(":memory:")
    columns = {t: {r["name"] for r in store.db.execute(f"PRAGMA table_info({t})")}
               for t in ("paper_account", "paper_orders", "paper_fills", "equity_daily")}
    assert columns["paper_account"] == {"id", "name", "initial_capital_krw", "cash_krw", "created_at"}
    assert columns["paper_orders"] == {
        "id", "account_id", "requested_by", "trade_id", "symbol", "name", "market", "currency", "order_type",
        "limit_price", "quantity", "entry_price", "target_price", "stop_price", "expire_date", "status",
        "filled_quantity", "fill_price", "fill_fx_rate", "filled_at", "exit_price", "exit_fx_rate", "exit_reason",
        "closed_at", "pnl", "pnl_krw", "signal_count", "note", "created_at", "style"}
    assert columns["paper_fills"] == {"id", "order_id", "side", "price", "quantity", "amount", "commission", "tax",
                                      "fx_rate", "cash_change_krw", "reason", "filled_at"}
    assert columns["equity_daily"] == {"account_id", "day", "cash_krw", "holdings_value_krw", "equity_krw",
                                       "recorded_at"}
    tables = {r[0] for r in store.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert not {"live_orders", "manual_orders"} & tables


def test_add_fill_moves_cash_and_order_together():
    store = Store(":memory:", capital_krw=5_000_000)
    oid = paper_order(store, "2026-09-29T10:00:00+09:00")
    assert store.paper_order(oid)["account_id"] == 1 and store.paper_order(oid)["signal_count"] == 0
    store.add_fill(oid, "BUY", 99_000, 10, 148.5, 0.0, 1.0, -990_148.5, "ENTRY", "2026-09-29T10:01:00+09:00",
                   {"status": "EXIT_WATCHING", "filled_quantity": 10, "fill_price": 99_000.0})
    assert store.account()["cash_krw"] == 5_000_000 - 990_148.5
    row = store.paper_order(oid)
    assert (row["status"], row["fill_price"]) == ("EXIT_WATCHING", 99_000)
    (fill,) = store.order_fills(oid)
    assert (fill["amount"], fill["filled_at"]) == (990_000, "2026-09-29T10:01:00+09:00")
    (joined,) = store.fills(limit=5)
    assert (joined["symbol"], joined["requested_by"], joined["currency"]) == ("005930", "alice", "KRW")
    assert store.fills(since="2026-09-30") == []


def test_paper_order_queries_for_report():
    store = Store(":memory:")
    old = paper_order(store, "2026-09-20T10:00:00+09:00", "CLOSED", closed_at="2026-09-25T10:00:00+09:00",
                      pnl=-5.0, pnl_krw=-5.0)
    closed = paper_order(store, "2026-09-28T10:00:00+09:00", "CLOSED", filled_at="2026-09-28T10:05:00+09:00",
                         closed_at="2026-09-30T09:10:00+09:00", pnl=150_000.0, pnl_krw=150_000.0)
    filled = paper_order(store, "2026-09-20T10:00:00+09:00", "EXIT_WATCHING", filled_at="2026-09-29T10:00:00+09:00")
    new = paper_order(store, "2026-09-29T12:00:00+09:00")
    paper_order(store, "2026-09-10T10:00:00+09:00", "EXIT_WATCHING", filled_at="2026-09-11T10:00:00+09:00")
    since = "2026-09-29T09:00:00+09:00"
    assert [r["id"] for r in store.closed_paper_orders()] == [old, closed]
    assert [r["id"] for r in store.closed_paper_orders(since)] == [closed]
    assert [r["id"] for r in store.paper_orders_touched_since(since)] == [closed, filled, new]
    assert [r["id"] for r in store.paper_orders(("EXIT_WATCHING",))] == [filled, 5]
    assert store.paper_today("2026-09-25") == (0, 5.0) and store.paper_today("2026-09-29") == (1, 0.0)


def test_equity_days_and_last_fx_rate():
    store = Store(":memory:")
    for day, cash in (("2026-09-28", 9e6), ("2026-09-30", 8e6), ("2026-09-29", 7e6)):
        store.record_equity(day, cash, 1e6, f"{day}T15:45:00+09:00")
    assert [d["day"] for d in store.equity_days()] == ["2026-09-28", "2026-09-29", "2026-09-30"]
    (prev,) = store.equity_days(1, before="2026-09-30")
    assert (prev["day"], prev["equity_krw"]) == ("2026-09-29", 8e6)
    store.record_equity("2026-09-30", 1.0, 2.0, "x")  # 같은 날은 덮어쓴다
    assert store.equity_days()[-1]["equity_krw"] == 3.0
    assert store.last_fx_rate() is None
    oid = paper_order(store, "2026-09-29T23:00:00+09:00", symbol="AAPL", market="US", currency="USD")
    store.add_fill(oid, "BUY", 200, 1, 0, 0, 1_395.5, -279_100, "ENTRY", "2026-09-29T23:00:00+09:00", {})
    assert store.last_fx_rate("USD") == 1_395.5 and store.last_fx_rate("KRW") is None


def test_paper_order_style_defaults_to_swing_and_filters_today():
    store = Store(":memory:")
    swing = paper_order(store, "2026-09-29T10:00:00+09:00", "CLOSED", closed_at="2026-09-29T11:00:00+09:00",
                        pnl=-3.0, pnl_krw=-3.0)
    long_ = paper_order(store, "2026-09-29T10:05:00+09:00", "CLOSED", closed_at="2026-09-29T14:00:00+09:00",
                        pnl=-7.0, pnl_krw=-7.0, style="long", symbol="000660", target_price=None, stop_price=None,
                        expire_date=None)
    paper_order(store, "2026-09-29T10:20:00+09:00", style="long", symbol="035720", target_price=None,
                stop_price=None, expire_date=None)
    assert store.paper_order(swing)["style"] == "swing" and store.paper_order(long_)["style"] == "long"
    assert store.paper_today("2026-09-29") == (3, 10.0)
    assert store.paper_today("2026-09-29", style="swing") == (1, 3.0)
    assert store.paper_today("2026-09-29", style="long") == (2, 7.0)
    assert store.paper_today("2026-09-30", style="long") == (0, 0.0)


def test_style_column_is_added_to_old_db(tmp_path):
    """style 열이 없던 DB: 열을 더하고 목표·손절·기한이 모두 없는 주문은 long, 나머지는 swing으로 채운다."""
    import sqlite3
    path = tmp_path / "old.db"
    Store(path).db.close()
    db = sqlite3.connect(path)
    db.execute("ALTER TABLE paper_orders DROP COLUMN style")
    base = ("alice", "005930", "삼성전자", "KR", "KRW", "MARKET", 1, 100.0, "EXIT_WATCHING", "2026-09-01T10:00:00+09:00")
    for target, stop, expire in ((110.0, 90.0, "2026-10-01"), (None, None, None), (None, None, "2026-10-01")):
        db.execute("INSERT INTO paper_orders (account_id, requested_by, symbol, name, market, currency, order_type, "
                   "quantity, entry_price, status, created_at, target_price, stop_price, expire_date) "
                   "VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?)", (*base, target, stop, expire))
    db.commit()
    db.close()
    store = Store(path)
    assert [r["style"] for r in store.paper_orders()] == ["swing", "long", "swing"]
    Store(path)  # 두 번 열어도 그대로
    assert [r["style"] for r in Store(path).paper_orders()] == ["swing", "long", "swing"]
