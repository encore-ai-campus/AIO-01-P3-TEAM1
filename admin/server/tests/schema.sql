-- 테스트용 SQLite 스키마: API.md 4장의 표·열을 서비스 열 이름 그대로 (+ 관리자가 읽지 않는 열 몇 개).
-- JSON 열은 문자열, 시각은 Django가 SQLite에 저장하는 형식(UTC, "YYYY-MM-DD HH:MM:SS.ffffff")이다.

CREATE TABLE auth_user (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    is_staff INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE VIEW admin_staff_accounts AS
    SELECT id, username, password, is_active FROM auth_user WHERE is_staff = 1;

CREATE TABLE engine_status (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL DEFAULT 'dev',
    host TEXT NOT NULL DEFAULT '',
    pid INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    beat_at TEXT NOT NULL,
    halted INTEGER NOT NULL DEFAULT 0,
    broker_ready INTEGER NOT NULL DEFAULT 0,
    last_tick_ms INTEGER,
    step_errors TEXT NOT NULL DEFAULT '[]',
    limits TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES auth_user (id),
    source TEXT NOT NULL DEFAULT 'user',
    team TEXT NOT NULL DEFAULT 'stock_report',
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT 'KR',
    status TEXT NOT NULL DEFAULT 'requested',
    results TEXT NOT NULL DEFAULT '{}',
    content TEXT,
    chaos TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

CREATE TABLE report_trace_events (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES reports (id),
    step INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    latency_ms INTEGER,
    details TEXT NOT NULL DEFAULT '{}',
    at TEXT NOT NULL,
    UNIQUE (report_id, step)
);

CREATE TABLE analysis_runs (
    id INTEGER PRIMARY KEY,
    run_file TEXT NOT NULL DEFAULT 'runs/x.json',
    symbol TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    analyzed_at TEXT NOT NULL,
    cost_usd REAL
);

CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'analyze',
    user_id INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'QUEUED',
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

CREATE TABLE notification_outbox (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    sent_at TEXT
);

CREATE TABLE daily_move_notes (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL,
    headline TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    cost_usd REAL
);
