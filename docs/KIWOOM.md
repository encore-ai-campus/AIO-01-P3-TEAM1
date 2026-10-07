# 키움 REST API 확인 결과

작성 2026-10-02 (계획서 단계 3). 구현은 `engine/paper_engine/data/kiwoom.py`(`KiwoomClient`), 장 달력은 `engine/paper_engine/data/calendar.py`.

> **아직 실제 앱키로 호출해 보지 않았다.** 이 문서의 TR ID·요청·응답 필드는 모두 키움 공식 API 명세(아래 출처 1)에서 확인한 것이고,
> 실측이 필요한 항목은 [8장](#8-실측-미확인-항목)에 모았다. 키를 받으면 `scripts/kiwoom_check.py`를 먼저 돌린다 ([9장](#9-실측-체크리스트)).

## 출처

1. 키움 공식 GitHub `Kiwoom-Securities/Kiwoom-REST-API` — 전체 API 명세 `kiwoom/_data/kiwoom_api_spec.json`(337개 API, 오류 코드 37개),
   공식 파이썬 클라이언트 `kiwoom/core/client.py`·`errors.py`·`auth.py`. 확인한 커밋 `953e5db` (2026-09-15).
   https://github.com/Kiwoom-Securities/Kiwoom-REST-API
2. 키움 REST API 가이드 (메뉴 구조, 도메인, 토큰 발급 형식): https://openapi.kiwoom.com/guide/apiguide
3. 키움 REST API 소개 페이지 (호출 제한): https://openapi.kiwoom.com/intro
4. 접속 IP 등록 (공식 문서에서는 못 찾고 사용 후기로 확인): https://wikidocs.net/342465 , https://algolab.co.kr/kiwoom-rest-key-guide
5. 공휴일: 공공데이터포털 한국천문연구원 특일정보 `getRestDeInfo`: https://www.data.go.kr/data/15012690/openapi.do

`engine/tests/fixtures/kiwoom/*.json`은 출처 1의 응답 예시를 그대로 옮긴 것이다 (목록은 3개로 줄임). 예시 값은 키움이 만든 표본이라
같은 종목코드가 반복되거나 값이 어긋난 곳이 있다 (예: ka10001 예시는 필드가 밀려 있다). 형식 확인용으로만 쓴다.

## 1. 공통 규칙 (출처 1)

| 항목 | 내용 |
|---|---|
| 도메인 | 실전 `https://api.kiwoom.com`, 모의 `https://mockapi.kiwoom.com` (모의는 국내 TR당 초당 1회, 일부 TR 미지원 `8104`). 시세 조회라 **실전 도메인을 쓴다** (`KIWOOM_BASE_URL`) |
| 방식 | 모든 TR이 `POST` + JSON 본문, `Content-Type: application/json;charset=UTF-8` |
| 요청 헤더 | `api-id`(TR ID), `authorization: Bearer <토큰>`, 연속 조회면 `cont-yn: Y`, `next-key: <응답의 next-key>` |
| 응답 헤더 | `api-id`, `cont-yn`(다음 데이터가 있으면 `Y`), `next-key` |
| 오류 | 업무 오류도 **HTTP 200**으로 오고 본문 `return_code`(0이 정상)·`return_msg`로 구분한다. `return_code`는 숫자 또는 숫자 문자열. 토큰 오류는 `return_code=3` + `return_msg="[8005:...]"`처럼 메시지 안에 코드가 들어오기도 한다 |
| 종목코드 | 국내 6자리. 거래소 지정은 `039490`(KRX), `039490_NX`(NXT), `039490_AL`(SOR). 우리는 KRX 코드만 쓴다 |
| 숫자 표기 | 가격 `"+71000"`·`"-71000"`(부호 = 전일 대비 방향, 값은 양수), 목록 TR은 `"00136000"`처럼 0 채움, 등락률은 % 문자열 `"+1.23"`, 거래대금 국내 **백만원**·미국 **천USD** |

연속 조회: 같은 본문에 `cont-yn: Y`, `next-key`를 붙여 다시 보낸다. `KiwoomClient._pages`가 따라가고, 한 번에 최대 50쪽(`MAX_PAGES`)에서 멈춘다.

## 2. 토큰 (au10001)

- `POST /oauth2/token`, 본문 `{"grant_type": "client_credentials", "appkey": ..., "secretkey": ...}`.
- 응답 `{"token": "...", "token_type": "bearer", "expires_dt": "20241107083713", "return_code": 0}`. `expires_dt`는 KST `YYYYMMDDHHMMSS`.
- 폐기는 `au10002`(`/oauth2/revoke`) — 쓰지 않는다.
- 오류 코드: `8001`·`8002` 앱키·시크릿 검증 실패, `8005` 토큰 무효, `8010` **토큰을 발급받은 IP와 요청 IP가 다름**, `8030`·`8031` 실전/모의 구분 불일치,
  `8040`·`8050` (지정)단말기 인증 실패, `8103` 토큰·단말기 인증 실패.
- 구현: 토큰 파일 캐시(`KIWOOM_TOKEN_CACHE`, 권한 0600, 원자적 교체)를 프로세스끼리 공유한다. 캐시에는 토큰·만료 시각·도메인·앱키 지문(sha256 앞 16자)만
  남기고 앱키·시크릿은 쓰지 않는다. 도메인이나 앱키가 다르면 캐시를 쓰지 않는다. 만료 5분 전부터 재발급.
  HTTP 401 또는 `8005`·`8031`·`8103`(본문 또는 메시지 안)이면 캐시 파일을 다시 읽어 다른 프로세스가 새로 받은 토큰이 있으면 그것을,
  없으면 한 번만 재발급해 다시 보낸다 (공식 클라이언트와 같은 코드 집합).

## 3. 호출 제한 (출처 3)

| 구분 | 공식 한도 (계좌·토큰별) |
|---|---|
| 국내주식 | 조회 TR 초당 5회, 주문 TR 초당 5회 |
| 미국주식 | 조회 초당 5회, 주문 초당 10회, 환전 초당 1회. **피크(09~10시 KST)** 조회·주문 초당 3회. 미국 전체 초당 50회, 차트 전체 초당 20회, 종목리스트(`usa10099`) **분당 5회** |
| 모의투자 | 국내 TR 1개당 초당 1회 |

- 초과 오류: `1700`(API별), `1701`(전체), `1702`(그룹). HTTP 429도 올 수 있다 (공식 MCP 안내).
- 구현: 클라이언트 하나 안에서 모든 TR 사이 0.25초(초당 4회), 미국 TR은 피크 시간 0.34초, `ust31301` 1.1초, `usa10099` 12.5초 간격을 둔다.
  잠금 안에서 다음 호출 시각을 예약하고 잠금 밖에서 기다리므로 serve의 여러 스레드가 같이 써도 된다.
  429·`1700`~`1702`는 `Retry-After`(없으면 1·2·4초) 뒤 최대 3번 다시 보낸다.
- **주의**: 한도는 토큰 단위인데 간격 조절은 프로세스 안에서만 한다. 엔진 serve와 CLI 명령을 동시에 돌리면 합쳐서 초당 5회를 넘을 수 있다
  (그때는 재시도로 흡수). 웹(Django)은 키움을 직접 부르지 않는다 (DECISIONS 1·6장).

## 4. TR 표 (엔진 메서드 → 키움 TR)

| 메서드 | 국내 TR | 미국 TR | URL |
|---|---|---|---|
| `prices` | `ka10095` 지정종목 정보요청 (`stk_cd`를 `\|`로 이어 여러 종목, 50개씩) | `usa20100` 현재가 종목정보 (종목마다) | `/api/dostk/stkinfo`, `/api/us/mrkcond` |
| `orderbook` | `ka10004` 주식호가요청 (10단계) | `usa20101` 현재가 10호가 | `/api/dostk/mrkcond`, `/api/us/mrkcond` |
| `confirmed_prices` | `prices` + `orderbook` (원본과 같은 중간값 규칙) | 같음 | |
| `daily_candles`, `candles_before`, `completed_daily_candles` | `ka10081` 주식일봉차트조회 (`base_dt`, `upd_stkpc_tp=1` 수정주가, 연속 조회) | `usa06012` 일 차트 (`upd_stkpc_tp=1`, `exrt_appl_tp=0`) | `/api/dostk/chart`, `/api/us/chart` |
| ~~`minute_candles(symbol, day, minutes=1)`~~ (2026-10-05, 단타 연습 — **2026-10-06 단타 폐기로 지웠다, 쓰지 않음**. 아래는 조사 기록) | `ka10080` 주식분봉차트조회 (`tic_scope` = `minutes`, `upd_stkpc_tp=1` 수정주가, `base_dt` = `day`, 연속 조회로 `day` 09:00 앞 봉이 나올 때까지, 최대 `MINUTE_MAX_PAGES`=20쪽) — 응답 목록 키 `stk_min_pole_chart_qry`. **실측 전** | 없음 → `KiwoomApiError` | `/api/dostk/chart` |
| `stocks`, `warnings`, `listed_stocks(KOSPI\|KOSDAQ)` | `ka10099` 종목정보 리스트 (시장구분별, 하루 캐시) + `ka10100` 종목정보 조회 (목록에 없을 때) | `usa10098` 거래소구분 조회 / `usa10099` 종목리스트 | `/api/dostk/stkinfo`, `/api/us/stkinfo` |
| `investor_trading` | `ka10059` 종목별투자자기관별 (`amt_qty_tp=2` 수량, `trde_tp=0` 순매수, `unit_tp=1` 1주) | 없음 → `KiwoomApiError` | `/api/dostk/stkinfo` |
| `rankings(MARKET_TRADING_AMOUNT)` | `ka10032` 거래대금상위 (`mrkt_tp=000`, `stex_tp=1` KRX, `mang_stk_incls` 0=관리종목 제외) | `usa20540` 당일 거래대금 상위(주식) | `/api/dostk/rkinfo`, `/api/us/rkinfo` |
| `rankings(TOP_GAINERS\|TOP_LOSERS)` | `ka10027` 전일대비등락률상위 (`sort_tp` 1 상승률 / 3 하락률, `stk_cnd` 1=관리종목 제외) | `usa20910` 전일대비 등락률상위 (`sort_tp` 1 / 4) | 같음 |
| `exchange_rate` | — | `ust31301` 환율 조회 (`exch_tp` 1·2) | `/api/us/exchange` |
| `market_calendar` | 없음 → `data/calendar.py` | 없음 → `data/calendar.py` | |

- 순위는 **당일(1d)만** 있다. `duration`이 `1d`가 아니면 `KiwoomApiError(0, ...)`. 백테스트 유니버스(`backtest/run.py`의 여러 기간 순위)는 1d만으로 바꾸거나
  다른 방법이 필요하다 (W2·백테스트 담당에게 알림).
- 순위 TR은 집계 시각을 주지 않는다 → `rankings_with_time`의 기준 시각은 `None`.
- 미국 TR은 모두 거래소구분(`stex_tp`: `NY`·`ND`·`NA`)이 필요하다. `usa10098`로 종목마다 한 번 받아 메모리에 둔다 (순위·종목리스트 응답에서도 채움).
- 계좌·주문 TR(`kt*`, `ust2000x`, `ust21xxx` 등)은 만들지 않았다.

## 5. 내부(토스) 형식 매핑

| 내부 필드 | 키움 필드 | 변환 |
|---|---|---|
| 현재가 `lastPrice` | `ka10095.atn_stk_infr[].cur_prc`, `usa20100.cur_prc` | 부호·앞자리 0 제거, 빈 값·0이면 그 종목은 뺀다 |
| 호가 `bids[i]`/`asks[i]` `{price, quantity}` | 국내 `buy_fpr_bid`/`buy_fpr_req`, `buy_{2..10}th_pre_bid`/`_req` (매도는 `sel_`). 미국 `buy_{1..10}bid`/`buy_{n}bid_req` | 가격 0·빈 단계는 뺀다 (장 마감 후 호가 없음 → 빈 목록 → `confirmed_prices`에서 제외) |
| 일봉 `timestamp` | `dt` (YYYYMMDD) | 국내 `YYYY-MM-DDT00:00:00+09:00`, 미국 `YYYY-MM-DDT00:00:00-04:00/-05:00`(뉴욕 시간, 거래일 = 장 달력 date) |
| `openPrice/highPrice/lowPrice/closePrice` | `open_pric/high_pric/low_pric/cur_prc` | 부호 제거 (문자열) |
| `volume` | 국내 `trde_qty`, 미국 `acc_trde_qty` | |
| 일봉 순서 | 키움은 최신 → 과거 | 날짜로 정렬해 과거 → 최신, 같은 날짜는 하나만 |
| 순위 `rank` | 응답 순서 | 투자 유의 종목을 뺀 뒤 1부터 다시 매김 |
| `tradingAmount` | 국내 `ka10032.trde_prica`(백만원), 미국 `usa20540.trde_prica`(천USD) | × 1,000,000 / × 1,000 → 원·USD. 등락률 순위에는 없음 → `None` |
| `tradingVolume` | 국내 `now_trde_qty`, 미국 `acc_trde_qty`/`trde_qty` | |
| `price.changeRate` | `flu_rt` (%) | ÷ 100 → 소수 비율 (`"-1.23"` → `"-0.0123"`) |
| 투자자 `netBuyVolume` | `ka10059` `ind_invsr`(개인), `frgnr_invsr`(외국인), `orgn`(기관계) | 부호 유지 (순매수 음수 = 순매도) |
| 분봉 `timestamp` (단타 폐기로 쓰지 않음, 조사 기록) | `ka10080` `cntr_tm` (`YYYYMMDDHHmmss`, 옛 형식 `HHmmss` + `cntr_dt`도 읽는다) | 봉 시작 시각으로 보고 `YYYY-MM-DDTHH:MM:00+09:00` (초는 버린다). **가정(실측 전)**: 공지(2025-10)로 `cntr_tm`에 날짜가 들어갔다고 보고, 봉 시각이 시작인지 끝인지 모른다 → `minutes > 1` 봉을 다시 묶지 않는다 |
| 분봉 가격·거래량 (단타 폐기로 쓰지 않음) | `ka10080` `open_pric/high_pric/low_pric/cur_prc`, `trde_qty`(그 봉의 거래량 — `acc_trde_qty`는 누적이라 쓰지 않는다) | 부호 제거 (문자열). 시가·고가·저가가 없으면 종가로 채운다. 시각이나 종가를 읽지 못한 행은 버린다. 정규장(09:00~15:30, 양 끝 포함) 밖과 다른 날짜의 봉은 버린다 |
| 분봉 완결 여부 (단타 폐기로 쓰지 않음) | (응답 없음) | `day` 09:00보다 앞선 봉까지 닿았으면 두 번째 값 `complete = True`. 쪽 수 한도에 걸리거나 더 오래된 봉을 주지 않으면 `False` → 웹 API `partial: true` |
| 환율 `rate` | `ust31301` `exch_tp=1`의 `buy_aplc_exrt`, `exch_tp=2`의 `sell_aplc_exrt` | 두 값 평균(매매기준율 근사). 한쪽만 받으면 그 값. 60초 캐시 |

### 종목 정보 (`stocks`)

`ka10099`를 시장구분별로 받아 종목코드 → 유형 표를 만든다 (KST 날짜별 1회, `KIWOOM_TOKEN_CACHE`와 같은 폴더 `kiwoom-stocks-<날짜>.json`에 캐시).

| `mrkt_tp` | 내부 `securityType` | 비고 |
|---|---|---|
| `0` 코스피, `10` 코스닥 | `STOCK` (이름에 "스팩"이 있으면 `SPAC`) | `market` = KOSPI / KOSDAQ |
| `8` ETF | `ETF` | 같은 종목이 0·10 목록에도 있으면 특수 유형이 이긴다 |
| `60` ETN, `70` 손실제한 ETN, `90` 변동성 ETN | `ETN` | |
| `3` ELW | `ELW` | |
| `6` 리츠 | `REIT` | |
| `2` 인프라투융자, `4` 뮤추얼펀드, `9` 하이일드펀드 | `INFRA_FUND`, `MUTUAL_FUND`, `HIGH_YIELD_FUND` | |
| `5` 신주인수권, `7` 신주인수권증서 | `WARRANT` | |

- `screen.eligible`은 `STOCK`·`FOREIGN_STOCK`·`DEPOSITARY_RECEIPT`만 통과시키므로 위 특수 유형과 `SPAC`은 선별에서 빠진다
  (원본 토스는 리츠·스팩을 어떻게 분류했는지 모른다. 스윙 대상이 아니라 빼는 쪽을 택했다).
- 외국기업(`companyClassName`=외국기업)·DR 구분은 아직 하지 않는다 → `STOCK`.
- `status`: 목록·조회에 있으면 `ACTIVE`. `koreanMarketDetail.krxTradingSuspended` = `state`에 "거래정지",
  `liquidationTrading` = `orderWarning=2` 또는 `state`에 "정리매매".
- `leverageFactor`: ETF·ETN 이름으로 추정 (레버리지·2X → `"2"`, 3X → `"3"`, 인버스 → `"-1"`, 인버스2X·곱버스 → `"-2"`). 주식은 `None`.
- 목록에 없는 종목(당일 신규 상장 등)은 `ka10100`의 `marketCode`를 같은 표로 읽고, 모르는 코드는 `UNKNOWN`(선별 탈락).
- 미국: `usa10098`의 `isEtf`=Y → `ETF`, 아니면 `STOCK`. `englishName` = `stk_enm`. ETN·DR 구분은 없다.

### 매수 유의 (`warnings`, `exclude_caution`)

국내 `ka10099`/`ka10100`의 세 필드로 만든다. 하나라도 있으면 리스크 엔진이 매수를 막는다 (`judge/risk.py`).

| 근거 | 값 | `warningType` |
|---|---|---|
| `orderWarning` | `1` ETF투자주의요망, `2` 정리매매, `3` 단기과열, `4` 투자위험, `5` 투자경고 | `ETF_INVESTMENT_CAUTION`, `LIQUIDATION_TRADING`, `SHORT_TERM_OVERHEATED`, `INVESTMENT_RISK`, `INVESTMENT_WARNING` |
| `auditInfo` (감리구분, "정상"이 아니면) | 투자주의환기종목 / 투자주의 / 투자경고 / 투자위험 / 그 밖 | `INVESTMENT_CAUTION_ALERT`, `INVESTMENT_CAUTION`, `INVESTMENT_WARNING`, `INVESTMENT_RISK`, `AUDIT` |
| `state` (종목상태) | 관리종목 / 거래정지 / 정리매매 | `ADMINISTRATIVE_ISSUE`, `TRADING_SUSPENDED`, `LIQUIDATION_TRADING` |

순위의 `exclude_caution`도 같은 기준으로 거른다 (국내는 추가로 요청 옵션으로 관리종목 제외). 미국은 유의 정보가 없어 `warnings`가 `[]`이고 거르지 않는다.
일별 "투자주의" 지정이 `auditInfo`에 실제로 들어오는지는 미확인이다.

## 6. 미국 주식·환율 지원 여부

| 항목 | 상태 |
|---|---|
| 미국 시세·호가·일봉·종목정보·순위 TR | **문서로 확인** (출처 1·2: `usa*` TR 100여 개. 웹 검색 결과로는 2026년 7월 추가). 구현했지만 **실측 미확인** |
| 미국 투자자별 매매동향 | 없음 → `investor_trading`은 `KiwoomApiError` |
| 미국 매수 유의 정보 | 없음 → `warnings`는 `[]` (`usa20100.trd_susp_tp` 거래정지여부는 아직 안 씀) |
| 환율 | `ust31301` 환율 조회가 문서에 있다 (환전 메뉴). **실측 미확인**: 해외주식 계좌·약정이 없으면 거절될 수 있다 |
| 기간 순위(1w~1y) | 국내·미국 모두 당일 순위만 → 미지원 |

**환율 대안** (`ust31301`이 거절되면): ① `usa20100`(미국 현재가) 응답의 `base_exrt`(환율) 필드 — 시세 TR이라 계좌와 무관할 가능성이 크다,
② 한국수출입은행 현재환율 API(`oapi.koreaexim.go.kr`, 키 발급 필요), ③ 공공데이터포털 환율 정보. 엔진은 `MARKETS=KR`이면 환율 실패를 견딘다(W2).

## 7. 접속 IP 등록

- 공식 명세의 `8010`(토큰 발급 IP ≠ 요청 IP)로 보아 **토큰은 발급받은 IP에 묶인다**. 그래서 토큰 캐시 파일은 한 서버 안에서만 공유한다.
- 사용 후기(출처 4): 키움 REST API 홈페이지 → API 사용신청 → **계좌 App Key 관리**에서 접속 IP를 등록해야 하고 최대 10개.
  → EC2 공인 IP를 등록해야 한다. **EC2를 중지하면 공인 IP가 바뀌므로**(`docs/DEPLOY.md` 0장) 다시 등록하거나 탄력적 IP를 쓴다. 개발자 PC로 실측할 때도 그 PC의 IP를 등록한다.
- 사용 신청 조건: 키움 계좌 + HTS ID 연결 (출처 검색 결과, 미확인).

## 7-1. 장 달력 (`data/calendar.py`)

키움에는 장 달력 TR이 없다 (명세 337개 중 없음; `0s` 장시작시간은 실시간 WebSocket). 그래서 코드로 만든다. 형식·규칙은 모듈 docstring.

- 국내: 정규장 09:00~15:30, 프리 08:00~08:50, 애프터 15:30~20:00 (KRX+NXT 통합). 휴장 = 주말 + 특일정보 공휴일 + 양력 고정 공휴일 + 근로자의날 + 12월 마지막 영업일.
  특일정보는 `PAPER_ROOT/.cache/holidays-KR-<연도>.json`에 캐시(7일마다 갱신, 조회 실패 시 오래된 캐시 사용). 키가 없거나 실패하면 경고 1회 후
  음력 공휴일·대체공휴일 없이 동작한다 → **운영 전에 `DATA_GOKR_API`(특일정보 활용신청)를 꼭 넣는다.**
- **2026-09-14 장 시간 개편 뒤 구조** (KRX·넥스트레이드 공지 기준 — 키 받은 뒤 실측으로 다시 확인):

  | 구간 | KRX | NXT(넥스트레이드) |
  |---|---|---|
  | 프리마켓 | – | 08:00~08:50 |
  | 정규장 | 09:00~15:30 (장 마감 단일가 15:20~15:30) | 메인마켓 (정규장 판단은 KRX 시각으로 한다) |
  | 애프터마켓 | **16:00~20:00 (새로 생김)** | 15:40~20:00 |
  | 시간외단일가 | **폐지** (그 전 장후 시간외 15:40~18:00) | – |

  `KR_SESSIONS`의 afterMarket 15:30~20:00은 두 거래소의 **합집합**으로 그대로 둔다 (정규장 밖 판단에만 쓰고 체결은 정규장만 한다).
  화면·평가의 가격은 정규장 종가(장마감 기준, `docs/API.md` 공통 규칙)라 애프터마켓 가격을 쓰지 않는다. 기준일은 정규장 종료 + 10분(15:40 KST)에 오늘로 바뀐다.
  **분봉**(`ka10080`, 단타 연습 — 2026-10-06 단타 폐기로 쓰지 않는다. 조사 기록)은 시간외 봉이 섞여 올 수 있어 정규장(09:00~15:30) 안의 봉만 쓰도록 했었다 (엔진 `minute_candles`는 지웠다).
  `ka10095`의 `cur_prc`가 15:30 뒤·애프터마켓 중에 정규장 종가인지 애프터마켓 체결가인지는 실측 전이다 (8장 5번) — 그래서 화면 가격은 `cur_prc`가 아니라 일봉 종가를 쓴다.
- 미반영: 새해 첫 거래일 10:00 개장, 수능일 개장·폐장 지연, 임시 휴장.
- 미국: NYSE 규칙(휴장 10일 + 대체 휴일, 조기 폐장 3일)과 `zoneinfo` 서머타임. 임시 휴장(국가 애도일)은 미반영.

## 8. 실측 미확인 항목

키가 없어 다음은 확인하지 못했다. `scripts/kiwoom_check.py` 결과로 채운다.

1. 토큰 유효 기간(`expires_dt`까지의 시간)과, 재발급하면 기존 토큰이 무효가 되는지 (토스는 1개만 유효했다).
2. 접속 IP 등록이 필수인지, 등록하지 않은 IP에서 어떤 오류가 오는지.
3. 실제 HTTP 상태 코드: 호출 제한 초과가 429인지 200 + `1700`인지, 토큰 만료가 401인지 200 + `8005`인지 (둘 다 처리하게 만들었다).
4. `ka10081` 한 페이지 행 수(블로그 기준 약 600)와 연속 조회 키 형식, 장중 오늘 봉 포함 여부, 수정주가가 기대대로 나오는지.
5. `ka10095` 한 번에 넣을 수 있는 종목 수 상한 (지금 50개씩), 장 마감 후·시간외에 `cur_prc`가 무엇인지.
6. `ka10004` 응답 필드명 철자(`sel_2th_pre_bid` 등, 명세 그대로 썼다)와 장 마감 후 호가 값.
7. `ka10032`·`ka10027` 한 페이지 행 수, 연속 조회 지원, `stex_tp=1`(KRX)과 `3`(통합) 중 무엇이 토스 순위와 가까운지, ETF 포함 여부.
8. `ka10099` 목록 크기·연속 조회 여부, 코스피 목록(`0`)에 ETF·ETN·리츠가 섞여 오는지, `marketCode` 값이 `mrkt_tp`와 같은 체계인지(`ka10100` 대체 경로가 의존).
9. `orderWarning`·`auditInfo`·`state`의 실제 값 목록 (일별 투자주의 지정이 들어오는지).
10. `ka10059`의 `dt` 기준(당일 포함 여부)과 연속 조회.
11. 미국 TR 전부: 거래소구분 조회, 현재가·호가 값, `usa06012`의 행 순서·`strt_dt` 의미·`dt`가 뉴욕 거래일인지, 순위 단위.
12. `ust31301` 환율 조회가 해외주식 계좌 없이 되는지, 값이 매매기준율과 얼마나 다른지.
13. 공식 호출 제한(초당 5회)이 실제로 TR 전체 합산인지 TR별인지.
14. ~~`ka10080` 분봉~~ (2026-10-05 추가, 단타 연습 — **단타 폐기로 실측하지 않음**, 2026-10-06): 응답 목록 키(`stk_min_pole_chart_qry`)와 필드, `cntr_tm`이 날짜 포함 14자리인지·봉의 시작 시각인지 끝 시각인지,
    `tic_scope` > 1일 때 봉 경계가 09:00 기준인지, 한 쪽 행 수, `base_dt`로 며칠 전 세션까지 받을 수 있는지(지난 세션 `partial`이 얼마나 나는지), 시간외(NXT) 봉이 섞여 오는지, 15:30 단일가 봉의 시각.

## 9. 실측 체크리스트

`.env`에 `KIWOOM_APPKEY`, `KIWOOM_SECRETKEY`(그리고 `DATA_GOKR_API`)를 넣고, 등록한 IP의 기계에서:

```bash
uv run python scripts/kiwoom_check.py --save-raw /tmp/kiwoom-raw          # 국내 (읽기 전용)
uv run python scripts/kiwoom_check.py --fx --us --save-raw /tmp/kiwoom-raw  # 환율·미국까지
```

스크립트는 앱키·시크릿·토큰을 출력하지 않고, 조회 TR만 부른다. 확인할 것:

- [ ] 토큰 발급 성공, 만료까지 남은 시간 → 8장 1번
- [ ] 005930 현재가·호가 3단계·확인 가격 (장중 / 장 마감 후 각각) → 5·6번
- [ ] 일봉 3개 (오늘 봉, 수정주가), 한 페이지 행 수, 2쪽 연속 조회 → 4번
- [ ] 거래대금 상위 5개(단위가 원으로 맞는지: 삼성전자 거래대금이 조 단위인지), 상승률 상위 3개 → 7번
- [ ] 종목정보 리스트 13개 시장구분의 종목 수, ETF(069500)·레버리지(122630) 판정, `ka10100` marketCode → 8번
- [ ] 매수 유의, 투자자별 매매동향 3일 → 9·10번
- [ ] 장 달력 KR (다음 영업일이 공휴일·대체공휴일을 건너뛰는지)
- [ ] (`--fx`) 환율 → 12번. 실패하면 6장 대안
- [ ] (`--us`) NVDA 거래소구분·현재가·호가·일봉·거래대금 상위·종목정보, 장 달력 US → 11번
- ~~분봉(`ka10080`) 한 세션 → 14번~~ (단타 폐기로 하지 않음, 2026-10-06. `KiwoomClient.minute_candles`는 지웠다)
- [ ] `--save-raw` 폴더의 원본 응답으로 테스트 픽스처(`engine/tests/fixtures/kiwoom/`)를 실제 응답으로 바꾸고 이 문서 8장을 고친다

## 10. `MARKETS=US`를 켜기 전에 필요한 것

1. 위 체크리스트 `--us --fx` 전부 통과 (특히 `usa06012` 일봉 순서·날짜 기준, `usa20101` 호가, 순위 단위).
2. 환율: `ust31301`이 되거나 6장 대안 중 하나를 `exchange_rate`에 넣는다 (미국 종목 체결·평가에 필수).
3. 미국 매수 유의·ETN·DR 구분이 없다는 점을 받아들일지 결정 (`usa10104` ETF·ETN 리스트로 ETN 구분 추가 가능).
4. 백테스트·시장 기록의 기간 순위(1w~1y) 대체 방법.
5. 미국 피크 시간(09~10시 KST) 초당 3회 한도에서 serve 감시 주기가 버티는지 확인.
