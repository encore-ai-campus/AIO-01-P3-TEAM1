# 공통 결정 (계획서 6장 단계 2)

작성 2026-10-02. 계획서 `TEAM_PAPER_TRADING_PLAN.md`를 구현하면서 여러 작업자가 같이 따라야 하는 결정을 모은다.
바꾸려면 이 파일을 먼저 고치고 관련 작업자에게 알린다.

## 1. 저장소 구조와 실행

```
pyproject.toml      uv 작업 공간 (members: engine, backend). 루트는 패키지가 아니다
engine/             paper-engine 패키지 (paper_engine/), 테스트 engine/tests/. 런타임 의존성 없음 (표준 라이브러리만)
backend/            paper-backend: Django 프로젝트 (config/, accounts/, trading/). 외부 의존성은 여기만
frontend/           Vite + React + TypeScript
backtest/           백테스트 (DB 없이 단독 실행, engine을 import)
deploy/             compose.dev.yml (로컬 Redis. `--profile postgres`로 PostgreSQL도)
docs/               DESIGN.md(엔진 설계), DECISIONS.md(이 파일), KIWOOM.md(키움 API 확인 결과)
```

- 엔진 실행: `uv run python -m paper_engine <명령>` (루트에서). 테스트: `uv run pytest`, `uv run pytest backtest`.
- 실행 데이터는 `PAPER_ROOT`(기본: 저장소 루트) 아래 `data/`(SQLite·중단 스위치·백업), `runs/`(분석 기록 JSON·PDF),
  `data/reports/`(일일 리포트), `.cache/`(토큰·종목 목록·공휴일 캐시). 모두 git에 넣지 않는다.
- **DB: 로컬 개발 환경은 SQLite, EC2 운영은 PostgreSQL.** Django 설정이 `POSTGRES_HOST` 유무로 고른다
  (없으면 `backend/db.sqlite3`). 같은 모델·마이그레이션을 쓰므로 PostgreSQL 전용 기능은 쓰지 않고, CI는 PostgreSQL로 검사한다.
- **시간대: 엔진은 호스트 시간대가 KST라고 가정한다** (백업 06시·리포트 07시, 보유 기한 날짜, 오늘 손실·주문 수 집계).
  컨테이너(4E)는 `TZ=Asia/Seoul`(+ tzdata)로 띄운다. 장 달력과 키움 날짜 변환은 zoneinfo로 시장 시간대를 따로 쓴다.
- 이번 단계에서 Django와 React는 **빈 페이지만** 띄운다. 엔진 저장소는 아직 SQLite(`data/trading.db`)이고,
  Django ORM 저장소·REST API·작업 큐는 다음 단계(4C)에서 아래 4~6장의 형식대로 만든다.

## 2. 설정 키 (`.env`, 환경 변수가 우선)

