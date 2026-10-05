# 팀 프로젝트 전환 계획: 키움 REST API 기반 모의매매 웹 서비스

작성 2026-10-01. 이 파일은 계획만 담는다. 실제 작업은 새 디렉터리에서 한다.

목차
1. 배경과 목표
2. 현재 프로젝트(`toss_trading`)에 구현된 기능
3. 전환하면서 바꾸는 것 (증권사 API, 실주문 삭제, 알림)
4. 팀 프로젝트로 새로 추가하는 것 (웹 화면, Django 백엔드, PostgreSQL, Redis, AWS EC2, CI/CD)
5. 확정된 결정과 정해야 할 항목
6. 작업 순서
7. 검증
8. 준비할 것

---

## 1. 배경과 목표

`toss_trading`은 토스증권 Open API로 **실제 주문까지 내는 개인용 스윙 매매 자동화 프로그램**이다.
이것을 팀 토이 프로젝트로 쓰기 위해 **새 디렉터리에 복제**하고 다음과 같이 바꾼다.

| 항목 | 지금 | 바꾼 뒤 |
|---|---|---|
| 증권사 API | 토스증권 Open API | **키움 REST API** (시세·일봉·순위 조회만. 계좌는 비어 있고 쓰지 않는다) |
| 주문 | 실주문 | **전부 삭제.** 가상 현금 계좌에서 체결을 흉내 내는 모의매매 |
| 사용자 | 나 한 명 | **팀원 여러 명** (팀원별 로그인 계정) |
| 조작 화면 | Discord `/toss` 명령, CLI | **웹 화면** (React + TypeScript) |
| 서버 | 이 PC, 표준 라이브러리 HTTP 클라이언트 | **Django 백엔드** + 기존 엔진 |
| DB | SQLite 파일 | **EC2 운영은 PostgreSQL, 로컬 개발 환경은 SQLite** (같은 Django 모델·마이그레이션) |
| Redis | 이 PC의 컨테이너 | EC2의 컨테이너 |
| 알림 | openclaw Discord 봇, 내 DM | **openclaw 유지**, 팀 채널로 **알림만** (명령은 웹) |
| 실행 환경 | 이 PC (systemd) | **AWS EC2 + Docker Compose** |
| 배포 | 수동 | **GitHub Actions** (검사 → 이미지 빌드 → EC2 자동 배포) |
| AI 분석 | DevPass LLM Gateway | **그대로 유지** |
| 통계·기록 | 예측 기록, 시장 기록, 일일 리포트, 백업 | **그대로 유지** (저장소만 Django DB로: EC2는 PostgreSQL, 로컬은 SQLite) |

운영 중인 `toss_trading`(이 PC의 systemd `toss-trading`, Redis `toss:*`, `~/.openclaw/`)에는 영향을 주지 않는다.

---

## 2. 현재 프로젝트(`toss_trading`)에 구현된 기능

스윙 매매(보유 3~20거래일) 대상 종목을 **규칙으로 고르고 → 여러 AI가 교차검증하고 → 코드가 금액·한도를 정해 → 사용자 확인 후 실제 주문**하며,
모든 예측과 결과를 기록해 어떤 모델·규칙이 맞는지 추적하는 시스템이다.

원칙: **AI는 제안만 한다.** 지표 계산, 사실 확인, 수량·한도·주문 가능 여부는 모두 결정론적 코드가 판단한다.

### 2-1. 데이터 수집 (`data/`)

| 자료 | 출처 | 파일 |
|---|---|---|
| 현재가, 호가, 일봉(최대 200일), 종목 정보, 매수 유의사항, 투자자별 매매동향(국내), 거래대금·등락률 순위, 환율, 장 운영 시간 | 토스증권 Open API | `data/toss.py` (토큰 파일 캐시, 429 재시도, gzip 처리) |
| 국내 재무(매출·영업이익·순이익·EPS·ROE·부채비율 등)와 공시 제목 | DART | `data/dart.py` |
| 국내 최근 5년 연간 실적 추이 | 공공데이터포털 금융위원회 기업 재무정보 | `data/fina_stat.py` |
| 미국 재무와 공시 | SEC EDGAR | `data/sec.py` |
| 뉴스 제목 (최근 7일 15개) | Google News RSS | `data/news.py` |
| 증권사 리포트 헤드라인 (증권사·목표가·상향/하향) | Google News RSS 제목 정규식 | `data/broker_reports.py` |
| 기술 지표 (이동평균, RSI, ATR, 변화율) | 코드 계산 | `data/indicators.py` |
| 호가 단위 | 코드 (국내 가격대별 표, 미국 0.01) | `data/ticks.py` |

이 자료를 종목당 하나의 **스냅샷**(`data/snapshot.py`)으로 묶는다. PER·PBR·TTM 등 API에 없는 값은 코드가 계산한다.

### 2-2. 종목 선별 (`judge/screen.py`, CLI `scan`)

1. 전일 거래대금 상위 100종목(투자 유의 제외)에서 ETF·ETN·레버리지·거래정지 종목을 뺀다.
2. 일봉으로 규칙 점수를 매긴다: 60일선 위, RSI 40~75, ATR 비율 1.5~8% 조건을 통과한 종목에
   추세(20일선·60일선)·20일 모멘텀·RSI·변동성 점수(각 20점, 100점 만점).
3. 선택하면 최근 2일 증권사 리포트 헤드라인의 종목도 후보에 넣는다 (종목명이 정확히 하나로 맞는 것만).
4. 보유 종목, 진행 중 자동 관리 종목, 최근 24시간 안에 분석한 종목은 AI 분석 대상에서 빼고 다음 순위로 채운다.

