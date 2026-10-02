# 공통 결정 (계획서 6장 단계 2)

작성 2026-10-02. 계획서 `docs/TEAM_PAPER_TRADING_PLAN.md`를 구현하면서 여러 작업자가 같이 따라야 하는 결정을 모은다.
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
- **DB: Django 설정이 `POSTGRES_HOST` 유무로 고른다** — 없으면 SQLite(`backend/db.sqlite3`, 혼자 개발할 때의 기본값), 있으면 PostgreSQL
  (EC2 운영, 그리고 팀이 같이 보는 개발 DB — 10장). 같은 모델·마이그레이션을 쓰므로 PostgreSQL 전용 기능은 쓰지 않는다.
  테스트는 SQLite 메모리 DB에서 돌고, `TEST_WITH_POSTGRES=1`일 때만(CI) PostgreSQL로 검사한다.
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
| `BROKER` | `kiwoom` | 엔진 | 조회에 쓸 증권사 (`kiwoom` \| `toss`). `toss`는 **로컬 개발 환경 전용**이다 (3장). EC2의 `.env`에는 넣지 않는다 |
| `CLIENT_ID`, `CLIENT_SECRET` | 없음 | 엔진 | `BROKER=toss`일 때 필수인 토스증권 Open API 키 (조회만 쓴다). 토큰 캐시는 `.cache/toss_token.json` (0600) |
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
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT` | | 백엔드 | `POSTGRES_HOST`가 없으면 SQLite, 있으면 PostgreSQL (EC2 운영 `db`, 로컬 컨테이너 `127.0.0.1`, 다른 PC의 개발 DB는 그 IP) |
| `POSTGRES_BIND` | `127.0.0.1` | 개발 compose | 로컬 PostgreSQL 컨테이너의 포트를 여는 주소. `0.0.0.0`이면 같은 네트워크에서 접속 (개발할 때만, 10장) |

삭제한 키: 실주문 허용 스위치, `OPENCLAW_USER_ID`, `OPENCLAW_STATE_DIR`.
(`CLIENT_ID`, `CLIENT_SECRET`은 지웠다가 로컬 개발용 토스 조회에 다시 쓴다 — 3장.)

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

- 엔진은 `__main__._client(cfg)` 하나로 클라이언트를 만들고, 같은 설정이면 프로세스에 하나만 둔다 (호출 간격 조절·캐시 공유).
  실제 생성은 `data/broker.make_client(cfg, ROOT/".cache")`가 한다 (백테스트도 이것을 쓴다). 기본(`BROKER=kiwoom`)은
  `KiwoomClient(cfg.kiwoom_appkey, cfg.kiwoom_secretkey, cfg.token_cache, MarketCalendar(cfg.data_gokr_api_key, ROOT/".cache"), cfg.kiwoom_base_url)`.
- 미국 시세를 키움이 지원하지 않으면 해당 메서드는 `KiwoomApiError`를 낸다. `MARKETS=KR`이면 엔진은 미국을 부르지 않는다.
- 계좌·주문 관련(`accounts`, `holdings`, `buying_power`, `sellable_quantity`, `commissions`)과 주문 TR은 만들지 않는다.

### 3-1. 로컬 개발 전용: 토스 조회 클라이언트 (2026-10-02 추가)

키움 앱키가 없어도 로컬에서 엔진을 돌려 볼 수 있게, 원본의 토스증권 Open API **조회** 클라이언트를 되살렸다.
운영(EC2)은 키움만 쓴다. 키움 코드(`data/kiwoom.py`, `data/calendar.py`)는 그대로다.

```
data/toss.py    TossClient(client_id, client_secret, token_cache=None, base_url=BASE_URL)   # 공개 메서드는 KiwoomClient와 같다
                TossApiError(status, body)       # KiwoomApiError의 하위 클래스 (엔진은 KiwoomApiError만 잡는다)
data/broker.py  make_client(cfg, cache_dir)      # cfg.broker에 따라 KiwoomClient 또는 TossClient
                BrokerClient                     # 두 클라이언트의 타입 표기