| 키 | 기본값 | 쓰는 곳 | 설명 |
|---|---|---|---|
| `KIWOOM_APPKEY`, `KIWOOM_SECRETKEY` | (필수) | 엔진 | 키움 REST API 앱키·시크릿. 조회 TR만 쓴다 |
| `KIWOOM_BASE_URL` | `https://api.kiwoom.com` | 엔진 | 모의투자 도메인(`https://mockapi.kiwoom.com`)은 시세 조회가 제한될 수 있어 실전 도메인을 쓴다 |
| `KIWOOM_TOKEN_CACHE` | `.cache/kiwoom_token.json` | 엔진 | 토큰 파일 캐시 (0600) |
| `MARKETS` | `KR` | 엔진 | 운영할 시장 (쉼표 구분, `KR` 또는 `KR,US`). 키움 미국 시세 확인 전에는 KR만 |
| `PAPER_CAPITAL_KRW` | `10000000` | 엔진 | 모의 계좌 초기 자금 (계좌를 처음 만들 때만 쓴다) |
| `PAPER_COMMISSION_KR`, `PAPER_COMMISSION_US` | `0.00015` | 엔진 | 모의 체결 수수료율 (매수·매도 각각). 국내 매도는 거래세 `SELL_TAX_RATE["KR"]`를 더한다 |
| `MAX_TOTAL_INVEST_KRW` | 없음(off) | 엔진 | 자동 관리 포지션 총 금액 한도. 모의 계좌는 현금이 상한이라 기본으로 두지 않는다 |
| `DEVPASS_APIKEY`, `ANALYSTS`, `RESEARCHERS`, `APPROVER`, `REQUIRED_MODELS` | | 엔진 | AI (원본과 같음) |
| `DART_API_KEY`, `DATA_GOKR_API`, `SEC_CONTACT_EMAIL` | | 엔진 | 재무·공시·공휴일(`DATA_GOKR_API`는 특일정보 활용신청도 필요) |
| `OPENCLAW_TARGET` | 없음 | 엔진 | 팀 채널 알림 대상 `channel:<ID>`. 없으면 콘솔 |
| `OPENCLAW_BIN` | `openclaw` | 엔진 | openclaw 실행 파일 |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | 엔진·백엔드 | 예약·전략·선별 결과·잠금·생존 신호. 키 접두사는 `paper:` (원본의 `toss:`를 쓰지 않는다) |
| `CHROME_BIN`, `BACKUP_DIR` | | 엔진 | 원본과 같음 |
| `PAPER_ROOT` | 저장소 루트 | 엔진 | 실행 데이터 위치 (컨테이너에서는 볼륨 경로) |
| `AI_DAILY_BUDGET_USD` | `10` | 백엔드(4C) | 하루 전체 AI 비용 한도 |
| `AI_DAILY_ANALYSES_PER_USER` | `5` | 백엔드(4C) | 팀원별 하루 분석 요청 종목 수 |
| `DJANGO_SECRET_KEY`, `DJANGO_DEBUG`, `DJANGO_ALLOWED_HOSTS` | | 백엔드 | `DJANGO_DEBUG`는 on/off |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT` | | 백엔드 | `POSTGRES_HOST`가 없으면 SQLite (로컬 개발), 있으면 PostgreSQL (EC2) |

삭제한 키: `CLIENT_ID`, `CLIENT_SECRET`(토스), 실주문 허용 스위치, `OPENCLAW_USER_ID`, `OPENCLAW_STATE_DIR`.

## 3. 증권사 조회 클라이언트 인터페이스

`engine/paper_engine/data/kiwoom.py`의 `KiwoomClient`. 공개 메서드는 원본 `TossClient`의 조회 메서드와 이름·반환 형식이 같다
(각 메서드 docstring이 형식 명세). 엔진의 다른 파일은 이 메서드만 쓰고 HTTP 경로를 직접 부르지 않는다.

```
KiwoomClient(appkey, secretkey, token_cache=None, calendar=None, base_url=BASE_URL)
  prices(symbols) · orderbook(symbol) · confirmed_prices(symbols) · stocks(symbols)
  daily_candles(symbol, count=200) · candles_before(symbol, before=None, count=200) · completed_daily_candles(symbol, market, count=200)
  market_calendar(market) · listed_stocks(exchange) · warnings(symbol) · investor_trading(symbol, count=20)
  rankings(type_, market, duration="1d", count=30) · rankings_with_time(type_, market, duration="1d", count=30, exclude_caution=True)
  exchange_rate(base="USD", quote="KRW")