### 2-3. AI 교차검증 분석 (`pipeline.py`, `agents/`, `judge/`, CLI `analyze`)

```
데이터 수집 → 웹 조사 → 시나리오 제안 → 사실 검증 → 상호 채점 → 판정 → 최종 승인 → (사용자 확인) → 주문
   코드        AI 조사자   AI 분석가      코드       AI 분석가    코드    AI 승인자
```

- **웹 조사** (`agents/researcher.py`): 여러 모델이 웹 검색으로 최근 실적·사건·목표주가·일정을 모은다.
  코드가 링크 제거, 미래 날짜 제거, 출처 확인(`sourceVerified`)을 한다. 비용의 대부분(종목당 약 $0.2).
- **시나리오 제안** (`agents/proposer.py`): 분석가 모델들이 서로를 보지 않고 각자 시나리오 1개(진입가·목표가·손절가·보유 기간·근거)를 낸다.
  제안하지 않아도 된다.
- **사실·조건 검증** (`judge/fact_check.py`): 근거로 든 숫자가 원본과 0.5% 안에서 맞는지, 인용 문장이 원문 그대로인지,
  진입가가 현재가에서 5% 안인지, 보유 기간이 3~20거래일인지 확인. 틀리면 탈락.
- **목표가 도달 가능성** (`judge/reach.py`): 목표까지 거리 ÷ (ATR × √보유일수). 표시용.
- **상호 채점** (`agents/critic.py`): 각 분석가가 자기 것을 뺀 시나리오를 0~100점과 확률로 채점. 제안자는 가린다.
- **판정** (`judge/verdict.py`): 모델 크기별 가중 평균 점수 60점 이상 + 참여 의결권 60% 이상 + 리스크 엔진 통과.
- **최종 승인** (`agents/approver.py`): 통과한 시나리오만 승인 모델이 승인/거부.
- 모델 시간 초과 처리: 시간 초과 모델은 이후 단계에서 빼고 의결권을 다시 나눈다. 핵심 모델이 시간 초과면 그 종목은 오류로 중단.
- 최대 4종목 동시 분석. 단계별 시간·비용 기록. 종목당 약 $0.3.
- 결과: `runs/*.json` 실행 기록과 PDF 리포트(`report.py`, HTML → Chrome으로 PDF).
  알림에는 매수 추천과 한 줄 요약만, 나머지(모든 시나리오 카드, 모델별 점수·약점, 웹 조사, 비용)는 PDF로 첨부.

### 2-4. 리스크 엔진 (`judge/risk.py`)

- 기대값 = 확률 × 예상 수익 − (1−확률) × 예상 손실 − 비용. 0 이하면 탈락.
- 최소 손익비 2.0 (AI에게는 알리지 않는다).
- 수량 = (자산 × 건당 위험 1%) ÷ (진입가 − 손절 주문가). 총 투자 한도(`MAX_TOTAL_INVEST_KRW`), 매수 가능 금액, 유동성으로 상한.
- 미국 종목 소수점 매수(금액 방식) 지원. 매수 유의 종목, 일일 손실 한도, 1주 미만은 탈락.

### 2-5. 실주문 실행 (`agents/executor.py`, `data/orders.py`)

- 이중 안전장치: `.env`의 `LIVE_TRADING=on` **그리고** `--live` 옵션이 있어야 실주문.
- 실행 직전 점검: 중단 스위치, 분석 후 30분 이내, 현재가 2% 이내, 1억 원 상한, 같은 종목 중복 금지.
- 사용자가 Discord에 **종목코드를 직접 입력**해야 주문이 나간다.
- **자동 관리 주문**: 지정가 매수 → 체결되면 토스 OCO 조건주문(목표가 매도 / 손절 매도)을 걸고 → 기한이 지나면 시장가 매도.
  손절 지정가가 안 채워지면 시장가로 바꾼다. 미국 소수점은 프로그램이 가격을 감시해 청산.
- `sync`가 주문 상태를 확인하고 다음 단계로 진행 (장 시작 전후 2분 10초, 장중 1분, 그 외 5분 간격).
- `orders`(목록), `halt`/`resume`(새 주문 중단 스위치).

### 2-6. 사용자 명령 (Discord `/toss`, `commands.py`)

- 조회: `보유`(평가 손익과 자동 관리 주문의 목표·손절·기한·예상 손익), `주문`, `미체결`, `예약`, `전략`
- 매매: `<종목> <N>주 매수|매도 [지정가 P] [목표 P 손절 P 기한 N일]`, `<미국종목> <금액>달러 매수`, `전량매도`
- 관리: `취소 N`, `주문 N 목표 P 손절 P`(목표·손절 수정), `예약취소 N`
- 정규장 밖 시장가 명령은 "예약 / 지정가" 중 고르게 묻는다. 끝에 `예약`을 붙이면 다음 정규장 시작 때 실행.
- 리포트: `리포트 [N일] [분석]`
- 전략: `전략생성 <이름> 시장= 실행= 후보= 분석= 한도= 소수점= 리포트=`, `전략활성|전략중지|전략실행 N` 등

### 2-7. 전략 자동 실행 (`strategies.py`, `scheduler.py`)

- 전략 = 시장, 후보 수, AI 분석 수, 실행 방식(알림만 / 컨펌 후 주문), 종목당 한도, 소수점, 리포트 후보 여부.
- 활성 전략마다 매일 정규장 1시간 전(국내 08:00, 미국 21:30/22:30)에 선별 → AI 분석 → (컨펌 전략이면) 주문 흐름.
- 휴장일에는 돌지 않고, 하루 한 번만 돈다 (Redis에 기록). 선별 결과는 Redis에 30일 보관.

