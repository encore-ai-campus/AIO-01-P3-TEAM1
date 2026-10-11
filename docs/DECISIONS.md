# 공통 결정 (계획서 6장 단계 2)

작성 2026-10-02. 계획서 `docs/plans/TEAM_PAPER_TRADING_PLAN.md`를 구현하면서 여러 작업자가 같이 따라야 하는 결정을 모은다.
바꾸려면 이 파일을 먼저 고치고 관련 작업자에게 알린다.

## 1. 저장소 구조와 실행

```
pyproject.toml      uv 작업 공간 (members: engine, backend). 루트는 패키지가 아니다
engine/             paper-engine 패키지 (paper_engine/), 테스트 engine/tests/. 런타임 의존성 없음 (표준 라이브러리만)
backend/            paper-backend: Django 프로젝트 (config/, accounts/, trading/, analysis/, reports/, autotrade/, notifications/,
                    longterm/(장기투자, 2026-10-05) — 앱별 설명은 AGENTS.md "구조". daytrade/(단타 연습)는 2026-10-06 폐기, 16장). 외부 의존성은 여기만
frontend/           Vite + React + TypeScript
backtest/           백테스트 (DB 없이 단독 실행, engine을 import)
deploy/             compose.dev.yml (로컬 Redis. `--profile postgres`로 PostgreSQL도)
docs/               기준 문서(API·DECISIONS(이 파일)·DEPLOY·KIWOOM)와 종류별 폴더(guides·plans·design·records·evaluation 등) — 문서 지도는 docs/README.md (29장)
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
| `ALLOW_TOSS_BROKER` | `off` | 엔진 | `DJANGO_DEBUG=off`여도 `BROKER=toss`를 받는다 — 키움 키를 받기 전 **운영 임시용** (3-1, 23장). 키움 키가 오면 지운다 |
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
- **`minute_candles`는 없다** (2026-10-05에 단타 연습 분봉용으로 두 클라이언트에 같은 이름·인자·반환으로 더했다가 **2026-10-06 단타 폐기로 둘 다 지웠다** — 16장). 키움 `ka10080` 조사는 `docs/KIWOOM.md` 4장에 남아 있으나 쓰지 않는다.

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
  **예외 (2026-10-08, 23장)**: 키움 키를 받기 전 운영 임시로 `ALLOW_TOSS_BROKER=on`이면 `DJANGO_DEBUG=off`여도 받는다 — 토스 때문에 운영 DEBUG를 켜 두지 않으려고. 키움 키가 오면 끈다.
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
| exit_reason | TEXT NULL | TARGET \| STOP \| EXPIRED \| MANUAL (`EOD`는 2026-10-05에 단타 장 마감 전 정리용으로 더했다가 2026-10-06 단타 폐기로 지웠다 — 16장). 8자 이하 (Django 열 길이) |
| closed_at | TEXT NULL | |
| pnl, pnl_krw | REAL NULL | 실현 손익 (종목 통화, 원화). 수수료·세금 포함 |
| signal_count | INTEGER | 청산 조건 연속 확인 횟수 (`LOCAL_EXIT_CONFIRMATIONS`=2) |
| note | TEXT NULL | 취소 사유 등 |
| created_at | TEXT ISO | |
| style | TEXT | 보유 방식 `swing` \| `long`, 기본 `swing` (2026-10-05, 14-3. `day`는 2026-10-06 단타 폐기로 지웠다 — 16장). 주문 뒤 바뀌지 않는다. 엔진 SQLite는 열이 없으면 더하고 목표·손절·기한이 모두 없는 기존 주문을 `long`으로, Django는 `trading/0002_order_style` |

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

`equity_daily` — 일별 자산 (국내 장 마감 기록 직후 하루 한 번. 웹 계좌는 KR 기준일이 오늘이 된 뒤 — 국내 거래일 15:40 KST 이후 — 장마감 기준 평가로, 14-1)
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
- **보유 방식 `style`** (2026-10-05, 14-3): `swing`은 위 목표·손절·기한 규칙 그대로. `long`은 자동 매도가 없다 (보유 기한을 쓰지 않는다).
  오늘 확정 손실·주문 수(`paper_today(day, style)`)는 보유 방식별로 센다 — 웹의 AI 추천 계획(SWING 한도)은 `swing` 주문만 센다 (`style` 인자는 `swing`·`long`).
  (`day` 방식과 15:15 강제 정리·`EOD`는 2026-10-06 단타 폐기로 지웠다 — 16장.)

### 4-3. 상태 전이

```
ENTRY_PENDING ──체결──▶ EXIT_WATCHING ──목표·손절·기한·사용자 매도──▶ CLOSED
      │
      └──지정가 당일 미체결·사용자 취소·점검 탈락──▶ CANCELED