KiwoomApiError(status, body)        # 모든 조회 오류. 엔진은 이것만 잡는다
data.calendar.MarketCalendar(data_gokr_api_key, cache_dir).calendar(market, now=None)
data.calendar.drop_incomplete(candles, calendar, now)
```

- 엔진은 `__main__._client(cfg)` 하나로 클라이언트를 만들고, 같은 설정이면 프로세스에 하나만 둔다 (호출 간격 조절·캐시 공유):
  `KiwoomClient(cfg.kiwoom_appkey, cfg.kiwoom_secretkey, cfg.token_cache, MarketCalendar(cfg.data_gokr_api_key, ROOT/".cache"), cfg.kiwoom_base_url)`.
- 미국 시세를 키움이 지원하지 않으면 해당 메서드는 `KiwoomApiError`를 낸다. `MARKETS=KR`이면 엔진은 미국을 부르지 않는다.
- 계좌·주문 관련(`accounts`, `holdings`, `buying_power`, `sellable_quantity`, `commissions`)과 주문 TR은 만들지 않는다.

## 4. 모의 계좌 (계획서 3-2)

### 4-1. 표 (이번 단계는 엔진 SQLite, 4C에서 같은 이름·열로 Django 모델을 만든다 — 로컬 SQLite, EC2 PostgreSQL)

원본의 `live_orders`, `manual_orders`는 없앤다. `trades`, `predictions`, `market_days`, `rankings`는 그대로 둔다.

`paper_account` — 팀 공용 계좌 1개 (id=1)
| 열 | 형식 | 설명 |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT | 기본 "팀 공용" |
| initial_capital_krw | REAL | `PAPER_CAPITAL_KRW` |
| cash_krw | REAL | 현금 (원화만. 미국 종목은 체결 시점 환율로 환산해 넣고 뺀다) |
| created_at | TEXT ISO | |

`paper_orders` — 매수 주문 하나 = 포지션 하나 (매수 → 보유·감시 → 청산). 매도는 포지션 단위 전량 청산이다
| 열 | 형식 | 설명 |
|---|---|---|
| id | INTEGER PK | |
| account_id | INTEGER | 1 |
| requested_by | TEXT | 팀원 계정 이름, `strategy:<번호>`, `cli` |
| trade_id | INTEGER NULL | AI 시나리오(`trades.id`)에서 나온 주문이면 연결 |
| symbol, name, market(KR\|US), currency(KRW\|USD) | TEXT | |
| order_type | TEXT | MARKET \| LIMIT (매수 방식) |
| limit_price | REAL NULL | 지정가 |
| quantity | REAL | 주문 수량 (미국 소수점 가능) |
| entry_price | REAL | 계획 진입가 (시장가는 주문 시점 확인 가격, AI 주문은 시나리오 진입가) |
| target_price, stop_price | REAL NULL | 목표가, 손절가 (없으면 자동 청산 없이 보유만) |
| expire_date | TEXT NULL | 보유 기한 YYYY-MM-DD (지나면 다음 정규장에서 청산) |
| status | TEXT | ENTRY_PENDING \| EXIT_WATCHING \| CLOSED \| CANCELED |
| filled_quantity, fill_price, fill_fx_rate | REAL NULL | 매수 체결 |
| filled_at | TEXT NULL | |
| exit_price, exit_fx_rate | REAL NULL | 매도 체결 |
| exit_reason | TEXT NULL | TARGET \| STOP \| EXPIRED \| MANUAL |
| closed_at | TEXT NULL | |
| pnl, pnl_krw | REAL NULL | 실현 손익 (종목 통화, 원화). 수수료·세금 포함 |
| signal_count | INTEGER | 청산 조건 연속 확인 횟수 (`LOCAL_EXIT_CONFIRMATIONS`=2) |
| note | TEXT NULL | 취소 사유 등 |
| created_at | TEXT ISO | |

`paper_fills` — 체결 내역
| 열 | 형식 | 설명 |
|---|---|---|
| id | INTEGER PK | |
| order_id | INTEGER | `paper_orders.id` |
| side | TEXT | BUY \| SELL |
| price, quantity | REAL | 종목 통화 가격 |
| amount | REAL | price × quantity (종목 통화) |
| commission, tax | REAL | 종목 통화 |
| fx_rate | REAL | 종목 통화 1단위의 원화 가치 (KRW는 1) |
| cash_change_krw | REAL | 현금 증감 (매수 음수, 매도 양수) |
| reason | TEXT | ENTRY \| TARGET \| STOP \| EXPIRED \| MANUAL |
| filled_at | TEXT ISO | |

`equity_daily` — 일별 자산 (국내 장 마감 기록 직후 하루 한 번)
| 열 | 형식 | 설명 |
|---|---|---|
| account_id, day | PK | day는 YYYY-MM-DD (KST) |
| cash_krw, holdings_value_krw, equity_krw | REAL | 평가액 = 현금 + 보유 평가액 |
| recorded_at | TEXT ISO | |

### 4-2. 체결 규칙 (엔진이 확인 가격 `confirmed_prices`로 판단, 정규장 안에서만)

- 시장가 매수: 정규장이면 현재 확인 가격에 즉시 체결. 정규장 밖이면 다음 정규장 시작 때 실행하는 **예약**으로 넣는다.
- 지정가 매수: 확인 가격 ≤ 지정가면 그 확인 가격으로 체결. 그날 정규장이 끝날 때까지 안 되면 CANCELED.
- 목표가·손절가·기한: 원본 `executor._check_local_exit` 방식 그대로 — 조건이 **2회 연속** 확인되면 확인 가격으로 매도.
  기한은 `expire_date`가 지난 뒤 첫 정규장에서 매도.
- 사용자 매도: 보유 중(EXIT_WATCHING) 포지션을 전량 시장가 매도 (정규장 밖이면 예약). 대기(ENTRY_PENDING) 주문은 취소.
- 비용: 수수료 = 금액 × `PAPER_COMMISSION_KR|US` (매수·매도 각각), 국내 매도는 거래세 `SELL_TAX_RATE["KR"]` 추가.
- 현금: 매수 체결 시 −(금액 + 수수료) × 환율, 매도 체결 시 +(금액 − 수수료 − 세금) × 환율. 환율은 체결 시점 `exchange_rate`.
- 매수 가능액 = 현금 − 대기 매수 금액(ENTRY_PENDING의 수량 × 지정가(시장가는 진입가) × 환율 × (1 + 수수료율)).
  계좌 평가액 = 현금 + 보유 평가액(보유 수량 × 확인 가격 × 현재 환율). (`backtest/sim.py`와 같은 방식)
- 같은 종목에 진행 중(ENTRY_PENDING·EXIT_WATCHING) 주문이 있으면 새 매수를 막는다 (원본 실행 직전 점검 유지).
- 주문 변경(접수·매도·취소·수정·체결 확인)은 **주문 잠금** 안에서 한 번에 하나씩 한다: 지금은 `data/paper.lock` 파일 잠금 +
  스레드 RLock (`agents/executor.OrderLock`, serve 스레드와 CLI 프로세스를 묶는다). 4C에서는 주문 변경을 엔진 작업 큐 한 곳에서
  처리하고, DB 트랜잭션(`select_for_update`)과 부분 유일 인덱스(`UniqueConstraint(fields=["symbol"], condition=status IN ACTIVE)`,
  SQLite·PostgreSQL 모두 지원)로 같은 종목 중복을 막는다.
- 확인 가격은 현재가·최우선 매수·매도호가의 중간값이다. 상한가·하한가처럼 한쪽 호가만 있으면 현재가가 그 호가와 3% 안일 때만 현재가를 쓴다.
- 중단 스위치(`data/HALT`)는 **새 모의 매수**만 막는다. 청산은 계속한다.
- AI 시나리오 주문: 원본 실행 직전 점검(`pre_trade_checks`: 분석 후 30분, 현재가 2% 이내, 1억 원 상한, 중복 금지)을 통과하면
  사용자 컨펌 없이 모의 주문을 낸다 (진입가 지정가, 목표·손절·기한은 `make_plan`).
- 리스크 엔진 입력(`AccountContext`)은 모의 계좌에서 만든다: 총자산=평가액, 매수 가능액, 수수료율=모의 수수료율,
  기존 보유 평가액, 오늘 확정 손실·주문 수, 자동 관리 금액.

### 4-3. 상태 전이

```
ENTRY_PENDING ──체결──▶ EXIT_WATCHING ──목표·손절·기한·사용자 매도──▶ CLOSED
      │
      └──지정가 당일 미체결·사용자 취소·점검 탈락──▶ CANCELED