### 2-8. 기록과 통계 (`records/`, CLI `track`, `stats`)

- SQLite `data/trading.db`:
  - `trades`: 사실 검증을 통과한 **모든 시나리오** (선정 여부와 무관). 탈락시킨 판단이 옳았는지도 보기 위해서다.
  - `predictions`: 모델별 확률·점수 예측.
  - `live_orders`, `manual_orders`: 실주문과 그 결과.
  - `market_days`, `rankings`: 시장 기록.
- **예측 추적** (`records/paper.py`, `track`): 완성된 일봉으로 각 시나리오의 체결·목표 도달·손절·만료를 판정 (애매하면 불리한 쪽).
- **통계** (`stats`): 선정/탈락별 손익, 모델별 확률 예측 성적(Brier 점수), AI 확률 대 실제 도달률.
- **시장 기록** (`records/market_log.py`, `record`): 장 마감 후 거래대금 상위 100, 등락률 상·하위 30, 벤치마크(KR 069500, US SPY), 환율.
  과거 시점 순위는 API로 받을 수 없어서 백테스트 편향을 없애려고 매일 쌓는다.

### 2-9. 일일 리포트 (`daily.py`, `report.py`, CLI `daily-report`)

- 매일 07시 PDF: 계좌 요약, 진행 중 자동 관리 주문, 종료 주문, 누적 성적, 시장 동향(벤치마크 10일, 순위 상위 10),
  기록(전략, 분석 실행, 예약, 예측 성적, 백업 상태).
- **일일 AI 분석**: 보유 종목 + 자동 관리 종목 + 시장별 거래대금 상위 3개(최대 20종목)를 재분석해 리포트에 넣는다 (하루 약 $5).
  같은 날 분석이 있으면 재사용, 24시간 안에 분석한 종목은 건너뜀.

### 2-10. 상시 실행과 운영 (`__main__.py serve`)

- 한 프로세스가 주문 상태 확인, 장 마감 후 시장 기록과 예측 추적, 07시 리포트, 예약 주문 실행, 전략 실행, Discord 명령 처리를 맡는다.
- 백업: 매일 SQLite 사본 + Redis 키 JSON 내보내기, 14일 보관.
- openclaw 연동: 알림·PDF 전송은 `openclaw message send`, 명령과 확인 답장은 openclaw 플러그인이 파일로 넘겨준다.
  openclaw AI 에이전트에는 조회 도구와 "주문 제안" 도구만 준다 (실제 주문은 항상 사용자 입력 필요).

### 2-11. 백테스트 (`backtest/`)

- AI 없이 선별 → 리스크 엔진 → 매매 규칙을 과거 일봉으로 재현. 규칙 변형 실험(`backtest/experiments/`)과 결론 문서.

### 2-12. 테스트

- `tests/`에 모듈별 단위 테스트 (가짜 API 객체, 가짜 주문 객체, 가짜 알림). 실제 API·실주문 없이 돈다. `uv run pytest`.

---

## 3. 전환하면서 바꾸는 것

### 3-1. 증권사 API: 토스 → 키움 REST API

원칙: **엔진 내부에서 쓰는 데이터 형식은 지금 것을 유지**한다 (일봉 `openPrice/highPrice/lowPrice/closePrice/volume/timestamp`,
순위 `rank/symbol/tradingAmount/price.lastPrice/price.changeRate`, 종목 `securityType/status/...`).
키움 응답을 이 형식으로 바꾸는 일은 새 클라이언트 안에서만 한다. 그러면 선별·백테스트·스냅샷 코드를 그대로 쓸 수 있다.

- 새 `data/kiwoom.py` `KiwoomClient`: 지금 `TossClient`의 조회 메서드와 같은 이름·반환 형식.
  - `prices`, `orderbook`, `confirmed_prices`, `stocks`, `daily_candles`, `completed_daily_candles`, `warnings`, `investor_trading`, `rankings`, `exchange_rate`
  - 계좌 관련(`accounts`, `holdings`, `buying_power`, `sellable_quantity`, `commissions`)과 주문 TR은 만들지 않는다.
  - 토큰 파일 캐시, 만료 전 재발급, 429 재시도, gzip은 `data/toss.py` 방식. 키움 TR별 호출 제한에 맞춘 간격 조절 추가.
- **토스 경로를 직접 부르던 곳을 클라이언트 메서드로 먼저 옮긴다** (토스 상태에서 리팩터링 후 교체):
  - 장 달력 → `client.market_calendar(market)` (`__main__.py:761,1410,1645,1649,1709`, `backtest/run.py:73`)
  - 전체 종목 목록 → `client.listed_stocks(market)` (`__main__.py:1389`)
  - 순위 + 기준 시각 → `client.rankings_with_time(...)` (`records/market_log.py:46`, `backtest/run.py:61`)
  - 일봉 페이지 조회 → `client.candles_before(...)` (`backtest/run.py:44`)
- **로컬 개발 전용 토스 조회 (2026-10-02 추가)**: 키움 앱키가 없어도 로컬에서 엔진을 돌려 볼 수 있게 원본의 조회 클라이언트를
  `data/toss.py`로 되살렸다. `.env`의 `BROKER=toss`(+ `CLIENT_ID`, `CLIENT_SECRET`)로 켠다. 조회만 하고(계좌·주문 API 없음),
  운영(EC2)은 키움만 쓴다 (`DJANGO_DEBUG=on`일 때만 받는다). 키움 코드는 그대로 둔다. 세부는 `docs/DECISIONS.md` 3-1장.
