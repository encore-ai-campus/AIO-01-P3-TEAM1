"""기록 저장소 (SQLite). AI 시나리오 예측 추적, 모델별 확률 예측, 모의 계좌, 시장 기록을 저장한다.

선별되지 않은 시나리오도 모두 기록한다. 탈락시킨 판단이 옳았는지 나중에 확인하기 위해서다.
모의 계좌 표(paper_*, equity_daily)는 docs/DECISIONS.md 4-1과 같은 이름·열이다 (4C에서 Django 모델로 옮긴다).
"""
import sqlite3
from datetime import datetime
from pathlib import Path

from ..judge.verdict import Candidate
from .paper import CLOSED, OPEN, PENDING, UNFILLED, Outcome

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_date TEXT NOT NULL,      -- 생성 시점에 완성돼 있던 마지막 일봉의 날짜
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    horizon TEXT NOT NULL,
    proposer TEXT NOT NULL,
    entry_price REAL NOT NULL,
    target_price REAL NOT NULL,
    stop_price REAL NOT NULL,
    holding_days INTEGER NOT NULL,
    consensus_probability REAL NOT NULL,
    score REAL,                      -- 의결권 가중 평균 점수 (0~100). 점수제 이전 기록은 NULL
    critic_count INTEGER NOT NULL,
    selected INTEGER NOT NULL,       -- 판정을 통과하고 최종 컨펌까지 받았는지
    passed INTEGER,                  -- 교차검증 점수와 리스크 엔진을 통과했는지
    approver TEXT, approved INTEGER, approval_reason TEXT,  -- 최종 컨펌 (통과한 경우에만)
    reject_reasons TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    commission_rate REAL NOT NULL,
    sell_tax_rate REAL NOT NULL,
    status TEXT NOT NULL,
    filled_at TEXT, fill_price REAL, closed_at TEXT, exit_price REAL, pnl REAL,
    run_file TEXT
);
CREATE TABLE IF NOT EXISTS predictions (
    trade_id INTEGER NOT NULL REFERENCES trades(id),
    analyst TEXT NOT NULL,
    role TEXT NOT NULL,              -- PROPOSER | CRITIC
    probability REAL NOT NULL,
    score REAL                       -- 0~100. 점수제 이전 기록은 NULL
);
-- 시장 기록 (records/market_log.py). 정규장이 끝난 뒤 하루 한 번 시장별로 남긴다.
-- 백테스트의 유니버스 편향(오늘 기준 랭킹으로 과거를 보는 문제)을 없애기 위한 원본 데이터다.
CREATE TABLE IF NOT EXISTS market_days (
    market TEXT NOT NULL,            -- KR | US
    day TEXT NOT NULL,               -- 거래일 (시장 현지 날짜)
    recorded_at TEXT NOT NULL,
    ranked_at TEXT,                  -- 랭킹 집계 기준 시각 (API)
    bench_symbol TEXT,               -- 벤치마크 ETF (KR 069500, US SPY)
    bench_close REAL,
    bench_change REAL,               -- 전일 대비 (소수비율)
    usd_krw REAL,
    PRIMARY KEY (market, day)
);
CREATE TABLE IF NOT EXISTS rankings (
    market TEXT NOT NULL,
    day TEXT NOT NULL,
    type TEXT NOT NULL,              -- AMOUNT(거래대금 상위 100) | GAINERS | LOSERS (등락률 상위 10)
    rank INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    security_type TEXT,              -- 종목 정보의 securityType (ETF 등을 나중에 걸러내기 위해)
    last_price REAL,
    change_rate REAL,
    trading_amount REAL,
    trading_volume REAL,
    PRIMARY KEY (market, day, type, rank)
);
-- 모의 계좌 (docs/DECISIONS.md 4장). 팀 공용 계좌 하나(id=1). 현금은 원화만 둔다.
CREATE TABLE IF NOT EXISTS paper_account (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    initial_capital_krw REAL NOT NULL,
    cash_krw REAL NOT NULL,
    created_at TEXT NOT NULL
);
-- 매수 주문 하나 = 포지션 하나 (매수 → 보유·감시 → 전량 청산).
CREATE TABLE IF NOT EXISTS paper_orders (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    requested_by TEXT NOT NULL,      -- 팀원 계정 이름, strategy:<번호>, cli
    trade_id INTEGER,                -- AI 시나리오(trades.id)에서 나온 주문이면 연결
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    market TEXT NOT NULL,            -- KR | US
    currency TEXT NOT NULL,          -- KRW | USD
    order_type TEXT NOT NULL,        -- MARKET | LIMIT (매수 방식)
    limit_price REAL,
    quantity REAL NOT NULL,
    entry_price REAL NOT NULL,       -- 계획 진입가 (시장가는 주문 시점 확인 가격, AI 주문은 시나리오 진입가)
    target_price REAL, stop_price REAL,  -- 없으면 자동 청산 없이 보유만
    expire_date TEXT,                -- 보유 기한 YYYY-MM-DD (지나면 다음 정규장에서 청산)
    status TEXT NOT NULL,            -- ENTRY_PENDING | EXIT_WATCHING | CLOSED | CANCELED
    filled_quantity REAL, fill_price REAL, fill_fx_rate REAL, filled_at TEXT,
    exit_price REAL, exit_fx_rate REAL,
    exit_reason TEXT,                -- TARGET | STOP | EXPIRED | MANUAL
    closed_at TEXT,
    pnl REAL, pnl_krw REAL,          -- 실현 손익 (종목 통화, 원화). 수수료·세금 포함
    signal_count INTEGER NOT NULL DEFAULT 0,  -- 청산 조건 연속 확인 횟수
    note TEXT,
    created_at TEXT NOT NULL,
    style TEXT NOT NULL DEFAULT 'swing'  -- 보유 방식 swing | long (docs/API.md "보유 방식")
);
CREATE TABLE IF NOT EXISTS paper_fills (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES paper_orders(id),
    side TEXT NOT NULL,              -- BUY | SELL
    price REAL NOT NULL, quantity REAL NOT NULL,
    amount REAL NOT NULL,            -- price × quantity (종목 통화)
    commission REAL NOT NULL, tax REAL NOT NULL,
    fx_rate REAL NOT NULL,           -- 종목 통화 1단위의 원화 가치 (KRW는 1)
    cash_change_krw REAL NOT NULL,   -- 현금 증감 (매수 음수, 매도 양수)
    reason TEXT NOT NULL,            -- ENTRY | TARGET | STOP | EXPIRED | MANUAL
    filled_at TEXT NOT NULL
);
-- 일별 자산. 국내 장 마감 시장 기록 직후 하루 한 번.
CREATE TABLE IF NOT EXISTS equity_daily (
    account_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    cash_krw REAL NOT NULL, holdings_value_krw REAL NOT NULL, equity_krw REAL NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (account_id, day)
);
"""

# 찬반 투표에서 점수제로 바뀌기 전에 만든 DB를 옮긴다.
MIGRATIONS = [
    ("trades", "agree_count", "ALTER TABLE trades DROP COLUMN agree_count"),
    ("trades", "agree_weight", "ALTER TABLE trades DROP COLUMN agree_weight"),
    ("predictions", "verdict", "ALTER TABLE predictions DROP COLUMN verdict"),
]


ACCOUNT_ID = 1
ACCOUNT_NAME = "팀 공용"
DEFAULT_CAPITAL_KRW = 10_000_000


class Store:
    def __init__(self, path: Path | str, capital_krw: float = DEFAULT_CAPITAL_KRW):
        """capital_krw는 모의 계좌가 없을 때 만들 초기 자금 (PAPER_CAPITAL_KRW)."""
        self.capital_krw = capital_krw
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self._migrate()

    def _columns(self, table: str) -> set[str]:
        return {r["name"] for r in self.db.execute(f"PRAGMA table_info({table})")}

    def _migrate(self) -> None:
        with self.db:
            for table in ("trades", "predictions"):
                if "score" not in self._columns(table):
                    self.db.execute(f"ALTER TABLE {table} ADD COLUMN score REAL")
            for column, kind in (("passed", "INTEGER"), ("approver", "TEXT"),
                                 ("approved", "INTEGER"), ("approval_reason", "TEXT")):
                if column not in self._columns("trades"):
                    self.db.execute(f"ALTER TABLE trades ADD COLUMN {column} {kind}")
            for table, column, sql in MIGRATIONS:
                if column in self._columns(table):
                    self.db.execute(sql)
            if "style" not in self._columns("paper_orders"):
                # 보유 방식 (2026-10-04). 기존 주문은 목표·손절·기한이 모두 없으면 long, 아니면 swing (웹 마이그레이션과 같은 규칙)
                self.db.execute("ALTER TABLE paper_orders ADD COLUMN style TEXT NOT NULL DEFAULT 'swing'")
                self.db.execute("UPDATE paper_orders SET style='long' WHERE target_price IS NULL "
                                "AND stop_price IS NULL AND expire_date IS NULL")

    def add_candidate(self, c: Candidate, name: str, created_at: str, created_date: str,
                      commission_rate: float, sell_tax_rate: float, run_file: str = "") -> int:
        s, a, ap = c.final, c.assessment, c.approval
        reasons = c.reject_reasons
        if ap and not ap.approved:
            reasons.append("최종 컨펌 거부")
        with self.db:
            cur = self.db.execute(
                "INSERT INTO trades (created_at, created_date, symbol, name, currency, horizon, "
                "proposer, entry_price, target_price, stop_price, holding_days, "
                "consensus_probability, score, critic_count, selected, passed, approver, "
                "approved, approval_reason, reject_reasons, "
                "quantity, commission_rate, sell_tax_rate, status, run_file) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (created_at, created_date, s.symbol, name, s.currency, s.horizon, c.proposer,
                 s.entry_price, s.target_price, s.stop_price, s.holding_days,
                 c.consensus_probability, c.score, len(c.critiques), int(c.selected),
                 int(c.passed), ap and ap.approver, ap and int(ap.approved), ap and ap.reason,
                 "; ".join(reasons), a.quantity, commission_rate, sell_tax_rate, PENDING, run_file))
            rows = [(cur.lastrowid, c.proposer, "PROPOSER", c.scenario.probability,
                     c.proposer_score)]
            rows += [(cur.lastrowid, q.analyst, "CRITIC", q.probability, q.score)
                     for q in c.critiques]
            self.db.executemany(
                "INSERT INTO predictions (trade_id, analyst, role, probability, score) "
                "VALUES (?,?,?,?,?)", rows)
        return cur.lastrowid

    def active_trades(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM trades WHERE status IN (?, ?) ORDER BY id",
                               (PENDING, OPEN)).fetchall()

    def update_outcome(self, trade_id: int, o: Outcome, pnl: float | None) -> None:
        with self.db:
            self.db.execute(
                "UPDATE trades SET status=?, filled_at=?, fill_price=?, closed_at=?, exit_price=?, "
                "pnl=? WHERE id=?",
                (o.status, o.filled_at, o.fill_price, o.closed_at, o.exit_price, pnl, trade_id))

    def trades(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM trades ORDER BY id").fetchall()

    def model_stats(self) -> list[dict]:
        """청산된 시나리오 기준 모델별 확률 예측 성적. 결과는 목표가 도달이면 1, 아니면 0."""
        rows = self.db.execute(
            f"SELECT p.analyst, COUNT(*) AS n, AVG(p.probability) AS avg_probability, "
            f"AVG(t.status = 'TARGET') AS hit_rate, "
            f"AVG((p.probability - (t.status = 'TARGET')) * (p.probability - (t.status = 'TARGET'))) "
            f"AS brier FROM predictions p JOIN trades t ON t.id = p.trade_id "
            f"WHERE t.status IN ({','.join('?' * len(CLOSED))}) GROUP BY p.analyst ORDER BY brier",
            CLOSED).fetchall()
        return [dict(r) for r in rows]

    def prediction_summary(self) -> dict:
        """예측 기록 누적 현황. closed는 미체결 포함 청산 수, 도달률과 평균 확률은 model_stats처럼 체결 후 청산(resolved)만 본다."""
        marks = ",".join("?" * len(CLOSED))
        r = self.db.execute(
            f"SELECT COUNT(*) AS total, COALESCE(SUM(selected), 0) AS selected, "
            f"COALESCE(SUM(status IN (?, ?)), 0) AS active, "
            f"COALESCE(SUM(status IN ({marks}, ?)), 0) AS closed, "
            f"COALESCE(SUM(status IN ({marks})), 0) AS resolved, "
            f"COALESCE(SUM(status = 'TARGET'), 0) AS target, "
            f"AVG(CASE WHEN status IN ({marks}) THEN consensus_probability END) AS avg_probability "
            f"FROM trades", (PENDING, OPEN, *CLOSED, UNFILLED, *CLOSED, *CLOSED)).fetchone()
        out = dict(r)
        out["hit_rate"] = out["target"] / out["resolved"] if out["resolved"] else None
        return out

    def summary(self) -> list[dict]:
        """선별 여부별 모의매매 성적."""
        rows = self.db.execute(
            "SELECT selected, currency, COUNT(*) AS total, "
            "SUM(status IN ('TARGET','STOP','EXPIRED')) AS closed, "
            "SUM(status = 'TARGET') AS target, SUM(status = 'STOP') AS stop, "
            "SUM(status = 'EXPIRED') AS expired, SUM(status = 'UNFILLED') AS unfilled, "
            "SUM(status IN ('PENDING','OPEN')) AS active, COALESCE(SUM(pnl), 0) AS pnl "
            "FROM trades GROUP BY selected, currency ORDER BY selected DESC, currency").fetchall()
        return [dict(r) for r in rows]

    # --- 시장 기록 ---

    def market_day_recorded(self, market: str, day: str) -> bool:
        return self.db.execute("SELECT 1 FROM market_days WHERE market=? AND day=?",
                               (market, day)).fetchone() is not None

    def add_market_day(self, market: str, day: str, recorded_at: str, ranked_at: str | None,
                       bench_symbol: str | None, bench_close: float | None, bench_change: float | None,
                       usd_krw: float | None, rankings: list[dict]) -> None:
        """하루치 시장 기록을 한 트랜잭션으로 저장한다. rankings 항목은 rankings 표의 열 이름을 키로 쓴다."""
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO market_days (market, day, recorded_at, ranked_at, bench_symbol, "
                "bench_close, bench_change, usd_krw) VALUES (?,?,?,?,?,?,?,?)",
                (market, day, recorded_at, ranked_at, bench_symbol, bench_close, bench_change, usd_krw))
            self.db.execute("DELETE FROM rankings WHERE market=? AND day=?", (market, day))
            self.db.executemany(
                "INSERT INTO rankings (market, day, type, rank, symbol, name, security_type, last_price, "
                "change_rate, trading_amount, trading_volume) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(market, day, r["type"], r["rank"], r["symbol"], r.get("name"), r.get("security_type"),
                  r.get("last_price"), r.get("change_rate"), r.get("trading_amount"), r.get("trading_volume"))
                 for r in rankings])

    def market_days(self, market: str, limit: int = 10) -> list[sqlite3.Row]:
        """최근 시장 기록 (과거 → 최신)."""
        rows = self.db.execute("SELECT * FROM market_days WHERE market=? ORDER BY day DESC LIMIT ?",
                               (market, limit)).fetchall()
        return rows[::-1]

    def market_day_count(self, market: str) -> int:
        return self.db.execute("SELECT COUNT(*) FROM market_days WHERE market=?", (market,)).fetchone()[0]

    def rankings(self, market: str, day: str, type_: str, limit: int = 100) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT * FROM rankings WHERE market=? AND day=? AND type=? ORDER BY rank LIMIT ?",
            (market, day, type_, limit)).fetchall()

    # --- 모의 계좌 ---

    def account(self) -> sqlite3.Row:
        """팀 공용 계좌 (id=1). 없으면 capital_krw로 만든다."""
        row = self.db.execute("SELECT * FROM paper_account WHERE id=?", (ACCOUNT_ID,)).fetchone()
        if row is None:
            with self.db:
                self.db.execute(
                    "INSERT OR IGNORE INTO paper_account (id, name, initial_capital_krw, cash_krw, created_at) "
                    "VALUES (?,?,?,?,?)", (ACCOUNT_ID, ACCOUNT_NAME, self.capital_krw, self.capital_krw,
                                           datetime.now().astimezone().isoformat()))
            row = self.db.execute("SELECT * FROM paper_account WHERE id=?", (ACCOUNT_ID,)).fetchone()
        return row

    def add_paper_order(self, **fields) -> int:
        """새 모의 주문. account_id는 1, signal_count는 0으로 채운다."""
        self.account()
        fields = {"account_id": ACCOUNT_ID, "signal_count": 0} | fields
        with self.db:
            cur = self.db.execute(
                f"INSERT INTO paper_orders ({', '.join(fields)}) VALUES ({','.join('?' * len(fields))})",
                tuple(fields.values()))
        return cur.lastrowid

    def update_paper_order(self, order_id: int, **fields) -> None:
        columns = ", ".join(f"{k}=?" for k in fields)
        with self.db:
            self.db.execute(f"UPDATE paper_orders SET {columns} WHERE id=?", (*fields.values(), order_id))

    def paper_order(self, order_id: int) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM paper_orders WHERE id=?", (order_id,)).fetchone()

    def paper_orders(self, statuses: tuple[str, ...] | None = None) -> list[sqlite3.Row]:
        if statuses is None:
            return self.db.execute("SELECT * FROM paper_orders ORDER BY id").fetchall()
        marks = ",".join("?" * len(statuses))
        return self.db.execute(
            f"SELECT * FROM paper_orders WHERE status IN ({marks}) ORDER BY id", statuses).fetchall()

    def add_fill(self, order_id: int, side: str, price: float, quantity: float, commission: float, tax: float,
                 fx_rate: float, cash_change_krw: float, reason: str, at: str, order_fields: dict) -> int:
        """체결 한 건: 체결 내역, 현금, 주문 상태(order_fields)를 한 트랜잭션으로 바꾼다. at은 체결 시각 (ISO)."""
        with self.db:
            cur = self.db.execute(
                "INSERT INTO paper_fills (order_id, side, price, quantity, amount, commission, tax, fx_rate, "
                "cash_change_krw, reason, filled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (order_id, side, price, quantity, price * quantity, commission, tax, fx_rate, cash_change_krw,
                 reason, at))
            self.db.execute("UPDATE paper_account SET cash_krw = cash_krw + ? WHERE id=?",
                            (cash_change_krw, ACCOUNT_ID))
            if order_fields:
                columns = ", ".join(f"{k}=?" for k in order_fields)
                self.db.execute(f"UPDATE paper_orders SET {columns} WHERE id=?", (*order_fields.values(), order_id))
        return cur.lastrowid

    def fills(self, limit: int | None = None, since: str | None = None) -> list[sqlite3.Row]:
        """체결 내역 (최신 → 과거), 주문의 종목 정보를 붙인다."""
        sql = ("SELECT f.*, o.symbol, o.name, o.currency, o.requested_by FROM paper_fills f "
               "JOIN paper_orders o ON o.id = f.order_id")
        args: tuple = ()
        if since is not None:
            sql += " WHERE f.filled_at>=?"
            args = (since,)
        sql += " ORDER BY f.id DESC"
        if limit is not None:
            sql += " LIMIT ?"
            args += (limit,)
        return self.db.execute(sql, args).fetchall()

    def order_fills(self, order_id: int) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM paper_fills WHERE order_id=? ORDER BY id", (order_id,)).fetchall()

    def paper_today(self, day: str, style: str | None = None) -> tuple[int, float]:
        """(오늘 낸 모의 주문 수, 오늘 확정 손실 원화). 손실은 양수다.

        style(swing | long)을 주면 그 보유 방식의 주문만 센다.
        """
        where, args = "", ()
        if style is not None:
            where, args = " AND style=?", (style,)
        count = self.db.execute(f"SELECT COUNT(*) FROM paper_orders WHERE substr(created_at,1,10)=?{where}",
                                (day, *args)).fetchone()[0]
        loss = self.db.execute(f"SELECT COALESCE(-SUM(pnl_krw), 0) FROM paper_orders "
                               f"WHERE substr(closed_at,1,10)=? AND pnl_krw < 0{where}", (day, *args)).fetchone()[0]
        return count, float(loss)

    def closed_paper_orders(self, since: str | None = None) -> list[sqlite3.Row]:
        """청산이 끝난 모의 주문 (CLOSED). since(ISO)를 주면 그 이후에 끝난 것만."""
        if since is None:
            return self.db.execute("SELECT * FROM paper_orders WHERE status='CLOSED' ORDER BY closed_at").fetchall()
        return self.db.execute("SELECT * FROM paper_orders WHERE status='CLOSED' AND closed_at>=? ORDER BY closed_at",
                               (since,)).fetchall()

    def paper_orders_touched_since(self, since: str) -> list[sqlite3.Row]:
        """since(ISO) 이후에 만들었거나 체결됐거나 끝난 모의 주문 (리포트용)."""
        return self.db.execute(
            "SELECT * FROM paper_orders WHERE created_at>=? OR filled_at>=? OR closed_at>=? ORDER BY id",
            (since, since, since)).fetchall()

    def last_fx_rate(self, currency: str = "USD") -> float | None:
        """그 통화 종목의 가장 최근 체결 환율. 환율 조회가 실패했을 때 평가에 쓴다."""
        row = self.db.execute(
            "SELECT f.fx_rate FROM paper_fills f JOIN paper_orders o ON o.id = f.order_id "
            "WHERE o.currency=? ORDER BY f.id DESC LIMIT 1", (currency,)).fetchone()
        return row[0] if row else None

    def record_equity(self, day: str, cash_krw: float, holdings_value_krw: float, recorded_at: str) -> None:
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO equity_daily (account_id, day, cash_krw, holdings_value_krw, equity_krw, "
                "recorded_at) VALUES (?,?,?,?,?,?)",
                (ACCOUNT_ID, day, cash_krw, holdings_value_krw, cash_krw + holdings_value_krw, recorded_at))

    def equity_days(self, limit: int = 30, before: str | None = None) -> list[sqlite3.Row]:
        """일별 자산 (과거 → 최신). before(YYYY-MM-DD)를 주면 그 날 전까지만."""
        if before is None:
            rows = self.db.execute("SELECT * FROM equity_daily WHERE account_id=? ORDER BY day DESC LIMIT ?",
                                   (ACCOUNT_ID, limit)).fetchall()
        else:
            rows = self.db.execute("SELECT * FROM equity_daily WHERE account_id=? AND day<? ORDER BY day DESC "
                                   "LIMIT ?", (ACCOUNT_ID, before, limit)).fetchall()
        return rows[::-1]