```

## 5. Redis 키 (접두사 `paper:`)

| 키 | 형식 | 설명 |
|---|---|---|
| `paper:reservation:seq`, `paper:reservation:<id>`, `paper:reservations` | 원본과 같음 | 예약 주문 (4C에서 DB `reservations`로 옮긴다) |
| `paper:strategy:*`, `paper:strategies` | 원본과 같음 | 전략 (4C에서 DB `strategies`로) |
| `paper:scan:s<id>:<날짜>` | NX, 3일 | 전략 하루 한 번 실행 표시 |
| `paper:scanresult:s<id>:latest\|<날짜>` | JSON | 선별 결과 (4C에서 DB `scan_results`로) |
| `paper:engine:heartbeat` | ISO 시각, EX 120 | 엔진 생존 신호 (serve 루프마다) |
| `paper:jobs` | LIST (LPUSH/BRPOP) | 작업 큐 (4C) |
| `paper:lock:<이름>` | NX EX | 잠금 (일일 리포트 분석 등) |

## 6. 작업 큐 형식 (4C에서 구현)

웹은 `jobs` 표에 행을 만들고 `paper:jobs`에 작업 번호를 넣는다. 엔진은 꺼내서 처리하고 `jobs` 행을 갱신한다.

```json
{"id": 123, "type": "analyze", "requestedBy": "alice", "payload": {"symbols": ["005930"], "web": true}, "createdAt": "2026-10-02T09:00:00+09:00"}
```

- `type`: `order.buy` · `order.sell` · `order.cancel` · `order.modify` · `analyze` · `strategy.run` · `report.daily`
- `jobs` 표: id, type, requested_by, payload(JSON), status(QUEUED|RUNNING|DONE|FAILED), result(JSON), error, created_at, started_at, finished_at.
- 같은 작업 번호를 두 번 처리하지 않는다 (상태가 QUEUED인 것만 RUNNING으로 바꾼 쪽이 처리).

## 7. REST API 초안 (4C, drf-spectacular로 OpenAPI 생성 → openapi-typescript로 프론트 타입)

계획서 4-3장 표가 기준이다. 공통 규칙:
- 경로는 `/api/...`, 끝 슬래시 없음. JSON 키는 camelCase. 금액은 숫자(원화는 정수 반올림 표시는 프론트).
- 인증은 세션 + CSRF. 비로그인은 401. 관리자 전용(계정·전략 변경·중단 스위치·비용 한도)은 403.
- 시세가 필요하거나 오래 걸리는 요청(주문 등록·AI 분석·전략 실행·리포트 생성)은 `202 {"jobId": n}`을 돌려주고 `GET /api/jobs/{id}`로 확인.
- 목록은 `?limit=&offset=` 페이지 (`{"count", "results"}`).
- 상태 확인 `GET /api/health` → `{"status": "ok"}` (이번 단계에 이미 있음).