- **장 달력**: 키움에는 토스 같은 달력 API가 없을 가능성이 크다. 새 `data/calendar.py`가 같은 형식을 만든다.
  - 국내: 정규장 09:00~15:30 고정 + 공휴일은 data.go.kr 특일정보 API(`DATA_GOKR_API` 이미 있음) + KRX 연말 휴장일.
  - 미국: NYSE 휴장·조기 폐장 규칙을 코드로 계산, 서머타임은 `zoneinfo`.
- 종목 구분(ETF·ETN·우선주·스팩, 거래정지, 투자유의)은 키움 종목정보에서 매핑해 `screen.eligible`이 쓰는 필드로 채운다.
- 미국 시장: 키움 REST API가 미국주식 시세·차트·환율을 지원한다고 알려져 있다(2026년 추가). 순위·종목 목록 지원은 확인 필요.
  부족하면 국내만 먼저 하고(`MARKETS=KR`) 미국은 이후 과제.
- 키움은 **앱키에 접속 IP 등록**이 필요할 수 있다 → EC2 공인 IP를 등록. 확인 필요.

### 3-2. 실주문 삭제 → 모의매매 엔진

삭제: `data/orders.py`, `LIVE_TRADING`, `--live`, `--bypass`, 사용자 확인(종목코드 입력) 절차, OCO 조건주문, 토스 오류 코드 안내,
bypass 한도, 소수점 금액 주문 시간 제한, 실계좌 조회 전부.

유지: 예측 추적(`trades`/`predictions`/`track`/`stats`), 리스크 엔진, 주문 계획(`make_plan`), 실행 직전 점검, 호가 단위, 예상 손익 계산.

새 **모의 계좌**:
- **팀원별 계좌** (2026-10-02 확정, 처음 계획은 팀 공용 1개), 초기 자금은 각자 `PAPER_CAPITAL_KRW` (기본 1천만원).
  미국 종목은 원화 현금에서 체결 시점 환율로 환산. 엔진 자체 SQLite 계좌는 엔진 CLI·전략(AI 자동 매수)용으로 남는다 (`docs/DECISIONS.md` 8-1).
- 주문 상태: `대기(ENTRY_PENDING)` → `보유·감시(EXIT_WATCHING)` → `종료(CLOSED)` / `취소(CANCELED)`.
- 체결 규칙 (엔진이 실시간 시세로 판단, 정규장 안에서만):
  - 시장가: 현재 확인 가격에 즉시 체결.
  - 지정가 매수: 가격 ≤ 지정가면 체결. 당일 정규장 종료까지 안 되면 취소.
  - 목표가·손절가·기한: 지금의 가격 감시 청산 로직(`executor._check_local_exit`, 2회 연속 확인) 재사용.
  - 정규장 밖 시장가 주문은 다음 정규장 시작 때 실행하는 예약으로 넣는다.
  - 비용: 수수료 `PAPER_COMMISSION_KR/US` (기본 0.015%) + 국내 매도 세금.
- 계좌 평가액 = 현금 + 보유 평가액, 매수 가능액 = 현금 − 대기 매수 금액 (`backtest/sim.py`의 방식).
- 실계좌를 보던 곳(보유 조회, 일일 리포트 계좌 요약, 분석 대상 제외, 리스크 엔진 입력)을 모두 모의 계좌로 바꾼다.
- 전략의 "컨펌 후 주문"은 "**모의 자동 매수**"로 바뀐다.
- 주문마다 **누가 냈는지**(팀원 계정 또는 "전략 N") 기록한다.
- 중단 스위치는 "새 모의 매수 중단"으로 유지.

### 3-3. 알림: openclaw는 팀 채널 알림 전용

- 명령은 웹으로 옮기므로 **openclaw 플러그인(`/toss` 명령, 확인 답장, 에이전트 도구)은 삭제**한다.
- 알림은 `openclaw message send --target channel:<팀 채널 ID>`만 쓴다: 매수 추천, 체결·청산, 전략 실행 결과, 일일 리포트 PDF, 오류.
- openclaw는 **EC2에 설치하고 팀용 새 Discord 봇**을 쓴다 (이 PC의 개인 봇과 분리). 엔진 컨테이너에서 알림을 보내는 방법
  (같은 컨테이너에 openclaw CLI를 넣을지, 호스트의 openclaw를 부를지)은 설치하면서 확인한다.
- 팀 봇의 AI 대화 기능은 꺼 두거나 응답 범위를 제한해 알림 전용으로 쓴다.
- `notify.py`의 `confirm`/`ask`와 파일 브리지 코드는 삭제. openclaw 설정이 없으면 콘솔 출력 (개발용).

---

## 4. 팀 프로젝트로 새로 추가하는 것

### 4-1. 전체 구조

```
                    ┌──────────────────────── AWS EC2 (Docker Compose) ────────────────────────┐
 브라우저 ──HTTPS──▶ │ nginx ──┬─ /        React 빌드 파일                                       │
 (팀원)              │         └─ /api/    Django + DRF (gunicorn) ──┐                           │
                    │                                               ├─▶ PostgreSQL (기록·계좌·전략) │
                    │   엔진 (python manage.py run_engine) ──────────┤                           │
                    │     체결 감시, 전략, 시장 기록, 리포트, AI 분석  └─▶ Redis (작업 큐·잠금·캐시) │
                    │     │                                                                      │
                    │     ├─▶ 키움 REST API, DART, SEC, DevPass, Google News                      │
                    │     └─▶ openclaw ─▶ Discord 팀 채널 (알림)                                  │
                    └────────────────────────────────────────────────────────────────────────────┘
```

- **웹(Django)은 짧은 요청만** 처리한다 (조회, 주문 등록, 전략 수정). 시세가 필요하거나 오래 걸리는 일(AI 분석, 체결, 리포트)은
  Redis 작업 큐에 넣고 **엔진**이 처리한다. 웹은 작업 번호를 받아 상태를 확인한다.