config.py       Config.broker · toss_client_id · toss_client_secret · toss_token_cache · broker_ready, BROKER_KEYS
```

- 켜는 법: 로컬 `.env`에 `BROKER=toss`, `CLIENT_ID`, `CLIENT_SECRET`. `BROKER`를 주지 않으면 토스 키가 있어도 키움이다.
- **운영에서는 못 켠다.** `DJANGO_DEBUG`가 켜져 있을 때만 `load_config`가 `BROKER=toss`를 받는다 (운영은 `DJANGO_DEBUG=off`).
  처음에는 `POSTGRES_HOST` 유무로 가렸지만, 로컬에서도 PostgreSQL을 쓰게 되어 바꿨다 (2026-10-02, 10장). 4E의 운영 compose는 `BROKER`를 넘기지 않는다.
- **조회만.** 토큰 발급 말고는 GET만 보내고 계좌 헤더를 붙이지 않는다. 계좌·주문 메서드는 없다
  (`test_toss.py`가 공개 메서드가 `KiwoomClient`와 이름·인자까지 같은지 검사한다). 주문은 계속 모의 계좌에서만 체결한다.
- 토스 주소(`tossinvest`) 문자열은 `data/toss.py` 한 곳에만 둔다. 다른 파일에서 토스 경로를 직접 부르지 않는다.
- 토스 응답이 곧 엔진 내부 형식이라 변환하지 않는다. 모의 체결 가격(`confirmed_prices`)은 키움 쪽 구현을 그대로 쓴다 (4-2 규칙은 증권사와 무관).
- 키움과 다른 점: 장 달력을 토스 API에서 받는다 (`data/calendar.py`·특일정보를 쓰지 않는다), 순위 집계 시각(`rankedAt`)이 있다,
  순위 기간이 1d 말고도 된다 (엔진·백테스트는 키움에 맞춰 1d만 쓴다), 미국 시세가 된다.
- **토큰 주의:** 토스 토큰은 client당 1개만 유효하다. 운영 중인 원본 `toss_trading`과 같은 `CLIENT_ID`로 여기서 토큰을 받으면
  원본의 토큰이 무효가 되고(원본이 다시 받으면 이쪽이 무효), 서로 재발급을 되풀이한다. 원본에 영향을 주지 않으려면 개발용 client를
  따로 발급해 쓴다. 이 머신 안에서는 `.cache/toss_token.json`으로 프로세스끼리 토큰을 같이 쓴다.
- 테스트는 실제 증권사에 조회를 보내지 않는다. 루트 `conftest.py`가 모든 테스트에서 `BROKER`와 증권사 키(토스·키움)를 비워,
  개발자 `.env`에 실제 키가 있어도 CLI 테스트가 그 키로 조회하지 않는다. 키가 필요한 테스트는 가짜 값을 직접 넣는다.
- 토스로 돌린 결과는 키움 변환 코드를 검증하지 못한다. 키움 실측(`scripts/kiwoom_check.py`, `docs/KIWOOM.md` 8장)은 키움 키로 따로 한다.

## 4. 모의 계좌 (계획서 3-2)

> 2026-10-02: 웹 계좌는 **팀원별**로 바뀌었다 (8-1). 아래의 "팀 공용 계좌 1개 (id=1)"는 엔진 자체 SQLite 계좌에만 해당한다.
> 표의 열과 체결 규칙(4-2, 4-3)은 웹 계좌에도 그대로 쓴다.

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

## 8. 웹 기능 1차 (2026-10-02): 팀원별 로그인 · 모의 트레이딩 · AI 분석 대시보드 · My Page · 랭킹

API 계약은 `docs/API.md`. 아래는 그 배경 결정이다. 앞 장과 다르면 이 장이 우선한다.

### 8-1. 계좌는 팀원별로 둔다 (팀 공용 1개 → 팀원별)

- My Page의 수익률·투자금액과 랭킹보드가 팀원별 성적을 요구하므로 **팀원마다 모의 계좌 하나**를 둔다.
  초기 자금은 각자 `PAPER_CAPITAL_KRW`(기본 1천만원). 계좌는 처음 쓸 때 만든다.
- 웹의 계좌·주문·체결·일별 자산은 **Django DB**(`backend/trading` 모델, 로컬 SQLite / EC2 PostgreSQL)에 둔다.
  열은 4-1의 `paper_account`·`paper_orders`·`paper_fills`·`equity_daily`와 같고, `paper_account`에 `user`가 붙는다.
  같은 종목 중복은 `UniqueConstraint(account, symbol, 조건: status가 진행 중)`로 막는다.
- 체결 규칙은 엔진 `agents/executor.PaperExecutor`와 `records/account.py`를 **고치지 않고 그대로 쓴다.**
  백엔드는 계좌 하나로 범위를 좁힌 ORM 저장소(엔진 `Store`의 모의 계좌 메서드와 같은 이름·반환 형식)를 넘긴다.
  주문 변경은 DB 트랜잭션 + 계좌 행 잠금(`select_for_update`) 안에서 한다.
- 엔진 자체 SQLite(`data/trading.db`)의 계좌(id=1)는 엔진 CLI·전략(AI 자동 매수)용으로 그대로 둔다. 웹 계좌와 섞지 않는다.
  두 저장소를 합치는 일(엔진 기록 저장소를 Django ORM으로)은 단계 5 통합에서 한다.
- 팀원 계정은 `python manage.py create_team_accounts`가 만든다 (기본 5개). 아이디·비밀번호는 무작위로 만들어
  저장소 루트의 `team_accounts.txt`(0600, git 제외)에 적는다. 닉네임(랭킹 표시 이름)과 공개 여부는 `accounts.Profile`.

### 8-2. 시세는 웹이 짧은 캐시로 직접 조회한다 (실시간 = 폴링)

- 계획서 4-1의 "시세가 필요한 일은 작업 큐" 원칙에서 **현재가·일봉 조회와 시장가 체결은 예외**로 한다. 화면이 1초마다
  가격을 받아야 하고 주문 결과를 바로 보여 줘야 하기 때문이다. 조회는 `config.engine.broker_client()` 하나로 하고
  (프로세스에 하나, 호출 간격 조절 공유), 현재가는 1초, 전일 종가·일봉·종목 목록은 하루 캐시한다 (Django 캐시).
  화면은 시세를 1초, 계좌를 2초마다 받고 탭이 가려져도 계속 받는다 (2026-10-02 변경, 처음은 3초·5초에 가려지면 멈춤).
  증권사 호출은 1초마다 "그 순간 캐시에 없는 종목 묶음" 수만큼 나간다. 팀원들이 서로 다른 화면을 보면 묶음이 늘어
  키움 한도(토큰당 초당 5회)에 가까워지고, 그때는 클라이언트의 호출 간격 조절 때문에 응답이 늦어진다.
- 오래 걸리는 일(AI 분석)은 `jobs` 표에 넣고 `python manage.py run_engine`이 처리한다. Redis 큐(6장)는 아직 쓰지 않고
  DB의 `QUEUED` 행을 엔진 루프가 가져간다 (팀 5명 규모에서는 충분하다. 운영에서 필요하면 6장 형식으로 바꾼다).
- `run_engine` 루프가 하는 일: 진행 중 주문의 체결·청산 확인(정규장), 예약 실행(정규장 시작), 일별 자산 기록(국내 장 마감 뒤),
  분석 작업 실행(`analysis.jobs.tick()`). 로컬 개발은 `runserver` + `run_engine` + `npm run dev` 세 개를 띄운다.
- 테스트는 실제 증권사·AI를 부르지 않는다 (루트 `conftest.py`가 키를 비운다. 가짜 클라이언트를 `config.engine`에 끼운다).

### 8-3. 예약 (정규장 밖 시장가)

- 정규장 밖의 시장가 매수·전량 매도는 DB `reservations`에 넣고, 엔진 루프가 그 시장의 다음 정규장이 열리면 실행한다
  (실패하면 사유를 남기고 지운다). Redis 예약(5장 `paper:reservation:*`)은 엔진 CLI용으로 남는다.

### 8-4. AI 분석 대시보드

- 분석 결과의 원본은 엔진이 남기는 실행 기록 `runs/*.json`이다. 백엔드 `analysis` 앱이 이것을 `analysis_runs` 표로 색인하고
  (종목 하나 = 행 하나, 대표 시나리오와 판정 요약, 실행 기록 경로) 목록·상세 API로 내준다. 엔진 CLI·전략이 만든 기록도 같이 보인다.
- 웹에서 요청한 분석은 엔진 CLI를 하위 프로세스로 돌린다: `python -m paper_engine analyze <종목> --by <아이디> --equity <초기 자금>`
  (`--buy`는 주지 않는다. 엔진 계좌에 자동 매수하지 않는다). 한도는 횟수로 건다: 팀원별 하루 `AI_DAILY_ANALYSES_PER_USER`(기본 5),
  전체 하루 `AI_DAILY_BUDGET_USD ÷ 0.3`(기본 33회).

### 8-5. 프론트엔드

- 스타일은 **Tailwind CSS**(v4, `@tailwindcss/vite`)로 한다 (계획서의 CSS Modules 대신). 토스증권 웹을 참고한 모바일 우선 반응형:
  모바일은 하단 탭, PC(`lg` 이상)는 왼쪽 메뉴 + 넓은 본문.
- 라우팅 React Router, 서버 상태 TanStack Query(폴링), 일봉 차트 `lightweight-charts`, 개발·테스트용 가짜 응답 MSW.
- 화면: 로그인 · 홈(내 자산 + AI 분석 종목 대시보드) · 종목 상세·주문 · 내 주식(보유·주문·체결) · AI 분석 상세 · 랭킹 · My Page.

### 8-6. 독립 리뷰 뒤 반영한 것 (2026-10-02)

- 분석 한도는 엔진을 시작한 작업을 실패해도 센다. `run_engine`은 시작할 때 이전 실행이 남긴 RUNNING 작업을 실패로 정리하고,
  끝낼 때 돌고 있는 분석 하위 프로세스를 끝낸다 (**엔진 루프는 하나만 띄운다**는 전제).
- 체결 확인과 예약 실행은 시장별로 장 달력 실패를 따로 넘긴다 (한 시장의 장애가 다른 시장의 손절·체결을 멈추지 않는다).
  예약 실행의 일시 오류는 정규장 시작 뒤 10분 동안 다시 시도한다.
- `/api/quotes` 한 번이 새로 받는 전일 종가는 10개까지이고(종목마다 일봉 조회 1번), 실패도 60초 캐시한다. 종목 상태는 60초만 캐시한다.
- 분석 요청자는 닉네임으로 낸다 (로그인 아이디는 다른 팀원에게 내지 않는다). 닉네임은 NFKC 정규화하고 보이지 않는 문자를 거절한다.
- 로그인은 주소별 1분 10회로 제한한다. `/api/schema/`는 로그인해야 본다. 너무 큰 숫자(1e400 등)는 400으로 거절한다.
- **남긴 것 (운영 전 4E에서)**: Django 캐시가 프로세스별 메모리라 gunicorn 워커를 여럿 띄우면 증권사 호출이 워커 수만큼 늘어난다 →
  Redis 캐시로 바꾸거나 워커 수를 키움 호출 한도(토큰당 초당 5회)에 맞춘다. 팀 전체 분석 한도는 동시 요청에서 1~2회 넘을 수 있다.
  거절된 예약의 사유는 사용자 화면에 남지 않는다. CI의 PostgreSQL 검사(동시 주문 경합)는 아직 없다.

### 8-7. 파일 소유 (병렬 작업 경계)

| 범위 | 내용 |
|---|---|
| `backend/config/`, 루트 설정·문서 | 메인. `config/engine.py`(엔진 접점), `config/api.py`(오류 응답·페이지), `urls.py`가 앱의 `urls.py`를 include |
| `backend/accounts/` | 로그인·프로필·팀 계정 생성 |
| `backend/trading/` | 계좌·주문·시세·랭킹·`run_engine` |
| `backend/analysis/` | 분석 색인·분석 작업 |
| `frontend/` | 화면 전체 |

## 9. AI 리포트: Agents Orchestration과 Trace 구조 (2026-10-02)

API 계약은 `docs/API.md` "AI 리포트" 절. 개념과 용어는 `docs/교육용문서.md`(04 Distributed Collaboration)를 따른다.

### 9-1. 범위: 구조만 만들고 Agent 실행은 만들지 않는다

- 만드는 것: 리포트 신청(종목별), 실행 계획(YAML Registry)과 계획 검증, Shared State와 구조화된 Trace의 저장·조회(Snapshot)·전달(SSE),
  이것을 보여 주는 화면 (실행 계획 그래프, Trace 타임라인, Shared State, 실패 정책·Handoff 계약 안내, 교육용 문서).
- **만들지 않는 것 (팀이 구현한다)**: Agent(LLM 호출)와 역할별 출력 계약, Orchestrator(병렬 실행·완료 수집·Join Guard·부분 실패 판단·
  Handoff Guard·전체 종료), 리포트 본문. 그래서 신청한 리포트는 `requested`로 남고 `ExecutionPlan.implemented`는 false다.
- 기존 "AI 분석"(엔진의 교차검증 파이프라인, `backend/analysis`)과는 별개 기능이다.

### 9-2. 교육용 문서와의 대응

| 문서의 개념 | 이 저장소에서 |
|---|---|
| Execution Plan, 계획 검증 | `backend/reports/team_definitions.yaml`의 steps(`depends_on`, `join`) + `registry.py`의 검증 (없는 앞 단계·중복 step id·순환·없는 Worker) |
| Sequential / Parallel | step의 `mode`. 조사(`parallel_research`)는 병렬, 리포트 작성·검토는 순차 |
| Join Guard | step의 `join: true`. Trace의 `join_guard` 사건(`join_completed`·`join_blocked`). 판단 코드는 미구현 |
| Partial Failure 정책 | team의 `failure_policy`(fail_fast·best_effort·required_optional)와 step의 `required`·`optional`. 판단 코드는 미구현 |
| Handoff | team의 `handoffs`(from·to·responsibility·max_hops). 계약 필드와 Guard는 화면에 안내만, 코드는 미구현 |
| Shared State | `reports.Report` 행 (status, current_step, results, errors, completed_agents, failed_agents) |
| 구조화된 Trace | `reports.TraceEvent` 행 (step, actor, action, status, provider, model, latency_ms, details) |
| YAML Registry | `worker_definitions.yaml`(Worker 이름·목표·Provider·출력 계약 이름), `team_definitions.yaml`(병렬·필수·선택 구성과 Timeout) |
| SSE + Snapshot | `GET /api/reports/{id}/events`(SSE)와 `GET /api/reports/{id}`(Snapshot). 저장소는 DB (Redis Stream은 쓰지 않는다) |

### 9-3. 종목 리포트 팀 (Registry 초안)

```
시세·차트 Agent (market_agent, 필수)    ─┐
재무·공시 Agent (fundamental_agent, 필수) ─┼→ Join Guard → 리포트 작성 Agent (report_agent) → 검토 Agent (review_agent)
뉴스·심리 Agent (news_agent, 선택)       ─┘                                                    └ Handoff ⇢ 리스크 점검 Agent (risk_agent)
```

- 실패 정책은 Required/Optional: 시세·재무는 필수, 뉴스는 선택. Provider·Model은 아직 정하지 않았다 (null).
- step id: `parallel_research`(병렬, timeout 60초) → `compose`(순차, join, 90초) → `review`(순차, 60초).

### 9-4. Orchestrator를 붙일 자리 (구현할 때)

- State와 Trace는 **`backend/reports/state.py`의 함수로만** 바꾼다 (Orchestrator만 State를 갱신한다. Worker는 독립 결과만 돌려준다).
  `start` · `set_step` · `record`(Trace 사건) · `add_result`(계약을 통과한 결과만) · `add_error` · `finish`.
- 오래 걸리는 실행은 웹 요청 안에서 하지 않는다. `run_engine` 루프에서 `requested` 리포트를 집어 실행하는 식으로 붙인다 (8-2).
- 붙인 뒤 `reports.registry.AGENTS_IMPLEMENTED`를 True로 바꾸면 화면이 SSE를 연다.
- Guard 사건의 `details`에는 대상을 넣는다: `join_guard`는 `{"step": <Join하는 step id>}`, `handoff_guard`는 `{"to": <넘겨받는 Worker id>}`
  (화면이 그래프의 어느 노드인지 찾는 데 쓴다). `workflow_completed`를 남긴 뒤 `finish`를 부른다 (끝난 리포트에는 Trace가 붙지 않는다).
- 운영(4E)에서 SSE는 연결 하나가 요청 처리 스레드 하나를 60초까지 잡는다: gunicorn은 스레드 워커(gthread), nginx는 `/api/reports/*/events`에
  `proxy_buffering off`와 60초보다 긴 read timeout. `docs/교육용문서.md`는 프론트 빌드에 들어가므로 저장소에 넣어야 한다.

### 9-5. 화면

- `/reports`: 종목 검색 → 리포트 신청, 리포트 목록, 실행 계획 미리 보기. 종목 상세에도 "AI 리포트 신청" 버튼.
- `/reports/:id`: 리포트 본문(미구현 안내) · 실행 계획 그래프(Worker별 상태·Provider·소요 시간) · Trace 타임라인 · Shared State ·
  실패 정책과 Handoff 계약 안내 · 교육용 문서 탭(`docs/교육용문서.md`를 그대로 렌더).
- Agent가 없어 실제 Trace가 비어 있으므로, 화면 구조를 확인할 수 있게 **예시 Trace 재생**(프론트에 든 예시 데이터, "예시"라고 표시)을 둔다.

## 10. 팀이 같이 보는 개발 DB: 로컬 PostgreSQL 컨테이너 (2026-10-02)

- 개발 중에 팀원이 같은 네트워크에서 DB를 직접 볼 수 있게, 호스트 PC 한 대에 PostgreSQL 16 컨테이너를 띄운다
  (`deploy/compose.dev.yml`의 `db`, 프로젝트 이름 `paper-dev`, 데이터는 볼륨 `paper-dev_pgdata`).
  호스트 PC의 `.env`: `POSTGRES_HOST=127.0.0.1`, `POSTGRES_PORT`(그 PC의 빈 포트), `POSTGRES_BIND=0.0.0.0`, 긴 임의 `POSTGRES_PASSWORD`,
  `DJANGO_SECRET_KEY`. `scripts/dev.sh`가 컨테이너를 띄우고 마이그레이션을 적용한다. 접속 방법은 `scripts/dev.sh status`와 `TEAM_DEV_PLAN.md` 2장.
- **개발할 때만 연다.** 운영(EC2)에서는 DB 포트를 밖으로 열지 않는다. 비밀번호는 저장소·문서에 적지 않고 따로 전한다.
- 혼자 개발할 때의 기본값은 여전히 SQLite다 (`POSTGRES_HOST`를 비워 둔다). SQLite에 쌓인 데이터는 `scripts/dev.sh import-sqlite`
  (`scripts/sqlite_to_postgres.py`)로 한 번 옮긴다: 계정(비밀번호 해시)·프로필·계좌·주문·체결·분석·리포트를 옮기고 세션·관리자 기록은 옮기지 않는다.
- 팀원이 자기 PC의 Django를 공유 DB에 붙일 수는 있다 (`POSTGRES_HOST=<호스트 PC의 IP>`). 다만 **엔진 루프(`run_engine`)는 호스트 PC에서만** 돌린다
  (두 곳에서 돌면 서로의 분석 작업을 실패로 정리한다 — 8-6). 모델을 바꿀 때는 마이그레이션이 공유 DB에 바로 적용되므로 팀에 먼저 알린다.
- 이 변경으로 "PostgreSQL이면 운영"이라는 가정이 깨졌다: 토스 조회 허용은 `DJANGO_DEBUG`로 가리고 (3-1),
  개발용 기본 비밀키는 SQLite일 때만 쓰므로 PostgreSQL을 쓰면 `DJANGO_SECRET_KEY`가 있어야 한다.
- 테스트는 SQLite 메모리 DB에서 돈다 (공유 DB를 건드리지 않는다). `TEST_WITH_POSTGRES=1`로 PostgreSQL에서도 백엔드 테스트 전부가 통과한다 (2026-10-02 확인).