```

### 4-4. 웹에만 있는 표 (Django, 2026-10-04~05 추가)

엔진 SQLite에는 없고 웹(Django)에만 있는 표 중 2026-10-04 결정(13·14장)으로 생기거나 바뀐 것. 열의 뜻은 각 모델 주석과 `docs/API.md`의 같은 이름 타입.
JSON 열은 읽고 쓰기만 한다 (PostgreSQL 전용 조회를 쓰지 않는다 — 로컬 SQLite, 운영 PostgreSQL).

| 표 (앱·마이그레이션) | 새 열·표 | 설명 |
|---|---|---|
| `reservations` (`trading/0002_order_style`) | `style` TEXT NULL | BUY 예약을 받을 때 정한 보유 방식(`swing`·`long`). 실행할 때 이 값으로 주문한다. SELL 예약은 null. 기존 BUY 예약은 마이그레이션이 같은 규칙으로 채웠다 |
| `investor_profiles` (`accounts/0003_investorprofile`) | 새 표 (사용자당 하나) | `beginner_mode`(기본 켬), 진단 답 `answers`(JSON, q2는 보기 순서로)·점수·단계·성향·추천 모드·`assessed_at`. (단타 퀴즈 `day_quiz_passed_at`은 2026-10-06 `accounts/0004`로 지웠다 — 16장.) 행이 없으면 기본값으로 본다 (14-7 B10) |
| `recommendations` (`autotrade/0002_horizon`) | `horizon` TEXT (`SWING`·`DAY`, 기본 `SWING`), `source`에 `day` 더함 | **2026-10-06 단타 폐기로 `autotrade/0003`(행)·`0004`(열)에서 `horizon`·`source = day`를 지웠다 (16장)** — 이력: `day` 추천(단타 계획의 껍데기)만 `DAY` (14-4) |
| `trade_plans` (`autotrade/0002_horizon`) | `horizon` TEXT | **2026-10-06 `autotrade/0003`(행)·`0004`(열)에서 지웠다 (16장)** — 이력: 추천에서 복사. `DAY`면 진입 주문이 style `day`, 재주문 없음 |
| `daily_move_notes` (`longterm/0001_initial`) | 새 표 (종목·날짜당 하나, 팀 공용) | 오늘의 내 종목 뉴스 (`DailyMove`). 업종 등락은 v1에서 늘 null이라 열이 없다. `llm_model`·`cost_usd`는 API에 내지 않는다 |
| `investment_theses` (`longterm/0001_initial`) | 새 표 (사용자·종목당 하나) | 산 이유 (`Thesis`). `baseline`(JSON)은 9개 지표 값을 모두 담는다 (판정은 셋만) |
| `thesis_checks` (`longterm/0001_initial`, `0002_thesischeck_facts`) | 새 표 + **`facts`** JSON (2026-10-05) | 산 이유 점검 한 번 (`ThesisCheck`). `facts`는 판정에만 쓰는 값(보고서·매출 성장률·같은 누적 기간의 순이익·영업현금흐름) — 다음 점검이 "2개 보고서 연속" 조건을 볼 때 읽는다. API에 내지 않는다. `caption`은 고정 문구라 저장하지 않는다 |

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
  전체 하루 `AI_DAILY_BUDGET_USD ÷ 0.3`(기본 33회). 2026-10-08부터 팀 전체 몫은 리포트와 같은 예산이다: 오늘 쓴 분석 예상 비용과 리포트 실제 비용을
  뺀 나머지 ÷ 0.3 (`reports/limits/budget.py` `used_usd`, `analysis/quota.py` `team_left`). 리포트 비용이 없으면 전과 같다.

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
| `backend/reports/` | AI 리포트 (담당별 파일은 `docs/tasks/00-공통.md` 2절) |
| `backend/autotrade/`, `backend/notifications/` | AI 추천·매매 계획·자동매매·알림 (12-6) |

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
| Execution Plan, 계획 검증 | `backend/reports/orchestration/team_definitions.yaml`의 steps(`depends_on`, `join`, `retry`) + `registry.py`의 검증 (없는 앞 단계·중복 step id·순환·없는 Worker·대체 모델·검토 재시도) |
| Sequential / Parallel | step의 `mode`. 조사(`parallel_research`)는 병렬, 리포트 작성·검토는 순차 |
| Join Guard | step의 `join: true`. Trace의 `join_guard` 사건(`join_completed`·`join_blocked`). 판단 코드는 미구현 |
| Partial Failure 정책 | team의 `failure_policy`(fail_fast·best_effort·required_optional)와 step의 `required`·`optional`. 판단 코드는 미구현 |
| Handoff | team의 `handoffs`(from·to·responsibility·max_hops). 계약 필드와 Guard는 화면에 안내만, 코드는 미구현 |
| Shared State | `reports.Report` 행 (status, current_step, results, errors, completed_agents, failed_agents) |
| 구조화된 Trace | `reports.TraceEvent` 행 (step, actor, action, status, provider, model, latency_ms, details) |
| YAML Registry | `worker_definitions.yaml`(Worker 이름·목표·Provider·주 모델·순서형 대체 모델·출력 계약 이름), `team_definitions.yaml`(병렬·필수·선택 구성과 Timeout·Retry). 정의하지 않은 키는 오타로 보고 거부한다 |
| SSE + Snapshot | `GET /api/reports/{id}/events`(SSE)와 `GET /api/reports/{id}`(Snapshot). 저장소는 DB (Redis Stream은 쓰지 않는다) |

### 9-3. 종목 리포트 팀 (Registry 초안)

```
시세·차트 Agent (market_agent, 필수)    ─┐
재무·공시 Agent (fundamental_agent, 필수) ─┼→ Join Guard → 리포트 작성 Agent (report_agent) → 검토 Agent (review_agent)
뉴스·심리 Agent (news_agent, 선택)       ─┘                                                    └ Handoff ⇢ 리스크 점검 Agent (risk_agent)
```

- 실패 정책은 Required/Optional: 시세·재무는 필수, 뉴스는 선택. Provider·Model은 아직 정하지 않았다 (null).
  각 Worker의 `fallbacks`는 주 모델 실패 시 순서대로 시도할 모델 목록이며, 아직 배정하지 않았으면 빈 목록이다.
  (2026-10-07부터 호출기는 `fallbacks`를 쓰지 않고 `healing.FALLBACK_POOL`에서 대체 모델 하나를 고른다. 2026-10-08부터 `fallbacks`는 그 모델 하나로 맞춘 화면 표시값이다 — `docs/tasks/00-공통.md` 4·7절)
- step id: `parallel_research`(병렬, timeout 60초) → `compose`(순차, join, 90초) →
  `review`(순차, 60초, RETRY면 `report_agent`를 최대 2회 다시 실행).
  Registry는 설정 실수를 막기 위해 `retry.max_rounds`를 1~3으로 제한한다.

### 9-4. Orchestrator를 붙일 자리 (구현할 때)

- State와 Trace는 **`backend/reports/orchestration/state.py`의 함수로만** 바꾼다 (Orchestrator만 State를 갱신한다. Worker는 독립 결과만 돌려준다).
  `start` · `set_step` · `record`(Trace 사건) · `add_result`(계약을 통과한 결과만) · `add_error` · `finish`.
- 오래 걸리는 실행은 웹 요청 안에서 하지 않는다. `run_engine` 루프에서 `requested` 리포트를 집어 실행하는 식으로 붙인다 (8-2).
- 붙인 뒤 `reports.orchestration.registry.AGENTS_IMPLEMENTED`를 True로 바꾸면 화면이 SSE를 연다.
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
  `DJANGO_SECRET_KEY`. `scripts/dev.sh`가 컨테이너를 띄우고 마이그레이션을 적용한다. 접속 방법은 `scripts/dev.sh status`와 `docs/plans/TEAM_DEV_PLAN.md` 12장.
- **개발할 때만 연다.** 운영(EC2)에서는 DB 포트를 밖으로 열지 않는다. 비밀번호는 저장소·문서에 적지 않고 따로 전한다.
- 혼자 개발할 때의 기본값은 여전히 SQLite다 (`POSTGRES_HOST`를 비워 둔다). SQLite에 쌓인 데이터는 `scripts/dev.sh import-sqlite`
  (`scripts/sqlite_to_postgres.py`)로 한 번 옮긴다: 계정(비밀번호 해시)·프로필·계좌·주문·체결·분석·리포트를 옮기고 세션·관리자 기록은 옮기지 않는다.
- 팀원이 자기 PC의 Django를 공유 DB에 붙일 수는 있다 (`POSTGRES_HOST=<호스트 PC의 IP>`). 다만 **엔진 루프(`run_engine`)는 호스트 PC에서만** 돌린다
  (두 곳에서 돌면 서로의 분석 작업을 실패로 정리한다 — 8-6). 모델을 바꿀 때는 마이그레이션이 공유 DB에 바로 적용되므로 팀에 먼저 알린다.
- 이 변경으로 "PostgreSQL이면 운영"이라는 가정이 깨졌다: 토스 조회 허용은 `DJANGO_DEBUG`로 가리고 (3-1),
  개발용 기본 비밀키는 SQLite일 때만 쓰므로 PostgreSQL을 쓰면 `DJANGO_SECRET_KEY`가 있어야 한다.
- 테스트는 SQLite 메모리 DB에서 돈다 (공유 DB를 건드리지 않는다). `TEST_WITH_POSTGRES=1`로 PostgreSQL에서도 백엔드 테스트 전부가 통과한다 (2026-10-02 확인).

## 11. 컨테이너와 CI/CD (2026-10-02)

설정 방법과 동작은 `docs/DEPLOY.md`. 여기에는 정한 것과 이유만 적는다.

- **이미지 3개**: `web`과 `engine`은 같은 Dockerfile(`deploy/Dockerfile`)의 두 대상이다 (코드는 같고, engine에만 리포트 PDF용 Chromium과
  한글 글꼴이 들어간다). `nginx`는 프론트 빌드 파일을 담는다. 빌드 컨텍스트는 저장소 루트 하나, `.dockerignore`도 루트에 하나.
- **컨테이너 권한**: root가 아닌 사용자(uid 10001), 읽기 전용 파일 시스템, 권한(capability) 전부 제거. 쓰는 곳은 `/data` 볼륨
  (`PAPER_ROOT`: 중단 스위치·실행 기록·캐시. web과 engine이 같이 쓴다)과 `/tmp`뿐이다. Chromium은 자체 샌드박스를 끄고(`--no-sandbox`) 돈다 —
  컨테이너 격리에 맡기며, 여는 것은 엔진이 만든 리포트 HTML뿐이다.
- **web은 gunicorn 프로세스 1개 + 스레드 16개**: 시세 캐시와 증권사 호출 간격 조절이 프로세스별이고(8-6) SSE가 스레드를 잡기 때문이다(9-4).
- **마이그레이션은 `migrate` 서비스가 한 번 돌린다.** web과 engine은 그것이 성공해야 뜬다. 띄울 때마다 돌므로 배포 절차에 따로 넣지 않는다.
- **DB·Redis 포트는 밖으로 열지 않는다.** 설정은 `deploy/.env.docker`(서버에만, git 제외)에 두고 `POSTGRES_HOST`, `REDIS_URL`, `PAPER_ROOT`는
  compose가 컨테이너에 맞게 넣는다. 토스 조회 키는 운영 파일에 넣지 않는다 (3-1).
- **CI는 비밀 값 없이 돈다.** 테스트는 `.env` 없이 `DJANGO_DEBUG=on`으로 돌고, PostgreSQL 검사는 작업 안에서 띄운 DB를 쓴다.
  컨테이너 작업은 검사 두 개가 통과해야 돈다 (실패한 코드로 이미지를 만들지 않는다).
- **배포는 `main`의 검사가 통과했을 때만**, 그리고 저장소 변수 `DEPLOY_ENABLED=true`일 때만 돈다 (서버를 준비하기 전에 미리 만들어 둔 파이프라인이라 스위치를 둔다).
  이미지는 GHCR에 커밋 해시 태그로 올린다 (`latest`를 쓰지 않는다 — 무엇이 떠 있는지와 되돌릴 대상이 분명해야 한다).
- **되돌리기는 서버의 스크립트(`deploy/remote_deploy.sh`)가 한다.** 새 버전이 뜨지 않으면 직전에 성공한 태그로 다시 띄우고 실패로 끝난다.
  DB 마이그레이션은 되돌리지 않으므로, 되돌릴 수 없는 모델 변경은 두 번에 나눠 배포한다.
- **서버 접속**: 배포 전용 SSH 키(비밀 값)와, 저장소 변수에 적어 둔 서버 호스트 키로만 접속한다 (접속하면서 호스트 키를 받아 믿지 않는다).
  호스트 키는 별칭으로 맞춰 보므로 서버 IP가 바뀌어도 `DEPLOY_HOST`만 고치면 된다. 레지스트리 로그인은 작업이 끝나면 못 쓰게 되는 토큰으로 하고 끝나면 지운다.
- **macOS에서 빌드할 때의 한글 파일 이름**: `docs/교육용문서.md`가 분해형(NFD) 이름으로 빌드에 들어가 프론트의 import 경로(NFC)와 어긋난다.
  nginx 이미지 빌드가 `docs/`의 파일 이름을 NFC로 맞춘 뒤 빌드한다. `docs/`에 한글 이름 파일을 더해 import할 때도 그대로 된다.

## 12. AI 추천 → 계획 활성화 → 자동매매 → 알림 (2026-10-04)

서비스의 최종 목표: **AI Agent가 추천 종목과 진입가·목표가·손절가·기대수익을 알려 주면, 사용자가 Discord나 웹에서 "계획 활성화"를 누르고,
그 뒤로는 계획대로 모의 자동매매가 진행되며 단계마다 사용자에게 알림이 간다.** API 계약은 `docs/API.md` "AI 추천 · 매매 계획 · 자동매매 · 알림",
담당과 남은 일은 `docs/tasks/06-추천·자동매매.md`.

### 12-1. 범위: 핵심 Agent 워크플로우는 팀원 몫, 나머지는 시연 가능한 버전

- **핵심 Agentic 워크플로우**(AI 리포트의 Worker·Orchestrator·AutoHealing — `docs/tasks/02~04`)는 담당 2·3·4가 구현한다. 이 기능은 그 코드를 고치지 않고
  **결과(`Report.results["report_agent"]`)를 읽기만** 한다. 리포트가 끝나면 엔진 루프가 알아서 추천을 만든다 (담당 3이 따로 부를 함수가 없다).
- 그 전에도 끝까지 시연할 수 있게 추천 출처를 셋으로 둔다: `report`(리포트 Agent 워크플로우), `analysis`(지금 있는 AI 교차검증 분석의 BUY),
  `demo`(**시연용 규칙 추천, AI 아님**). 화면·Discord에 출처를 늘 표시한다 (평가 가이드: 문서와 화면에 실제 구현한 것만).
- 리포트의 출력 계약 `ReportDraft.targets`에 `holdingDays`(보유 거래일)와 `probability`(목표가 도달 확률)를 더했다 (`docs/tasks/00-공통.md` 10절).
  둘 다 null 허용이고, 없으면 보유 10거래일·확률 0.5(`probabilityAssumed`)로 본다.

### 12-2. 추천(Recommendation)과 계획(TradePlan)을 나눈다

- **추천**은 AI(또는 시연 규칙)의 제안 하나다. 팀 전체가 같이 보고 `validUntil`(기본 만든 때부터 `RECOMMENDATION_VALID_DAYS`=3일)까지 활성화할 수 있다.
  출처마다 하나만 만든다 (리포트 하나 → 추천 하나, 분석 하나 → 추천 하나). 판정이 buy/BUY이고 `0 < 손절 < 진입 < 목표`일 때만 만든다.
- **계획**은 팀원 한 명이 자기 모의 계좌에 활성화한 것이다. 활성화 때 추천의 가격·기간을 **복사**해 둔다 (추천이 바뀌거나 만료돼도 진행 중 계획은 그대로).
- 계획의 사건(`PlanEvent`)은 리포트의 Trace처럼 순서 번호(step)를 붙여 남긴다. 화면은 이 사건으로 "자동매매 워크플로우"를 그린다:
  활성화 → 리스크 점검 → 진입 주문 → 체결 대기(날마다 재주문) → 보유 감시(목표·손절·기한) → 청산 → 알림.

### 12-3. 판단은 결정론적 코드가 한다

- ~~수량과 활성화 가능 여부는 **엔진 리스크 엔진 `judge/risk.py`의 `assess`를 그대로** 쓴다 (건당 위험 1%, 최소 손익비 1.5(2026-10-07 바뀜 — 21장), 매수 가능 금액,
  총 금액 한도 `MAX_TOTAL_INVEST_KRW`, 매수 유의 종목). 사용자가 예산(`budgetKrw`)을 주면 수량을 그만큼 더 줄인다 (늘리지는 않는다).~~
  **2026-10-11 바뀜 (28장)**: 넣을 돈은 사용자가 정하고(매수 가능 금액의 % 또는 원, 필수), 수량은 그 금액으로 계산하며, 리스크 엔진(`assess_budget`)은 한도를 점검만 한다 (넘으면 막는다).
- 추천의 `rewardRisk`·`expectedReturn`도 같은 비용 계산(수수료·거래세·손절 미끄러짐 1%)으로 만든다. 화면의 숫자와 리스크 엔진의 판단이 어긋나지 않게.
- 진입은 **지정가(= 추천 진입가)**로 한다. 모의 체결 규칙상 지정가는 그날 정규장이 끝나면 취소되므로, 진입 기한(`validUntil`) 안에서는
  엔진 루프가 다음 정규장에 다시 주문한다. 지금 가격이 이미 목표가 이상이거나 손절가 이하면 활성화하지 않는다.
- 주문은 기존 웹 주문과 같은 `trading.service`(잠금·중복 방지·예약 규칙 그대로)로 내고, 요청자는 `plan:<계획 id>`다. 그래서 "같은 종목은 포지션 하나만"
  규칙이 계획에도 그대로 걸리고, 사용자가 "내 주식"에서 직접 매도·취소해도 계획이 그 결과를 따라간다.
- 진행은 엔진 루프(`run_engine`)의 "자동매매" 단계가 한다. 활성화 요청은 그 자리에서 한 번 진행해(첫 주문) 사용자가 결과를 바로 본다.
  웹 요청과 엔진 루프가 같은 계획을 동시에 진행해도 주문이 두 번 나가지 않게, 상태를 바꿀 때 "지금 상태가 X일 때만 Y로"(조건부 UPDATE)로 바꾼다.

### 12-4. 알림: 웹 알림 + Discord Webhook (보낼 편지함)

- 알림 하나 = 받는 사람별 웹 알림 행(`notifications`) + Discord로 보낼 메시지 하나(`notification_outbox`). Discord 전송은 엔진 루프의 "알림 발송" 단계가 한다
  (웹 요청이 Discord 응답을 기다리지 않게. 엔진이 잠깐 멈춰도 메시지가 사라지지 않게).
- Discord는 서버 `.env`의 `DISCORD_WEBHOOK_URL` 채널 하나로 보낸다 (팀 채널. 배포 파이프라인 알림과 같은 채널을 써도 된다). 받는 사람이
  My Page에 Discord 사용자 ID를 넣어 두면 `<@ID>`로 멘션한다. Webhook 주소는 **비밀 값**이다 (`.env`에만, 로그·문서·화면에 넣지 않는다).
- 전송 실패: 1회 재시도 → 첨부가 있으면 첨부 없이 글만 → 그래도 안 되면 실패로 기록하고 콘솔에 남긴다 (`docs/plans/TEAM_DEV_PLAN.md` 5-1의 "알림 실패", DR-NOTI-01).
  웹 알림은 Discord와 무관하게 남는다.
- **Discord에서 활성화**: Webhook은 보내기만 되므로(버튼을 눌러 서버로 돌아오는 상호작용은 봇이 있어야 한다) 추천 메시지에 **서명된 활성화 링크**를 넣는다.
  링크를 누르면 웹의 추천 화면이 열리고, 로그인한 사용자가 확인을 누르면 활성화된다 (`via: "discord"`). 봇(버튼·명령) 방식은 하지 않는다 —
  봇 토큰·계정 연결·상시 접속이 필요하고, 시연에는 링크로 충분하다. 링크 주소의 앞부분은 `PUBLIC_BASE_URL`(개발: 프론트 주소, 운영: 배포 주소).

### 12-5. 설정 키 (`.env`. `.env.example`·`deploy/.env.docker.example`에 같이)

| 키 | 기본 | 뜻 |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | (없음) | 팀 Discord 채널 Webhook. 없으면 Discord로는 보내지 않고 콘솔에만 남긴다 (비밀 값) |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Discord 메시지의 링크 앞부분 (웹 화면 주소) |
| `RECOMMENDATION_VALID_DAYS` | `3` | 추천을 활성화할 수 있는 기간이자 진입 기한 (달력 일수) |
| `AUTOTRADE_DEMO` | `on` | 시연용 규칙 추천을 웹에서 만들 수 있게 할지 |
| `AUTOTRADE_DEMO_PER_USER` | `5` | 팀원별 하루 시연 추천 수 |
| `AUTO_RECOMMEND` | `off` | `demo`면 국내 거래일마다 선별(거래대금 상위 → 규칙 점수) 상위 종목으로 시연 추천을 만들어 팀 전체에 알린다. 선별이 증권사 조회를 100번 넘게 하므로 기본은 끔 |
| `AUTO_RECOMMEND_TOP` | `3` | 매일 자동 추천할 종목 수 |
| `AUTO_RECOMMEND_AT` | `08:00` | 이 시각(KST) 이후 하루 한 번 (시도 표시 파일 `runs/autotrade/recommend-<날짜>-<시장>.json`으로 하루 한 번을 지킨다. 선별이 실패해도 그날은 다시 하지 않는다) |
| `AUTO_REPORT` | `off` | (2026-10-07, 19장) `on`이면 국내 거래일마다 규칙 선별 → 선정 팀(AI) → 선정 Guard → 종목 자동 리포트 → Discord. LLM·증권사 조회를 쓰므로 기본은 끔. `AUTO_RECOMMEND=demo`와 같이 켜지 않는다 |
| `AUTO_REPORT_TOP` | `3` | 하루 자동 리포트 종목 수 (1~5) |
| `AUTO_REPORT_AT` | `08:00` | 이 시각(KST) 이후 하루 한 번 (선별 파일의 `selection` 키·건너뜀 표시 `runs/screening/<날짜>-<시장>.skip.json`으로 하루 한 번을 지킨다) |

### 12-6. 파일 소유

| 범위 | 내용 |
|---|---|
| `backend/autotrade/` | 추천·계획·사건 모델, 추천 만들기(리포트·분석·시연), 리스크 미리 보기, 계획 진행(executor), API |
| `backend/notifications/` | 웹 알림·알림 설정·보낼 편지함 모델, `service.notify`, Discord 발송(`dispatch.tick`), API |
| `engine/paper_engine/notify.py` | `WebhookNotifier`(표준 라이브러리 multipart), `make_notifier` (Webhook > openclaw > 콘솔) |
| `backend/config/engine.py` | `notifier()` 접점 |
| `backend/trading/management/commands/run_engine.py` | 단계 한 줄씩: 추천 수집 · 자동매매 · 알림 발송 |

## 13. 서비스 컨셉과 투자 방식 확장 결정 (2026-10-04)

팀 회의를 열지 않고 **팀장(사용자) 권한으로** 정했다. `docs/plans/컨셉변경계획.md` 13장(D-1~D-7)과 8장 계약 변경(B1~B10), `docs/plans/투자서비스확장계획.md` 6장(E-1~E-7)의
제안은 아래 표에서 따로 적은 것 말고는 **그대로 받아들였다**. 결정 목록·진행 상태는 `docs/결정필요사항.md`.

### 13-1. 컨셉 (D-1~D-7)과 계약 변경

| # | 결정 | 제안과 다른 점 |
|---|---|---|
| D-1 | **AI 교차검증 분석을 사용자 화면에 남긴다.** 여러 AI가 각자 계획을 내고 서로 검증해 최종 승인하는 과정(분석 상세 `/analyses/:id`의 제안 AI별 시나리오 카드 · 통과/탈락 · 최종 승인)을 사용자가 눈으로 확인할 수 있어야 한다. 들어가는 곳: 종목 상세의 보조 버튼 "AI 교차검증 분석"(큰 버튼 "AI 리포트 만들기" 아래), 리포트 탭의 "교차검증 분석" 묶음. 주린이모드 켬에서도 보이고 과정은 쉬운 말로(점수·확률은 끔 모드에서) 보인다. 분석 결과(BUY)는 계획 제안의 출처로 계속 쓴다. 비용(약 $0.3/종목)·하루 한도(`AI_DAILY_ANALYSES_PER_USER`)는 그대로 | 제안은 "사용자 메뉴에서 빼고 전문가 보기에서만"이었다 |
| D-2 | 하단 탭 **홈 · 종목 · 리포트 · 모의투자 · 마이** (주소는 그대로) | – |
| D-3 | 보기 방식은 **주린이모드**로 하고 **계정(서버)에 저장**한다 (B10) | – |
| D-4 | 연습용 예시(시연 규칙 추천)는 개발·시연 환경만 켜고, 배포는 리포트가 돌면 끈다 (`AUTOTRADE_DEMO`) | – |
| D-5 | 서비스 이름 **"AI 리포트 데스크"** — 화면 머리말·로그인 화면·PDF·Discord 머리말·발표 자료에 쓴다. 저장소·패키지·코드 이름은 바꾸지 않는다. **→ 2026-10-05 바뀜: "종이배"**(사용자 요청, 15-7) **→ 2026-10-07 바뀜: "모매매"**(사용자 결정, 18장) | – |
| D-6 | 투자 성향으로 수량 배수를 두지 않는다 (리스크 엔진 그대로, 예산 입력으로 충분) — 2026-10-11부터 넣을 돈을 사용자가 정한다 (28장) | – |
| D-7 | 장애 주입이 없는 failed 리포트는 하루 한도에서 뺀다 (담당 2의 T2-9) | – |
| B1~B10 | 컨셉 계획 8장의 계약 변경을 모두 받아들인다. B1(`plainSummary`)·B3(`ReportSummary.opinion`·`oneLiner`)은 10/5 회의 없이 확정 → 담당 2·4의 뼈대 PR에 처음부터 넣는다 | 제안은 "10/5 오전 회의에서 정하고, 못 정하면 10/8" |

### 13-2. 투자 방식 확장 (E-1~E-7)

| # | 결정 | 제안과 다른 점 |
|---|---|---|
| E-1 | 주린이모드 기본값은 진단 전 **켬**, 계정에 저장 | – |
| E-2 | 진단 7문항·점수표는 `docs/plans/투자서비스확장계획.md` 2-1의 제안값으로 구현하고 사용성 시험 뒤 조정 | – |
| E-3 | 뉴스 출처: **네이버 폐기**, 발표까지 Google 뉴스 RSS 유지 + 출처 표시 (13-3) | 제안은 "네이버로 바꾸는 것을 검토" |
| E-4 | 장기 보유의 종목당 비중 한도 **100%** (`RiskLimits.max_position = 1.0` — 한 종목에 계좌 전부까지 살 수 있다. 실제 한도는 현금) | 제안은 "팀 결정(값 미정)" |
| E-5 | 펀더멘털 점검 기준값과 LLM 생략 기준은 제안값으로 시작하고, 과거 공시 몇 종목으로 검산 뒤 확정 | – |
| E-6 | **폐기 (2026-10-06, 단타 폐기 — 16장).** 이력: 단타 `DAY` 한도는 아래 값으로 시작하고 2단계 시작 때 백테스트로 다시 본다: 건당 위험 0.5% · 하루 최대 손실 2% · 하루 최대 거래 10건 · 최소 손익비 2.0(스윙과 같음) · 강제 청산 15:15 KST(장 마감 단일가 15:20 전) | 제안은 "팀 결정(값 없음)"이라 값을 정해 넣었다 |
| E-7 | **선물 모의거래는 하지 않는다 (폐기).** `docs/research/선물모의거래_조사.md`는 참고용으로만 남긴다. KIS 키·`paper:fut:*`·`margin_call`·`expiry_warning`·선물 메뉴를 만들지 않는다 | 제안은 "발표 뒤 조건 확인 후 결정" |

### 13-3. 운영·데이터 (결정필요사항 1장)

| 항목 | 결정 |
|---|---|
| 증권사 조회 | 키움 키를 받을 때까지 **로컬 개발은 토스 조회(`BROKER=toss`)를 그대로 쓴다** (3-1 규칙 그대로: 운영 EC2는 키움만). 키움 첫 실측(`scripts/kiwoom_check.py`)은 키를 받은 뒤 |
| 토스 토큰 | 엔진 로그의 "token-revoked"는 **원본 개인 프로젝트가 같은 client를 함께 쓰기 때문**이다 (사용자 확인). 같은 client를 쓰는 동안 어느 쪽이든 새로 발급하면 다른 쪽 토큰이 무효가 된다 → 실시간 확인 호출은 최소로 한다 |
| Discord | **실제 채널 시험을 미룬다.** 구현된 코드(보낼 편지함·Webhook)는 그대로 두고 `DISCORD_WEBHOOK_URL`은 비워 둔다 (콘솔에만 남는다) |
| 관리자 계정 | 이 PC의 개발 DB에 superuser 하나를 만들고 아이디·비밀번호를 저장소 루트 `admin_account.txt`(권한 0600, git 제외)에 적었다. 랭킹에 나오지 않게 "내 정보 공개"는 끈다. 운영 DB에는 EC2에서 따로 만든다 (`docker compose exec web python manage.py createsuperuser`) |
| 휴장일 | 2026-10-05(월)는 개천절 대체공휴일로 휴장이다. 토스 장 달력은 이를 반영한다. **키움(운영)은 장 달력을 코드로 만들어 `DATA_GOKR_API`(특일정보)가 없으면 대체공휴일을 모른다** → 운영 `.env`에 이 키를 넣는다 (2장) |
| 뉴스 출처 (U5·E-3) | **네이버 검색 API는 폐기한다** (2026-10-04 사용자 결정, 약관 검토 뒤). NAVER API 이용약관(2026-09-07 개정) 검색 API 특약 2.3이 "데이터를 AI에 입력하거나 학습, 개선, 평가 및 노출 등에 활용하는 행위"를, 2.2가 가공을 금지하고, 부칙 제2조로 개발자센터 신규 신청이 2026-07-30에 끝났다 (원문 확인). **발표까지 Google 뉴스 RSS를 유지**하되 출처 표시·노출 최소화를 하고, 발표 뒤 LLM 근거를 OpenDART 공시·재무·시세 수치 중심으로 옮긴다. 근거: `docs/research/약관_이용조건_조사.md` 3장·9장 |
| 약관 ("교육용이라 상관없나") | **상관있다.** 약관(계약)은 비상업·교육 목적이어도 그대로 적용된다. 저작권 위험이 낮은 것은 교육용이어서가 아니라 제목·사실만 쓰기 때문이다. 원문: Google 뉴스 RSS "personal feed reader … personal, non-commercial use" 밖, **키움 「오픈 API 서비스 이용약관」 제5조 ③** "시세 정보를 … 개인의 업무에 한하여 이용해야 하며, 제3자에게 제공해서는 아니 된다", **토스 Open API FAQ** "비상업적인 용도라 하더라도 제 3자에게 배포하는 행위는 엄격히 금지". OpenDART·공공데이터포털(재무·특일)은 허용. 현실적 위험은 소송보다 **키 정지·차단**이다 |
| 약관 대응 (발표 전) | 배포 URL은 계정 있는 사람만(가입 경로 없음 유지, 시험 계정은 시험 기간만), 검색엔진 색인 막기, ~~공개 시연 영상의 시세·뉴스 화면은 가짜 데이터(`VITE_MOCK=1`)로~~ → **2026-10-05 사용자 결정: 가능한 부분은 실제 데이터를 쓰고, 실시간 시세는 장마감 기준으로 쓰며 그렇게 표시한다**(14-1), 화면 하단 출처 문구, 키움에 교육용 다중 표시 문의. 토스 조회는 원래 "혼자 로컬"까지만 회색이라 **`scripts/dev.sh`(0.0.0.0)로 팀원에게 보이는 지금 방식은 토스 FAQ 범위 밖**이다 — 키움 키를 받으면 바로 바꾼다 (사용자가 그때까지 토스 유지를 정함). 할 일 목록: 조사 보고서 9-2 |

## 14. 구현 결정 (2026-10-04): 장마감 기준 · 장기투자 · 단타 연습(2026-10-06 폐기, 16장) · 리포트 끝 알림

사용자(팀장)가 2026-10-04에 정한 두 가지와, 그것을 구현하려고 정한 공통 결정이다. API 계약은 `docs/API.md`(각 절의 "구현 예정(2026-10-04, Claude)" — 2026-10-05에 모두 만들어 "구현: 2026-10-05 (Claude)"로 바꿨다. 만들면서 계약 문장과 달라진 곳은 그 자리와 아래 각 절에 "2026-10-05 구현"으로 적었다).
앞 장(특히 8-7·12-6의 파일 소유, 13장의 담당 번호)과 다르면 이 장이 우선한다.
**2026-10-06: 이 장의 단타 연습(14-4와 흩어진 단타 줄)은 사용자 결정으로 폐기했다 — 16장.** 폐기한 줄은 이력으로 남기고 "폐기(2026-10-06)"를 붙였다.

| 사용자 결정 | 뜻 |
|---|---|
| **표시·계산만 장마감 기준, 체결은 엔진 내부 장중** | 화면의 가격·평가·랭킹·미리 보기·추천 가격은 직전 정규장 종가로 계산하고 보인다. 모의 체결·청산 판단(체결 확인·예약 실행·재주문·활성화의 장중 확인·시장가 체결)만 지금처럼 장중 확인 가격을 쓴다 (14-1) |
| **확장 1·2단계까지 구현** | `docs/plans/투자서비스확장계획.md` 5장 로드맵의 1단계(장기투자)와 2단계 (a)(단타 연습)를 이번에 만든다. 2단계의 AI 팀(`day_plan`·`day_review`)은 추천 워크플로우라 팀 몫이고, 3단계(WebSocket 틱)는 하지 않는다. **→ 2단계 (a) 단타 연습은 2026-10-06 폐기 (16장)** |

### 14-1. 장마감 기준

> **2026-10-06 바뀜 (사용자 결정, 17장)**: 종목 조회의 시세(`Quote`·`StockDetail`)는 실시간이다. 이 절의 나머지(계좌 평가·랭킹·일별 자산·미리 보기·`priceAtCreation`·리포트)는 그대로다.

- **왜**: ① 화면의 숫자가 장중에 흔들리지 않아 초보가 읽기 쉽고, 미리 보기·활성화·평가·랭킹이 같은 숫자를 쓴다 (미리 보기에서 본 수량이 그대로 주문 수량이 된다).
  ② 증권사 조회가 "보이는 종목마다 1초에 1번"(8-2)에서 "종목·기준일마다 일봉 1번"으로 줄어 키움 한도(토큰당 초당 5회)에 여유가 생긴다.
  ③ 실시간 시세를 여러 사람 화면에 계속 띄우는 모양에서 멀어진다 — 다만 약관 문제(13-3)를 없애지는 않는다 (종가도 증권사 시세다).
  체결을 장중으로 두는 이유: 모의 체결 규칙(4-2)이 장중 확인 가격 기준이고, 종가로 체결하면 지정가·손절이 하루 늦게 반응해 연습의 뜻이 없어진다.
- **정의** (`docs/API.md` 공통 규칙 "장마감 기준"): 시장별 **기준일**(그 시장 현지 날짜) = **정규장 종료 + 10분(`CLOSE_SETTLE_MIN`, 일봉 종가가 굳기를 기다리는 여유)이 지금 이전인 가장 최근 영업일**
  (2026-10-05 고침: 앞의 "아니면 지금 이전에 정규장이 끝난 가장 최근 영업일"은 15:30~15:40에 오늘을 골라 10분 규칙과 어긋났다 — KR은 거래일 15:40 KST, US는 뉴욕 16:10에 오늘로 바뀐다). **종가 봉** = 날짜가 기준일 이하인 마지막 일봉. **asOf** = 종가 봉 날짜의 정규장 종료 시각
  (봉 날짜를 쓰므로 장 달력이 대체공휴일을 몰라도 실제 마지막 거래일로 표시된다 — 13-3 "휴장일").
- **코드 접점**: 엔진 `data/calendar.py`의 `close_basis_day`·`session_end_iso`·`close_of`(표준 라이브러리), 백엔드 `trading/market.py`의 `basis`·`closes`·`close_price`·`completed_candles`
  (종목·기준일별 캐시, 한 호출이 새로 받는 종목은 10개까지). `current_prices`·`confirmed_prices`·`last_price`는 **내부 경로 전용**으로 남긴다.
- **장마감 기준인 것**: 시세(`Quote`)·종목 상세(완성 봉만)·계좌 평가·수익률·랭킹·일별 자산 기록(`record_equity`)·리스크 미리 보기와 활성화 수량·`priceAtCreation`·시연 추천 진입가·리포트 PDF 차트·(분봉은 2026-10-06 삭제 — 16장)·
  **리포트 시세 Worker 결과**(`MarketResult.price`·`changePct`·지표 — 팀의 `market_agent`도 `market.close_price`·`completed_candles`를 쓰고 `asOf`를 낸다, `docs/tasks/00-공통.md` 10절. 리포트 상세·PDF는 팀 전체가 본다.
  2026-10-08부터 장 중에 만들면 `price`·`changePct`는 현재가 기준 — 26장).
  분석의 `priceAtAnalysis`는 분석 시각 가격 그대로 두는 **일부러 둔 예외**다 (화면 "분석 시각 가격", 장중이었으면 "장중 가격"이라고 밝힌다). 지표 기준일(`dataAsOf`)을 따로 낸다.
- **일별 자산 기록(`record_equity`)** (2026-10-05 확정): 그날 기록은 **KR 기준일이 오늘이 된 뒤**(국내 거래일 15:40 KST = 정규장 종료 + `CLOSE_SETTLE_MIN`) 하루 한 번 남긴다.
  국내 보유는 그날 종가, **미국 보유는 그때의 최신 미국 종가**(장마감 기준 — `AccountSummary.pricesAsOf.US`와 같은 값, 15:40 KST에는 그날 새벽 끝난 뉴욕 정규장 종가)로 평가한다.
  왜: 15:30 직후에는 일봉 종가가 굳지 않았을 수 있고, 미국 보유를 장중 가격으로 평가하면 화면(종가)과 기록이 어긋난다. 그 전 기록은 기록한 때의 가격 그대로 둔다.
- **`priceAtCreation`은 출처와 무관하게 만들 때의 종가다** (2026-10-05 확정): 분석에서 나온 추천(`autotrade.recommend.sources.from_analysis`)도 분석 시각 가격(`run.price_at_analysis`)이 아니라
  추천을 만들 때의 종가(`market.close_price`)를 넣는다 — 추천 화면의 "추천 때 가격"과 미리 보기(종가)가 같은 기준이 되게. 분석 상세의 `priceAtAnalysis`는 위 예외대로 그대로다.
- **장중 가격 숫자는 문장에 넣지 않는다**: `400`의 `detail`·`failureReason`·`PlanEvent.message`·알림 문장에 장중 확인 가격이나 그것으로 계산한 금액을 넣지 않는다 (정해진 문장 — `docs/API.md` 공통 규칙 표).
  이유: 일부러 틀린 목표가·손절가를 보내 거절 문장으로 장중 가격을 읽어 내는 길(특히 `PATCH /api/orders/{id}`)을 막아 "화면은 종가"가 실제로 지켜지게. 엔진 `buy_blockers`·`modify`와 재주문 점검 문장을 고친다.
- **어긋남과 대응**: 시장가 주문은 화면 추정(종가)과 체결(주문 시점)이 다르다 → 화면 문구. 종가로는 활성화할 수 있는데 장중에 이미 목표가·손절가를 지났을 수 있다 →
  활성화에 **장중 확인**을 하나 더 둔다 (`price_passed`, 문장에 장중 가격 숫자를 넣지 않는다). 재주문은 지금처럼 장중 가격으로 계산한다.
- **폴링**: 시세·종목 60초, 계좌 10초, 랭킹 30초, 주문·계획 5초(체결은 장중에 바뀐다). 화면 아래 공통 출처 줄: "시세: {quoteProvider} 조회 · 장마감 기준 | 공시·재무: 금융감독원 OpenDART, 금융위원회(공공데이터포털) | 뉴스 제목: Google 뉴스 검색 결과(각 언론사)".
- KRX 시간외 개편(2026-09-14: KRX 시간외단일가 폐지·애프터마켓 16:00~20:00 신설, NXT 애프터 15:40~20:00)을 `data/calendar.py` 설명에 반영한다. `KR_SESSIONS`의 afterMarket 15:30~20:00은 "KRX+NXT 합집합"으로 그대로 둔다.

### 14-2. 범위와 파일 소유 (2026-10-04부터)

- **팀은 추천 워크플로우만 만든다**: AI 리포트 Agent 워크플로우(Worker·출력 계약·Orchestrator·Guard·AutoHealing·장애 주입·복구 지표), 자동 리포트(B9, 01 T1-3·T1-4·T1-5의 자동 리포트 부분),
  (단타의 AI 팀 `day_plan`·`day_review`는 2026-10-06 폐기 — 16장), 그리고 **UI/UX 고도화**(Claude가 만든 화면을 다듬기), **기능 논의**, **테스트**(사용성 시험·장애 시험 포함).
  워크플로우에 붙어 있는 작은 계약 B1 `plainSummary`(출력 계약, 2)도 팀 몫 그대로다.
- **B3 `opinion`·`oneLiner`는 Claude가 지금 만든다** (2026-10-05 바뀜 — 앞의 "4의 T4-1에서 한 PR에"를 버렸다): `payloads.summary`에 두 필드
  (`status == "completed"`일 때만 `results["report_agent"]`의 `verdict`·`oneLiner`, 그 밖은 null). 왜: 리포트 목록 카드·쉬운 보기 화면이 먼저 이 값을 쓰고,
  결과를 그대로 옮기는 작은 일이라 4가 AutoHealing에 집중하게 했다. 4는 나중에 같은 `summary`·`detail` 함수에 T4-1·T4-7의 나머지 필드(`source`·`chaosEnabled`·`costUsd`·`hasPdf`·`chaos`·`recovery`)를
  더한다 — Claude가 넣은 B3 두 필드와 그 테스트는 지우지 않고 그 위에 더한다.
- **그 밖은 Claude가 만든다**: 장마감 기준, 컨셉 변경 B3·B4~B8·B10과 D-1·D-4·D-5·D-7(횟수 한도)·U12, 보유 방식, 장기투자, ~~단타 연습~~(2026-10-06 폐기 — 16장), 컨셉 P0·P1 화면.
- **파일 소유의 원본은 `docs/tasks/00-공통.md` 2절**이다 (2026-10-04에 다시 썼다). 요점:
  - **팀 파일** — Claude는 만들거나 고치지 않는다: `backend/reports/{contracts.py, agents/, orchestrator.py, guards.py, runner.py, healing.py, chaos.py, stats.py, payloads.py(B3 두 필드 말고), auto.py, budget.py(새)}`,
    `backend/reports/models.py`와 `migrations/0002*` 이후, `registry.py`·YAML Registry, `management/commands/auto_report.py`, `engine/paper_engine/llm.py`의 `complete_json_once`.
  - **Claude 파일**(reports 안): 새 `alerts.py`(리포트 끝 알림 B7 — 14-5), 새 `text.py`(실패 사유 문장), 새 `quota.py`(하루 리포트 횟수 한도 — 14-6), `pdf.py`(이름·쉬운 요약 상자·면책·완성 봉 차트),
    `payloads.py`의 B3 두 필드(`summary`의 `opinion`·`oneLiner` — 2026-10-05, 위),
    `views.py`·`urls.py`의 자기 View·경로(`QuotaView`, 목록의 `?mine=1`, `ReportsView.post`의 횟수 한도 한 줄).
  - `ReportsView.post` 순서: 입력 검사(종목 → **4**의 `chaos.parse`) → 같은 종목 진행 중이면 `200` → **Claude**의 `quota.check(user, now)` → **2**의 `budget.check(now)` → 생성.
    먼저 합쳐진 쪽 위에 다음 쪽이 자기 한 줄을 이 자리 순서대로 더한다.
  - 프론트: Claude가 컨셉 P0·P1 화면을 먼저 만든다 (5의 기존 파일 포함 — `Layout.tsx`·`LoginPage.tsx`·`index.html`·`ReportsPage`·`ReportPage`·`components/reports/*` 등).
    5는 Claude가 "합쳤다"고 알린 뒤 그 위에서 다듬는다. 그 전에는 같은 파일을 고치지 않는다.
- **팀 문서의 바뀐 작업 줄** (아래가 `docs/tasks/01~06`보다 우선한다. 2026-10-05에 Claude가 맡게 된 줄(일부만이면 그 부분)에 "→ Claude가 구현 (2026-10-05)"을 붙였다 — 줄은 지우지 않았다.
  팀이 그대로 하되 내용이 바뀐 줄(02 T2-4, 03의 B7 줄·T3-4·T3-12)은 표시 없이 이 목록으로 읽는다 — 문서 머리의 2026-10-05 안내가 이 표를 가리킨다):

  | 문서·작업 | 바뀐 것 |
  |---|---|
  | 01 T1-5 | 팀원 리포트 알림(user 부분)은 Claude `alerts.py`. 남는 것은 **자동 리포트 부분**: 팀 파일 `auto.py`의 `auto.after_finish(report)` — `source == "auto"`만 PDF·Discord, 그 밖은 아무것도 안 한다 (runner가 끝난 리포트마다 부른다) |
  | 01 T1-7 | `?mine=1`(B8)은 Claude. `?source=`는 그대로 1 (`source` 열이 생긴 뒤 `ReportsView.get`에 한 줄) |
  | 01 T1-19·T1-20·T1-21·T1-22·T1-23 | B4·B5·B10·B6·쉬운 보기 뼈대 → Claude |
  | 02 T2-4 | `market_agent`는 `trading.market.close_price`·`completed_candles`(장마감 기준)로 자료를 만들고 `MarketResult.asOf`를 채운다 (`00-공통.md` 10절). `current_prices`·`last_price`·미완성 봉을 쓰지 않는다 (2026-10-08: 장 중에는 가격만 현재가 `live_prices` — 26장) |
  | 02 T2-9 | 팀원별 횟수 한도(`quota.py`, `AI_DAILY_REPORTS_PER_USER`, `429`, `GET /api/reports/quota`)는 Claude. 2에게 남는 것은 **비용 예산**: 새 팀 파일 `backend/reports/limits/budget.py`의 `check(now) -> None`(넘으면 `LimitExceeded`)과 `tests/limits/test_budget.py`, `ReportsView.post`에 한 줄 (`cost_usd` 열이 생긴 뒤) |
  | 03 (B7 줄) · T3-4 · T3-12 | runner는 끝난 리포트마다 팀의 `auto.after_finish(report)`를 부른다 (자동 리포트용). 사용자 알림은 Claude `alerts`가 보내므로 runner가 따로 부를 것은 없다 (`alerts.notify_finished`를 불러도 된다). T3-12의 `healing.notify_failure` 호출과 완료 기준 "실패 1건에 `notify_failure` 호출 1번"은 빠진다. 실패할 때 `workflow_failed.details.reason`을 9절 코드로 남기는 것은 그대로 |
  | 04 T4-1 | **B3(`opinion`·`oneLiner`)는 Claude** (2026-10-05 바뀜 — Claude가 지금 `payloads.summary`에 넣는다). 4에게 남는 것: 모델 열·마이그레이션 0002, 같은 `summary`·`detail`의 `source`·`chaosEnabled`·`costUsd`·`hasPdf`·`requestedBy`("자동")·`chaos`·`recovery` — Claude가 넣은 B3 두 필드 위에 더한다 (지우지 않는다) |
  | 04 T4-8 | `healing.notify_failure`는 사용자 알림(`report_failed`)을 보내지 않아도 된다 (14-5) |
  | 05 T5-16·T5-17·T5-18·T5-19·T5-20·T5-21·T5-22 | 탭·주린이모드 분기·사유 문장 표·교차검증 배치·서비스 이름(`Layout`·`LoginPage`·`index.html`·`pdf.py`)·쉬운 보기·홈/종목/모의투자 → Claude가 먼저 만들고 5가 다듬는다. `pdf.py`의 `pdf_path` 열 전환(4의 0002 뒤)은 Claude 작업이 합쳐진 뒤 5 |
  | 06 T6-10·T6-11·T6-12·T6-13 | B4·B5·B7·B6 → Claude (01 T1-19·T1-20·T1-5의 팀원 리포트 부분·T1-22와 같은 일). `backend/autotrade`·`backend/notifications`는 Claude 파일 (`00-공통.md` 2절) |

- **경계**: Claude 코드는 팀이 새로 만드는 모듈(`contracts`·`agents`·`orchestrator`·`guards`·`runner`·`healing`·`chaos`·`stats`·`budget`, `auto`의 새 함수)을 import하지 않고 결과만 읽는다
  (이미 있는 `models`의 `Report`·`TraceEvent`, `payloads`의 기존 이름(`KST`·`summary` 등), `state`의 읽기는 써도 된다) — `Report.status`·`results["report_agent"]`, Trace의 `workflow_failed.details.reason`,
  아직 없는 열은 `getattr(report, "source", "user")`·`getattr(report, "chaos", None)`. 팀의 `guards.clean_text`·`healing.LlmCaller`가 필요한 곳(오늘의 내 종목 뉴스)은
  Claude 쪽 간단한 대체(`longterm` 안의 `clean_text`, 엔진 `LlmClient` 전용 인스턴스)로 먼저 만들고, 팀 것이 생기면 한 함수만 바꾼다. 팀 코드는 Claude의 `alerts`·`quota`·`wording`을 불러도 된다.
- 화면은 Claude가 먼저 만들고 팀이 그 위에서 다듬는다. 같은 파일을 동시에 고치지 않게 다듬기는 Claude 작업이 합쳐진 뒤 시작한다.

### 14-3. 보유 방식과 장기투자 (확장 1단계)

- **보유 방식 `style`** (`PaperOrder.style`, 엔진 SQLite `paper_orders.style`): `swing` · `long` (`day`는 2026-10-06 단타 폐기로 지웠다 — 16장), 기본 `swing`. 웹 주문에 `style`이 없으면 목표·손절·기한이 모두 없을 때 `long`.
  기존 주문(과 기존 매수 예약)은 마이그레이션에서 같은 규칙으로 채운다 — 목표·손절이 다 갖춰지지 않은 기존 `swing`(기한만·목표만·손절만)은 그대로 두는 **예외**다:
  있는 값대로만 자동 매도(기한만이면 기한 매도만), 배지는 "스윙", `PATCH`는 준 값만 바꾸고 둘 다를 요구하지 않는다. 새 주문·예약에는 허용하지 않는다 (아래 "보유 방식 규칙 더하기", 2026-10-05). 장기 보유가 웹 직접 매수라 `TradePlan`이 없으므로 주문 단위로 나눈다 (`docs/plans/투자서비스확장계획.md` 3-1).
  `long`은 자동 매도가 없다 (엔진이 `long`이면 보유 기한을 쓰지 않는다).
- **보유 방식 규칙 더하기** (2026-10-05 확정, `docs/API.md` "보유 방식"):
  - **`swing`은 목표가·손절가가 둘 다 있어야 한다** (없으면 `400`). `style` 없이 `days`만 주면 추론이 `swing`이라 역시 `400`이다 — 스윙의 자동 매도 기준은 목표·손절이고,
    기한만 있는 주문은 "스윙" 배지와 실제 동작(기한 매도만)이 어긋난다. `days`는 선택.
  - **예약은 `style`을 저장한다**: 정규장 밖 시장가 매수 예약은 받을 때 `style`을 정해 `Reservation.style`(새 열, 매도 예약은 null)에 두고(`long` 비중 점검도 그때),
    실행할 때 그 값으로 주문한다 (다시 추론하지 않는다 — 받을 때와 실행할 때 규칙이 갈리거나 사용자가 고른 `style`이 사라지지 않게). 열은 `trading/0002` 마이그레이션에 같이 넣는다 (이미 합쳐졌으면 다음 마이그레이션).
  - **(폐기 2026-10-06 — 16장) 단타 주문은 `PATCH /api/orders/{id}`로 바꾸지 않는다**: `days`를 주면 `400`(보유 기한이 없다), `targetPrice`·`stopPrice`를 주면 `400` "단타 계획에서 바꿔요" —
    단타 주문의 목표·손절은 단타 계획(`TradePlan`)의 값이라 주문만 바꾸면 계획·복기와 어긋난다. (폐기 — 단타 삭제, 16장)
- **장기 매수 점검**: 종목당 비중 한도 100%(E-4, `LIMITS["LONG_TERM"].max_position = 1.0`). 손절이 없어 손절 기반 `assess`를 쓸 수 없으므로
  엔진에 `assess_position(price, quantity, account, limits) -> (ok, reasons, codes)`(매수 가능 금액 `cash_short`·비중 한도 `position_limit`·총 금액 한도 `total_limit`)를 더해 웹 `long` 매수가 쓴다.
  `price`는 지정가 또는 직전 종가(장마감 기준 — 화면 추정과 같은 값), 막히면 `POST /api/orders`가 `400 {"detail", "reasonCodes"}`. 수량은 사용자가 정한다.
- **오늘의 내 종목 뉴스** (`daily_move`):
  - 대상은 팀원 누군가가 보유한 **국내 종목만**의 합집합, 종목당 하루 1회 (`DailyMoveNote(symbol, day)` 유일). 미국 종목은 v1에서 하지 않는다 (화면 "국내 종목만") — 시장 대용·공시(DART)·뉴스 지역이 국내 기준이라 범위를 줄였다.
  - 시각: 국내 거래일, 기준일이 오늘이 된 뒤 `DAILY_MOVE_AT`(16:30) 이후 하루 한 번. 장 마감 뒤 수급 값이 굳을 시간을 둔다 (16:30에 확정인지는 실측 필요 — 조사 보고서 8장).
  - **시장은 대용 ETF로 본다**: 코스피 종목 → KODEX 200(`069500`), 코스닥 종목 → KODEX 코스닥150(`229200`). 화면에 "KODEX 200 기준"처럼 적는다.
    이유: 토스 조회에는 지수가 없고, 키움 지수 TR(`ka20001`·`ka20006`)은 경로·단위를 키움 키로 실측하기 전이다. KODEX 200은 이미 엔진 벤치마크(`records/market_log.py`)다. 키움 키를 받으면 지수로 바꾼다.
  - **업종은 v1에서 하지 않는다** (`sectorChangeRate: null`, 화면 "업종 자료 없음"): 키움 종목 정보의 `upName`을 지금 버리고 있고, 키움 명세의 예시 응답(테스트 픽스처)에 005930이 "금융업"으로 나오는 등 값이 맞는지 실측 전이라 쓰지 않는다. 업종 TR(`ka10101`)도 아직 붙이지 않았다.
  - 분해는 β=1의 "시장 대비 초과 등락"이고 **회계식 분해이지 인과가 아니다**. LLM 생략(템플릿) 기준은 제안값(E-5): |초과 등락| < 1%p이면서 20일 일간 변동성보다 작고 그날 공시·헤드라인이 없을 때.
  - LLM은 종목당 0~1회, 엔진 `LlmClient` 전용 인스턴스(비용 = 호출 전후 차이), 모델 `DAILY_MOVE_MODEL` → `APPROVER` → 없으면 템플릿. 근거 id·숫자·금지어 검사에 걸리면 1번 다시, 또 걸리면 템플릿.
  - 알림은 사용자당 하루 1개 묶음, **웹만**. Discord로 보내지 않는 이유: 팀 채널이 하나라 사용자별 묶음이 사람 수만큼 쌓이고, 등락 설명이 공개 채널에서 권유로 읽힐 수 있다 (조사 보고서는 웹 + Discord였다).
  - 자료: 일봉·수급은 증권사 조회(지금 토스, 개발), 공시는 OpenDART, 뉴스는 Google 뉴스 RSS. 로컬 `.env`의 빈 `DART_API_KEY` 줄(U11)을 지워야 공시·재무가 실제로 나온다. 자료가 없으면 그 칸을 비우고 이유를 적는다.
- **펀더멘털 점검** (`thesis_check`):
  - 산 이유 `InvestmentThesis`(사용자·종목당 하나: 이유 1~3, 점검 축, 기준선, 기준선 보고서)를 장기 보유를 고를 때 "왜 샀나요?"로 받는다. 기준선은 처음 저장할 때 DART `fundamentals`로 잡고, 자료가 없으면 다음 점검에서 채운다.
  - 규칙은 `docs/plans/투자서비스확장계획.md` 3-2 표의 제안값 그대로(E-5) 순수 함수 `engine/paper_engine/judge/fundamentals_check.py`에 둔다. 표에 숫자가 없던 "이익의 질"은 영업외 손익이 세전이익의 절반 이상이면 △로 정했다 (제안값).
    영업현금흐름은 이미 받는 DART 전체 재무제표의 현금흐름표(`ifrs-full_CashFlowsFromUsedInOperatingActivities`)에서 파싱만 더한다. 이자보상배율은 금융비용으로 나눈 **근사**다 (이자비용 계정이 없다 — 조사 보고서).
    **기간을 맞춘다**: ROE는 DART 공시 지표(`reported.roe` — 분기 보고서면 누적·연환산 아님)를 쓰지 않고 순이익(TTM) ÷ 기말 자본총계로 계산한다 (보고서 종류가 바뀌어도 기준선과 비교되게).
    이자보상배율은 최신 보고서의 **같은 누적 기간**의 영업이익 ÷ 금융비용이다 (TTM 영업이익 ÷ 누적 금융비용은 1분기 보고서에서 약 4배로 부푼다).
    종합: ✗ 하나라도 → `review`, △ 둘 이상 → `caution`, 나머지 `solid`. 금융업·ETF·ETN·리츠·미국 종목은 적용하지 않는다(`na`). 점검 축은 판정을 바꾸지 않고 보이는 순서만 바꾼다 (경고를 숨기지 않게).
  - **표기는 중립으로** (2026-10-05 확정): 종합의 화면 표기는 `solid` "기준 충족" · `caution` "주의" · `review` "확인 필요" · `na` "적용하지 않음" (값은 그대로).
    전의 "견조"·"점검 필요"는 좋다·나쁘다(사라·팔아라)로 읽힐 수 있어 버렸다. `FundamentalsView`·`ThesisCheck`에 고정 문구 `caption` "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"를 늘 같이 낸다.
  - **판정 우선순위 bad > warn > ok**: 한 행에서 여러 칸의 조건이 함께 맞으면 나쁜 쪽을 고른다. 표의 빈 곳을 채웠다 — 영업현금흐름: 순이익 적자(≤ 0)이고 영업현금흐름 ≤ 0 → ✗,
    순이익 적자인데 영업현금흐름 > 0 → △ (흑자 쪽 규칙은 그대로: 흑자·영업현금흐름 > 0 → ✓, 흑자인데 ≤ 0 → △, 그것이 2개 보고서 연속 → ✗). 영업이익 적자 전환은 성장률 값이 null이어도 ✗.
  - **이익의 질은 보이는 값과 판정 지표가 다르다** (보이는 값 = 순이익 ÷ 영업이익, 판정 = 영업외 손익 ÷ 세전이익) → `note`에 판정한 지표와 값을 꼭 적는다 ("판정: 영업외 손익이 세전이익의 62%"). 판정 지표가 없으면 `na`.
  - 시각: 국내 거래일 `THESIS_CHECK_AT`(18:00) 이후 그날 정기공시(DART `pblntf_ty=A`, 마지막 쪽까지)가 있는 종목 + **매주 월요일** 전체 재점검 (조사 보고서의 토요일 대신 월요일).
  - 알림은 ✗가 새로 생기거나 종합이 나빠졌을 때만, **웹만**. 매도 권유 문구·자동 매도는 없다.
  - 보유 여부와 상관없이 종목 상세에서 지표와 절대 기준 판정을 볼 수 있다 (`GET /api/stocks/{symbol}/fundamentals`, 기준선 비교는 산 이유가 있을 때만).
- **2026-10-05 구현에서 정한 것** (`docs/API.md` "장기투자"에도 적었다):
  - **`data/dart.py`는 공용이다**: 공시·재무제표 항목에 접수번호 `rceptNo`(공시 원문 링크 `disclosure_url()`), `fundamentals()`에 `report`(보고서 이름 "2026 반기보고서"·접수번호·접수일)와 `cashFlow`(같은 누적 기간의 영업현금흐름·순이익)를 더했다.
    그래서 AI 교차검증 분석의 스냅숏과 팀 리포트 Worker가 받는 DART 자료에도 이 키가 같이 들어간다 (기존 키는 그대로). 새 함수: `periodic_filings(day)`(정기공시 `pblntf_ty=A`, 모든 쪽), `industry_code(symbol)`(금융업 제외용).
  - **`thesis_checks.facts`** (새 열, `longterm/0002`): "2개 보고서 연속" 조건은 직전 점검의 순이익·매출 성장률이 필요한데 저장한 `rows`에는 없어서, 판정용 값을 따로 둔다 (API에 내지 않는다 — 4-4).
  - 산 이유 `active` = 그 종목의 장기 보유 주문(체결 대기·보유)이나 장기 보유 매수 예약이 있음. `baseline`은 9개 지표 값을 모두 저장한다 (판정은 셋만).
  - 오늘의 내 종목 뉴스: `volatility20`이 없으면 LLM을 생략하지 않는다 (계약 그대로 — "1%p 미만이면서 변동성보다 작음"을 볼 수 없으므로). 한 바퀴에 최대 3종목, 실패는 10분 뒤 3번까지,
    알림은 그날 대상이 모두 끝난 뒤 사용자당 1개. 수급 근거는 외국인·기관·개인 셋까지.
  - 펀더멘털 점검: 산 이유당 하루 한 번, 한 바퀴에 최대 5개. DART 키가 없으면 점검 기록을 남기지 않고, 그 회사 재무제표가 없으면 모든 지표 `na`인 기록을 남긴다.

### 14-4. 단타 연습 (확장 2단계 a) — 폐기 (2026-10-06)

> **폐기 (2026-10-06, 사용자 결정 — 16장).** 아래는 2026-10-05 구현 때의 결정 이력이다. 코드·API·화면에서 모두 지웠고 지금 계약이 아니다.

- **잠금**: 주린이모드 끔 + 단타 연습 퀴즈 통과. 서버가 막는다 (`day_trading_locked`). 퀴즈는 5문항(당일 청산·손절·비용·VI·모의)이고 **5문항을 모두 맞혀야** 통과한다 —
  초보에게 가장 위험한 방식이라 일부만 알아도 열리지 않게 했다. 다시 풀 수 있고, 통과 기록은 틀려도 지우지 않는다. 문항·정답·해설은 서버 코드에만 둔다.
- **국내 종목만** (15:15·15:30 규칙이 국내 장 기준이다).
- **한도** (E-6 그대로): `LIMITS["DAY"] = RiskLimits(risk_per_trade=0.005, max_position=None, min_reward_risk=2.0, max_daily_loss=0.02, max_daily_trades=10)`. `HORIZONS`에 `"DAY"`를 더하고
  AI 경로의 `TRADABLE_HORIZONS`에는 넣지 않는다. 하루 거래 수·손실은 **style day 주문만** 센다 (`paper_today`에 style 인자) — 스윙·장기 주문이 단타 한도를 쓰지 않게, 단타가 스윙 한도를 쓰지 않게.
  (2026-10-05 구현: 웹의 SWING 한도 — AI 추천 계획의 미리 보기·활성화·재주문 — 도 `style="swing"` 주문만 센다. 그래서 장기 보유 주문의 손실은 어느 하루 한도에도 들어가지 않는다.)
- **진입 마감·강제 정리 15:15 KST** (`DAY_CLOSE_AT`, 상수): 장 마감 단일가(15:20~15:30) 전에 끝내려고 15:15로 정했다 (E-6).
  15:15 이후 체결 대기 단타 주문은 취소("단타 진입 마감"), 보유는 2회 확인 없이 바로 장중 확인 가격으로 청산(`exit_reason = "EOD"`, "장 마감 전 정리" — 열 길이 8자 안).
  장이 닫혀 놓친 보유는 다음 정규장 첫 확인에서 같은 방식으로 정리한다 (밤을 넘기지 않는 것이 원칙, 놓친 경우만). 15:15 이후 새 단타 진입은 막는다(`day_entry_closed`).
- **세션 규칙 (바뀜 — 앞의 "15:15 뒤에 만들면 다음 정규장 계획"은 버렸다)**: 단타 계획은 **국내 거래일 0시부터 15:15 KST 전까지만** 만든다 (장 전 계획 포함). 그 밖(15:15 이후·주말·휴장일)은 `day_entry_closed`.
  그래서 계획·주문의 세션은 늘 **만든 날**이다: 진입 기한 = 그날 15:15, 엔진은 단타 주문의 세션 날짜를 **접수 시각(`created_at`)의 KST 날짜**로 보고 "그 날짜의 15:15 이후"에 취소·정리한다 (오늘 날짜가 아니라 주문의 날짜로 비교 — 새 열 없음),
  하루 한도(`paper_today`의 접수 날짜 기준 셈)도 그날에 맞는다.
  - 왜: 활성화는 그 자리에서 진입 주문을 낸다. "다음 정규장 계획"을 받으면 (1) 15:15 뒤에 낸 주문이 곧바로 `day_entry_closed`이거나 그날 엔진의 15:15 취소에 걸리고,
    (2) 15:15~15:30에 낸 지정가가 그날 체결돼 밤을 넘기며, (3) 주문 수·손실이 만든 날로 세어져 세션과 어긋난다. 주문에 세션 열을 더하고 진입을 미루는 방법도 있지만, 연습 서비스에는 "그날 0시~15:15에만"이 단순하고 틀릴 곳이 없다.
  - 화면: 만들 수 없는 시각이면 `DaySession.acceptingPlans: false`와 다음 거래일("10월 6일(화) 0시부터 만들 수 있어요"). 미리 보기는 그대로 해 볼 수 있다 (`activatable: false`).
  - 활성화 점검(종가 계산·`DAY` 한도·장중 확인·세션)은 행을 만들기 전에 하고, 막히면 `400 {"detail", "reasonCodes"}`로 아무것도 만들지 않는다. 그 뒤 첫 주문 접수가 드문 경합으로 거절되면 일반 활성화와 같이 `201` + 계획 `failed`.
- **흐름**: 단타 계획 = autotrade 추천·계획 재사용 (`Recommendation.source = "day"`, `Recommendation.horizon`·`TradePlan.horizon` `"SWING"|"DAY"`). `POST /api/day/plans`가 추천을 만들고 곧바로 활성화한다.
  `day` 추천은 만든 사람 혼자 쓰는 것이라 팀 목록·추천 알림에 내지 않는다. 단타 계획의 상태 알림은 **웹만** (하루 최대 10건 × 사람 수가 팀 채널을 채우지 않게).
  실행 확인 체크리스트(손절 시 손실·15:15 강제 정리·비용)는 서버에서도 **`acknowledged: true`를 요구한다** (B5의 일반 활성화는 막지 않지만, 단타는 위험이 커서 막는다).
  (2026-10-05 구현: 추천 생성과 활성화(계획·첫 주문)는 한 DB 트랜잭션이 아니다 — 활성화가 증권사를 부르므로 그동안 트랜잭션을 열어 두지 않는다. 모든 점검을 행을 만들기 전에 하고,
  그 뒤 활성화가 경합으로 막히거나 조회가 실패하면 방금 만든 추천을 지운다. 그래서 "막히면 아무것도 만들지 않는다"는 그대로다.)
- **분봉**: 두 클라이언트에 같은 공개 메서드 **`minute_candles(symbol: str, day: str, minutes: int = 1) -> tuple[list[dict], bool]`** — 그 날짜 정규장(09:00~15:30) 봉과 "세션 시작까지 받았는지".
  (바뀜: 처음 정한 `minute_candles(symbol, minutes=1, count=200)`은 날짜를 고를 수 없고, 1분봉 정규장 390봉이 200봉 한 번에 들어가지 않으며, 최신 봉이 시간외 봉이라 지난 세션을 채울 수 없었다.)
  토스는 `interval=1m` 200봉씩 `before` 커서로 그 날짜 09:00 앞까지 쪽을 넘기고(시간외 봉은 버린다), 키움은 `ka10080`에 `base_dt` = 그 날짜 + 연속 조회. 한 번에 `MINUTE_MAX_PAGES = 20`쪽까지,
  못 다 받으면 API `MinuteCandles.partial: true`(화면 "일부 구간만 있어요"). 키움 응답 형식은 실측 전이라 방어적으로 파싱한다.
  (2026-10-05 구현: 두 번째 값의 이름은 **`complete`**다 — 설계 메모의 "(봉 목록, partial)"은 틀린 표기였다. 웹은 `partial = not complete`. 정규장 양 끝(09:00·15:30 봉)을 넣고,
  키움이 준 `minutes > 1` 봉은 다시 묶지 않는다(봉 시각이 시작인지 끝인지 실측 전). 정규장 시각은 09:00~15:30 고정 — 수능일처럼 시간이 바뀐 날은 다루지 않는다. 3장)
  화면에는 **완성된 정규장 세션만** 보인다 (14-1과 같은 원칙): 장 전·장중에는 직전 세션 분봉으로 계획하고, 장 마감 뒤에 그날 분봉으로 복기한다. 진입·청산 가격은 체결 사실이라 그대로 보인다.
- **비용**: 화면에 늘 "단타는 비용이 손익을 크게 좌우해요"와 비용 합계(수수료 `PAPER_COMMISSION_KR` 매수·매도, 매도 거래세 0.20%)를 보인다. 미리 보기가 목표가·손절가에서 팔 때의 비용을 각각 낸다.
- **복기**: 결정론 복기(계획·체결·청산·비용·사건)만 만든다. AI 복기는 팀의 `day_review` 몫이라 화면에 "AI 복기 — 준비 중".

### 14-5. 리포트 끝 알림 (컨셉 계획 B7 바뀜)

- **전**: 팀원의 runner가 `auto.after_finish`를 불러 완성 알림을, 담당 4의 `healing.notify_failure`가 실패 알림(`report_failed`)을 보낸다.
- **지금**: 알림은 **모두 Claude 코드** — 새 파일 **`backend/reports/output/alerts.py`**가 보낸다 (`auto.py`는 자동 리포트 B9의 팀 파일이라 나눴다 — 14-2).
  `notify_finished(report)`(즉시, 예외를 밖으로 내지 않음)와 `sweep_finished(now, log)`(최근 24시간 안에 끝난 리포트 중 아직 알림이 없는 것)를 두고,
  `run_engine`의 새 단계 "리포트 알림"(추천 수집 다음)이 `alerts.sweep_finished`를 부른다. 팀 코드는 `alerts.notify_finished`를 불러도 되고 안 불러도 된다.
  `healing.notify_failure`는 사용자 알림을 보내지 않아도 된다. 자동 리포트의 끝 처리(PDF·Discord)는 팀의 `auto.after_finish(report)`(runner가 부른다)다.
- **왜**: 팀 일을 줄여 추천 워크플로우에 집중하게 하고, 알림이 runner·healing의 구현 시점에 묶이지 않게 한다. sweep이 있어 어느 경로가 빠져도 한 번은 간다.
- 완성: 이 리포트로 추천이 있으면(추천 알림 첫 줄 "리포트가 완성됐어요"가 그 역할) 따로 보내지 않고, 없으면 `report_completed`. 실패: `report_failed`, 본문은 실패 사유 코드
  (`workflow_failed.details.reason`)의 쉬운 문장(`reports/output/text.py`), 모르면 "리포트를 만들지 못했어요. 다시 만들 수 있어요". 같은 사용자·kind·link 알림이 있으면 보내지 않는다.
  자동 리포트(`source: auto`)는 건너뛴다 (팀 몫, B9).

### 14-6. 하루 리포트 한도 (D-7)

- 새 `backend/reports/limits/quota.py`, 설정 `AI_DAILY_REPORTS_PER_USER`(기본 3). 오늘(KST) 내가 신청한 리포트에서 **장애 주입 없이 failed로 끝난 것은 빼고** 센다.
  `chaos` 열이 아직 없으므로 `getattr(report, "chaos", None)`이 dict이고 `enabled`가 참일 때만 failed도 센다 (열이 생기기 전에는 failed를 모두 뺀다). JSON 필드는 Python에서 읽는다 (PostgreSQL 전용 조회를 쓰지 않는다).
- 넘으면 `POST /api/reports` → `429 {"detail", "limit", "used"}` (`config.api`의 예외 처리는 `detail` 외 필드를 버리므로 `Response`를 직접 돌려준다). 같은 종목의 진행 중 리포트를 돌려주는 `200` 경로는 세지 않는다.
  남은 횟수는 `GET /api/reports/quota` (`limit`·`used`·`remaining`·`resetsAt`).
- **2026-10-08 바뀜 (사용자 결정): 기본값은 무제한.** `AI_DAILY_REPORTS_PER_USER`가 비어 있으면(또는 숫자가 아니면) 한도가 없다 — `limit`·`remaining`이 `null`이고 `429`가 나지 않는다.
  숫자를 넣으면 전처럼 그 수가 한도다 (0이면 신청할 수 없다). 팀 전체 하루 비용 예산(`AI_DAILY_BUDGET_USD`, `budget.check`)은 그대로 적용된다.
- 비용 합산 한도(분석 + 리포트 $)는 `cost_usd` 열이 생긴 뒤 팀원(2) 몫이다 — 새 팀 파일 `backend/reports/limits/budget.py`의 `check(now)`. `quota.py`(Claude)에 넣지 않는다.
  `ReportsView.post`에서는 `quota.check` 바로 뒤에 `budget.check`를 한 줄로 부른다 (14-2의 순서).

### 14-7. 그 밖의 구현 결정

- **B6 알림 문장**: `notifications.service.notify`에 키워드 전용 인자 `expert_title`·`expert_body`를 더하고, **받는 사람의 주린이모드**(`accounts.beginner_modes(user_ids)`, 행이 없으면 켬)에 따라 웹 알림 문장을 고른다.
  Discord(팀 공용 채널 하나)는 쉬운 문장 + 숫자 한 줄로 하나만, 맨 앞에 **`[모매매 · 모의투자]`**(2026-10-07 이름 바뀜, 18장). `PlanEvent.message`·`failure_reason`은 원래 용어(전문가 보기). 문장은 `autotrade/text.py`에 모은다.
  (2026-10-05 구현: 숫자 한 줄은 `notify(..., numbers=)` 키워드로 넘긴다. 주린이모드는 `accounts.modes.beginner_modes(user_ids)`로 한 번에 읽는다.)
  주문·체결·청산·활성화를 말하는 쉬운 문장에는 **"모의"를 꼭 넣는다**("모의 계좌에서 삼성전자를 … 샀어요") — 서비스 이름에서 "모의매매"가 빠져, 공용 채널·초보 화면에서 실제 매매로 읽힐 수 있다. 테스트로 확인한다.
- **사유 코드와 문장** (2026-10-05 구현, `docs/API.md` "실행 불가 사유 코드"·공통 규칙 표): 엔진 `buy_checks`가 `(reasons, codes)` 짝을 내고 `OrderRejected.codes`가 같은 순서다.
  그중 표 밖의 내부 코드(`invalid_order`·`market_closed`·`order_too_large`·`fx_unavailable`)는 API `reasonCodes`로 내지 않는다 (`trading.service`가 `400 {"detail"}`로 바꾼다).
  종가 `price_passed` 문장은 "직전 종가(80,721원)가 이미 목표가 이상" (괄호 — 계약의 "직전 종가 {종가}가"는 "…원가"로 읽혀서). 재주문 점검에서 막혀 `failed`가 되면 사건 details에 `reasonCodes`도 남긴다.
  엔진이 체결 시점에 진입 주문을 취소한 note "체결 시점 현금 부족 (현금 X원)"의 괄호 금액은 계획 `failureReason`에 옮기지 않는다.
- **B10**: `accounts.InvestorProfile`은 행이 없으면 기본값(`beginnerMode` 켬)으로 본다 (신호·데이터 마이그레이션 없이). 점수표는 순수 함수 모듈 `accounts/assessment.py`. (단타 퀴즈 통과 시각 `day_quiz_passed_at`도 이 모델에 뒀다가 2026-10-06 지웠다 — 16장.)
  (2026-10-05 구현: `q2`는 보기 순서로 저장해 돌려주고, 같은 값이 두 번이면 `400`. 다른 앱은 `accounts/modes.py`의 `beginner_modes(user_ids)`로 읽는다 (`day_trading_lock(user)`와 퀴즈 `accounts/quiz.py`는 2026-10-06 폐기로 지웠다 — 16장).
  관리 화면은 읽기만 하고 진단 원답은 보이지 않는다.)
- **D-1**: 교차검증 분석은 종목 상세의 보조 버튼과 리포트 탭의 "교차검증 분석" 묶음으로 남기고, 분석 목록에 `mine=1`을 더한다.
- **U12 약관 대응**: 분석 상세에 뉴스 매체·시각(`newsItems`)과 출처 표기(`newsProvider` "Google 뉴스 검색 결과")를 더한다 (기존 `news: string[]`은 그대로, 링크는 내지 않는다 — 긴 주소가 AI 입력에 섞이지 않게).
  검색엔진 색인 막기: `frontend/index.html`의 `noindex,nofollow`, `robots.txt`(Disallow: /), nginx `X-Robots-Tag`. 화면 아래 출처 줄(14-1).
- **금지 표현은 목록 하나**: 권유(매수·매도 모두)·인과 단정·예측 표현을 엔진 `engine/paper_engine/wording.py`(표준 라이브러리, 기반 단계)의 상수와 `forbidden_phrases(text, causal=False)` 한 곳에 두고,
  B6 알림 문장·오늘의 내 종목 뉴스 검사·펀더멘털 점검 알림이 모두 이것을 쓴다 (`docs/API.md` 공통 규칙 "금지 표현"). 전에는 B6 목록과 오늘의 내 종목 뉴스 목록이 달라 "사 볼 만해요"·"지금 사면"·"파세요" 등이 LLM 검사를 지나갔다.
- **화면 문구**: 서비스 이름 "모매매"(D-5 → 15-7 → 2026-10-07 바뀜, 18장). 권유형 문장 금지(위 금지 표현 — "사세요"·"사 볼 만해요"·"좋아요"·"매수 기회"·"지금 사면"·"파세요" 등), 주어를 밝힌다("AI 의견"·"안전장치"). 면책 문장은 하나로 통일한다:
  "이 리포트는 AI가 만든 참고 자료이며 투자 권유가 아닙니다. 모든 매매는 모의 계좌에서만 이뤄집니다." 연습용 예시(시연 추천)는 "연습용 예시 계획 (AI 아님)"(D-4).
- **PDF**: 이름 "모매매"(2026-10-07 바뀜 — 머리에 로고, 2026-10-08 로고 바뀜 — 27장, 양식 판 `TEMPLATE_VERSION` 5), 맨 위 쉬운 요약 상자(`results.report_agent.plainSummary`, 없으면 "자료 없음") + 통일 면책 문장, 차트는 완성 일봉 + 범례 "YYYY-MM-DD 종가 기준".
  (2026-10-05 구현: 지표 카드 아래 "시세 지표: 종가 72,000원 · 10월 2일(금) 15:30 장마감 기준" 한 줄 — `market_agent`의 `price`·`asOf`, 없으면 "시세 지표 기준 시각: 자료 없음".
  AI 의견 배지는 화면과 같은 "긍정적 · 지켜보기 · 부정적"(전의 매수·관망·회피는 권유로 읽혀서). **양식 판 `TEMPLATE_VERSION`**(그때 2, 2026-10-07 4, 2026-10-08 지금 5)을 파일 이름에 넣는다 —
  `PAPER_ROOT/reports/<id>.v<판>.pdf` (2026-10-07부터 쉬운 판은 `<id>.v<판>.easy.pdf` — 20장). 양식이 바뀌면 판을 올려 예전 파일(판 번호 없는 `<id>.pdf` = 1판)을 다시 쓰지 않고 새로 만든 뒤 지운다.)
- **이름과 목록 봉투** (2026-10-05 확정, `docs/API.md`): 목록 엔드포인트(자원의 모음을 돌려주는 것이 일인 응답)는 항목 배열을 늘 `results`에 담는다 (`GET /api/longterm/daily-moves`의 `items` → `results`, `date`는 그대로).
  한 대상을 돌려주는 객체(한 종목 — `StockDetail`·`TradePlanDetail`)는 목록 엔드포인트가 아니라 배열 필드가 자기 이름을 쓴다 (`candles`·`events`). (이 규칙을 정할 때는 단타 연습의 `MinuteCandles`·`DayReview`·`GET /api/day/*`도 있었으나 2026-10-06 폐기로 지웠다 — 16장.)
  2026-10-04 전부터 있는 `/api/quotes`의 `quotes`·`/api/account/equity`의 `points`는 프론트가 이미 써서 그대로 둔다.
- **"구현 예정" 표시 위치** (`docs/API.md` 머리): 새 타입은 선언 줄, 이미 서버가 내는 타입에 더한 필드는 그 필드 줄마다. 만들면 "구현: 날짜 (Claude)"로 바꾼다 (2026-10-05: 이 장의 것은 모두 바꿨다).

### 14-8. 새 설정 키 (`.env`. `.env.example`·`deploy/.env.docker.example`·CI에 같이)

| 키 | 기본 | 뜻 |
|---|---|---|
| `AI_DAILY_REPORTS_PER_USER` | `3` | 팀원별 하루 리포트 신청 한도 (14-6) |
| `LONGTERM_JOBS` | `on` | 장기투자 예약 작업(오늘의 내 종목 뉴스·펀더멘털 점검)을 엔진 루프에서 돌릴지. 외부(증권사·DART·뉴스·LLM)를 부르므로 루트 `conftest.py`는 `off`로 끈다 (빈 문자열이 아니라 `off` — 빈 값은 `.env` 값으로 넘어간다) |
| `DAILY_MOVE_AT` | `16:30` | 오늘의 내 종목 뉴스를 만드는 시각 (KST, 국내 거래일, 이 시각 이후 하루 한 번) |
| `DAILY_MOVE_MODEL` | (없음) | 오늘의 내 종목 뉴스 설명에 쓸 LLM 모델. 없으면 `APPROVER`, 그것도 없으면 템플릿 문장만 |
| `THESIS_CHECK_AT` | `18:00` | 펀더멘털 점검 시각 (KST. 정기공시 감지는 거래일, 월요일 전체 재점검) |

설정 키로 두지 않은 상수: `CLOSE_SETTLE_MIN` 10분, 시장 대용 ETF(`069500`·`229200`), 리포트 알림 sweep 창 24시간, 금지 표현 목록(`paper_engine/wording.py`).
(`DAY_CLOSE_AT`·`LIMITS["DAY"]`·단타 퀴즈 통과 기준·`MINUTE_MAX_PAGES`는 2026-10-06 단타 폐기로 지웠다 — 16장.)

## 15. UI/UX 개선: 모션 · 화면 모드(다크) · 배치 (2026-10-05)

사용자 요청: "UI/UX 개선점을 모두 조사하고 개선·테스트까지 — 자연스럽고 세련된 애니메이션, 사용자 경험 전반 향상, 컴포넌트 위치의 당위성, 다크모드 전환".
범위는 `frontend/`뿐이다(백엔드·`docs/API.md` 계약 변경 없음, 외부 의존성 추가 없음). 9개 영역(앱 뼈대·홈·종목·리포트·모의투자·단타·마이 + 모션·다크 — 단타 화면은 2026-10-06 삭제, 16장)을 감사해
305건을 찾고 검증자가 반박해 6건을 버리고 40건을 더했다. 공용 기반 → 화면 영역별 구현 → 통합 → 독립 검증 순으로 반영했다.
**화면별 배치 순서와 그 이유는 `docs/design/화면배치.md`**에 적었다.

### 15-1. 모션 원칙

- **짧고 차분하게**: 100~320ms, 곡선 셋(`ease-standard` 제자리 변화 · `ease-enter` 들어오기 · `ease-exit` 나가기), 이동 2~8px(시트만 100%). 바운스·흔들기·숫자 카운트업·스켈레톤 시머는 쓰지 않는다.
  토큰은 `src/index.css`: `duration-instant|fast|base|slow`(100·160·240·320ms), `animate-*`(page-in·rise-in·sheet-in/out·toast-in/out·flash-* 등).
- **움직이는 때는 셋**: 기다린 끝에 내용이 왔을 때, 사용자가 상태를 바꾼 순간, 시트·대화상자 같은 층이 열리고 닫힐 때. 캐시로 바로 그린 화면·첫 렌더·뒤로 가기·폴링 갱신에서는 움직이지 않는다.
  오래 이어지는 '진행 중'(체결 대기 등)은 도는 스피너 대신 `LiveDot`(움직임 줄이기면 멈춤).
- **화면 전환은 불투명도만**: 페이지 래퍼에 transform·translate·scale·filter를 주면 그 안의 `position: fixed`(종목 상세 구매 바·주문 시트)가 래퍼 기준으로 붙어 화면 밖으로 나간다(실측).
  react-router 선언형(`BrowserRouter`)에서는 `<Link viewTransition>`·`ScrollRestoration`이 동작하지 않아(소스 확인) 직접 만들었다(`components/motion/RouteTransition`·`ScrollManager`).
- **움직임 줄이기**(prefers-reduced-motion): 모든 애니메이션·전이를 전역으로 끈다(반복 1회·지연 0 포함). 로딩 스피너(`.motion-essential`)만 돈다.
- **테스트**: jsdom(css 끔)에는 애니메이션이 없다. `lib/motion.ts`의 `CAN_ANIMATE`가 false면 닫힘·퇴장이 같은 렌더에서 끝나 기존 동기 단언이 그대로 통과한다. matchMedia·startViewTransition·ResizeObserver는 typeof로 확인한다.

### 15-2. 화면 모드 (다크)

- **저장: 브라우저 localStorage `paper-theme`** = `system`(기본) · `light` · `dark`. 계정·API에 저장하지 않는다 — 기기마다 다를 수 있는 표시 설정이고 백엔드 변경이 필요 없다.
  기본은 기기 설정을 따른다(토스와 같은 방식). 주린이모드(계정에 저장, 내용이 바뀜)와는 저장 위치·성격이 달라 다른 카드에 둔다.
- **바꾸는 곳**: 마이 "화면 모드" 카드 `[기기 설정 · 밝게 · 어둡게]`(알림 설정 다음, 계정 앞 — PC는 오른쪽 열), PC 왼쪽 메뉴 아래 "어두운 모드" 스위치(프로필 위).
  모바일 화면 머리·하단 탭에는 두지 않는다(정보 구조 고정, 드물게 쓰는 설정). '자동'이라는 말은 '모의 자동매매'와 헷갈려 쓰지 않는다.
- **첫 페인트**: `frontend/index.html`의 인라인 스크립트가 그리기 전에 `html[data-theme]`·`color-scheme`·`theme-color`를 정한다(새로고침해도 깜빡이지 않음). 지금 nginx에 CSP가 없어 동작한다. 나중에 CSP를 넣으면 이 스크립트와 인라인 style의 sha256을 허용한다.
- **전환 애니메이션**: 누른 곳에서 원형으로 퍼지는 View Transition 400ms(키보드면 버튼 가운데). 움직임 줄이기·미지원 브라우저·기기 설정 변경·다른 탭에서 온 변경은 즉시 바뀐다.
- **색**: `@theme static` 토큰을 `:root[data-theme="dark"]`에서 같은 이름으로 덮어쓴다(클래스는 그대로). 다크 팔레트는 토스 다크 참고(바탕 #0f1115 · 카드 #1a1d24 · 칸 #23272f · 선 #2e323b · 글자 #e9ecef), 높이는 그림자 대신 표면 명도로.
  주요 글자 조합은 WCAG AA(4.5:1)를 계산으로 확인했다. 상승 빨강·하락 파랑 관례는 그대로다.
- **차트**(lightweight-charts): `lib/chartTheme.ts`의 `useChartColors()`가 지금 테마의 토큰 색을 주고, 테마가 바뀌면 `applyOptions`로 색만 바꾼다(다시 만들지 않아 확대 상태 유지).
- **발표**: 프로젝터에서는 PC 메뉴 스위치로 밝게 둔다(4-3의 "주린이모드를 켬으로 되돌린다"와 함께 확인).

### 15-3. 색 토큰 규칙

- **TSX에 색 값을 쓰지 않는다**: `#hex`·`rgb()`·`bg-white`·`bg-black` 금지. `src/test/colors.test.ts`가 검사한다(예외: `lib/chartTheme.ts`의 차트 대체값, `lib/theme.ts`의 테마색).
- **글자와 바탕을 나눈다**: `*-ink`는 글자(`brand-ink` 파란 글자 · `warn-ink` 경고 글자 · `up-ink` 오류·실패 글자 · `ok-ink` 초록 글자), `on-*`는 그 바탕 위 글자(`on-ink` 반전 표면 · `on-warn` · `on-medal`),
  `brand-dark`·`up-dark`는 버튼 hover 배경 전용. 아이콘·점·막대는 `brand`·`up`·`ok`·`warn` 그대로.
- **반전 표면**(툴팁·토스트·선택 칩)은 `bg-ink` + `text-on-ink`(다크에서는 밝은 표면 + 어두운 글자, 의도), 그 위 아이콘은 `ok-inverse`·`up-inverse`. 배경막은 `scrim`, 스위치 손잡이는 `knob`, Segmented 선택 표시는 `thumb`, brand 바탕 위 그림(로고의 배)은 `on-brand`(두 테마 모두 흰색).
- **흐린 글자 `mute`를 AA로**: #8b95a1 → #646e7a(흰 카드 5.18:1 · 회색 바탕 4.70:1). 옛 값은 `mute-weak`(아이콘·자리표시자·장식에만).
- 가격 상승·하락 글자(`text-up`·`text-down`, 흰 카드 3.71:1)와 brand·up·down·ok 위 흰 글자 버튼(3.2~3.7:1)은 토스 브랜드 값 그대로 둔다 — 올리려면 브랜드 결정이 필요하다.
- **겹침 층(z)**: header 30 · nav 40 · sheet 50 · popover 60 · toast 70(`z-(--z-toast)`처럼 쓴다, 임의값 `z-[60]` 금지). 토스트는 늘 맨 위다(전에는 '왜 샀나요?' 대화상자 뒤에 가려졌다).

### 15-4. 공용 부품 (새 화면도 이것을 쓴다)

| 부품 | 파일 | 쓰는 곳 |
|---|---|---|
| `Segmented`(미끄러지는 선택 표시, `surface="page"`), `PillTabs`(탭·화살표 키), `Switch`(role=switch), `Progress`, `LiveDot`, `Medal`, `EmptyState`(아이콘·제목·다음 행동)·`ErrorState`(retrying), `PageHeader`(back 대체 경로·문서 제목·brand), `Flash`(tone) | `components/ui.tsx` | 모든 화면 |
| `Collapse`(접힘 — 닫히면 언마운트), `Sheet`(바텀시트·대화상자: 포커스 가두기·Esc·배경 inert·스크롤 잠금·닫힘 애니메이션), `ScrollManager`, `RouteTransition`, `RouteErrorBoundary` | `components/motion/` | 펼침·대화상자·앱 뼈대 |
| `useRevealAfterLoading`·`revealList`(처음 내용이 올 때 한 번 등장), `useChanged`, `useNewKeys`(실시간으로 붙는 새 항목), `usePresence`, `useModal`, `useSlidingIndicator`, `useTheme`·`useResolvedTheme` | `hooks/` | |
| `press`(버튼 누름 scale .98), `press-row`(행·카드 링크 누름 배경), `reveal-fade`, `is-new`, `skeleton` | `index.css` | 모바일 누름 피드백(전에는 탭 하이라이트만 끄고 대신할 것이 없었다) |

- `BrandMark`(로고 — size px, 32px 이상은 속이 빈 ㅁ·더 작으면 속이 찬 사각형, `loop` 반복 모션, 고대비에서도 색 유지)·`Wordmark`("모매매" 글자 SVG — 세 ㅁ만 brand 색)·`BrandLockup`(로고 + 워드마크, 사이 = 마크의 1/4, 워드마크 높이 = 마크의 0.7배, 이름은 숨김 글자가 읽는다): `components/brand/BrandMark.tsx`, 도형 값은 `lib/brandShapes.ts`. 화면에 서비스 이름을 넣을 때는 이것을 쓴다 (2026-10-08 로고 바뀜 — 27장).
- `Skeleton`: className에 모서리(rounded-*)를 주면 기본 rounded-lg를 뺀다(원·알약 자리).
- 둥근 카드(overflow-hidden) 안의 행 링크는 `focus-visible:outline-offset-[-2px]` + 첫·마지막 행 모서리 맞춤으로 포커스 테두리가 잘리지 않게 한다. 요청을 보내는 버튼은 `disabled` 대신 `aria-disabled`(누름 무시·aria-busy·Spinner)로 포커스를 지키고, 누른 행이 사라지면 다음 행 → 앞 행 → 목록 제목 순으로 포커스를 옮긴다.
- 토스트: `toast(문장, "info" | "success" | "error", { action })`. 길이에 따라 3~6초, 마우스·포커스·숨은 탭 동안 멈추고 눌러 닫는다. 모바일은 하단 탭·주문 바 위, PC는 본문 열 가운데, 시트가 열려 있으면 화면 위쪽.
- 필터·검색을 바꾸는 목록은 `{ keepPrevious: true }`(api/queries.ts)로 이전 목록을 흐리게 남긴다(스켈레톤으로 줄었다 늘며 화면이 출렁이지 않게). 대상이 바뀌는 상세에는 쓰지 않는다.
- **화면 아래 칸 쌓기**: 하단 탭·구매 바(`lib/orderBar` — 종목 상세가 구매 바를 실제로 그릴 때만 하단 탭을 숨긴다) → 화면에 붙는 폼 바닥(`html[data-sticky-footer]`) → 연결 끊김 띠(`.connection-region`) → 토스트. 새로 화면에 붙는 바닥을 만들면 같은 표시를 단다.
- `Flash`의 `tone`: 기본 `trend`(오르면 빨강·내리면 파랑), `ok`(좋은 일이 **늘었을 때만** 초록 — 예: 자동 복구 수), `neutral`(입력으로 바뀐 금액, 회색). 첫 렌더에는 깜빡이지 않는다.

### 15-5. 스크롤 · 포커스 · 뒤로 가기

- 새 화면(주소가 바뀜, 보기 전환 `?view` 포함)은 맨 위에서 연다. 쿼리만 바뀌는 탭·필터는 위치를 지킨다. 뒤로·앞으로는 원래 위치로 돌아간다(전에는 탭을 누르면 이전 화면의 스크롤 위치에서 열렸다 — 마이는 로그아웃 버튼 앞).
- 지금 탭(PC 브랜드·프로필 포함)을 다시 누르면 맨 위로 부드럽게 간다.
- 화면을 옮기면 제목(h1)에 포커스가 가고 문서 제목이 "〈화면〉 · 모매매"가 된다(화면 읽기 프로그램이 새 화면을 알린다). 첫 Tab에 '본문 바로가기'.
- 화면 안 '뒤로 가기': 앱 안에 이전 기록이 있으면 뒤로, 링크로 바로 들어왔으면 탭 묶음 첫 화면(`lib/nav.ts` `parentPath` — 예: 리포트 상세 → 리포트 목록). 전에는 앱 밖으로 나갔다.
- 화면 렌더 오류는 그 화면 카드 안에서만 보인다(`RouteErrorBoundary`, 다시 시도·홈으로) — 전에는 앱 전체가 흰 화면이 됐다.
- 해시 링크(`/my#notification-settings` 등)로 새 화면에 가면 먼저 맨 위에서 열고, 대상이 그려지면 그 자리로 간다(느린 망에서 앞 화면의 스크롤 위치에 남지 않게).
- **키보드 포커스가 고정 머리·하단 바에 가리지 않게**: `:focus-visible`에 `scroll-margin`을 한 규칙으로 둔다(index.css). 머리 아래에 줄이 더 붙는 화면(리포트 전문가 탭 줄)은 `html`의 `--sticky-tabs-h`로 높이를 더한다. `html`의 `scroll-padding`은 쓰지 않는다 — 붙은 줄로 Shift+Tab 할 때 페이지가 튄다.
- 닫히는 시트는 사라지는 동안에도 스크림이 클릭을 받는다(두 번 누른 클릭이 보이지 않는 아래 버튼을 누르지 않게). 누른 버튼이 사라지거나 막히면 포커스를 이웃 요소·목록 제목으로 옮긴다(body로 떨어뜨리지 않는다).

### 15-6. 파일 소유와 다음 작업 규칙

- 이번 변경은 담당 5의 원래 파일(`Layout.tsx`·`LoginPage.tsx`·`index.html`·`ReportsPage`·`ReportPage`·`components/reports/*` 등)을 포함한다. 14-2대로 Claude가 "합쳤다"고 알린 뒤 5가 그 위에서 다듬는다.
- 화면을 고칠 때: 색은 토큰만, **라이트·다크 두 테마 × 모바일 390·PC 1280**을 함께 확인한다. 공용 부품·훅을 쓰고 비슷한 것을 새로 만들지 않는다. 배치를 바꾸면 `docs/design/화면배치.md`를 함께 고친다.

### 15-7. 이름과 로고: 종이배 (2026-10-05, 사용자 요청)

> **2026-10-07 이름을 "모매매"로 바꿨다 (18장).** 아래 이름 풀이·"이름이 나가는 곳"의 문자열은 지난 이름의 기록이다.
> **2026-10-08 로고(종이배 → ㅁ 블록 셋)·부제·풀이 한 줄도 바꿨다 (27장).** 아래 로고·부제·로그인 첫 화면과 "쓰지 않는 것"의 그림 규칙(배 색·물결·화살표·차트)은 지난 기록이다. "쓰지 않는 것"의 문구 규칙(배 은어·띄우다·접다 등)은 그대로 쓴다.

- 사용자 요청: "앱 이름이랑 로고 디자인 멋있게 변경해줘. 앱 이름 자체를 바꿔도 됨". 시안 9개(쉬운 우리말·은유·로고 먼저 세 방향)를 세 기준(초보 명확성·안전 / 브랜드 힘 / 로고 완성도 — 1배율 16px까지 그려 봄)으로 심사해 1위를 골랐다.
- **이름 "종이배"**(붙여 씀). '종이'가 두 가지를 뜻한다 — AI가 쓴 **리포트**(종이 위의 보고서)와 **모의투자**(paper trading, "종이 위에서 = 실제가 아니라 연습으로"). 이름이 처음부터 '진짜 돈이 아님'을 말해 실제 매매·수익 약속으로 읽힐 틈이 적다.
  부제 **"종이 위에서 연습하는 AI 리포트 모의투자"**. 영문은 설명할 때만 'Paper Boat'(상호처럼 'Paperboat' 한 단어로 쓰지 않는다 — 해외 음료 브랜드와 겹친다). 코드·저장소·패키지 이름은 그대로.
- **로고**: 리포트 한 장을 접은 종이배 정면 실루엣(사다리꼴 선체 + 삼각 돛, 돛 꼭짓점을 둥글려 ▲ 상승 기호로 읽히지 않게). brand 둥근 타일 + 흰 배. 48px 이상에서만 돛에 접힌 선 하나("종이를 접었다").
  파일: `frontend/src/components/brand/BrandMark.tsx`(CSS 변수 `--color-brand`·`--color-on-brand` — 다크에서 타일이 #458ef7), `frontend/public/favicon.svg`(16px 최적화), `apple-touch-icon.png`(180px). 쓰는 곳: PC 왼쪽 메뉴(32px), 모바일 홈 머리(28px), 로그인(56~64px), 부팅 화면, PDF 머리.
- **이름이 나가는 곳**: 브라우저 탭 "〈화면〉 · 종이배", 홈 화면에 추가할 때의 이름(`apple-mobile-web-app-title` — 없으면 그 순간의 탭 제목이 이름이 된다), Discord 머리말 `[종이배 · 모의투자]`(`notifications/service.py`),
  A4 PDF(양식 판 `TEMPLATE_VERSION` 3 — 예전 판 파일은 다음 요청 때 새로 만든다): 모든 쪽 맨 위 머리 [로고 9mm + 이름 | 'AI 리포트 · 모의투자 연습용'] + 가는 선. 면책·날짜는 본문·꼬리말에 이미 있어 머리에 넣지 않는다.
- 로그인 첫 화면: 로고 56px → 이름 26px → 부제(`SERVICE_TAGLINE`) → 설명 한 줄(`SERVICE_INTRO` "진짜 돈 대신 종이 위에서 — AI가 쓴 리포트를 읽고 따져 본 뒤, 가상 현금으로 모의투자를 연습해요.") → 3단계 칩. 상수는 `lib/plainText.ts`.
- **쓰지 않는 것**: 배를 노란색으로 칠하지 않는다(세월호 추모의 노란 종이배와 겹친다), 물결·화살표·차트를 덧그리지 않는다. 문구에 배 은어(탑승·승선·선장·출항·순항 — 리딩방 은어와 닿는다), '띄우다'(주가 띄우기)·'접다'(포기), 침몰·가라앉다·구조, '배(倍)' 말장난을 쓰지 않는다.
- 2·3위 후보(바꾸고 싶을 때): **"따져봄"**("AI 리포트로 따져 보는 모의투자 연습" — 검토 원칙을 가장 정확히 말하고 안전 심사 1위, 마크(안경)는 다시 다듬어야 함), **"검산"**(√ 체크 마크가 가장 독창적, 이름이 딱딱함). 이름은 `lib/plainText.ts` `SERVICE_NAME` 한 곳 + 백엔드 두 상수(`notifications/service.py` `HEADER`, `reports/output/pdf.py` `SERVICE_NAME`)다.


## 16. 단타 폐기 (2026-10-06, 사용자 결정)

사용자(팀장)가 2026-10-06에 2026-10-05에 구현한 "단타 연습"을 **전부 없애기로** 했다 (선물 폐기 E-7과 같은 방식). 투자 방식은 **스윙·장기 두 개**만 남는다.
13-2 E-6, 14-4와 그 앞뒤의 단타 결정은 이력으로 남기고 "폐기(2026-10-06)"로 표시했다. 이 장이 우선한다. 계약은 `docs/API.md`, 조사는 `docs/research/단타_실시간시세_조사.md`(폐기 기록).

### 16-1. 없앤 것

| 영역 | 없앤 것 |
|---|---|
| 보유 방식 | `style = "day"` (보유 방식은 `swing`·`long`). 상수 `DAY`(엔진 executor·`trading.models`), `STYLES`의 `day` |
| 단타 세션·정리 | `DAY_CLOSE_AT`(15:15), `DAY_ENTRY_CLOSED`("단타 진입 마감"), `day_session`·`day_cutoff`·`_day_close`, 청산 사유 `EOD`, 실행 불가 사유 코드 `day_entry_closed`·`day_trading_locked`, 계획 실패·만료 사유 `day_unfilled`, 백엔드 `market.day_entry_open`·`day_entry_cutoff`, `DaySession` |
| 계획 보유 기간 `horizon` | `Recommendation.horizon`·`TradePlan.horizon` 필드와 API 필드 `horizon`, 프론트 `PlanHorizon`. 엔진 `judge/risk.py`의 `LIMITS["DAY"]`(E-6 한도), `judge/scenario.py` `HORIZONS`의 `"DAY"`, `notify.py` `HORIZON_LABEL`의 `"DAY"`. `SWING`·`LONG_TERM`은 그대로 |
| 추천 출처 | `Recommendation.source = "day"` (`source`는 `report`·`analysis`·`demo`) |
| 분봉 | 엔진 `KiwoomClient.minute_candles`·`TossClient.minute_candles`(두 클라이언트가 같게 유지하므로 둘 다), `minute_session`·`bucket_minutes`·`_kr_minute_candle`·`_minute_time`·`MINUTE_STEPS`·`MINUTE_MAX_PAGES`, 백엔드 `trading.market.minute_candles`·`MINUTE_*`·`_minute_rows`, `MinuteCandlesView`, `GET /api/stocks/{symbol}/minute-candles` |
| 단타 연습 앱 | `backend/daytrade` 전체 (`/api/day/*` — 상태·미리 보기·계획·복기), `INSTALLED_APPS`·`config/urls`·`backend/pyproject.toml` testpaths의 `daytrade` |
| 단타 퀴즈·잠금 | `GET/POST /api/me/day-trading-quiz`, `accounts/quiz.py`, `DayQuizView`, `InvestorProfile.day_quiz_passed_at`, 응답의 `dayQuizPassedAt`·`dayTradingUnlocked`, `accounts/modes.py`의 단타 잠금(`lock_reasons`·`day_trading_lock`·`LOCK_*` 코드·`DayLockReason`) |
| 프론트 | `/day`·`/day/quiz`·`/day/review` 화면, `components/day/`, `DayQuizEntry`, 모의투자 탭의 "단타 연습장" 카드(`DayEntry`), 마이·종목 상세의 단타 진입점, `api/day.ts`, 관련 mock·테스트 |
| 함께 없앤 것 | 단타에만 쓰이던 인자·함수: 엔진 `buy_checks`·`buy_blockers`의 `now` 인자(15:15 진입 마감 판정용), 백엔드 `trading.market`의 `kr_trading_day`·`next_weekday`·`regular_market`(다른 곳에서 쓰지 않음) |
| 팀 몫이던 일 | 단타의 AI 팀(`day_plan`·`day_review`)과 AI 복기 — 만들지 않는다 |

### 16-2. 데이터 처리 (마이그레이션 4개 — SQLite·PostgreSQL 둘 다에서 돈다)

- **`trading/0003_remove_day_style`** (RunPython): `PaperOrder` `style = "day"` 중 `ENTRY_PENDING`은 `CANCELED`(`closed_at` = 지금, `note` = "단타 기능 삭제"), 나머지 `style = "day"`는 `"swing"`으로 바꾼다. 되돌리기는 아무것도 하지 않는다.
- **`autotrade/0003_remove_day_rows`** (RunPython): `horizon = "DAY"`이거나 추천 `source = "day"`인 `TradePlan`을 지운다 (`PlanEvent`는 CASCADE). 그 계획을 가리키던 `Notification`(`link == "/plans/<id>"`)과 `link`가 `/day`로 시작하는 `Notification`도 지운다
  (`notifications/0002`에 의존). `source = "day"` `Recommendation`은 `PROTECT`라 계획을 먼저 지운 뒤 지운다.
- **`autotrade/0004_remove_horizon`**: `Recommendation.horizon`·`TradePlan.horizon`을 지우고 `source`의 선택지를 `report`·`analysis`·`demo`로 바꾼다.
  행 정리(0003)와 나눈 까닭: PostgreSQL은 행을 지운 같은 트랜잭션에서 그 표를 `ALTER`하면 "pending trigger events"로 막는다.
- **`accounts/0004_remove_day_quiz`**: `InvestorProfile.day_quiz_passed_at`을 지운다.
- 팀 개발 DB(PostgreSQL)의 단타 행은 **0개**였다. 공유 DB에는 이 작업에서 직접 `migrate`를 돌리지 않았다.
  열을 지우므로 **migrate한 DB에서는 이 변경 전 코드가 돌지 않는다** (`horizon` 열을 읽음). 공유 개발 DB는 팀원이 이 커밋을 받은 뒤에 migrate한다 (`scripts/dev.sh`를 다시 띄우면 migrate한다). 테스트는 SQLite 메모리 DB에서 돈다.

### 16-3. 남긴 것 (헷갈리기 쉬운 것)

- **투자 성향 진단**의 문항·보기(q6의 `intraday` 포함)는 그대로다 — 저장된 `answers`와 호환된다. 결과 문구에 있던 "단타 연습장" 안내만 뺐다.
- 일봉·시세·장마감 기준 가격, `EquityDaily.day`(날짜 열), `--days` 옵션처럼 **'날짜(day)'**라는 단어는 단타와 무관하다. 지우지 않았다.
- 하루 주문 수·손실 한도(`paper_today`)는 스윙 계획에 계속 쓴다 (`style` 인자는 `swing`·`long`만).
- `docs/research/단타_실시간시세_조사.md`는 지우지 않고 "폐기된 기능의 조사 기록"으로 표시했다. 키움 `ka10080`(분봉) 조사 내용은 `docs/KIWOOM.md`에 남기되 쓰지 않는다.
- 위 이력(13-2 E-6, 14-4, 14-7 등)은 지우지 않았다. 지금 코드·계약은 이 장과 `docs/API.md`가 기준이다.

## 17. 시세 실시간 표시 (2026-10-06, 사용자 결정)

사용자가 "종목 조회는 종가 기준이 아니라 실시간으로 보여야 한다"고 정했다 (14-1의 시세 부분을 바꾼다). 계약은 `docs/API.md` 공통 규칙 "실시간 시세".

- **실시간으로 바꾼 것**: `Quote`(`/api/quotes`, `StockDetail.quote`) — 증권사 현재가, `basis: "live"`, `asOf` = 받은 시각. `StockDetail.candles`는 오늘 진행 중인 봉까지.
  직접 주문의 시장가 매수 가능 점검 가격도 현재가로 (화면의 예상 금액 = 시세 × 수량과 같게). 화면 시세 폴링 60초 → 5초.
- **`prevClose`**: 그 가격이 속한 거래일(오늘 정규장이 있으면 오늘, 없으면 마지막 일봉 날짜)의 전 거래일 종가. 장 달력을 못 받으면 평일을 거래일로 본다.
- **그대로 장마감 기준인 것**: 계좌 평가·수익률·`Position`, 랭킹, 일별 자산 기록, 리스크 미리 보기와 활성화 수량, `priceAtCreation`, 시연 추천 진입가, ~~리포트(시세 Worker·PDF)~~, 분석.
  (2026-10-08: 리포트 시세 Worker는 장 중에 만들면 현재가, 미리 보기·활성화의 가격 점검도 그때는 장중 가격 — 26장) 이유: 미리 보기에서 본 수량이 그대로 주문 수량이 되고 수익률·랭킹이 하루 동안 흔들리지 않게 (14-1 ①).
  그래서 같은 화면에서 시세(실시간)와 계좌 평가(장마감 기준)가 다를 수 있다 — 표기("실시간 · 시각" / "장마감 기준")로 구분한다.
- **현재가를 받지 못하면** 그 종목은 장마감 기준 Quote(`basis: "close"`)로 낸다.
- **조회량**: 현재가는 종목마다 1초 캐시를 팀 전체가 같이 쓴다. 키움은 국내 현재가를 여러 종목 한 번(`ka10095`)에 받으므로 한도(초당 5회) 안이다.
- **약관**: 실시간 시세를 여러 사람 화면에 계속 띄우는 모양이 된다 (13-3, U10 — 종가도 증권사 시세라 원래 문제를 없애지는 못했다). 사용자 결정으로 감수한다. 출처 줄은 "시세: {제공처} 조회 · 실시간 (계좌·랭킹은 장마감 기준)".

## 18. 서비스 이름: 모매매 (2026-10-07, 사용자 결정)

사용자가 "앱 이름 모매매로 바꿔"라고 정했다. 15-7의 이름 "종이배"를 바꾼다 (D-5 "AI 리포트 데스크" → 15-7 "종이배" → 18장 "모매매").

- **이름 "모매매"**(붙여 씀). 꾸밈말을 붙이지 않는다('AI 모매매' 아님). 코드·저장소·패키지 이름은 그대로.
- **바꾼 곳** — 이름 상수 셋과 그 테스트:
  - 화면 `frontend/src/lib/plainText.ts` `SERVICE_NAME`: 왼쪽 메뉴·모바일 홈 머리·로그인·부팅 화면, 브라우저 탭 "〈화면〉 · 모매매", 로고의 읽기 이름.
    `frontend/index.html`의 `<title>`·`apple-mobile-web-app-title`도 같이.
  - Discord 머리말 `[모매매 · 모의투자]` (`backend/notifications/service.py` `HEADER`).
  - A4 PDF 머리 (`backend/reports/output/pdf.py` `SERVICE_NAME`). 양식 판 `TEMPLATE_VERSION` 3 → 4 — 예전 판 PDF는 다음 요청 때 새 이름으로 다시 만든다.
- **그대로 둔 것**: 로고(종이배 모양 — `BrandMark.tsx`·`favicon.svg`·`apple-touch-icon.png`)와 15-7의 로고 규칙·"쓰지 않는 것",
  부제 "종이 위에서 연습하는 AI 리포트 모의투자"와 풀이 한 줄(`SERVICE_TAGLINE`·`SERVICE_INTRO`). 새 이름에 로고·부제를 맞출지는 `docs/결정필요사항.md` U24.
  → 2026-10-08 로고·부제·풀이 한 줄도 새 이름에 맞춰 바꿨다 (27장, U24 결정).
- **문서**: 지금 상태를 말하는 곳(`AGENTS.md`, `README.md`, 계획서들, `docs/API.md`, 이 문서의 현재 규칙 줄, 화면 배치)은 새 이름으로 고쳤다.
  지난 결정의 기록(15-7 본문, 작업 문서의 날짜 붙은 줄)은 지우지 않고 바뀐 사실만 덧붙였다.

## 19. 추천 워크플로우 구현: Orchestrator · Worker 11개 · 매매 종목 선정 팀 · 자동 리포트 (2026-10-07, 사용자 결정)

사용자(팀장)가 "추천 워크플로우 구현 — 전부 구현"을 정했다. 2026-10-04 결정(14-2: 핵심 Agent 워크플로우는 담당 2·3·4)을 바꿔, 설계 예시 `docs/design/AI_AGENT_WORKFLOW.md`를
Claude가 끝까지 만들었다. 팀원이 이미 만든 것(3의 T3-1 레지스트리 스키마, 4의 T4-1 마이그레이션 0002·T4-2~T4-5 호출기, 2의 계약 6개와 dy 브랜치의 계약 보강 `ce98783`) 위에 올렸다.
약속(`docs/tasks/00-공통.md` 6~10절)은 그대로 따르고, 바뀐 것은 00-공통에 "2026-10-07"로 적었다.

- **두 팀** (`Report.team`, 마이그레이션 0003): `stock_report`(종목 리포트, 기본)와 `stock_selection`(매매 종목 선정 — 하루 한 번, `symbol`은 시장 코드).
  `registry.execution_plan(team)`·`step_ids(team)`·`worker_ids(team)`, `state`는 리포트의 팀 계획으로 단계·Worker를 확인한다. 선정 실행은 목록·알림·추천 수집에서 빠진다.
- **Orchestrator** (`reports/orchestration/orchestrator.py`): 계획대로 병렬·순차 실행, 단계 제한 시간(180초) → `timeout`, Join Guard, 부분 실패 정책 셋, 검토 반복(RETRY ≤ 2), Handoff Guard(리스크 점검),
  비용 집계(`state.add_cost`). `state`의 쓰기는 프로세스 잠금으로 한 번에 하나 (병렬 Worker 스레드가 SQLite에서 "table is locked"를 내지 않게).
- **실패 사유 코드 셋 추가**: `agent_failed`(Join이 없는 단계의 필수 Worker 실패), `no_llm`(AI 키 없음), `expired`(24시간 넘게 기다린 `requested` — 실행기를 처음 켤 때
  묵은 신청이 실제 비용으로 한꺼번에 돌지 않게. 계획서 Q5). 화면·알림 문장 표에 같이 넣었다. 필수 Worker가 단계 제한 시간을 넘기면 `timeout`(Q3).
- **2026-10-08 바뀜 — LLM timeout 규칙(Q1, 사용자 결정)**: 주 모델 timeout은 같은 모델을 다시 기다리지 않고 바로 대체 모델, 대체 모델 timeout은 같은 모델로 한 번 더 (넘어갈 대체 모델이 없을 때만 주 모델로 한 번 더, `healing.py`).
  왜: 주 모델이 계속 멈출 때 60초를 또 기다리지 않아 복구가 125초 → 65초, 대체 모델이 첫 호출에서만 멈추는 경우도 180초 안에 복구된다.
  `yubeen` 브랜치의 "timeout은 어느 모델이든 바로 다음 모델" 안과 지금 규칙을 가짜 시계로 비교해 고른 절충안이다 (`docs/works/todo/yubeen_리뷰_Orchestrator별도구현_2026-10-08.md` 3장).
  호출 한 번에 주 모델 실패가 2번에서 1번으로 줄어, 장애 주입 시연에서 Circuit Breaker(연속 3번)는 세 번째 호출에서 열린다.
- **실행기** (`reports/orchestration/runner.py`): 엔진 루프 "리포트 실행" 단계가 `requested`를 오래된 순으로 하나씩(동시에 하나). 엔진이 다시 뜨면 남은 `running`을 `engine_restarted`로 끝낸다.
- **Worker 11개**: 종목 리포트 6개(시세 — 장마감 기준 값을 코드가 덮어씀, 재무·공시, 뉴스, 작성, 검토 — 투자유의면 코드가 Handoff를 붙임, 리스크 — 투자유의 단계의 하한을 코드가 정함),
  선정 5개(후보 뉴스, 후보 공시 — 고위험 공시 낱말은 코드가 high로, 수급 — 합계는 코드, 선정 — 가격 없음, 선정 검토 — 후보 밖 종목이면 코드가 RETRY로). 외부 글은 입력 Guard(`guards.clean_text`)를 거친다.
- **하루 파이프라인** (`reports/autoreport/auto.py`, `AUTO_REPORT=on`일 때만 — 기본 off): 국내 거래일 `AUTO_REPORT_AT`(08:00) 뒤 규칙 선별(후보 30) → 선정 팀 실행 →
  선정 Guard(`reports/autoreport/selection.py`: 후보 밖·투자유의(조회 실패면 제외)·고위험 공시·같은 테마 2개까지, 모자라면 규칙 점수로 채움) → 상위 3종목 자동 리포트 → 끝나면 Discord로 PDF와 표지,
  매수 의견이면 AI 추천(팀 전체 알림). 선정 팀이 실패하면 규칙 점수 상위로 Fallback하고 `selectedBy: "rule"`·`fallbackReason`을 남긴다. 증권사 조회가 안 되면 그날은 건너뛰고 Discord로 알린다.
  `AUTO_RECOMMEND=demo`(시연 추천)와 같이 켜지 않는다.
- **독립 리뷰(2026-10-07, 구현하지 않은 작업자 7명 + 결과마다 반박 3명)**에서 확인된 19건을 고쳤다: Worker 결과 쓰기와 단계 시간 초과의 경합,
  엔진 종료를 붙잡는 Worker 스레드(데몬으로), 신청자 없는 리포트의 팀 전체 알림 반복, 테스트가 실제 `runs/`를 건드림(`AUTO_REPORT` 고정),
  조회 하나가 LLM 시간을 먹는 문제, 공시 바닥의 해제 공시·오래된 공시·우선주, 뉴스 날짜(KST), 자정을 넘긴 선정·명령으로 시작한 선정·US 선정이 이어지지 않음,
  증권사 키 없이 매일 건너뜀 알림, 쉬운 실패 화면의 멈춘 단계, 문장 중복 등. 기록은 `docs/works/done/Hwanseok_리뷰_추천워크플로우_2026-10-07.md`.
- **사람이 최종 결정**: 바뀌지 않았다. AI 추천은 사용자가 리포트를 읽고 "계획 활성화"를 눌러야 모의 자동매매가 시작된다 (12장).
- **남은 것(팀원 몫)**: 4의 장애 주입(`chaos.py`, T4-6)과 복구 지표(`stats.py`·`recovery-stats` API, T4-7) — 지금 `recovery`는 고정값, 2의 비용 예산(`budget.py`),
  실제 모델로 프롬프트 다듬기(T2-10), 설계서·장애 복구 보고서. 주린이모드 "AI 의견 대립" 제안(`docs/design/AI_AGENT_WORKFLOW.md` 6장)은 만들지 않았다.

## 20. 주린이모드 PDF: 쉬운 판 (2026-10-07, 사용자 결정)

사용자가 "PDF 내용도 주린이 모드에서 쉬운 설명으로 대체"를 정했다. 14-7·컨셉 계획의 "PDF는 리포트당 한 벌(쉬운 요약 상자를 늘 넣는다)"을 바꾼다.

- **두 판**: 쉬운 판과 자세한 판(지금까지의 PDF, 내용 그대로). `GET /api/reports/{id}/pdf?view=easy|expert` — 화면의 `?view`와 같은 값.
  없으면 요청한 사람의 주린이모드(켬 → 쉬운 판). 웹 쉬운 보기의 "PDF로 보기"는 `?view=easy`, 자세히 보기는 `?view=expert`를 붙여 "이 화면만 자세히 보기"를 따른다.
- **쉬운 판 내용 = 웹 쉬운 보기와 같은 문장** (`backend/reports/output/easy_text.py` — 짝 TS 파일을 주석에 적고, 테스트가 두 쪽 문장이 같은지 본다):
  AI 의견 배지와 한 줄 풀이, 신뢰 패널(검토 통과·인용 수·자료 시각·자동 복구 문장·"AI 검토는 사실을 보증하지 않아요"), 쉬운 요약 3줄,
  매매 계획(말로 — "웹의 매매 계획 카드에서 '실행 준비'를 거쳐 직접 '모의 자동매매 시작'을 눌러야 시작돼요" — 쉬운 보기의 버튼 이름. 누르지 않으면 실행되지 않고 기한이 지나면 만료된다), 근거와 위험·"이 의견이 틀리는 경우", 세 가지 경우(1주 기준 %),
  가격 흐름(사는 가격·목표 가격·손절 가격 가로선, 이동평균 없음), 조사 자료 요약, **용어 풀이**(종이에서는 눌러 볼 수 없어서 — 그 쪽에 나온 용어만, 화면 용어 사전 문장 그대로),
  위험 점검 AI의 메모(결과가 있을 때 결론 위 노란 상자 — 컨셉 6장), 쉬운 꼬리말("어떻게 만들었나요")과 면책 문장.
- **쉬운 판에 넣지 않는 것**: 검토 점수·신뢰도·목표 도달 확률(컨셉 4-4), 모델 이름·제공자·비용·오류 코드, "Agent"라는 낱말, 신청자 이름,
  계좌마다 달라지는 값(수량·금액 — 파일은 리포트·판마다 하나라 누가 받아도 같아야 한다). 가격은 리포트 제안값을 호가 단위로 내린 값(추천과 같은 값)이고
  계획·시나리오·차트·"이 의견이 틀리는 경우"의 손절 문장이 모두 그 값을 쓴다. **웹 쉬운 보기도 같은 값으로 맞췄다** — 추천이 없을 때도 리포트 제안값을 호가 단위로 내려
  계획·시나리오·차트·"이 의견이 틀리는 경우"에 같은 값을 쓴다 (전에는 "틀리는 경우"만 내리지 않은 값이었다). 숫자 반올림은 화면(Intl.NumberFormat)과 같다.
  차트 범례는 "일봉 · 최근 60일 · 10월 2일(금) 15:30 장마감 기준"(시세 자료의 기준 시각, 없으면 마지막 완성 봉 날짜의 "종가 기준"), 보유 기간이 비어 있으면 추천과 같은 10거래일.
  PDF에만 있는 문장(위험 메모 제목, "계획 활성화" 안내, 계좌 금액 안내, 꼬리말)은 `easy_text.py`에 "PDF 전용"으로 표시했다.
- **파일**: 자세한 판 `<id>.v<판>.pdf`(그대로), 쉬운 판 `<id>.v<판>.easy.pdf`. 양식 판(`TEMPLATE_VERSION` 4)은 그대로 — 자세한 판 내용이 바뀌지 않았다.
- **Discord 자동 리포트**는 쉬운 판을 보낸다 (팀 공용 채널은 쉬운 문장 규칙 — 14-7 B6). `pdf_path`는 그 파일이다.
  엔진(Chrome이 있는 컨테이너)이 자세한 판도 같이 만들어 둔다 — 운영 web 이미지에는 Chrome이 없어(U22) 거기서 처음 만들면 HTML로 굳기 때문이다.
- 독립 리뷰(2026-10-07)에서 확인된 11건(반올림이 화면과 다름, 보유 기간 기본값, 웹·PDF 손절 가격, 범례·용어 풀이, 쉬운 보기 버튼 이름, 운영 자세한 판 형식,
  문서의 `pdf_path` 설명, 짝 검사가 화면 제목 변경을 놓침, 시간대 없는 기준 시각)과 1건(기한이 지난 뒤의 안내)을 고쳤다.

## 21. 손절가는 코드가 정한다 · 스윙 최소 손익비 1.5 (2026-10-07, 사용자 결정)

AI가 낸 시나리오의 손익비가 2.0을 넘은 적이 없었다 (운영 리포트 buy 2건 0.31·0.64, 10/2 교차검증 2건 1.10·0.69 — 비용 반영).
AI는 목표를 가깝게(+6~9%), 손절을 멀게(−5~−19%) 잡았다. 그래서 AI 추천은 활성화에서 거의 모두 `reward_risk_low`로 막혔다.

- **손절가는 AI가 아니라 코드가 정한다** (`engine/paper_engine/judge/stops.py`): 최근 완성 봉 10개의 최저가 − ATR14×0.5를
  기준가 − ATR14×2 ~ 기준가 − ATR14×1 안으로 맞추고 호가 단위로 내린다. 기준가는 분석할 때의 가격(엔진 분석 `lastPrice`, AI 리포트 시세 조사의 `price` —
  2026-10-08부터 장 중이면 현재가, 아니면 직전 정규장 종가, 26장)이다.
  진입가가 아니라 기준가로 정하므로 AI는 손절가를 미리 받아 확률을 추정한다.
  - 엔진 교차검증: 제안 전에 종목 데이터의 `stopRule`(값·정하는 법)을 넣고, 제안된 `stopPrice`를 그 값으로 바꾼다 (`pipeline.apply_stop`).
    일봉·ATR이 모자라 정하지 못했거나 진입가가 손절가 이하면 사실 검증에서 거른다. 제안 AI의 응답 형식에서 `stopPrice`를 뺐다.
  - AI 리포트: 시세 조사(`market_agent`)가 결과에 `stop`을 넣는다 (`MarketResult.stop`, 시세 LLM에는 보여 주지 않는다).
    작성 AI는 그 값을 손절 가격으로 받아 쓰고, 초안의 `targets.stop`은 코드가 그 값으로 덮어쓴다 (`report.finish`). 정하지 못했으면 null → 추천이 생기지 않는다.
- **스윙 최소 손익비 2.0 → 1.5** (`judge/risk.py` `LIMITS["SWING"]`). 리스크 엔진을 쓰는 곳(엔진 분석, 추천 활성화 미리 보기, 프론트 가짜 API)에 모두 걸린다.
  최소 손익비를 AI 프롬프트에 넣지 않는 규칙은 그대로다. 시연 규칙 추천(손익비 2.4)은 바꾸지 않았다.
- 알아 둘 것: 10/2 삼성전자 분석(ATR14 12,514원 = 4.5%)에 이 손절가를 거꾸로 넣어 보면 251,000원(−9.1%, ATR 2배 상한)으로 AI 손절보다 멀어
  손익비가 오르지 않았다 (gemini 1.10 → 0.64, gpt 0.69 → 0.83). 바뀐 흐름에서는 AI가 손절가를 미리 보고 목표·확률을 정하므로 새 분석으로 다시 봐야 한다.
  변동성이 큰 종목에서 손절이 계속 멀면 ATR 배수(`MAX_STOP_ATR`)·저점 기간(`SWING_LOOKBACK`)을 조정한다.

## 22. 자동 리포트 다시 시도: 손익비 기준을 넘는 추천이 없으면 다음 종목으로 최대 2번 (2026-10-08, 사용자 결정)

장 시작 전 자동 리포트 3개(`AUTO_REPORT_TOP`)에서 활성화할 수 있는 추천이 하나도 나오지 않는 날이 있었다
(10/8: 삼성전자 0.93 · 한미반도체 0.60 · 산일전기 0.73 — 비용 반영 손익비, 기준 1.5).

- 그날 자동 종목 리포트가 **모두 끝났을 때** 그날 리포트의 추천 중 손익비(`Recommendation.reward_risk`, 리스크 엔진과 같은 계산)가
  스윙 최소 손익비(`judge/risk.py` `LIMITS["SWING"]`, 지금 1.5) **이상**인 것이 없으면 다시 시도한다. buy가 아니어서 추천이 없는 리포트, 실패한 리포트도 "없음"이다.
- **같은 종목이 아니라 다음 종목**으로 낸다: 이미 리포트한 종목과 선정 Guard가 뺀 종목을 빼고, 같은 선정 Guard(AI 선정안의 남은 순위 → 규칙 점수 순,
  투자유의·고위험 공시·같은 테마 검사)로 top개를 고른다. 선정 팀(LLM)은 다시 부르지 않는다.
  같은 종목을 다시 내면 손절가는 코드가 정하고(21장) 목표가는 AI가 저항선에 맞춰 거의 같게 낸다 (10/7 삼성전자 두 번 모두 진입 269,000·목표 287,000, 한미반도체 두 번 모두 목표 283,500).
- **최대 2번** (`reports/autoreport/auto.py` `RETRY_ROUNDS`). 다음 종목이 없거나, 그날(KST)이 지났으면 더 하지 않는다. 다시 시도가 실패해도 표지는 보낸다.
- 그날 선별 파일: `retries`(다시 시도한 횟수), 더한 종목은 `picks`에 `retryRound`(1|2)를 붙여 더한다 (`docs/API.md` ScreeningResult).
  팀 채널에 "자동 리포트 다시 시도 n/2: …" 한 줄, 표지는 마지막 회차가 끝난 뒤 한 번 ("리포트 9개 (다시 시도 2번)").
  화면(오늘의 선별 결과)은 더한 종목에 "다시 시도 n차" 꼬리표를 단다. `manage.py auto_report --wait`도 다시 시도한 리포트까지 돌린다.
- 최소 손익비를 AI 프롬프트에 넣지 않는 규칙은 그대로다 (다시 시도는 코드가 판단하고, AI에게 목표를 올리라고 하지 않는다).
- 비용: 다시 시도 한 번에 종목 리포트 top개(LLM 호출)가 더 든다. 자동 리포트는 신청자가 없어 팀원의 하루 리포트 한도에 세지 않는다.

## 23. 운영 E2E 점검 뒤 고칠 것: 오늘 산 종목 평가 · 시작할 수 없는 추천 표시 · 알림 합치기 · 토스 허용 분리 (2026-10-08, 사용자 결정)

근거: `docs/records/운영E2E점검_UX리뷰_2026-10-08.md` (운영 서버에서 초보 투자자 관점으로 끝까지 돌려 본 결과). 사용자가 권장안을 모두 골랐다.

- **오늘 산 종목은 체결가로 평가한다 (UX-1).** 계좌·보유·랭킹의 장마감 기준 평가(14-1)는 그대로 두되, 평가할 종가의 기준 시각 **뒤에 체결된 보유**는
  그 종가 대신 체결가로 평가한다(손익 0, `Position.priceBasis: "today_fill"`). 기준일이 오늘로 바뀌면(KR 15:40) 그날 종가로 평가된다.
  이유: 원가(오늘 실시간 체결가)와 평가(어제 종가)의 기준이 달라, 산 지 1분 만에 "+4.31%"가 보이고 바로 팔면 손해였다. 랭킹도 그 값으로 움직였다. `docs/API.md` "장마감 기준".
- **시작할 수 없는 추천을 목록에서 미리 보인다 (UX-2).** `Recommendation.blockedBy` — 계좌와 무관한 사유 코드(`reward_risk_low`·`ev_negative`·`expired`)를
  리스크 엔진과 같은 계산으로 낸다(중단 스위치 `halted`도). 화면은 시작할 수 있는 것을 먼저, 시작할 수 없는 것은 접어서 보인다. 최종 판단은 지금처럼 `RiskPreview`다.
  직전 종가가 이미 목표·손절을 지난 경우(`price_passed`)와 투자유의(`warning_stock`)는 시세 조회가 들어 목록에서는 보지 않는다 — 상세가 막는다.
- **알림을 합친다 (UX-9).** 활성화 요청 하나 안에서 이어진 계획 사건(시작 → 주문 접수 → 체결)은 마지막 상태 하나만 웹·Discord로 보낸다. 사건 기록은 다 남긴다.
- **토스 허용을 DEBUG와 떼어 낸다 (OPS-1).** 3-1의 예외 `ALLOW_TOSS_BROKER=on`. 운영은 `DJANGO_DEBUG=off`로 되돌리고(디버그 404가 URL 목록을 보였다),
  키움 키를 받기 전까지만 `ALLOW_TOSS_BROKER=on`·`BROKER=toss`를 둔다. 운영 `AUTOTRADE_DEMO=off`(D-4: 리포트가 돌면 연습용 예시는 끈다).
- **HTTPS는 하지 않는다 (OPS-2).** 운영은 HTTP(80)로 유지한다 (사용자 결정). 그래서 `SESSION_COOKIE_SECURE`·`CSRF_COOKIE_SECURE`·HSTS는 켜지 않는다
  — HTTP에서 켜면 로그인이 깨진다. 로그인 비밀번호·세션 쿠키가 평문으로 오가는 것은 알고 받아들인 위험이다 (팀 내부 모의투자 서비스).
- **쉬운 보기의 AI 글에서 전문 용어를 줄인다 (UX-4·UX-5).** 리포트 Worker의 쉬운 필드에 금지 용어를 프롬프트로 알리고 Guard가 검사한다.
  숫자 쉼표·의견의 영어 표기(hold 등) 치환·블로그 출처 제외는 결정론적 코드가 한다. 실모델 프롬프트 튜닝(T2-10)은 그대로 담당 2 몫이다.
  비용 상한: 용어 RETRY는 **첫 검토에서만** 한다(리포트당 작성·검토가 최대 1번씩 더). 두 번째 초안에도 용어가 남으면 실패시키지 않고 괄호 풀이를 붙여 통과한다.
  용어 문제는 검토 LLM의 '코드 점검 결과'에 넣지 않고 코드가 RETRY를 더한다(LLM 규칙과 부딪혀 FAIL이 나지 않게). '이탈'·'돌파'는 가격 문맥일 때만 용어로 본다.
- 같은 날 독립 리뷰(P0 0 · P1 1 · P2 12) 뒤 고친 것: 위 두 줄, 블로그·링크·연도 오탐, `blockedBy`에 `halted`, 장 시작 전 기한은 앞 거래일 장 마감으로, 첫 주문 대기(`active`) 토스트.
  고치지 않은 것: 미국 종목 today_fill은 원화 환산에 지금 환율을 써 환율 차이만큼 손익이 생긴다(운영은 지금 국내만), Webhook 없이 openclaw만 있는 환경의 알림 설정 문구, '15:40' 고정 표기(수능일·미국 조기 폐장일은 다르다).

## 24. Discord 알림을 끈다 (2026-10-08, 사용자 결정)

- **서비스가 Discord로 아무것도 보내지 않는다.** 웹 알림(알림함)은 그대로다. 끈 것: 계획·체결·청산·리포트 끝 알림의 Discord 글, 자동 리포트의 표지·PDF 글,
  엔진 CLI의 팀 채널 알림 (12-4의 Discord 쪽 전부).
- **방법: 코드 두 곳을 주석 처리했다** (설정 값을 지우지 않아도 꺼진다).
  - `engine/paper_engine/notify.py`의 `make_notifier` — Webhook·openclaw 분기를 주석 처리해 늘 `ConsoleNotifier`(콘솔 출력)를 돌려준다.
    모든 Discord 전송(`config.engine.notifier()` → 알림 발송 `dispatch.tick`, 자동 리포트 `reports/autoreport/auto.py`)이 이 함수를 거친다.
  - `backend/notifications/service.py`의 `webhook_configured` — 늘 false. 화면(My Page 알림 설정)은 Discord 묶음(받기 스위치·사용자 ID·테스트 알림)을 접고
    "지금은 웹 알림으로만 와요"를 보인다. 테스트 알림 API는 `discord: "not_configured"`.
- 끈 동안 생기는 Discord 글은 편지함(`notification_outbox`)에 `skipped`로 남고 엔진 콘솔에만 찍힌다 (보내지 않음). `DISCORD_WEBHOOK_URL`은 남겨 둬도 된다.
- **배포 파이프라인의 Discord 알림도 없앴다** (2026-10-08 사용자 결정 "디스코드 알림은 구현 안 함"): `deploy.yml`의 `notify` 작업을 지웠다.
  (처음에는 서비스 기능이 아니라며 남겨 두었지만, 저장소 비밀 값 `DISCORD_WEBHOOK_URL`을 넣은 적이 없어 늘 건너뛰기만 했다.)
  배포 결과는 Actions 실행 결과(실행한 사람에게 GitHub 기본 실패 알림)와 관리 서버의 배포 기록(`record` 작업 — success·rolled_back·rollback_failed·failed·blocked)으로 본다.
- **다시 켜려면**: 위 두 곳의 주석을 풀고 `return ConsoleNotifier()` / `return False` 줄을 지운다. 테스트 `engine/tests/test_notify.py`,
  `backend/notifications/tests/test_service.py`·`test_notifications_api.py`의 "disabled" 테스트를 예전 기대값(각 테스트 docstring에 적었다)으로 되돌린다.


## 25. 리포트·계획 제안 지우기와 가격이 지난 제안 자동 정리 (2026-10-08, 사용자 결정)

근거: 사용자가 "리포트 삭제 기능이 있어야 할 것 같다"며 예로 든 계획 제안(두산에너빌리티, AI 리포트)이 현재가가 이미 손절가보다 낮은데도 목록에 '시작할 수 있음'으로 남아 있었다
(23장의 `blockedBy`는 시세를 보지 않는다). 사용자가 권장안 셋(직접 지우기 + 자동 정리, 만든 사람만, 리포트와 제안 둘 다 숨김)을 골랐다. 계약은 `docs/API.md`
"리포트·계획 제안 지우기"·"가격이 지난 계획 제안 자동 정리", 구현은 `backend/autotrade/hide.py`·`sources.invalidate`.

- **직접 지우기는 만든 팀원만** 한다: 리포트는 신청한 팀원(끝난 `completed`·`failed`만), 계획 제안은 `requestedBy`인 팀원. 응답의 `canDelete`로 화면이 버튼을 보인다.
  자동 리포트·선정 실행·자동 추천은 만든 사람이 없어 아무도 지우지 않는다 — 아래 자동 정리와 기한이 내린다.
- **지우기는 숨김이다** (`deleted_at`): 목록·상세·PDF·SSE·추천 API에서 빠지고(`404`) 행은 남는다. 이유: 행을 지우면 비용 예산(`reports/limits/budget.py`)·하루 한도(`quota.py`)·
  복구 통계(`stats.py`)·관리 서버가 세는 행이 사라져, 지우고 다시 만들어 한도를 되돌려 받는 길이 생기고 통계가 바뀐다. 그래서 **지워도 한도는 돌아오지 않는다** (확인 문구에 적는다).
- **리포트와 그 제안은 같이 숨긴다** (어느 쪽을 지워도). 그 제안으로 **진행 중인 계획**(누구 것이든)이 있으면 지우지 않는다 — 다른 팀원이 산 이유를 지우지 않게.
  끝난 계획은 남고 계획 상세도 열린다. 지우기와 활성화는 추천 행을 잠그고 서로를 확인한다 (지운 뒤의 활성화는 `404`).
- **가격이 지난 제안 자동 정리**: 엔진 루프 "추천 수집"이 1분에 한 번 open 추천의 현재가를 한 번에 조회해, 손절가 이하면 `expired`·`expiredReason: "below_stop"`,
  목표가 이상이면 `"above_target"`으로 바꾼다. 다시 open으로 돌리지 않는다 (손절선을 깬 스윙 계획은 그 자체로 깨진 것으로 본다). 진행 중 계획은 자기 값으로 그대로 진행한다.
  23장과의 관계: 목록 요청의 `blockedBy`는 지금처럼 시세를 보지 않고(요청마다 시세 조회를 하지 않는다), 시세는 엔진이 1분에 한 번만 본다. 그 1분 사이에는 '시작할 수 있음'으로 보일 수 있지만
  상세의 안전장치(종가)와 활성화의 장중 확인이 지금처럼 막는다. 기한으로 끝난 추천은 `expiredReason: "deadline"`이다 (예전 행도 `deadline`으로 낸다).
- 고치지 않은 것: 추천이 생기는 순간 이미 가격이 지났으면 '계획 제안' 알림이 먼저 가고 1분 안에 정리된다(알림을 열면 끝난 제안으로 보인다 — 만들 때 막으면 리포트 끝 알림이 사라진다,
  `reports/output/alerts.py`). 관리 서버(`admin/`)는 지운 리포트도 그대로 보인다(`deleted_at` 열).

## 26. 리포트 시세는 만들 때 가격: 장 중이면 현재가 (2026-10-08, 사용자 결정)

근거: 사용자가 "조사 시 전일 종가를 가져오는 것 같다"고 했다. 운영 리포트 #44(엑스게이트, 10-08 15:23 KST 실행)의 조사 자료 요약 시세가
"종가 18,700원 · 10월 7일(수) 15:30 장마감 기준"이었고, 그때 가격은 17,990원(−3.8%)이었다. 그날 리포트 #26~#47이 모두 10-07 종가를 썼다.
17장에서 리포트를 장마감 기준으로 남겼기 때문이다 (기준일은 정규장 종료 + 10분에 바뀐다 — 14-1). 두 방법(① 판단은 종가로 두고 화면에 현재가를 같이 보이기,
② 시세 조사가 장 중에는 현재가를 쓰기) 중 사용자가 ②를 골랐다. 계약은 `docs/API.md` 공통 규칙 "리포트 시세".

- **언제**: 그 시장의 기준일 뒤 날짜의 정규장이 이미 시작됐을 때 (`trading.market.traded_since_basis`) — 정규장 중과, 끝났지만 기준일이 아직 바뀌기 전(KR 15:30~15:40).
  장 시작 전(자동 리포트 08:00 포함)·장 마감 뒤·휴장에는 지금처럼 직전 정규장 종가다.
- **리포트 시세 조사**(`market_agent`): `price` = 현재가, `priceBasis: "live"`, `asOf` = 받은 시각, `changePct` = 현재가 ÷ 직전 종가 − 1. 현재가를 받지 못하면 종가.
  지표는 완성 봉만(그대로). 손절 가격의 기준가 = `price` — 엔진 분석이 `lastPrice`(현재가)와 완성 봉으로 손절가를 정하는 것과 같아진다 (21장).
  작성 AI의 진입가 규칙("price에서 5% 안")과 검토 점검도 같은 `price`를 본다.
- **표기**: "장중 가격 17,990원 · 10월 8일(목) 15:23 기준" (웹 쉬운 보기·쉬운 PDF·자세한 PDF). 리포트는 나중에도 읽으므로 "실시간 · 시각"이 아니라 날짜를 넣는다.
- **미리 보기·활성화의 가격 점검**(`price_passed`)도 같은 때에는 장중 가격으로 본다 (미리 보기는 현재가, 활성화는 장중 확인 가격. 숫자 없는 정해진 문장).
  왜: 리포트의 손절·목표가가 장중 가격 기준인데 어제 종가와 비교하면, 오른 날에는 손절가가 어제 종가보다 높아 시작할 수 있는 제안이 "직전 종가가 이미 손절가 이하"로 막히고,
  내린 날에는 이미 지난 제안이 열려 보인다 (가격이 지난 제안 자동 정리는 이미 현재가를 본다 — 25장). 미리 보기의 수량·금액·자산·`lastPrice`는 그대로 장마감 기준이라
  "본 수량이 그대로 활성화 수량"(14-1 ①)은 지켜진다. 활성화는 전에는 종가 점검 + 정규장 중 장중 확인이었고, 이제 그때는 장중 확인만 한다.
- **그대로인 것**: `priceAtCreation`(만들 때의 직전 종가 — 화면 "추천 때 종가"), 재무 조사의 PER·PBR, 리포트 차트(완성 봉), 계좌 평가·랭킹, 분석(교차검증), 매매 종목 선정 팀.
- 알아 둘 것: 같은 종목 리포트도 만든 시각에 따라 가격·손절가가 다르다 (시각을 표기로 밝힌다). 장 중 리포트의 손절가는 오늘 장중 저가를 보지 않는다 (지표처럼 완성 봉만).
  예전 리포트(`priceBasis` 없음)는 종가로 읽어 표기가 바뀌지 않는다.

## 27. 로고: ㅁ 블록 셋의 계단 · 워드마크 · 앱 인트로, 로그인 부제 (2026-10-08, 사용자 결정)

ju 브랜치 `f2d42db`("인트로 로고 수정")가 15-7의 종이배 로고를 바꾸고 부제를 새로 썼다. 리뷰에서 이것이 미정이던 U24(새 이름에 로고·부제를 맞출지)를
정하는 일이고, 15-7의 그림 규칙("▲ 상승 기호로 읽히지 않게", "화살표·차트를 덧그리지 않는다")과 부딪힌다고 알렸다 — 새 로고는 오르는 계단이다.
사용자가 "로고 바꿀거야"라고 정해 main에 합쳤다. 이 장이 15-7의 로고·부제·로그인 첫 화면 줄을 대신한다.

- **로고(아이콘)**: brand 둥근 타일(viewBox 32, rx 8 = 25%) + 흰 ㅁ 블록 셋이 왼쪽 아래에서 오른쪽 위로 오르는 계단. 이름의 세 ㅁ(모·매·매)이 아이콘의 세 블록이 된다.
  ㅁ은 104 × 96 속이 빈 사각형(획 32, 아래 변만 살짝 기울임) 하나를 복사해 쓴다. **크기 단계**: 32px 이상은 속이 빈 ㅁ, 더 작으면 속이 찬 사각형(속 구멍이 1배율에서 뭉개져서).
  도형 값은 `frontend/src/lib/brandShapes.ts` 한 곳 (`MU_PATH`·`ICON_BLOCKS`·`ICON_BLOCK_SCALE`). 색은 토큰만 — 타일 `--color-brand`, 블록 `--color-on-brand`.
- **워드마크 "모매매"**: 굵은 직선 획 글자 SVG(viewBox 640 × 175), 세 ㅁ만 brand 색이고 나머지 획은 글자색(둘러싼 `text-*`). 장식이라 화면 읽기에서 숨기고 이름은 옆의 숨김 글자(sr-only)가 읽는다.
  가로 잠금 `BrandLockup`(PC 왼쪽 메뉴 32px · 모바일 홈 머리 28px · 부팅 뼈대): 마크 + 워드마크, 사이 = 마크의 1/4, 워드마크 높이 = 마크의 0.7배.
- **파비콘·홈 화면 아이콘**: `public/favicon.svg`는 16px 전용 모양(속이 찬 사각형 셋, 블록 사이 틈 0.8 — path·선 없음), `apple-touch-icon.png`(180px) 새 모양으로.
- **PDF 머리**: 로고만 새 아이콘(32px 이상 판 — 속이 빈 ㅁ)으로 바꾸고 이름은 그대로 글자다(PDF에서 검색·복사되게). 도형 값은 `brandShapes.ts`를 `backend/reports/output/pdf.py`에 옮겨 적었고,
  두 값이 같은지 `backend/reports/tests/output/test_pdf.py::test_logo_shapes_match_frontend`가 검사한다. 양식 판 `TEMPLATE_VERSION` 4 → 5 — 예전 판 PDF는 다음 요청 때 새 로고로 다시 만든다.
- **로그인 첫 화면**: 로고 56px(반복 모션) → 워드마크 높이 28px(제목 `h1` 안, 이름은 숨김 글자) → 부제 14px → 풀이 한 줄 → 3단계 칩.
  - 부제 `SERVICE_TAGLINE` **"여러 AI가 함께 검증하는 모의투자"** (전: "종이 위에서 연습하는 AI 리포트 모의투자"). 이 서비스의 핵심(여러 AI의 교차검증 + 모의투자)을 한 줄로.
  - 풀이 한 줄 `SERVICE_INTRO` **"AI들이 조사하고 서로 따져 본 리포트를 읽고, 가상 현금으로 매매를 연습해요."** — 아래 안심 줄('실제 주문은 나가지 않아요')과 같은 말을 되풀이하지 않는다.
  - 로고 반복 모션(`BrandMark loop`, `.brand-hop`): 세 블록이 계단을 오르는 순서로 한 칸씩 튀고 쉰다(4.2초 주기). 인트로가 도는 동안(`html[data-intro=playing]`)과 마우스를 올렸을 때는 멈추고, 움직임 줄이기에서는 가만히 있다.
- **앱 인트로** (`components/brand/BrandIntro.tsx`, `components/brand/IntroGate.tsx`, 움직임은 `index.css`의 `.intro-*`): 5초 — 워드마크 → ㅁ을 뺀 획이 옅어짐 → 세 ㅁ이 계단 자리로 모이며 작아짐 → 파란 타일이 깔리고 ㅁ이 흰색(아이콘) → 아이콘이 왼쪽으로 밀리고 이름이 옆에.
  끝나고 0.5초 머문 뒤 0.4초 동안 사라진다(덮개의 `animationend`에서 지움). 화면 전체를 덮으며 누르면 바로 끝난다.
  - **나오는 때**: 앱을 주소 `/` 또는 `/login`으로 열 때(새로 열기·새로고침)마다. 처음 그릴 때의 주소로만 정해 앱 안에서 화면을 옮길 때는 다시 나오지 않는다. 주소 끝 `?intro=1`이면 어느 화면에서든.
  - **건너뛰는 때**: 움직임 줄이기 설정, 디자인 검수 화면(`/ui/*`), 다른 화면 주소로 바로 연 경우(예: 알림 링크), 테스트(`MODE=test`).
  - 알아 둘 것 (리뷰에서 말함, 바꾸지 않고 합침): 로그인한 사용자에게 `/`는 홈이라 홈을 새로고침하거나 홈 화면 아이콘으로 열 때도 약 5.9초 인트로가 나온다. 키보드(Esc·Enter)로는 끝나지 않는다.
- **검수 화면** `/ui/brand` (`VITE_MOCK=1` 전용, 홈의 "발표·검수 도구" 카드에서): 인트로 다시 재생·전체 화면(발표 영상 녹화용)·크기별(16·24·32·48·96px)·가로 잠금.
- **로고 규칙(15-7을 대신함)**: 늘이기·돌리기·기울이기, 그림자·그라데이션을 하지 않는다. 블록 색을 바꾸지 않는다(워드마크의 ㅁ만 brand 색으로 강조). 고대비(forced-colors)에서도 브랜드 색을 지킨다.
  문구 규칙(배 은어·띄우다·접다·침몰·'배(倍)' 말장난을 쓰지 않음 — `lib/plainText.ts`)은 그대로 둔다.
- **바꾼 파일**: `frontend/src/lib/brandShapes.ts`(새), `components/brand/BrandMark.tsx`(`BrandMark`·`Wordmark`·`BrandLockup`), `components/brand/BrandIntro.tsx`·`IntroGate.tsx`(새), `pages/BrandPreviewPage.tsx`(새),
  `pages/LoginPage.tsx`, `App.tsx`, `index.css`, `lib/plainText.ts`, `public/favicon.svg`, `public/apple-touch-icon.png`, `index.html`, `components/home/DemoPreviewCard.tsx`, `backend/reports/output/pdf.py`(`LOGO_SVG`·`TEMPLATE_VERSION`)와 그 테스트.

## 28. 투자 금액은 사용자가 정한다 · 종목 화면 보유 평가는 실시간 (2026-10-11, 사용자 결정)

사용자가 "자동 매매 활성화 할 때, 프로그램이 투입 금액을 정하게 하지 말고 사용자가 내 자금의 몇 퍼센트 혹은 특정 액수를 정해서 투자할 수 있게",
"종목 정보 창에서 실시간 정보를 사용하도록"이라고 정했다. 계획의 결정 B1~B5(아래 괄호)는 모두 권장안으로 갔다.
12-3의 "수량은 `assess` 그대로 · 예산은 줄이기만"과 D-6의 "예산 입력으로 충분"을 이 장이 대신한다. 계약은 `docs/API.md` "AI 추천" 절("넣을 돈")과 "실행 불가 사유 코드" 표.

- **넣을 돈은 사용자가 정한다 (필수)**: 실행 확인에서 `내 자금의 %`(1~100 정수) 또는 `금액(원)` 중 하나를 꼭 정한다. 기본값은 없다 — 정하기 전에는 시작 버튼이 꺼진다.
  화면은 % 칩 10·25·50·100과 직접 입력을 준다.
- **% 기준 = 매수 가능 금액** (B1): 현금 − 대기 매수 금액(`buyingPowerKrw`). 그 순간 값에 곱해 원 단위로 내리고, 계획의 `budgetKrw`에 그 금액을 남긴다.
  총자산 기준이 아닌 까닭: 100%여도 현금을 넘지 않고, 가격 기준(종가·실시간)과 무관하다.
- **수량은 코드가 계산한다**: 금액 ÷ 1주 매수 비용(진입가 × (1 + 수수료) × 환율). 국내는 내림 정수 주, 미국은 금액을 센트로 내린 소수점 수량.
  진입가로 계산하므로 미리 보기 수량이 그대로 활성화 수량이다 (14-1 ①).
- **한도는 점검만 한다 — 넘으면 막는다** (B2): 매수 금액이 매수 가능 금액보다 크면 `cash_short`, 총 금액 한도(`MAX_TOTAL_INVEST_KRW`)를 넘으면 `total_limit`,
  1주(미국 $1) 미만이면 `budget_too_small`. 사용자가 정한 금액을 말없이 줄이지 않는다 (장기 매수 `assess_position`과 같은 방식 — 14-3).
  엔진에 `judge/risk.assess_budget`을 더했고 `assess`(엔진 CLI·엔진 자체 계좌)는 그대로다.
- **건당 위험 1%는 수량 제한에서 뺀다** (B3): 손절 시 손실이 총자산의 1%를 넘으면 `RiskPreview.largeLoss`로 경고 한 줄만 보인다 (막지 않는다).
  손실 금액은 지금처럼 실행 확인 체크("손절 시 약 ○원을 잃을 수 있어요")로 받는다. 손익비·기대값·매수 유의·일일 손실 한도·기한·같은 종목·중단 스위치·`price_passed` 점검은 그대로다.
- **재주문**: 같은 수량으로 다시 내고, 매수 가능 금액·총 금액 한도가 모자라면 그 안으로 줄이기만 한다. 건당 위험 한도로 다시 계산하지 않는다 (2026-10-11 전 계획도 같다).
- **기록**: `TradePlan.budgetMode`(`percent`|`amount`, 예전 계획은 null)·`budgetPercent`, `activated` 사건 details에 같은 값. 계획 화면이 "내 자금의 25% (○원)"처럼 보인다.
- **종목 화면 보유 평가는 실시간** (B5): 종목 상세의 보유 블록·"모의 보유" 한 줄의 평가 금액·손익·수익률을 시세(`Quote.price`, 5초)와 체결가·수량으로 **종목 통화로** 계산한다
  (계획 화면의 현재 손익과 같은 함수 `frontend/src/lib/holding.ts`). 오늘 산 종목도 실시간 숫자다. 시세를 받지 못하면 지금처럼 장마감 기준 `Position` 값.
  API는 바뀌지 않는다. 홈·마이·랭킹·`AccountSummary`는 그대로 장마감 기준이다 (14-1, 23장) — 그래서 같은 보유가 종목 화면(실시간)과 홈(장마감)에서 다를 수 있고, 화면 표기로 구분한다.
- **AGENTS.md 안전 규칙**: "수량·활성화 여부는 리스크 엔진" → "넣을 돈은 사용자가 정하고, 수량 계산·한도 점검·활성화 여부는 리스크 엔진".

## 29. 디렉터리 정리: 기능별 폴더 (2026-10-11, 사용자 결정)

사용자가 "문서뿐만 아니라 코드 디렉터리도 기능별(agents, orchestrator 등)로 나누어서 깔끔하게 정리"하라고 정했다.
파일 위치만 바꾸고 동작·함수 이름·Django 앱 이름·모델·마이그레이션은 그대로다 (관리 서버가 읽기 전용 DB 계정으로 표를 바로 읽는다).

- **옮긴 방식**: `git mv`로 옮기고 같은 커밋에서 import·경로 문자열을 모두 고쳤다. 옛 경로를 이어 주는 호환 모듈은 두지 않는다
  (호환 모듈이 있으면 테스트의 `monkeypatch`가 실제로 쓰이지 않는 모듈 객체를 고칠 수 있다). 앞 장들과 `docs/works/` 같은 지난 기록 속 경로도
  새 경로로 바꿨다 — 경로는 찾아가는 링크이고 옛 모습은 git 이력에 남는다.
- **문서**: 기준 문서(`API.md`·`DECISIONS.md`·`DEPLOY.md`·`KIWOOM.md`·`결정필요사항.md`·`교육용문서.md`)만 `docs/` 바로 아래에 두고,
  나머지는 `guides/`(설치)·`plans/`(계획서)·`design/`(설계)·`records/`(시험 기록)·`evaluation/`(평가 기준·기여)로 나눴다.
  저장소 루트의 계획·안내 5개(`SETUP_PROMPT.md`·`WSL2_SETUP.md`·`TEAM_DEV_PLAN.md`·`OPS_ADMIN_PLAN.md`·`DEPLOY_SPLIT_PLAN.md`)도 옮겨
  루트에는 `README.md`·`AGENTS.md`만 남는다. 문서 지도는 `docs/README.md`. `교육용문서.md`는 앱 빌드가 그 자리를 가정해서
  (`?raw` import, nginx 이미지의 NFC 이름 정리, `.dockerignore`의 `!docs/*.md`) 옮기지 않는다.
- **`backend/reports`**: 앱 루트에는 Django가 정한 자리(`models.py`·`migrations/`·`admin.py`·`apps.py`·`urls.py`·`views.py`·`sse.py`·`payloads.py`·`management/`)만 남기고
  기능 코드를 폴더 6개로 나눴다 — `orchestration/`(orchestrator·runner·registry·state와 YAML 두 개. registry가 YAML을 자기 폴더에서 찾는다),
  `guardrails/`(guards·contracts·tidy), `autohealing/`(healing·chaos·stats), `autoreport/`(auto·selection·conf), `output/`(pdf·easy_text·alerts·text), `limits/`(quota·budget).
  `agents/`는 팀별 폴더 `report_team/`·`selection_team/`으로 나누고, 팀 폴더와 이름이 겹치는 등록 파일 둘만 `team.py`로 이름을 바꿨다
  (`agents/report_team.py` → `agents/report_team/team.py`). Orchestrator는 그대로 `agents.WORKERS`만 본다.
  테스트도 같은 폴더로 나눴다 (`tests/<폴더>/`. 여러 폴더에 걸친 API·SSE·필드 테스트와 `conftest.py`는 `tests/` 바로 아래).
  같은 앱 안은 상대 import, 다른 앱에서는 절대 import(`from reports.autohealing import healing`)를 쓴다. import 경로를 문자열로 적은 곳
  (`orchestrator.TEAM_INPUTS`, `auto_report` 명령, 테스트의 `sys.modules`)과 관리 서버 CI의 경로 조건(`backend/reports/autohealing/stats.py`)도 바꿨다.
- **`backend/autotrade`**: 루트에는 Django 자리와 앱 공통 모듈(`conf.py`·`text.py`·`tokens.py`·`hide.py`)만 두고, 추천 만들기는 `recommend/`(sources·demo·auto),
  계획 진행은 `plans/`(risk·executor)로 옮겼다. 테스트는 9개라 나누지 않는다. `backend/tests/test_pages.py`(`/`·`/api/health`)는 `backend/config/tests/`로 옮겼다.
- **`frontend/src`**: `src` 바로 아래의 화면 단위 테스트 27개와 `setupTests.ts`를 `src/test/`(`setup.ts`, 도우미 `render.tsx`·`time.ts`와 같은 곳)로 옮겼다.
  한 파일만 보는 단위 테스트(`lib/*.test.ts` 등)는 그 파일 옆에 둔다. 기능 전용 부품은 `components/` 루트에서 기능 폴더로 옮겼다 —
  `analysis/`(AnalysisCard·AnalysisRequest), `stock/`(OrderPanel), `charts/`(CandleChart·LineChart), `brand/`(BrandMark·BrandIntro·IntroGate), 그리고 `lib/useDebounced.ts` → `hooks/`.
  `components/` 루트에는 여러 화면이 같이 쓰는 부품(`ui.tsx`·`Icon.tsx`·`Layout.tsx`·`Term.tsx`·`toast.ts`·`ToastProvider.tsx`·`RequireAuth.tsx`·`DeleteAction.tsx`·`AssetCard.tsx`)만 남는다.
  `tsc`가 못 잡는 문자열 경로(`vi.mock`·`importOriginal`, `colors.test.ts`·`foundation.test.tsx`의 `import.meta.glob`, `?raw`, 동적 `import()`)도 고쳤다.
- **옮기지 않은 것**: 엔진(`engine/paper_engine`)은 이미 기능 폴더(`agents/`·`data/`·`judge/`·`records/`·`longterm/`)로 나뉘어 있고 안전 규칙·CI가 경로를 박아 둔다
  (`data/toss.py`만 토스 주소 허용, 손절은 `judge/stops.py`). 나머지 백엔드 앱(`accounts`·`trading`·`analysis`·`longterm`·`notifications`)은 기능 모듈이 몇 개뿐이라 그대로다.
  프론트 `lib/`·`pages/`도 그대로다 — 백엔드 테스트가 `lib/plainText.ts`·`lib/reports.ts`·`lib/glossary.ts`·`lib/brandShapes.ts`와 `components/plan/PlanCard.tsx`·`components/reports/easy/`를
  경로로 읽어 문장이 같은지 보고, 화면 파일은 라우터와 1:1이라 평평한 쪽이 찾기 쉽다.

## 30. 선정 팀 검토가 끝나게: 마지막 검토는 코드가 판정 · 좁힌 검토 기준 · 이전 검토 전달 · 선정 자료의 가격 가림 (2026-10-12, 사용자 요청)

사용자가 "선정팀 실패 원인 알아보고 고쳐"라고 했다. 매매 종목 선정 팀(19장)이 자주 `review_failed`로 끝나 자동 리포트가 규칙 점수 순(Fallback)으로 종목을 골랐다.
`backend/reports`만 바꿨다 — 마이그레이션·설정 키·YAML(`select_review` maxRounds 2 그대로)·화면·관리 서버는 그대로다. Trace 계약은 `docs/API.md` "AI 리포트" 절 Trace 타입 주석.

- **원인** (기록된 선정 실행 3회 — 로컬 #5·운영 #8 실패, 운영 #14 성공 — 의 Trace와 같은 입력의 재현으로 확인):
  - 선정 검토 규칙이 "고칠 것이 하나라도 있으면 RETRY"였고, Orchestrator는 점수가 아니라 verdict만 본다 (같은 88점이 한 번은 PASS, 한 번은 RETRY였다).
    세 번째 RETRY면 종목·순위에 문제가 없어도 AI 선정안 전체를 버리고 규칙 점수 순으로 돌아갔다 (#5: AI가 악재로 일부러 뺀 종목이 Fallback으로 들어왔다).
  - 지적 20개가 모두 reason·evidence·summary 글에 관한 것이었다 — 출처 누락 6, 우려·수급 기간 생략 5, summary 불일치 4, 기대를 확정으로 쓴 과장 2, 뉴스 제목에서 옮긴 가격·목표가 3.
    후보 밖 종목·고위험 공시·테마·순위 지적은 0개였고, 두 실패의 마지막 선정안도 코드 점검을 통과했다.
  - 같은 검토 루프를 쓰는 종목 리포트 팀은 운영에서 검토까지 간 56회 중 51회 완료(다시 쓴 뒤 둘째 검토 PASS 31/44, 셋째 8/13)인데 선정 팀은 1/3, 0/2였다. 차이는 선정 팀에만 있던 것들이다:
    ① 작성 규칙에 검토 기준(기대·전망을 확정으로 쓰지 않기, 수급 방향, summary 일반화 금지)과 "지시받지 않은 곳은 그대로"가 없었다 (종목 리포트 작성은 3616e02에서 고쳤다).
    ② 다시 하는 검토가 자기 이전 지적을 몰라 매번 새 기준을 냈다 (#5: 1회차가 "그대로 두라"고 한 종목을 3회차가 "다른 종목은 우려를 적었다"며 지적).
    ③ 선정안 evidence는 계약상 종목마다 3개에서 조용히 잘리는데, 검토는 그것을 모르고 "근거 추가"를 되풀이했다.
    ④ 뉴스 제목의 "목표가 360,000원"이 evidence로 옮겨졌는데 코드 점검은 evidence를 보지 않았다 — 운영 #8은 이 지적 하나로 실패했다.
    ⑤ 가격 정규식이 가격 아닌 숫자를 가격으로 봤다 — 같은 입력을 지금 코드로 다시 돌린 재현에서 운영 #8 입력 3회 중 1회가 선정 Worker가 쓴 "수주가 3.9조"("주가 3…"으로 읽음)
      코드 점검 하나로 실패했다 (검토 점수 88·92·92).
- **바꾼 규칙**:
  1. **마지막 검토는 코드가 판정한다**: 선정 검토의 마지막 검토(시도 수 > `maxRounds`, 지금 3번째)가 RETRY여도 코드 점검(후보 표 밖 종목·공시 위험 high·권유 표현·가격·목표가)에
     걸리는 것이 없으면 PASS + `acceptedWithNotes: true`로 바꾼다. 남은 지적은 State·Trace(`agent_completed.details.acceptedWithNotes`)·선정 실행 본문의 "검토 메모"에 남는다.
     FAIL이거나 코드 점검 문제가 남으면 지금처럼 `review_failed` → 규칙 Fallback이다. 점수는 쓰지 않는다. 이 키는 코드만 붙인다 (LLM이 보내도 선정·종목 리포트 검토가 지운다).
  2. **RETRY 기준을 좁혔다**: 사실이 조사 결과에 없음·반대 해석·기대를 확정으로 쓴 과장·다른 종목 재료·summary 불일치·가격·권유일 때만 RETRY다.
     출처가 evidence에 없는 것, 우려·수급 기간 일부만 쓴 것, 종목마다 문체가 다른 것은 PASS다. evidence 3개 상한을 검토 규칙에 적었다.
  3. **다시 하는 검토에 직전 지적과 "이번에 바뀐 부분"을 준다** (`WorkerContext.retry` = {round, review, draft}, 바뀐 부분은 코드가 이전 선정안과 비교한다).
     이전 지적이 고쳐졌는지부터 보고, 바뀌지 않은 곳은 다시 문제 삼지 않는다. 종목 리포트 Worker의 입력·프롬프트는 바뀌지 않는다 (테스트로 고정).
  4. **선정 작성 규칙을 검토 기준에 맞추고 다시 쓸 때 앞머리(RETRY_PREFIX)를 둔다**: 지시받지 않은 종목의 순위·reason·evidence는 글자 그대로 둔다 (3616e02와 같은 처방).
  5. **가격**: 선정·선정 검토 프롬프트에 넣는 조사 결과 사본의 가격을 "(가격)"으로 가린다 (State에 저장된 원문은 그대로). evidence에서 가격·목표가·"(가격)"이 든 항목은
     선정 Worker 코드가 지운다. reason·summary는 코드 점검이 막는다 (숫자 없는 "목표가 상향"·"(가격)" 포함). 가격 정규식이 등락률·기간·날짜·순위("주가 3.18% 하락", "순매수가 5일째", "주가 10월 들어")와
     금액·개수("수주가 3.9조", "순매수가 120만주", "주주가 3명", "3억5000만원")를 가격으로 잘못 보던 것을 고쳤다 — "주가"·"매수가"·"매도가" 앞에 한글이 붙은 낱말
     (수주가·대주주가·순매수가·공매도가)은 가격 낱말이 아니고, 회사 목표("수주·매출·판매·생산 목표가", "목표가 아니다")는 목표가 낱말이 아니다.
     단위 없는 가격("20만 돌파")은 잡지 않는다 — 가입자·판매 수와 글이 같아, 잡으면 마지막 검토를 막는 오탐이 된다 (가격은 뒤의 종목 리포트가 정하고 evidence는 화면에 없다). 계약 상한 200자에서 잘린 reason은 마지막으로 끝난 문장까지 줄인다.
  6. **관측**: 선정 Worker가 다시 쓴 곳 `agent_completed.details.changed`, `review_failed`의 남은 지적 `workflow_failed.details.message`.
- **종목 리포트 팀에는 마지막 검토 판정을 넣지 않았다**: 진입·목표·손절 가격이 AI 추천과 리스크 엔진으로 이어지는 관문이고, 이미 91% 수렴하며, 작성 쪽 보존 규칙이 이미 있다.
- **남는 실패**: FAIL, 마지막 검토까지 남은 코드 점검 문제, Worker 실패·시간 초과 — 이때는 규칙 Fallback이 맞는 결과다.
- **받아들인 위험**: 검토가 문제 삼은 글이 그대로 선정 이유(aiReason)로 보일 수 있다 (완화: Trace·본문 "검토 메모", 선정 Guard는 그대로). 후속 후보: 지적된 aiReason 감추기,
  화면 진행 문장에 acceptedWithNotes 표시, 종목 리포트 검토에도 이전 지적 전달.
- **검증** (2026-10-12): 단위·종단 테스트(가짜 LLM), 저장된 출력을 그대로 되돌리는 비용 0 재현(바꾸기 전 코드는 #5·#8을 `review_failed`로 재현하고 바꾼 코드는 둘 다 완료),
  같은 조사 결과로 선정·선정 검토만 실제 LLM으로 돌린 재현(#5·#8·#14 입력): 바꾸기 전 9회 중 완료 8회·첫 검토 PASS 3회(검토 횟수 중앙값 2, 1회 비용 중앙값 약 $0.15) →
  바꾼 뒤 14회 모두 완료·첫 검토 PASS 10회(중앙값 1, 약 $0.07), evidence 속 가격 0건, 14회 모두 AI 선정. 남은 지적을 기록하고 통과한 경우(acceptedWithNotes)는 실제 LLM 14회에서는 나오지 않았다.
- **되돌리기**: 커밋 revert만 하면 된다 (마이그레이션·설정·YAML 변경 없음).

## 31. 시연용 수동 시작: 손익비·기대값 점검만 건너뛴다 (2026-10-12, 사용자 결정)

사용자가 "손익비가 안나오는 계획도 '매매 계획' 컴포넌트에 수동매매 버튼을 추가해서 수동으로 계획을 시작할 수 있는 시연용 기능 만들어 (시연용이라고 명시해)"라고 정했다.
자동 리포트의 계획 대부분이 손익비 기준(스윙 1.5)에 못 미쳐 발표에서 모의 자동매매를 시작해 보일 수 없었다. 계약은 `docs/API.md` "AI 추천" 절 규칙 "시연용 수동 시작".

- **진입점**: 매매 계획 카드(쉬운 보기 리포트)와 실행 확인의 막힌 화면에 "수동매매 (시연용)" → `/recommendations/{id}?manual=1`.
  보이는 조건은 금액 없는 미리 보기(내 계좌까지 본 결과)가 `reward_risk_low`·`ev_negative`**로만** 막았을 때다. 다른 사유가 하나라도 섞이면 보이지 않는다.
- **넣을 돈과 확인은 그대로**: 넣을 돈은 사용자가 정하고(28장 — 기본값 없음), 확인 체크에 넷째 "안전장치의 손익비·기대 수익 점검을 통과하지 못한 계획을 시연용으로 직접 시작해요."를 더한다.
  시작 버튼은 경고색 "모의 수동매매 시작 (시연용)"(전문가 보기 "수동매매 활성화 (시연용)")이다 — 들어가는 버튼은 사용자 말 그대로 "수동매매 (시연용)",
  쉬운 보기의 시작 버튼에는 실제 매매로 읽히지 않게 "모의"를 넣는다. 이 기능이 보이는 모든 자리에 "시연용"을 쓴다.
- **건너뛰는 것은 둘뿐이다**: `reward_risk_low`(비용 반영 손익비 < 최소 기준)·`ev_negative`(비용 반영 기대값 ≤ 0). 추천의 가격·확률과 수수료만으로 정해지는 계획 품질 판단이라
  (23장 `ACCOUNT_FREE`·`blockedBy`와 같은 계산) 계좌·시장 상태와 무관하고, 사람이 덮어써도 모의 계좌 정합성과 계획 실행기 상태가 깨지지 않는다.
  그대로인 점검: 넣을 돈·수량 계산, 매수 유의·일일 손실·일일 거래 한도, `budget_too_small`·`cash_short`·`total_limit`, `expired`, `plan_exists`·`position_exists`, `halted`,
  `price_passed`(활성화의 장중 확인 포함), 주문 접수 때 엔진 모의 체결기의 점검. 재주문도 같은 둘만 건너뛴다.
- **엔진은 그대로다**: `engine/paper_engine/judge/risk.py`에 건너뛰기 모드를 두지 않는다 (엔진 테스트의 "우회 모드 없음"). 웹의 활성화 판단(`backend/autotrade/plans/risk.py`
  `MANUAL_SKIP_CODES`)이 사유를 `reasons`에서 `skippedReasons`로 옮길 뿐이고, `approved`는 엔진의 원래 판정(false)을 그대로 남긴다.
- **기록**: `TradePlan.manual_start`(`db_default` False, 활성화 때 한 번 쓰고 바꾸지 않는다), `activated`·`risk_checked` 사건 details·message, 이 계획의 모든 알림 제목 앞
  `[시연용 수동 시작]`, 계획·목록·홈의 배지 "시연용 수동 시작", Django 관리 화면의 필터.
- **설정 키를 두지 않았다**: 운영 `.env.docker`가 2026-10-08부터 `AUTOTRADE_DEMO=off`라 그것으로 막으면 시연에서 `403`이 난다. 발표 뒤 끌지·지울지는 `docs/결정필요사항.md` U27.
- **이름**: 원본의 실주문 리스크 우회 플래그와 헷갈리지 않게 "bypass" 대신 `manual_start`·`skipped`를 쓴다.
- **AGENTS.md 안전 규칙**("AI는 제안만 한다")에 이 예외를 한 문장 더했다.
- **같이 고친 것**: 실행 확인의 확인 체크는 화면이 "시작할 수 없음"으로 바뀌면(뒤로 가기, 중단 스위치 등) 지운다 — 전에는 체크 칸은 비었는데 시작 버튼이 켜진 채 남을 수 있었다 (일반 시작도 같다).