- 예외 (2026-10-02): **현재가·일봉 조회와 시장가 체결은 웹이 짧은 캐시(1초)로 직접** 한다. 화면이 1초마다 가격을 받고 주문 결과를
  바로 보여 줘야 해서다. AI 분석처럼 오래 걸리는 일은 `jobs` 표에 넣고 `run_engine`이 처리한다 (`docs/DECISIONS.md` 8-2).
- 엔진은 지금의 `serve` 루프를 Django 관리 명령으로 감싼 것이다. 엔진 로직(선별·분석·리스크·체결)은 그대로 쓰고,
  저장소 계층(`records/store.py`)만 Django ORM으로 바꾼다.

### 4-2. 저장소 구조 (새 GitHub 저장소)

```
paper_trading/
  engine/              매매 엔진 파이썬 패키지 (기존 src/toss_trading 에서 이름 변경: paper_engine)
  backend/             Django 프로젝트
    config/            설정 (환경 변수에서 읽음)
    accounts/          팀원 계정, 권한
    trading/           모델, REST API, 관리자 화면, 관리 명령(run_engine, 기존 CLI 명령)
  frontend/            React + TypeScript + Vite
  backtest/            백테스트 (DB 없이 단독 실행)
  deploy/              docker-compose.yml, nginx 설정, Dockerfile, EC2 설정 문서
  .github/workflows/   ci.yml, deploy.yml
  docs/                설계, 키움 API 매핑, 팀 개발 안내
```

### 4-3. 백엔드 (Django + Django REST Framework)

**DB 모델 (EC2: PostgreSQL / 로컬 개발: SQLite)**

- DB 엔진은 환경 변수로 고른다: `POSTGRES_HOST`가 있으면 PostgreSQL(EC2의 `db` 컨테이너), 없으면 SQLite(`backend/db.sqlite3`).
  로컬 개발 환경은 SQLite를 쓰고, EC2에 올렸을 때만 PostgreSQL을 쓴다. 모델·마이그레이션은 같은 것을 쓰므로
  PostgreSQL 전용 기능(JSONB 연산자, 배열 필드, `DISTINCT ON` 등)은 쓰지 않는다. 운영과 차이를 잡기 위해 CI는 PostgreSQL로 검사한다.


| 구분 | 표 | 내용 |
|---|---|---|
| 기존 유지 | `trades`, `predictions` | AI 시나리오와 모델별 예측 (예측 추적·통계) |
| 기존 유지 | `market_days`, `rankings` | 시장 기록 |
| 모의 계좌 | `paper_account` | 현금, 초기 자금 |
| 모의 계좌 | `paper_orders` | 주문·포지션 (진입가, 수량, 목표·손절·기한, 상태, 손익, 요청자) |
| 모의 계좌 | `paper_fills` | 체결 내역 (매수/매도, 가격, 수량, 수수료, 세금, 환율, 시각) |
| 모의 계좌 | `equity_daily` | 일별 자산 스냅샷 (대시보드 자산 추이 차트) |
| Redis에서 이동 | `strategies`, `reservations`, `scan_results` | 웹에서 수정·조회하므로 DB로 옮긴다 |
| 새로 | `analysis_runs` | AI 분석 실행 색인 (종목, 시각, 결과 요약, 비용, 실행 기록 JSON·PDF 경로, 요청자) |
| 새로 | `jobs` | 웹이 요청한 작업 상태 (대기·실행 중·완료·실패, 결과) |
| 새로 | `ai_usage` | AI 비용 사용량 (일별, 팀원별) |
| Django 기본 | `auth_user` 등 | 팀원 계정 |

- 실행 기록 JSON과 PDF 파일은 EC2 디스크 볼륨(`runs/`, `reports/`)에 두고 DB에는 경로만 둔다.
- 마이그레이션은 Django 마이그레이션으로 관리.

**Redis 용도**: 작업 큐, 전략 하루 한 번 실행 표시, 잠금(동시에 한 번만 도는 리포트 분석 등), 시세 캐시, 엔진 생존 신호.

**REST API (요약)**

| 경로 | 기능 |
|---|---|
| `POST /api/auth/login`, `logout`, `GET /api/auth/me` | 로그인 (세션 + CSRF) |
| `GET /api/account` | 모의 계좌 요약 (현금, 평가액, 손익, 자산 추이) |
| `GET /api/positions` | 보유 종목 (현재가, 손익, 목표·손절·기한, 예상 손익) |
| `GET/POST /api/orders`, `PATCH/DELETE /api/orders/{id}` | 주문 목록·등록·목표/손절 수정·취소 |
| `GET /api/fills` | 체결 내역 |
| `GET/POST/DELETE /api/reservations` | 예약 주문 |
| `GET/POST/PATCH /api/strategies`, `POST /api/strategies/{id}/run` | 전략 관리·즉시 실행 |
| `GET /api/scans` | 선별 결과 |
| `GET /api/stocks/search?q=`, `GET /api/stocks/{code}` | 종목 검색, 스냅샷(시세·일봉·지표·재무·뉴스·리포트) |
| `POST /api/analyses`, `GET /api/analyses`, `GET /api/analyses/{id}` | AI 분석 요청·목록·상세(시나리오 카드, 점수, PDF) |
| `GET /api/stats` | 예측 성적 (모델별 Brier·적중률, 선정/탈락별 손익, 팀원별 모의 성적) |
| `GET /api/market` | 시장 기록 (일별 순위, 벤치마크) |
| `GET /api/reports`, `POST /api/reports` | 일일 리포트 목록·생성 |
| `GET /api/jobs/{id}` | 작업 상태 |
| `GET/POST /api/admin/halt` | 중단 스위치 (관리자) |

