-- 관리 서버가 쓰는 서비스 DB 읽기 전용 계정 paper_admin_ro (API.md 4장). 서비스 DB 서버에서 서비스 DB 관리자(POSTGRES_USER)로 한 번 돌린다.
-- 다시 돌려도 된다: 권한을 모두 거두고 처음부터 다시 준다. 서비스 마이그레이션(engine_status 표가 생기는 trading 0004)을 먼저 배포한다.
--
--   docker exec -i paper-trading-db-1 sh -c 'psql -v ON_ERROR_STOP=1 -v ro_password="$RO_PASSWORD" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < readonly_role.sql
--   (RO_PASSWORD는 `docker exec -e RO_PASSWORD=...`로 넘긴다. 셸 기록에 남기지 않으려면 read -s로 받는다 — README.md)
--
-- 막는 것: 쓰기(읽기 전용 트랜잭션 + SELECT 권한만), 아래 목록에 없는 표·열(리포트 본문·알림 본문·사용자 표·세션 등),
-- staff가 아닌 사용자의 비밀번호 해시(admin_staff_accounts 뷰는 staff 행만 낸다).
\set ON_ERROR_STOP on

SELECT 'CREATE ROLE paper_admin_ro LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'paper_admin_ro') \gexec
ALTER ROLE paper_admin_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 10 PASSWORD :'ro_password';
ALTER ROLE paper_admin_ro SET default_transaction_read_only = on;
ALTER ROLE paper_admin_ro SET statement_timeout = '10s';
ALTER ROLE paper_admin_ro SET idle_in_transaction_session_timeout = '30s';

-- 권한을 처음 상태로 (표 단위 권한을 거두면 열 단위 권한도 같이 거둬진다)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM paper_admin_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM paper_admin_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM paper_admin_ro;
SELECT format('GRANT CONNECT ON DATABASE %I TO paper_admin_ro', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO paper_admin_ro;

-- 로그인 확인용: staff 행의 아이디·해시·활성 여부만 (뷰는 만든 사람의 권한으로 auth_user를 읽는다)
CREATE OR REPLACE VIEW admin_staff_accounts AS
    SELECT id, username, password, is_active FROM auth_user WHERE is_staff;
GRANT SELECT ON admin_staff_accounts TO paper_admin_ro;

GRANT SELECT (name, version, host, pid, started_at, beat_at, halted, broker_ready, last_tick_ms, step_errors, limits)
    ON engine_status TO paper_admin_ro;
GRANT SELECT (id, user_id, team, symbol, name, market, source, status, chaos, cost_usd, created_at, started_at, finished_at)
    ON reports TO paper_admin_ro;
GRANT SELECT (id, report_id, step, actor, action, status, provider, model, latency_ms, details, at)
    ON report_trace_events TO paper_admin_ro;
GRANT SELECT (id, symbol, analyzed_at, cost_usd) ON analysis_runs TO paper_admin_ro;
GRANT SELECT (id, type, user_id, payload, status, created_at, started_at, finished_at) ON jobs TO paper_admin_ro;
GRANT SELECT (id, kind, status, attempts, last_error, created_at, claimed_at, sent_at) ON notification_outbox TO paper_admin_ro;
GRANT SELECT (id, symbol, created_at, cost_usd) ON daily_move_notes TO paper_admin_ro;