- API 명세는 `drf-spectacular`로 OpenAPI 문서를 만들고, 프론트엔드는 여기서 TypeScript 타입을 자동 생성한다 (`openapi-typescript`).
- **권한**: 관리자(계정 생성, 전략 변경, 중단 스위치, 비용 한도) / 팀원(조회, 모의 주문, AI 분석 요청).
- **AI 비용 한도**: 하루 전체 한도 `AI_DAILY_BUDGET_USD`와 팀원별 하루 분석 요청 수 한도. 넘으면 요청 거부.
  웹에서 분석 요청 시 예상 비용(종목당 약 $0.3)을 보여준다.
- Django 관리자 화면(`/admin`)으로 계정·데이터 확인.

### 4-4. 프론트엔드 (React + TypeScript + CSS)

- 도구: Vite, React Router, TanStack Query(서버 데이터 캐시·폴링), **Tailwind CSS**(2026-10-02 변경, 처음 계획은 CSS Modules),
  차트는 `lightweight-charts`(캔들). 스타일은 토스증권 웹을 참고한 모바일 우선 반응형 (모바일 하단 탭, PC 왼쪽 메뉴).
- **1차 구현 범위 (2026-10-02)**: 로그인 · 홈(내 자산 + AI 분석 종목 대시보드) · 종목 검색·상세·주문 · 내 주식 · AI 분석 상세 ·
  랭킹보드(내 정보 공개를 켠 팀원의 현재 수익률) · My Page(실시간 수익률·투자금액·공개 체크박스). API 계약은 `docs/API.md`.
  아래 표의 나머지 화면(전략, 선별 결과, 통계, 시장, 리포트, 관리)은 이후 단계.
- **AI 리포트 (2026-10-02 추가, 구조만)**: 종목별 리포트 신청과 여러 Agent의 협업 과정(Trace)을 보는 화면 `/reports`.
  실행 계획 그래프·Trace 타임라인·Shared State·실패 정책·Handoff 안내와 교육용 문서(`docs/교육용문서.md`)를 담는다.
  Agent·Orchestrator 실행은 팀이 구현한다 (`docs/DECISIONS.md` 9장).
- 개발 중에는 Vite 개발 서버가 `/api`를 로컬 Django로 넘긴다. API 완성 전에는 MSW로 가짜 응답을 써서 병렬 개발.
- 반응형 (모바일에서도 조회·주문 가능), 다크 모드.

**화면**

| 화면 | 내용 |
|---|---|
| 로그인 | 팀원 계정 로그인 |
| 대시보드 | 총자산·현금·평가 손익·오늘 손익, 자산 추이 차트, 진행 중 주문, 최근 체결, 오늘 전략 실행 결과 |
| 보유·주문 | 보유 종목 표(현재가, 손익률, 목표·손절까지 거리, 남은 기한), 대기 주문 취소, 목표·손절 수정, 체결 내역 |
| 주문하기 | 종목 검색(자동 완성), 시세·일봉 차트, 매수/매도 폼(시장가/지정가, 목표·손절·기한, 예약), 리스크 엔진 수량 제안 미리보기 |
| 종목 상세 | 스냅샷(지표, 재무, 뉴스, 증권사 리포트), 이 종목의 과거 분석 결과, "AI 분석 요청" 버튼(예상 비용 표시) |
| AI 분석 | 분석 목록(종목, 결과, 점수, 비용, 요청자), 상세(시나리오 카드, 모델별 점수와 약점, 판정 사유, 웹 조사, PDF 다운로드) |
| 선별 결과 | 전략별·날짜별 후보 순위, 규칙 점수, 탈락·제외 사유 |
| 전략 | 전략 목록, 생성·수정(시장, 후보 수, 분석 수, 자동 매수 여부, 한도), 활성·중지, 즉시 실행 |
| 예약 | 예약 주문 목록, 취소 |
| 통계 | AI 예측 성적(모델별 적중률·Brier, 확률 대 실제 도달률 그래프), 선정/탈락 손익 비교, 팀원별 모의 성적 순위 |
| 시장 | 날짜별 거래대금·상승·하락 상위, 벤치마크 추이, 환율 |
| 리포트 | 일일 리포트 목록과 PDF 보기, 새로 만들기 |
| 관리 (관리자) | 팀원 계정, 중단 스위치, AI 비용 사용량, 엔진 상태(마지막 생존 신호, 작업 큐) |

### 4-5. 인프라 (AWS EC2 + Docker Compose)

- EC2: Ubuntu, `t3.medium`(메모리 4GB, Chrome PDF·PostgreSQL·엔진을 함께 돌리기 위해) 권장, EBS 30GB 이상.
- IP: 단기 사용이라 **EC2 자동 할당 공인 IP**를 쓴다. 재부팅해도 유지되지만 인스턴스를 **중지 후 시작하면 바뀐다.**
  바뀌면 키움 IP 등록, GitHub Secrets의 배포 주소, 팀원 접속 주소를 다시 맞춘다. 그래서 운영 중에는 인스턴스를 중지하지 않는다.
  자주 껐다 켜야 하거나 기간이 길어지면 Elastic IP로 바꾼다 (인스턴스에 붙어 있는 동안 공인 IP와 요금이 같다).
- 컨테이너 (`deploy/docker-compose.yml`):

| 서비스 | 내용 |
|---|---|
| `nginx` | React 빌드 파일 제공, `/api`·`/admin` 프록시, HTTPS (Let's Encrypt 자동 갱신) |
| `web` | Django + gunicorn |
| `engine` | `python manage.py run_engine` (Chrome 포함, PDF 생성) |
| `db` | PostgreSQL 16 (볼륨 영구 보관) |
| `redis` | Redis 7 (AOF) |

- openclaw: EC2에 설치, 팀용 새 Discord 봇 토큰. 엔진 → openclaw 연결 방법은 설치 때 확정.
- 보안 그룹: 80·443 공개, 22는 팀원 IP만 (또는 AWS SSM으로 SSH 없이 접속). DB·Redis 포트는 외부에 열지 않는다.
- 비밀 정보: EC2의 `.env` 파일에만 둔다 (키움 키, DevPass 키, DART·data.go.kr 키, Django 비밀키, DB 비밀번호, 봇 토큰). 저장소에 넣지 않는다.
- 백업: 매일 `pg_dump` + Redis 내보내기, 14일 보관. 선택: S3 업로드, EBS 스냅샷.
- 로그: 컨테이너 로그(`docker compose logs`), 엔진 오류는 Discord 알림.
- 도메인: HTTPS를 쓰려면 도메인이 필요하다 (없으면 처음에는 HTTP + IP로 시작).

### 4-6. CI/CD (GitHub Actions)

**`ci.yml`** — 모든 PR과 `main` push에서 실행:
1. 백엔드·엔진: `ruff` 검사 → `pytest` (EC2와 같은 PostgreSQL·Redis 서비스 컨테이너 사용, 외부 API는 전부 가짜 객체)
2. 백테스트: `pytest backtest`
3. 프론트엔드: `npm ci` → `eslint` → `tsc --noEmit` → `vitest` → `vite build`
4. Docker 이미지 빌드 확인
5. API 명세와 프론트엔드 타입이 맞는지 확인 (OpenAPI 생성 결과 비교)

**`deploy.yml`** — `main`에 push(직접 또는 PR 병합)되고 CI가 통과하면:
1. 이미지 빌드 (`web`/`engine` 공용 이미지, `nginx`+프론트 이미지) → GitHub Container Registry(GHCR)에 올림 (태그: 커밋 해시)
2. EC2 접속 (SSH 키는 GitHub Secrets, 또는 AWS SSM) → `docker compose pull` → `migrate` → `docker compose up -d`
3. 배포 후 상태 확인 (`/api/health`), 실패하면 이전 태그로 되돌림
4. 배포 결과를 Discord 팀 채널로 알림

**협업 규칙**
- `main` 직접 push 허용. PR·리뷰 1명 필수 규칙과 브랜치 보호는 두지 않는다 (2026-10-02 결정). 큰 변경은 필요하면 PR로 리뷰를 받는다.
- push 전에 로컬에서 테스트를 돌리고, CI(`ci.yml`)는 `main` push마다 돈다. 브랜치를 쓸 때 이름은 `feat/…`, `fix/…`.
- 로컬 개발: DB는 SQLite (`POSTGRES_HOST`를 비워 둔다) + `docker compose -f deploy/compose.dev.yml up`(Redis) + `manage.py runserver` + `npm run dev`.
  운영과 같은 PostgreSQL로 확인할 때만 `--profile postgres`로 PostgreSQL도 띄우고 `POSTGRES_HOST=127.0.0.1`을 준다.
  (2026-10-02: 팀이 같이 보는 개발 DB로 호스트 PC의 PostgreSQL 컨테이너를 쓴다. `scripts/dev.sh`가 띄우고, 개발할 때만 같은 네트워크에 연다.
  `docs/DECISIONS.md` 10장, `TEAM_DEV_PLAN.md` 12장.)
  `.env.example`에 개발용 기본값.

### 4-7. 팀 역할 분담 예시

| 역할 | 담당 범위 |
|---|---|
| 프론트엔드 1~2명 | `frontend/` 화면, 차트, API 연결 |
| 백엔드 1명 | `backend/` 모델, API, 인증, 권한, 작업 큐 |
| 엔진·데이터 1명 | `engine/` 키움 클라이언트, 장 달력, 모의매매 체결, AI 분석 연결 |
| 인프라 1명 (겸임 가능) | Docker, EC2, GitHub Actions, openclaw 알림, 백업 |

---

## 5. 확정된 결정과 정해야 할 항목

### 확정

- 새 디렉터리 `~/Repos/paper_trading`, git 히스토리 없이 새로 시작. 팀 GitHub 저장소로 올린다.
- 데이터는 복사하지 않는다 (`data/`, `runs/`, `.cache/`, `backtest/cache/`, `.env` 제외). 현재 DB에는 실포지션이 있으므로 절대 가져가지 않는다.
- 증권사: 키움 REST API (조회만). AI: DevPass 유지.
- 명령은 웹, Discord는 openclaw로 팀 채널 알림만. 이메일·webhook은 쓰지 않는다.
- DB: **EC2 운영은 PostgreSQL, 로컬 개발 환경은 SQLite** (`POSTGRES_HOST` 유무로 전환, 같은 모델·마이그레이션). 팀원별 계정, EC2 + Docker Compose, GitHub Actions.
- 엔진 로직은 표준 라이브러리 원칙 유지. Django·DRF·psycopg·gunicorn 등은 백엔드에서만 추가 (사유: 웹 서비스·다중 사용자·DB).
- (2026-10-04, 팀장 결정) 서비스 컨셉: **"AI 리포트 데스크"**(2026-10-05 이름을 **"종이배"**로 바꿈) — 주식이 처음인 사람도 AI 리포트를 만들고·검토하고·모의 자동매매로 실행한다.
  주린이모드(계정 저장), AI 교차검증 분석 유지, 투자 방식 확장은 장기·단타만(선물 폐기). 자세한 결정은 `docs/DECISIONS.md` 13장.

### 정해야 할 항목 (기본값으로 진행, 바꾸려면 알려줄 것)

1. 계좌 구조: **팀원별 계좌로 확정** (2026-10-02. 랭킹보드와 My Page가 팀원별 수익률을 쓴다). 팀원 계정은
   `python manage.py create_team_accounts`로 만든다 (아이디·비밀번호 무작위, `team_accounts.txt`에 저장, git 제외).
2. 초기 자금: 기본 1천만원.
3. 미국 시장: 키움 확인 결과에 따라 포함 여부 결정.
4. AI 비용 한도: 기본 하루 전체 $10, 팀원별 하루 분석 요청 5종목.
5. 도메인: 있으면 HTTPS로, 없으면 IP + HTTP로 시작.
6. GitHub 저장소 위치: 개인 계정 또는 팀 조직.

---

## 6. 작업 순서

메인 세션이 계획·분해·공통 결정·검토·통합을 맡고, 분리 가능한 구현은 Orca 작업자로 병렬 실행한다.
여러 작업이 같은 파일을 건드리지 않도록 **공통 결정(DB 표 구조, API 명세, 설정 키 이름)은 메인이 먼저 확정**해 모든 작업자에 같이 준다.

| 단계 | 내용 | 담당 | 병렬 |
|---|---|---|---|
| 0 | 복제, `git init`, 저장소 구조 재배치(`engine/`, `backend/`, `frontend/`), 패키지 이름 변경, 기존 테스트 통과 확인 | 메인 | – |
| 1 | 토스 경로 직접 호출을 클라이언트 메서드로 이동 (3-1 리팩터링) + 테스트 | 메인 | – |
| 2 | **공통 결정 문서**: DB 표 구조(4-3), REST API 명세 초안(OpenAPI), 설정 키, 작업 큐 형식 | 메인 | – |
| 3 | 키움 API 확인: TR ID·필드·호출 제한·IP 등록, 응답 샘플 저장(`docs/KIWOOM.md`) — **키움 앱키 필요** | Opus 작업자 | ○ |
| 4A | 키움 클라이언트, 장 달력, 클라이언트 교체, 백테스트 연결 (3단계 이후) | Opus 작업자 | ○ |
| 4B | 모의매매 엔진: 실주문 삭제, 모의 계좌·체결, 알림 정리(confirm·플러그인 삭제) | Opus 작업자 | ○ |
| 4C | Django: 모델·마이그레이션, ORM 저장소 구현, 인증·권한, REST API, 작업 큐, `run_engine` | Opus 작업자 | ○ |
| 4D | React: 화면 전체 (MSW 가짜 응답으로 시작) | Sonnet 작업자 (어려운 화면은 Opus) | ○ |
| 4E | Docker·Compose·nginx, GitHub Actions(ci·deploy), EC2 설정 문서 | Sonnet 작업자 | ○ |
| 5 | 통합: 엔진 ↔ Django 저장소 연결, 프론트 ↔ 실제 API, 전체 테스트 | 메인 | – |
| 6 | 구현에 관여하지 않은 작업자로 독립 리뷰 (주문 코드 잔존, 권한, 비밀 정보 노출, 비용 한도) | Opus 작업자 | – |
| 7 | EC2 첫 배포 (AWS 계정·도메인·봇 준비 후), openclaw 설치, 실제 알림 확인 | 메인 + 사용자 | – |

---

## 7. 검증

- **테스트**: GitHub Actions의 `ci.yml` 전부 통과 (엔진·백엔드 `pytest`, 백테스트, 프론트 `eslint`·`tsc`·`vitest`·빌드).
- **주문 코드 제거 확인**: 코드 검색으로 `orders.py`, `create_order`, `LIVE_TRADING`, `--live` 0건.
  `tossinvest`는 로컬 개발용 조회 클라이언트 `engine/paper_engine/data/toss.py`의 주소 1건만 (계좌·주문 경로 없음).
- **운영에 토스 없음 확인**: EC2의 `.env`·compose에 `BROKER`, `CLIENT_ID`, `CLIENT_SECRET`이 없고, 엔진이 키움으로 뜬다.
- **키움 조회 실제 확인** (읽기 전용): 스냅샷 `005930`, 선별 `KR --no-ai`, 시장 기록, 백테스트 `--market KR`.
- **모의매매 흐름** (웹에서): 로그인 → 종목 검색 → 10주 시장가 매수 → 체결·현금 감소 확인 → 목표·손절 지정 매수 → 엔진이 청산 →
  통계·대시보드 반영 → 정규장 밖 시장가 주문이 예약으로 들어가는지.
- **AI 분석**: 웹에서 1종목 분석 요청 → 작업 상태 → 결과 화면·PDF → 비용 한도 초과 시 거부.
- **권한**: 팀원 계정으로 전략 변경·중단 스위치가 막히는지, 로그인 없이 API가 막히는지.
- **배포**: `main` push → 자동 배포 → `/api/health` 정상 → Discord 팀 채널 알림 수신. 일부러 실패시켜 되돌리기 확인.
- **기존 서비스 무영향**: 이 PC의 `toss-trading` 서비스 정상, 기존 Redis·openclaw 설정 변화 없음.

---

## 8. 준비할 것

- 키움 REST API 앱키·시크릿 (빈 계좌로 신청 가능, 접속 IP 등록 여부 확인).
- AWS 계정과 EC2 (공인 IP), 도메인(선택).
- 팀 GitHub 저장소와 팀원 초대, GitHub Secrets(EC2 접속 정보).
- 팀용 Discord 봇(새로 만들기)과 팀 서버·채널.
- DevPass 키 (팀이 같이 쓸 키와 비용 한도).
