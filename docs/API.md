# 웹 API 계약 (1차: 로그인 · 모의 트레이딩 · AI 분석 대시보드 · My Page · 랭킹)

작성 2026-10-02. 백엔드(`backend/`)와 프론트엔드(`frontend/`)가 같이 따르는 계약이다. 배경 결정은 `docs/DECISIONS.md` 8장.
바꾸려면 이 파일을 먼저 고치고 양쪽 작업자에게 알린다. 프론트 타입(`frontend/src/api/types.ts`)은 지금은 이 문서를 보고
손으로 쓰고, OpenAPI 자동 생성(`drf-spectacular` → `openapi-typescript`) 비교는 CI 단계(4E)에서 붙인다.

**2026-10-04 합의 (2026-10-05 구현)**: 서비스 컨셉 변경(`docs/plans/컨셉변경계획.md` 8장, 결정 `docs/DECISIONS.md` 13장)의 계약 변경 B3·B4·B5·B6·B7·B8·B10과
구현 결정(`docs/DECISIONS.md` 14장: 장마감 기준(2026-10-06부터 시세는 실시간 — 17장) · 보유 방식 · 장기투자 · 리포트 끝 알림 · 하루 리포트 한도)을 아래 각 절에 넣었다.
"구현 예정(2026-10-04, Claude)"으로 표시했던 것은 **2026-10-05에 모두 만들어** 그 자리를 "구현: 2026-10-05 (Claude)"로 바꿨다 (코드로 하나씩 확인했다).
만들면서 계약 문장과 달라진 곳은 그 자리에 "2026-10-05 구현"으로 적었다. 앞으로 새로 합의한 것도 "구현 예정(날짜, 담당)" → 만들면 "구현: 날짜 (담당)"로 표시한다.
팀 몫(리포트 Worker·Orchestrator 등, "(추가)" 표시)은 이 표시와 따로다 — 아직 서버가 내지 않는다.
표시 위치(2026-10-05): **새 타입**은 선언 줄(`type …`·`interface …`)에 표시하고 그 표시가 타입의 모든 필드를 덮는다. **이미 서버가 내는 타입에 더한 필드**는 그 필드 줄마다 표시한다. 절 전체가 새것이면(장기투자) 절 머리의 표시가 그 절의 엔드포인트를 덮는다. **가격 기준**(공통 규칙 "장마감 기준" 절 머리의 표시)은 문서 곳곳의 "장마감 기준"·"종가"·"완성 봉" 문구를 덮는다 — 그 밖의 새 동작(`style` 등)은 그 자리에 따로 표시한다.
추천 워크플로우(리포트 Agent·Orchestrator·AutoHealing)와 그것에 붙은 B1(`plainSummary`, 출력 계약), 자동 리포트(B9)는 팀 몫이고, 그 밖은 Claude가 만든다 — **B3(`ReportSummary.opinion`·`oneLiner`)도 Claude가 `payloads.summary`에 넣었다** (2026-10-05 바뀜·구현. 같은 파일의 나머지 새 필드 — `summary`의 `source`·`chaosEnabled`·`costUsd`·`hasPdf`, `detail`의 `chaos`·`recovery` — 는 담당 4) (`docs/DECISIONS.md` 14-2, 파일 소유는 `docs/tasks/00-공통.md` 2절).
B1(`ReportDraft.plainSummary`)은 HTTP가 아니라 리포트 출력 계약이라 `docs/tasks/00-공통.md` 10절에 있다 (화면은 `state.results.report_agent.plainSummary`로 읽는다).

**2026-10-11 투자 금액은 사용자가 정한다** (사용자 결정, `docs/DECISIONS.md` 28장 — 구현: 2026-10-11 (Claude)): 계획 활성화의 수량을 리스크 엔진(건당 위험 1%)이 정하지 않는다.
사용자가 `budgetPercent`(매수 가능 금액의 %) 또는 `budgetKrw`(원)를 **반드시** 정하고, 코드는 그 금액을 진입가로 나눠 수량을 계산한 뒤 한도를 **점검만** 한다 (넘으면 줄이지 않고 막는다).
바뀐 곳: "AI 추천" 절의 `RiskPreview`·`TradePlan`·`activated` 사건·미리 보기·활성화·재주문 규칙, "실행 불가 사유 코드" 표.

**2026-10-12 시연용 수동 시작** (사용자 결정, `docs/DECISIONS.md` 31장 — 구현: 2026-10-12 (Claude)): 리스크 엔진이 손익비·기대값(`reward_risk_low`·`ev_negative`)**만으로** 막은 계획을
사용자가 '수동매매 (시연용)'을 눌러 넣을 돈을 정하고 확인한 뒤 직접 시작한다 (`manualStart`). 나머지 점검(넣을 돈·한도·가격·기한·같은 종목·중단 스위치·매수 유의)은 그대로다.
바뀐 곳: "AI 추천" 절의 `RiskPreview.skippedReasons`·`skippedCodes`, `TradePlan.manualStart`, `activated`·`risk_checked` 사건 details, 미리 보기·활성화 요청, 규칙 "시연용 수동 시작", "실행 불가 사유 코드"의 코드가 나가는 자리.

**2026-10-12 선정 팀 검토가 끝나게** (사용자 요청 "선정팀 실패 원인 알아보고 고쳐", `docs/DECISIONS.md` 30장 — 구현: 2026-10-12 (Claude)): HTTP 계약은 그대로이고,
"AI 리포트" 절 Trace 타입 주석에 `agent_completed.details`의 `acceptedWithNotes`·`changed`와 `workflow_failed.details.message`(review_failed)를 더했다.

**2026-10-06 단타 삭제** (사용자 결정, `docs/DECISIONS.md` 16장): 단타 연습(`/api/day/*`)·단타 퀴즈(`/api/me/day-trading-quiz`)·분봉(`/api/stocks/{symbol}/minute-candles`)과 `InvestorProfile.dayQuizPassedAt`·`dayTradingUnlocked`, `Recommendation`·`TradePlan`의 `horizon`, 보유 방식 `day`, 추천 출처 `day`, 청산 사유 `EOD`, 사유 코드 `day_entry_closed`·`day_trading_locked`를 계약에서 지웠다. 투자 방식은 `swing`·`long` 둘이다.

## 공통 규칙

- 경로는 `/api/...`, **끝 슬래시 없음**. 요청·응답은 JSON, 키는 **camelCase**.
- 인증은 Django 세션 쿠키 + CSRF. 프론트는 같은 출처로 부른다 (개발: Vite가 `/api`를 `127.0.0.1:8000`으로 프록시).
  - 변경 요청(POST·PUT·PATCH·DELETE, 로그인 포함. PUT은 B10의 진단 제출이 처음 쓴다)에는 `X-CSRFToken` 헤더가 필요하다. 프론트는 **요청할 때마다 `csrftoken` 쿠키 값을 읽어**
    헤더에 넣는다 (로그인하면 값이 바뀐다). 쿠키가 아직 없으면 `GET /api/auth/csrf`를 먼저 불러 쿠키를 받는다.
    CSRF 검사에 걸리면 `403 {"detail": ...}`.
  - 로그인하지 않았으면 `401 {"detail": "로그인이 필요합니다."}`. 로그인·csrf·health만 로그인 없이 된다 (`/api/schema/`도 로그인 필요).
- 오류: `{"detail": "사람이 읽는 한국어 메시지"}`. 입력·규칙 위반(주문 거절 포함) 400, 없는 대상 404, 한도 초과 429,
  증권사 조회 실패 503 (`detail`에 사유).
- 숫자는 JSON number (문자열 아님). 금액은 종목 통화 기준이고, 이름이 `...Krw`면 원화다. 비율은 소수 (0.0123 = 1.23%).
  값이 없으면 `null`. 원화 반올림·천 단위 표시는 프론트가 한다.
- 시각은 UTC 오프셋이 붙은 ISO 8601 (`2026-10-02T09:00:00+09:00`), 날짜는 `YYYY-MM-DD`.
- 목록의 페이지: `?limit=20&offset=0` → `{"count": n, "results": [...]}`.
- **목록 봉투는 `{"results": [...]}`다** (2026-10-05 확정): **목록 엔드포인트** — 자원의 모음을 돌려주는 것이 일인 응답(주문·체결·예약·분석·리포트·추천·계획·알림 목록, 검색, `GET /api/longterm/daily-moves` 등) — 는 항목 배열을 늘 `results`에 담는다. 페이지가 있으면 `count`를, 맥락 값이 있으면 옆에 둔다 (예: `{"date", "results"}`).
  **한 대상을 돌려주는 객체**(한 종목·한 리포트)는 목록 엔드포인트가 아니다 — 그 안의 배열 필드는 자기 이름을 쓴다 (예: `StockDetail.candles`, `TradePlanDetail.events`).
  2026-10-04 전부터 서버가 내는 `GET /api/quotes`의 `quotes`와 `GET /api/account/equity`의 `points`는 그대로 둔다 (프론트가 이미 쓴다).
- **새로 받기 = 폴링. 시세는 실시간, 그 밖의 가격은 장마감 기준** (아래 "실시간 시세"(2026-10-06)·"장마감 기준"). 프론트는 화면에 보이는 종목의 시세(`/api/quotes`, `/api/stocks/{symbol}`)를
  **5초**(2026-10-06 바뀜, 전 60초), 계좌(`/api/account`)를 10초, 랭킹을 30초, 주문·매매 계획·작업 상태를 5초 간격으로 다시 받는다.
  백엔드는 현재가를 종목마다 1초(`PRICE_TTL`), 종가를 종목·기준일별로 캐시한다 (팀원이 몇 명이 봐도 같은 종목은 현재가 1초에 1번, 일봉 조회는 기준일마다 1번).
  시세와 계좌는 로그인해 있는 동안 탭이 가려져도 계속 받고, 나머지는 탭이 보이지 않으면 멈춘다.
  간격은 `frontend/src/api/queries.ts`의 `POLL`, 캐시는 `backend/trading/market.py`(`closes`).
  (2026-10-04 전: 시세 1초·계좌 2초·랭킹 5초, 현재가 1초 캐시 `PRICE_TTL` — 이 캐시는 내부 체결 경로에만 남는다.)

### 실시간 시세 (2026-10-06 사용자 결정, `docs/DECISIONS.md` 17장)

**종목 조회의 시세는 실시간이다.** 계좌 평가·수익률·랭킹·일별 자산·추천 미리 보기·`priceAtCreation`은 그대로 아래 "장마감 기준"이다.
리포트 시세 조사(`MarketResult`)와 미리 보기의 가격 점검(`price_passed`)은 2026-10-08부터 장 중이면 그때 가격이다 (아래 "리포트 시세").

- **실시간인 것**: `Quote`(`GET /api/quotes`, `StockDetail.quote`), `StockDetail.candles`(오늘 정규장이 열렸으면 오늘 진행 중인 봉까지),
  직접 주문(`POST /api/orders`)의 시장가 매수 가능 점검 가격(화면의 예상 금액과 같은 현재가).
- `price` = 증권사 현재가 (서버가 종목마다 1초 캐시). `asOf` = 그 가격을 받은 시각(서버 시각, ISO). `basis` = `"live"`.
- **`prevClose`** = 그 가격이 속한 거래일의 **전 거래일 종가** (일봉에서). 가격이 속한 거래일 = 오늘(그 시장 현지 날짜)에 정규장이 있으면 오늘, 없으면(주말·휴장) 마지막 일봉의 날짜.
  전 거래일 종가 = 날짜가 그 거래일보다 앞선 마지막 일봉의 종가. 그래서 장 시작 전에는 등락이 어제 종가 대비이고, 주말·휴장에는 마지막 거래일의 등락이 보인다.
  장 달력을 받지 못하면 평일을 거래일로 본다. 일봉이 없으면 `prevClose`·`change`·`changeRate`가 null이다.
- **현재가를 받지 못한 종목**은 그 종목만 장마감 기준 `Quote`(`basis: "close"`, 아래 규칙 그대로)로 낸다. 화면은 `basis`를 보고 표기를 고른다.
- 화면 표기: `live`는 "실시간 · 15:20:31"(받은 시각, KST), `close`는 지금처럼 "10월 2일(금) 15:30 장마감 기준".
- **종목 화면의 내 보유** (2026-10-11, DECISIONS 28장): 종목 상세 화면의 보유 평가(평가 금액·손익·수익률)는 화면이 이 `Quote.price`와 체결가·수량으로 **종목 통화로** 계산한다
  (계획 화면의 현재 손익과 같다 — API 변경 없음). `Position`·`AccountSummary`(홈·마이·랭킹)는 그대로 장마감 기준이다.
- 아래 "장중 가격을 쓰는 것"의 "화면에 가격으로 내지 않는다"는 시세에는 적용하지 않는다. 주문 거절 문장·알림 문장에 장중 **확인** 가격(체결 판단용 가격) 숫자를 넣지 않는 규칙은 그대로다.
  단 **현재가(Quote로 공개되는 값)로 계산한 금액은 넣어도 된다** — 예: 시장가 `long` 점검의 `cash_short` 문장 "매수 금액 ○원이 매수 가능 금액 ○원보다 큼"의 매수 금액(화면의 예상 금액과 같은 숫자).

### 리포트 시세 (2026-10-08 사용자 결정, `docs/DECISIONS.md` 26장)

**리포트를 장 중에 만들면 시세 조사는 그때 가격(현재가)을 쓴다.** 전에는 직전 정규장 종가였다 — 15:23에 만든 리포트가 어제 종가 18,700원을 보이고
손절가도 그 값으로 정했는데, 그때 가격은 17,990원(−3.8%)이었다.

- **언제 현재가인가** (`trading.market.traded_since_basis(market)`): 그 시장의 **기준일(아래 "장마감 기준") 뒤 날짜의 정규장이 이미 시작됐을 때** —
  정규장 중, 그리고 정규장이 끝났지만 기준일이 아직 오늘로 바뀌기 전(KR 15:30~15:40 KST, US 뉴욕 16:00~16:10). 직전 종가보다 새 가격이 있다는 뜻이다.
  장 시작 전·기준일이 오늘로 바뀐 뒤·휴장·장 달력을 받지 못함이면 아니다.
- **리포트 시세 조사** (`market_agent`, `MarketResult`): 위 때에는 `price` = 현재가(실시간 시세와 같은 1초 캐시), `priceBasis: "live"`, `asOf` = 받은 시각,
  `changePct` = 현재가 ÷ 직전 정규장 종가 − 1 (×100). 그 밖이거나 현재가를 받지 못하면 지금처럼 장마감 기준 종가(`priceBasis: "close"`, `asOf` = 정규장 종료 시각).
  지표(RSI·변동성·지지·저항·ATR·이동평균)는 그대로 **완성 봉만**이다. 손절 가격(`MarketResult.stop`)의 기준가는 `price`다 (엔진 분석이 `lastPrice`를 쓰는 것과 같다).
  작성 AI의 진입가가 `price`에서 5% 안인지 보는 검토 점검도 같은 값이다. `priceBasis`가 없는 예전 결과는 `"close"`로 읽는다.
- **화면 표기** (웹 쉬운 보기·두 PDF 같음): live는 "장중 가격 17,990원 · 10월 8일(목) 15:23 기준"(받은 시각을 그 시장 현지 시각으로, 미국은 "15:23(뉴욕)"),
  close는 지금처럼 "종가 18,700원 · 10월 7일(수) 15:30 장마감 기준". 차트는 그대로 완성 봉이고 범례는 마지막 봉의 "… 종가 기준"이다.
- **계획 제안 미리 보기의 가격 점검** (`price_passed`): 위 때에는 직전 종가가 아니라 장중 가격으로 본다 — 미리 보기는 실시간 시세와 같은 현재가,
  활성화는 장중 확인 가격. 문장은 장중 가격 숫자가 없는 정해진 문장("장중 가격이 이미 목표가 이상이에요" / "…손절가 이하예요")이다. 장중 가격을 받지 못하면 직전 종가로 본다.
  그 밖의 때는 지금처럼 직전 종가로 본다. 이유: 장 중에 만든 리포트의 손절·목표가를 어제 종가와 비교하면, 오른 날에는 손절가가 어제 종가보다 높아 시작할 수 있는 제안이 막히고
  내린 날에는 이미 지난 제안이 열려 보인다. 미리 보기의 `lastPrice`·자산은 그대로 장마감 기준이다. 수량은 사용자가 정한 금액을 진입가로 나눠 정하므로(2026-10-11) 본 수량이 그대로 활성화 수량이다.
- 그대로인 것: `Recommendation.priceAtCreation`(만들 때의 직전 종가), 재무 조사의 PER·PBR(직전 종가), 계좌 평가·랭킹, 매매 종목 선정 팀.

### 장마감 기준 (2026-10-04 결정 — 구현: 2026-10-05 (Claude), `docs/DECISIONS.md` 14-1)

화면에 보이는 가격·평가·계산은 **직전 정규장 종가**다 — **2026-10-06부터 시세(`Quote`·`StockDetail`)는 예외로 실시간이다 (위 절).** 모의 체결·청산 판단만 엔진 내부에서 지금처럼 장중 확인 가격을 쓴다.

- **기준일**(시장별, 그 시장 현지 날짜 `YYYY-MM-DD`): **정규장 종료 + 10분이 지금 이전인 가장 최근 영업일** (2026-10-05 고침 — 시각 하나로 정한다).
  그래서 오늘 정규장이 있어도 종료 + 10분 전(KR 15:30~15:40 KST, US 뉴욕 16:00~16:10 포함)에는 그 앞 영업일이고, KR은 거래일 15:40 KST, US는 뉴욕 16:10에 오늘로 바뀐다.
  10분(`CLOSE_SETTLE_MIN`)은 일봉 종가가 굳기를 기다리는 여유다.
- **종가 봉**: 일봉 중 날짜가 기준일 이하인 마지막 봉. 가격 = 그 봉의 종가, `prevClose` = 그 앞 봉의 종가.
- **`asOf`**(가격 기준 시각, ISO): 종가 봉 날짜의 정규장 종료 시각. 장 달력에 그 날짜가 있으면 그 종료 시각, 없으면 KR `15:30+09:00`, US 뉴욕 `16:00`.
  봉 날짜를 쓰므로 장 달력이 휴일을 몰라도(예: 키움 + `DATA_GOKR_API` 없음) 실제 마지막 거래일로 표시된다.
- 화면 표기: KR "10월 2일(금) 15:30 장마감 기준", US "10월 2일(금) 16:00(뉴욕) 장마감 기준". 가격·평가를 보이는 곳마다 옆에 붙인다.
- **오늘 산 종목** (2026-10-08 사용자 결정, DECISIONS 23장): 그 시장의 장마감 기준 시각(평가에 쓸 종가의 `asOf`) **뒤에 체결된 보유**는 그 종가로 평가하지 않고
  **체결가로 평가**한다 (손익 0, `Position.priceBasis: "today_fill"`). 기준일이 오늘로 바뀌면(KR 15:40) 그날 종가로 평가된다.
  원가는 오늘 실시간 체결가인데 평가는 어제 종가라 생기던 가짜 손익(예: 어제 종가 79,900 · 오늘 76,600에 삼 → "+4.31%")을 없앤다.
  `AccountSummary`·`Position`·`Ranking`(그리고 그것을 쓰는 홈·마이) 모두 같은 규칙이다. 일별 자산 기록(15:40 이후)은 그날 종가라 영향이 없다.
  미국 종목은 원화 환산에 지금 환율을 쓰므로 체결 뒤 환율이 바뀐 만큼 손익이 생긴다 (달러 기준 손익은 0).
- **장마감 기준인 것**: ~~`Quote`, `StockDetail`(일봉은 완성 봉만)~~(2026-10-06 실시간으로 바뀜 — 현재가를 받지 못할 때만 장마감 기준), `AccountSummary`·`Position`(평가·수익률), `Ranking`,
  일별 자산(`/api/account/equity` — 그날 기록은 KR 기준일이 오늘이 된 뒤(국내 거래일 15:40 KST 이후) 남기고, 국내 보유는 그날 종가, 미국 보유는 그때의 최신 미국 종가(`AccountSummary.pricesAsOf.US`와 같은 값)로 평가한다),
  `RiskPreview`의 자산(`equityKrw` 등 — 2026-10-11부터 수량·금액은 진입가로 계산해 가격 기준과 무관하다), `Recommendation.priceAtCreation`(출처와 무관하게 만들 때의 종가 — 분석에서 나온 추천(`from_analysis`)도 분석 시각 가격이 아니라 만들 때의 종가), 시연 추천의 진입가, 리포트 PDF 차트,
  리포트 시세 Worker 결과(`state.results.market_agent`의 지표 — `docs/tasks/00-공통.md` 10절 `MarketResult`. ~~`price`·`changePct`~~ 2026-10-08부터 장 중에 만들면 현재가 — 위 "리포트 시세".
  이 항목은 팀(담당 2)이 Worker를 만들 때 지킨다 — 이 절 머리의 "구현" 표시는 Claude가 만든 나머지를 덮는다).
- **장중 가격을 쓰는 것** (화면에 가격으로 내지 않는다): 체결 확인·청산·예약 실행·지정가 재주문, 활성화의 장중 확인(아래 "AI 추천" 절 규칙), 시장가 체결,
  주문 거절 검사(엔진 `buy_blockers`), `PATCH /api/orders/{id}`의 순서 검사. 체결가·청산가는 일어난 사실이라 그대로 보인다.
- 분석의 `priceAtAnalysis`는 분석 시각의 가격 그대로다 (일부러 둔 예외. 화면은 "분석 시각 가격"으로 적고, 장중이었으면 "장중 가격"이라고 밝힌다).

**장중 가격 숫자는 문장에 넣지 않는다**: 사람이 읽는 문장 — `400`의 `detail`, `TradePlan.failureReason`, `PlanEvent.message`, 알림 제목·본문(웹·Discord) — 에
장중 확인 가격이나 그것으로 계산한 금액을 넣지 않는다 (사용자가 일부러 틀린 값을 보내 장중 가격을 읽어 내는 길이 되지 않게). 정해진 문장을 쓴다
(숫자는 사용자가 넣은 지정가·목표가·손절가, 종가, 체결가·청산가(일어난 사실), 현금만 넣어도 된다):

| 자리 | 문장 |
|---|---|
| 활성화의 장중 확인, 재주문 점검(`risk.preview(…, plan=…)`) | "장중 가격이 이미 목표가 이상이에요" / "장중 가격이 이미 손절가 이하예요" (코드 `price_passed`) |
| 미리 보기(종가 — 2026-10-08부터 기준일 뒤 정규장이 시작됐으면 위 줄의 장중 문장, "리포트 시세") | "직전 종가({종가})가 이미 목표가 이상" / "직전 종가({종가})가 이미 손절가 이하" (코드 `price_passed`. 종가는 넣어도 된다. 예: "직전 종가(80,721원)가 이미 목표가 이상" — 2026-10-05 구현: 괄호를 넣었다, "{종가}가"는 "…원가"로 읽혀서) |
| 시장가 주문의 순서 검사 (엔진 `buy_blockers`) | "손절가 {stop} < 현재가 < 목표가 {target} 순서가 아님" (현재가 숫자 없음. 지정가 주문은 지금처럼 지정가 숫자를 쓴다) |
| 매수 가능 금액 (엔진 `buy_blockers`) | "매수 가능 금액 부족 (가능 {가능 금액}원)" (장중 가격으로 계산한 "필요 금액"을 넣지 않는다) |
| `PATCH /api/orders/{id}` 순서 검사 (엔진 `modify`) | "손절가 {stop} < 현재가 < 목표가 {target} 순서가 아님" |
| 엔진이 체결 시점에 진입 주문을 취소 (`Order.note`) · 그 계획의 `failureReason` | note "체결 시점 현금 부족 (현금 {현금}원)" (현금은 넣어도 된다). 계획의 `failureReason`은 괄호 속 금액을 옮기지 않는다: "모의 주문이 취소됨: 체결 시점 현금 부족" (2026-10-05 구현) |

엔진 문장(`buy_blockers`·`modify`)은 엔진 CLI에도 같은 문장으로 나온다 (엔진 쪽에서 고친다). 예약 실행 실패처럼 `run_engine` 콘솔에만 남는 문장은 이 규칙 밖이다.

### 금지 표현 (2026-10-04 결정 — 구현: 2026-10-05 (Claude))

우리가 만들어 사용자에게 보이는 문장(알림 문장 B6, 오늘의 내 종목 뉴스의 LLM 설명과 템플릿, 펀더멘털 점검 알림, 화면 고정 문구)에 쓰지 않는 표현이다.
**목록의 원본은 코드 한 곳** — 엔진 `engine/paper_engine/wording.py`(표준 라이브러리. 기반 단계에서 만든다)의 상수 `PERSUASION`·`CAUSAL`·`PREDICTION`과
`forbidden_phrases(text: str, *, causal: bool = False) -> list[str]`(걸린 표현 목록. 공백을 모두 지운 뒤 부분 문자열로 비교 — "사 볼 만해요"와 "사볼만해요"를 같게 본다).
백엔드(`autotrade/text.py`·`notifications`·`longterm`)가 이 함수로 검사한다 (팀의 `guards`·프롬프트 점검도 쓸 수 있다. 화면 문구는 코드 검사 대상이 아니라 이 목록을 보고 쓴다).
아래는 **최소 목록**이다 (모듈은 이것을 모두 담고, 더하면 이 표도 고친다).

| 상수 | 언제 검사하나 | 최소 목록 |
|---|---|---|
| `PERSUASION` (권유 — 매수·매도 모두) | 우리가 만드는 모든 사용자 문장 (`causal=False`) | 사세요 · 사 볼 만해요 · 사 볼 만 · 매수하세요 · 매수 기회 · 지금 사면 · 담으세요 · 좋아요 · 파세요 · 팔아야 · 매도하세요 · 매도 기회 · 지금 팔면 · 정리하세요 · 비중을 줄이세요 · 비중을 늘리세요 · 손절하세요 |
| `CAUSAL` (인과 단정) | 시장 움직임을 설명하는 문장 (오늘의 내 종목 뉴스, `causal=True`) | 때문에 · 덕분에 · 원인은 · 탓에 · 영향으로 |
| `PREDICTION` (예측) | `causal=True`일 때 같이 | 오를 것 · 내릴 것 · 오를 거 · 내릴 거 · 상승할 것 · 하락할 것 · 반등할 것 |

`causal=True`는 `PERSUASION`도 함께 본다. 우리 시스템이 한 일을 설명하는 문장("목표가에 닿아 팔았어요")은 `causal=False`로 검사한다.
테스트: 목록의 표현마다 걸리는지 하나씩 (`engine/tests/test_wording.py`), B6 쉬운 문장 전부와 오늘의 내 종목 뉴스 템플릿이 걸리지 않는지 (각 앱 테스트).

## 타입

```ts
type Market = "KR" | "US";
type Currency = "KRW" | "USD";

interface Me {
  id: number;
  username: string;       // 로그인 아이디
  nickname: string;       // 랭킹에 보이는 이름 (기본값은 아이디)
  isPublic: boolean;      // 내 정보 공개 (켜면 랭킹보드에 수익률이 나온다). 기본 false
  isStaff: boolean;
  beginnerMode: boolean;  // 주린이모드 (켬 = 쉬운 보기, 끔 = 중급 이상 화면). 진단 전 기본 true. InvestorProfile.beginnerMode와 같은 값
                          // (2026-10-04 합의, 컨셉 계획 B10 — 구현: 2026-10-05 (Claude))
}

// 투자자 프로필 (2026-10-04 합의, 컨셉 계획 B10 — 구현: 2026-10-05 (Claude)). 문항·보기 값·점수표는 아래 "투자자 프로필" 절
type ExperienceLevel = "intro" | "novice" | "intermediate" | "expert";   // 경험 단계: 입문 · 초급 · 중급 · 숙련 — 구현: 2026-10-05 (Claude)
type RiskProfile = "stable" | "stable_seeking" | "neutral" | "active" | "aggressive";   // 구현: 2026-10-05 (Claude)
// 투자 성향 5단계: 안정형 · 안정추구형 · 위험중립형 · 적극투자형 · 공격투자형

interface InvestorAnswers {       // 투자 성향·경험 진단 7문항의 답 (영문 코드) — 구현: 2026-10-05 (Claude)
  q1: "none" | "under_1y" | "1_3y" | "over_3y";
  q2: ("deposit" | "fund_etf" | "kr_stock" | "us_stock" | "derivatives")[];   // 여럿 고름 (1개 이상, 같은 값 두 번 안 됨).
                                // 서버는 이 보기 순서(deposit → derivatives)로 저장해 돌려준다 — 낸 순서와 다를 수 있다 (2026-10-05 구현)
  q3: "never" | "yearly" | "monthly" | "daily";
  q4: "unknown" | "heard" | "explain";
  q5: "no_loss" | "loss_10" | "loss_20" | "more";
  q6: "years" | "weeks" | "intraday";
  q7: "practice" | "growth" | "short_term";
}

interface InvestorProfile {       // 구현: 2026-10-05 (Claude)
  beginnerMode: boolean;                    // 지금 주린이모드. 진단 전 기본 true
  answers: InvestorAnswers | null;          // 진단 전이면 null (아래 여섯도 null)
  experienceScore: number | null;           // 경험 점수 0~11
  experienceLevel: ExperienceLevel | null;
  riskScore: number | null;                 // 성향 점수 0~8
  riskProfile: RiskProfile | null;
  recommendedBeginnerMode: boolean | null;  // 진단이 추천하는 주린이모드 (경험 단계가 intro·novice면 true)
  assessedAt: string | null;                // 마지막 진단 제출 시각
}

interface Quote {               // 실시간 (공통 규칙 "실시간 시세", 2026-10-06). 현재가를 받지 못한 종목만 장마감 기준 ("장마감 기준")
  symbol: string;
  name: string | null;
  currency: Currency;
  price: number | null;        // live: 증권사 현재가 · close: 직전 정규장 종가 (종가 봉의 종가). 둘 다 받지 못하면 null
  prevClose: number | null;    // live: 그 가격이 속한 거래일의 전 거래일 종가 · close: 그 전 거래일 종가 (종가 봉 앞 봉의 종가). 일봉이 없거나 하나뿐이면 null
                               // close는 한 요청이 새로 받는 종목이 10개까지라 처음 보는 종목은 잠깐 null일 수 있다 (다음 폴링에 채워진다)
  change: number | null;       // price - prevClose
  changeRate: number | null;   // price / prevClose - 1
  asOf: string | null;         // live: 현재가를 받은 시각 · close: 종가 봉 날짜의 정규장 종료 시각. price가 null이면 null
  basis: "live" | "close";     // 가격 기준 — 2026-10-06: "live"(실시간) 추가. 화면은 이 값으로 표기("실시간 · 시각" / "장마감 기준")를 고른다
}

interface StockItem {            // 검색 결과
  symbol: string;
  name: string;
  exchange: string;            // KOSPI | KOSDAQ | NYSE | NASDAQ | AMEX
  market: Market;
}

interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }

interface StockDetail {
  symbol: string;
  name: string;
  exchange: string;
  market: Market;
  currency: Currency;
  quote: Quote;                // 실시간 (2026-10-06 — 현재가를 받지 못하면 장마감 기준)
  candles: Candle[];           // 일봉 최근 120개, 과거 → 최신. 2026-10-06부터 오늘 정규장이 열렸으면 마지막은 오늘 진행 중인 봉 (전: 완성 봉만)
  asOf: string | null;         // 마지막 봉이 오늘 진행 중인 봉이면 quote.asOf와 같은 값(받은 시각), 완성 봉이면 그 봉 날짜의 정규장 종료 시각. 일봉이 없으면 null
                               // quote.basis가 "close"(현재가를 받지 못함)면 StockDetail 전체가 장마감 기준이다: candles는 완성 봉만, asOf는 마지막 완성 봉의 정규장 종료 시각
  warnings: string[];          // 매수 유의 (투자경고 등). 없으면 []
}

interface MarketStatus {
  markets: { market: Market; isOpen: boolean; opensAt: string | null; closesAt: string | null;
             closeDate: string | null; lastCloseAt: string | null }[];   // closeDate·lastCloseAt: 구현: 2026-10-05 (Claude)
  // isOpen: 지금 정규장인지. opensAt: 다음(또는 오늘) 정규장 시작, closesAt: 지금 열려 있으면 오늘 종료 시각
  // closeDate: 그 시장의 기준일 (공통 규칙 "장마감 기준"). lastCloseAt: 기준일의 정규장 종료 시각. 장 달력을 못 받으면 둘 다 null
  //   (장 달력으로 계산한 값이다. 종목 가격의 정확한 기준 시각은 각 Quote.asOf — 실제 마지막 봉 날짜)
  halted: boolean;             // 새 모의 매수 중단 스위치
  brokerReady: boolean;        // 증권사 조회 키가 있는지 (없으면 시세·주문이 안 된다)
  quoteProvider: string;       // 시세 출처 이름 (화면 아래 출처 줄): "토스증권 Open API(개발)" (BROKER=toss) | "키움증권 REST API" — 구현: 2026-10-05 (Claude)
}

type OrderStatus = "ENTRY_PENDING" | "EXIT_WATCHING" | "CLOSED" | "CANCELED";
// ENTRY_PENDING 체결 대기 · EXIT_WATCHING 보유 중 · CLOSED 종료(매도 완료) · CANCELED 취소

type HoldingStyle = "swing" | "long";   // 보유 방식 (구현: 2026-10-05 (Claude)). 아래 "주문 규칙"의 보유 방식
// swing 스윙(목표·손절·기한으로 자동 매도) · long 장기 보유(자동 매도 없음)

type ExitReason = "TARGET" | "STOP" | "EXPIRED" | "MANUAL";   // 청산 사유. 뜻은 아래 "청산 사유" 표

interface Order {                // 매수 주문 하나 = 포지션 하나
  id: number;
  symbol: string; name: string; market: Market; currency: Currency;
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  quantity: number;
  status: OrderStatus;
  style: HoldingStyle;         // 보유 방식. 주문할 때 정해지고 바뀌지 않는다 — 구현: 2026-10-05 (Claude)
  entryPrice: number;          // 계획 진입가 (시장가는 주문 시점 가격)
  fillPrice: number | null; filledAt: string | null;
  targetPrice: number | null; stopPrice: number | null; expireDate: string | null;   // long이면 셋 다 null
  exitPrice: number | null; exitReason: ExitReason | null; closedAt: string | null;
  pnlKrw: number | null;       // 실현 손익 (수수료·세금 포함)
  note: string | null;         // 취소 사유 등
  createdAt: string;
}

interface Position {             // 보유 중(EXIT_WATCHING)인 주문의 평가 (장마감 기준)
  orderId: number;
  symbol: string; name: string; market: Market; currency: Currency;
  style: HoldingStyle;         // 보유 방식 (화면의 스윙·장기 배지) — 구현: 2026-10-05 (Claude)
  quantity: number;
  avgPrice: number;            // 매수 체결가
  lastPrice: number | null;    // 직전 정규장 종가. 못 받으면 null (그때는 체결가로 평가)
  costKrw: number;             // 매수 원금 (체결가 × 수량 × 체결 환율)
  valueKrw: number;            // 평가 금액 (종가 × 수량 × 환율)
  profitKrw: number;           // valueKrw - costKrw
  profitRate: number | null;
  targetPrice: number | null; stopPrice: number | null; expireDate: string | null;
  filledAt: string;
  priceBasis: "close" | "today_fill" | "fill";   // 평가에 쓴 가격 (2026-10-08, DECISIONS 23장). close: 직전 장마감 종가 ·
                               // today_fill: 그 시장의 장마감 기준 시각(종가 asOf) 뒤에 체결된 보유 = 오늘 산 종목 → 체결가로 평가 (lastPrice는 직전 종가 그대로, valueKrw = 체결가 × 수량)
                               // · fill: 종가를 받지 못해 체결가로 평가 (lastPrice null). 화면은 today_fill이면 "오늘 산 종목은 장 마감 뒤에 평가돼요"
}

interface AccountSummary {       // My Page · 홈 자산 카드. 평가는 장마감 기준
  initialCapitalKrw: number;
  cashKrw: number;
  holdingsValueKrw: number;    // 보유 평가액 (종가 기준)
  equityKrw: number;           // 총자산 = 현금 + 보유 평가액
  investedKrw: number;         // 투자금액 = 보유 종목 매수 원금 합계
  profitKrw: number;           // equityKrw - initialCapitalKrw
  profitRate: number;          // 수익률 = equityKrw / initialCapitalKrw - 1
  pendingKrw: number | null;   // 대기 매수 금액
  buyingPowerKrw: number | null; // 매수 가능액 = 현금 - 대기 매수 금액
  positions: Position[];
  notes: string[];             // "종가를 받지 못해 체결가로 평가: ..." 같은 안내
  pricesAsOf: { KR?: string; US?: string };   // 평가에 쓴 종가의 기준 시각 (시장별, 보유가 있는 시장만. 없으면 {}) — 구현: 2026-10-05 (Claude)
                               // 값 = 그 시장 보유 종목 종가 asOf 중 가장 늦은 것. 그 시장 종가를 하나도 받지 못했으면 그 시장은 빠진다 (체결가로 평가, notes에 사유)
  asOf: string;                // 계산 시각 (응답을 만든 때. 가격 시각은 pricesAsOf)
}

interface Fill {
  id: number; orderId: number;
  symbol: string; name: string; currency: Currency;
  side: "BUY" | "SELL";
  price: number; quantity: number; amount: number;
  commission: number; tax: number;
  cashChangeKrw: number;       // 현금 증감 (매수 음수)
  reason: "ENTRY" | ExitReason;   // 매수 체결은 ENTRY, 매도 체결은 청산 사유
  filledAt: string;
}

interface Reservation {          // 정규장 밖 시장가 매수·매도 → 다음 정규장 시작에 실행
  id: number;
  kind: "BUY" | "SELL";
  symbol: string; name: string; market: Market;
  quantity: number;
  orderId: number | null;      // SELL이면 팔 주문(포지션)
  targetPrice: number | null; stopPrice: number | null; days: number | null;
  style: HoldingStyle | null;  // BUY 예약의 보유 방식 = 예약을 받을 때 정한 값("swing" | "long"). 실행할 때 이 값으로 주문한다 (다시 추론하지 않는다). SELL이면 null — 구현: 2026-10-05 (Claude)
  runAt: string | null;        // 실행 예정 (다음 정규장 시작)
  createdAt: string;
}

interface OrderResult {          // 주문·매도 요청의 결과
  order: Order | null;         // 접수(또는 체결)된 주문
  reservation: Reservation | null; // 정규장 밖이라 예약으로 들어간 경우
  message: string;             // "삼성전자 10주 71,000원에 매수 체결" 같은 한 줄 결과
}

interface RankingEntry {
  rank: number;                // 1부터, 수익률 내림차순
  nickname: string;
  profitRate: number;
  isMe: boolean;
}

interface Ranking {              // 수익률은 장마감 기준 평가 (AccountSummary.profitRate와 같은 계산)
  results: RankingEntry[];     // 내 정보 공개(isPublic)를 켠 사용자만
  me: { isPublic: boolean; rank: number | null; profitRate: number }; // 내가 비공개면 rank는 null
  pricesAsOf: { KR?: string; US?: string };   // 평가에 쓴 종가의 기준 시각 (시장별, 평가한 계좌(공개 사용자 + 나)가 보유한 시장만. 값은 AccountSummary와 같은 규칙) — 구현: 2026-10-05 (Claude)
  asOf: string;                // 계산 시각
}

type Verdict = "BUY" | "PASS";   // BUY: 교차검증·리스크 엔진·최종 승인을 통과한 시나리오가 있음

interface Scenario {
  proposer: string;            // 제안한 모델
  selected: boolean;           // 최종 승인까지 통과
  passed: boolean | null;      // 교차검증 점수 + 리스크 엔진 통과
  score: number | null;        // 0~100
  probability: number | null;  // 합의 확률 (손절 전에 목표가에 도달할 확률, 0~1)
  entryPrice: number; targetPrice: number; stopPrice: number;
  holdingDays: number;
  rationale: string[];         // 근거
  invalidation: string;        // 시나리오가 틀렸다고 볼 조건
  rejectReasons: string[];     // 탈락 사유 (통과면 [])
}

interface AnalysisSummary {      // AI 분석 종목 대시보드의 카드
  id: number;
  symbol: string; name: string; market: Market; currency: Currency;
  analyzedAt: string;
  verdict: Verdict;
  priceAtAnalysis: number | null; // 분석 시각의 가격 (엔진 스냅숏의 그때 가격, 장마감 기준이 아니다. 화면 "분석 시각 가격")
  best: Scenario | null;       // 대표 시나리오: 승인된 것 중 최고 점수, 없으면 전체 중 최고 점수. 시나리오가 없으면 null
  scenarioCount: number;
  requestedBy: string | null;  // 요청한 팀원의 닉네임 (로그인 아이디는 내지 않는다), 전략 실행이면 "strategy:<번호>", CLI면 "cli"
  costUsd: number | null;
}

interface AnalysisDetail extends AnalysisSummary {
  scenarios: Scenario[];
  news: string[];              // 뉴스 제목 (예전 형식. 그대로 둔다)
  // 아래 셋: 2026-10-04 합의 (U12 약관 대응·장마감 기준)
  newsItems: { title: string; source: string | null; publishedAt: string | null }[];   // 구현: 2026-10-05 (Claude)
                               // 뉴스 제목 + 매체 이름 + 게시 시각(ISO), news와 같은 순서. 링크는 내지 않는다
  newsProvider: string;        // 뉴스 출처 표기 "Google 뉴스 검색 결과" (화면이 뉴스 칸 아래에 적는다) — 구현: 2026-10-05 (Claude)
  dataAsOf: string | null;     // 지표·일봉 자료의 기준일 YYYY-MM-DD = 엔진 스냅숏의 lastCandleDate. 없으면 null — 구현: 2026-10-05 (Claude)
  research: { researcher: string; findings: { claim: string; direction: string | null; date: string | null;
                                               sourceTitle: string | null }[] }[];
  indicators: Record<string, number | string | null>;   // 엔진 스냅샷의 지표 그대로
  errors: string[];
}

interface Job {
  id: number;
  type: "analyze";
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  result: { analysisIds: number[] } | null;  // DONE이면 만들어진 분석
  error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

interface AnalysisQuota {
  usedToday: number;           // 내가 오늘(KST) 요청한 수
  limitPerUser: number;        // AI_DAILY_ANALYSES_PER_USER (기본 5)
  remaining: number;           // 내 한도와 팀 전체 예산 중 작은 쪽의 남은 횟수 (팀 예산 = (AI_DAILY_BUDGET_USD − 오늘 쓴 분석 예상 비용 − 리포트 실제 비용) ÷ 0.3 — 2026-10-08부터 리포트 비용도 뺀다)
  estimatedCostUsd: number;    // 종목당 예상 비용 0.3
  enabled: boolean;            // AI 키(DEVPASS_APIKEY, ANALYSTS)가 있어 분석을 요청할 수 있는지
}
```

## 엔드포인트

### 계정 (`backend/accounts`)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/auth/csrf` | – (로그인 불필요) | `200 {"csrfToken": string}` + `csrftoken` 쿠키 |
| `POST /api/auth/login` | `{"username", "password"}` | `200 Me` · 틀리면 `400 {"detail": "아이디 또는 비밀번호가 올바르지 않습니다."}` · 같은 주소에서 1분에 10번 넘게 시도하면 `429` (`Retry-After` 헤더) |
| `POST /api/auth/logout` | – | `204` |
| `GET /api/auth/me` | – | `200 Me` · `401` |
| `PATCH /api/me/profile` | `{"isPublic"?: boolean, "nickname"?: string}` | `200 Me` · 닉네임은 2~12자(NFKC 정규화 후), 다른 사람의 닉네임·아이디와 겹치거나 보이지 않는 문자가 있으면 `400` |
| `GET /api/me/investor-profile` | – | `200 InvestorProfile` (진단 전이면 `beginnerMode: true`, `answers`부터 `assessedAt`까지 일곱은 null) — (2026-10-04 합의, 컨셉 계획 B10 — 구현: 2026-10-05 (Claude)) |
| `PUT /api/me/investor-profile` | `{"answers": InvestorAnswers}` (`answers` 필수) | `200 InvestorProfile` — 진단 제출. 서버가 아래 점수표로 `experienceScore`·`experienceLevel`·`riskScore`·`riskProfile`·`recommendedBeginnerMode`를 계산해 저장한다 (다시 내면 덮어쓴다). **`beginnerMode`는 바꾸지 않는다** · 빠진 문항·모르는 키·모르는 값, `q2`가 목록이 아니거나 비었거나 같은 값이 두 번 있거나("q2에 같은 답이 두 번 있습니다." — 2026-10-05 구현에서 더함) `deposit`이 다른 보기와 같이 오면, 본문에 `answers` 밖의 키가 있으면(`beginnerMode` 포함) `400` — (2026-10-04 합의, 컨셉 계획 B10 — 구현: 2026-10-05 (Claude)) |
| `PATCH /api/me/investor-profile` | `{"beginnerMode": boolean}` | `200 InvestorProfile` — 주린이모드 스위치만 (진단 전에도 된다) · 빠졌거나(`{}`) 불리언이 아니거나 `beginnerMode` 밖의 키가 있으면 `400` — (2026-10-04 합의, 컨셉 계획 B10 — 구현: 2026-10-05 (Claude)) |

#### 투자자 프로필과 주린이모드 (2026-10-04 합의, 컨셉 계획 B10 — 구현: 2026-10-05 (Claude))

마이 메뉴의 투자 성향·경험 진단(7문항)과 주린이모드 스위치. 원문은 `docs/plans/투자서비스확장계획.md` 2장, 결정은 `docs/DECISIONS.md` 13-2(E-1·E-2).

- 주린이모드는 **계정(서버)에 저장**한다. 기기를 바꿔도 같고, 웹 알림 문장이 같은 모드를 따른다. 진단 전 기본값은 **켬**(`true`).
  리포트 상세의 "이 화면만 자세히 보기"(`?view=expert`)는 화면만 바꾸고 이 값을 바꾸지 않는다 (서버 변경 없음).
  리포트 PDF도 같은 값을 따른다 (2026-10-07): 쉬운 보기의 "PDF로 보기"는 `?view=easy`, 자세히 보기는 `?view=expert`를 붙이고, 붙이지 않으면 이 값으로 고른다 (`GET /api/reports/{id}/pdf`).
- 진단 제출(`PUT`)은 결과만 계산해 저장한다. 화면이 "진단 결과: 초급 · 위험중립형 → 주린이모드 켬 추천"을 보이고, 사용자가 추천을 받아들이면 `PATCH {beginnerMode}`를 부른다.
- 점수 계산은 **결정론적 코드**다 (LLM 아님). 점수표는 이 절과 코드에 같이 두고, 바꾸면 이 절을 먼저 고친다 (E-2: 이 값으로 시작해 사용성 시험 뒤 조정).
- **법정 적합성 진단이 아니다** (모의 투자 연습 도구라 권유·판매가 없다). 화면에 그렇게 적는다. 진단 결과는 본인만 본다 (랭킹·다른 팀원에게 내지 않는다).
- 성향은 화면 안내에만 쓰고 리스크 엔진의 수량 계산은 바꾸지 않는다 (`docs/DECISIONS.md` 13-1 D-6).

| 키 | 질문 | 보기 (값 — 화면 문구) | 점수 |
|---|---|---|---|
| `q1` | 주식 투자를 해 본 기간 | `none` 없음 · `under_1y` 1년 미만 · `1_3y` 1~3년 · `over_3y` 3년 이상 | 경험 0 · 1 · 2 · 3 |
| `q2` | 거래해 본 상품 (여럿 고름, 1개 이상. `deposit`은 혼자만) | `deposit` 예적금만 · `fund_etf` 펀드·ETF · `kr_stock` 국내 주식 · `us_stock` 해외 주식 · `derivatives` 레버리지 ETF·선물·옵션 | 경험: `kr_stock` 1 + `us_stock` 1 + `derivatives` 2 (합계 최대 3). 성향: `derivatives`가 있으면 1 |
| `q3` | 주식 거래 빈도 | `never` 해 본 적 없음 · `yearly` 1년에 몇 번 · `monthly` 한 달에 몇 번 · `daily` 거의 매일 | 경험 0 · 1 · 2 · 3 |
| `q4` | "PER, 손절, 지정가"를 남에게 설명할 수 있나요 | `unknown` 모름 · `heard` 들어 봄 · `explain` 설명할 수 있음 | 경험 0 · 1 · 2 |
| `q5` | 1,000만 원을 넣었다면 견딜 수 있는 손실 | `no_loss` 원금 손실은 싫다 · `loss_10` −10%까지 · `loss_20` −20%까지 · `more` 그 이상도 괜찮다 | 성향 0 · 1 · 2 · 3 |
| `q6` | 주로 생각하는 투자 기간 | `years` 몇 년 이상 · `weeks` 몇 주 · `intraday` 하루 안 | 성향 0 · 1 · 2 |
| `q7` | 투자 목적 | `practice` 연습·공부 · `growth` 꾸준한 자산 증식 · `short_term` 짧은 기간 수익 | 성향 0 · 1 · 2 |

- **경험 점수** = `q1` + `q3` + `q4` + `q2`(경험), 0~11 → 0~2 `intro`(입문) · 3~5 `novice`(초급) · 6~8 `intermediate`(중급) · 9 이상 `expert`(숙련).
- **성향 점수** = `q5` + `q6` + `q7` + `q2`(성향), 0~8 → 0~1 `stable`(안정형) · 2~3 `stable_seeking`(안정추구형) · 4~5 `neutral`(위험중립형) · 6 `active`(적극투자형) · 7 이상 `aggressive`(공격투자형).
- **`recommendedBeginnerMode`** = 경험 단계가 `intro`·`novice`면 `true`, `intermediate`·`expert`면 `false` (성향은 추천에 쓰지 않는다).
- 예: `q1 none, q2 [deposit], q3 never, q4 heard, q5 loss_10, q6 weeks, q7 practice` → 경험 1(`intro`), 성향 2(`stable_seeking`), 추천 켬.

### 모의 트레이딩 (`backend/trading`)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/market` | – | `200 MarketStatus` |
| `GET /api/stocks/search?q=&limit=20` | `q`는 종목명 일부나 종목코드 | `200 {"results": StockItem[]}` (`q`가 비면 `[]`) |
| `GET /api/stocks/{symbol}` | – | `200 StockDetail` · `404` |
| `GET /api/quotes?symbols=005930,000660` | 쉼표 구분, 최대 50개 | `200 {"quotes": Quote[], "asOf": string}` (모르는 종목은 빠진다). 맨 위 `asOf`는 **응답 시각**이다 (가격의 기준 시각은 각 `Quote.asOf`) |
| `GET /api/account` | – | `200 AccountSummary` |
| `GET /api/account/equity?days=30` | – | `200 {"points": {"day": string, "equityKrw": number}[]}` (일별 자산, 과거 → 최신. 그날 기록은 **KR 기준일이 오늘이 된 뒤**(국내 거래일 15:40 KST = 정규장 종료 15:30 + 10분 이후) 하루 한 번 남긴다 — 국내 보유는 그날 종가, 미국 보유는 그때의 최신 미국 종가(장마감 기준, `AccountSummary.pricesAsOf.US`와 같은 값 — 15:40 KST에는 그날 새벽에 끝난 뉴욕 정규장의 종가)로 평가한다. 구현: 2026-10-05 (Claude). 그 전 기록은 기록한 때의 가격) |
| `GET /api/orders?status=active\|all` | 기본 `active`(대기·보유), 페이지 | `200 {"count", "results": Order[]}` (최신순) |
| `POST /api/orders` | `{"symbol", "quantity", "orderType": "MARKET"\|"LIMIT", "limitPrice"?, "targetPrice"?, "stopPrice"?, "days"?, "style"?: "swing"\|"long"}` | `201 OrderResult` · 거절 `400 {"detail"}`. `long` 매수가 비중 점검(`assess_position`)에서 막히면 `400 {"detail", "reasonCodes": string[]}` (`Response`를 직접 돌려준다). `style` 규칙은 아래 "보유 방식" (구현: 2026-10-05 (Claude)) |
| `PATCH /api/orders/{id}` | `{"targetPrice"?, "stopPrice"?, "days"?}` | `200 Order` · `long` 주문에 셋 중 하나라도 주면 `400` (구현: 2026-10-05 (Claude)) |
| `POST /api/orders/{id}/sell` | – (보유 전량 매도. 대기 주문이면 취소) | `200 OrderResult` |
| `POST /api/orders/{id}/cancel` | – (체결 대기 주문만) | `200 Order` |
| `GET /api/fills` | 페이지 | `200 {"count", "results": Fill[]}` (최신순) |
| `GET /api/reservations` | – | `200 {"results": Reservation[]}` |
| `DELETE /api/reservations/{id}` | – | `204` |
| `GET /api/ranking` | – | `200 Ranking` |

종목 경로의 `GET /api/stocks/{symbol}/fundamentals`는 "장기투자" 절에 있다.

주문 규칙 (엔진 `PaperExecutor` 그대로, `docs/DECISIONS.md` 4-2):
- 매수 주문 하나가 포지션 하나다. **같은 종목은 포지션 하나만** (진행 중 주문이 있으면 거절), **매도는 전량**이다.
- 체결은 정규장 안에서만. 시장가는 확인 가격(현재가·최우선 호가의 중간값)에 바로 체결, 지정가는 확인 가격 ≤ 지정가면 체결하고
  그날 정규장이 끝날 때까지 안 되면 취소. 국내 종목은 정수 주.
- **정규장 밖 시장가 매수·매도는 예약**으로 들어가고(`OrderResult.reservation`), 엔진(`run_engine`)이 다음 정규장 시작에 실행한다.
  정규장 밖 지정가 매수는 체결 대기 주문으로 받는다.
- `targetPrice`와 `stopPrice`는 함께 주거나 함께 뺀다 (손절가 < 기준가 < 목표가). `days`는 보유 기한(오늘부터 달력 일수).
  주면 엔진이 목표·손절·기한 조건을 2회 연속 확인했을 때 자동으로 판다. `days`를 주지 않으면 기한 없이 목표·손절만 본다
  (엔진 CLI는 기본 30일이지만 웹은 넣지 않는다).
- 예약 실행이 증권사 조회 실패 같은 일시 오류로 안 되면 정규장 시작 뒤 10분 동안 다시 시도하고, 그래도 안 되거나 주문이 거절되면
  예약을 지운다 (사유는 `run_engine` 콘솔에 남는다).
- 남의 주문·예약은 `404`.
- 화면의 시장가 매수 추정 금액·최대 수량은 **직전 장마감 종가 기준**이고 실제 체결은 주문 시점(장중) 확인 가격이다. 화면에
  "직전 장마감 가격 기준 추정이에요. 시장가는 주문 시점 가격으로 체결돼요"를 적는다 (API 변화 없음).
- `PATCH /api/orders/{id}`의 "손절가 < 현재가 < 목표가" 검사는 **`PATCH`를 받은 때의 현재가**(`market.last_price`, 장중이면 장중 가격)로 한다 (주문을 낸 때의 가격이 아니다).
  그래서 화면의 종가로는 맞아 보여도 `400`이 날 수 있다. 그 `400` 문장에는 현재가 숫자를 넣지 않는다 (공통 규칙 "장중 가격 숫자는 문장에 넣지 않는다").

**보유 방식 `style`** (2026-10-04 결정 — 구현: 2026-10-05 (Claude), `docs/DECISIONS.md` 14-3):
- `POST /api/orders`의 `style`은 `"swing"`·`"long"`만 받는다. 모르는 값은 `400`.
  `style`이 없으면 `targetPrice`·`stopPrice`·`days`가 모두 없을 때 `long`, 하나라도 있으면 `swing`이다.
- **`swing`은 `targetPrice`와 `stopPrice`가 둘 다 있어야 한다** (2026-10-05 확정). `style: "swing"`을 주고 둘 중 하나라도 없으면 `400`,
  `style` 없이 `days`만 주면(→ `swing`) 역시 `400`이다 — 스윙의 자동 매도는 목표·손절이 기준이고, 기한만 있는 주문은 만들지 않는다. `days`는 선택이다.
- `long`(장기 보유)이면 `targetPrice`·`stopPrice`·`days`를 받지 않는다 (주면 `400`). **자동 매도가 없다** (보유 기한도 없다 — 사용자가 팔 때까지 보유).
- `long` 매수는 손절 기반 수량 계산 대신 리스크 엔진의 비중 점검(`assess_position(price, quantity, account, limits) -> (ok, reasons, codes)`:
  매수 가능 금액 · 종목당 비중 한도 100% · 총 금액 한도 `MAX_TOTAL_INVEST_KRW`)을 통과해야 한다. `price`는 지정가 주문이면 지정가, 시장가면 현재가(실시간 시세와 같은 값 — 화면의 예상 금액과 같다. 받지 못하면 직전 종가, 2026-10-06 바뀜),
  자산은 장마감 기준 평가다. 막히면 `400 {"detail": 사유들을 "; "로 이은 것, "reasonCodes"}` — 코드는 `cash_short`·`position_limit`·`total_limit` ("실행 불가 사유 코드" 표).
  이 점검을 통과한 뒤 실제 접수(엔진 `buy_blockers`, 장중 가격)에서 막히면 다른 주문처럼 `400 {"detail"}`이다. 수량은 사용자가 정한다 (점검이 줄이지 않는다).
  시장가 `long` 매수인데 직전 종가를 받지 못하면 점검 전에 `400 {"detail": "확인된 가격이 없어 주문하지 않음"}`(`reasonCodes` 없음)이다. 매수 금액이 자산보다 크면 `cash_short`와 `position_limit`이 같이 나올 수 있다 (2026-10-05 구현).
- `style`은 주문 뒤에 바뀌지 않는다. `long` 주문에 `PATCH`로 `targetPrice`·`stopPrice`·`days`를 주면 `400`.
- 정규장 밖 시장가 매수의 예약은 **예약을 받을 때** 위 규칙으로 `style`을 정해 `Reservation.style`에 저장하고(`long` 비중 점검도 그때 한다), 실행할 때는 **저장한 `style`로** 주문한다 (다시 추론하지 않는다). 매도 예약의 `style`은 `null`이다.
- 2026-10-04 전에 만든 주문은 목표·손절·기한이 모두 없으면 `long`, 아니면 `swing`으로 바꿔 둔다 (마이그레이션. 기존 매수 예약의 `Reservation.style`도 같은 규칙으로 채운다).
  **기존 주문 예외** (2026-10-05): 목표·손절이 다 갖춰지지 않은 기존 주문(기한만·목표만·손절만 있는 것)도 `swing`으로 두고, 있는 값대로만 자동 매도한다 (기한만이면 기한 매도만).
  배지는 다른 스윙 주문과 같이 "스윙"이고 없는 목표·손절은 비워 보인다. `PATCH`는 이런 주문에 지금처럼 준 값만 더하거나 바꾸고, 둘 다 있으라고 요구하지 않는다.
  새 주문·새 예약에는 이 모양을 허용하지 않는다 (위의 "`swing`은 둘 다" 규칙).
- 2026-10-06: 단타 폐기로 `style`은 `swing`·`long`만 남았다. 마이그레이션(`trading/0003`)이 `day` 주문 중 체결 대기는 취소하고 나머지는 `swing`으로 바꿨다 (`docs/DECISIONS.md` 16-2).

**청산 사유** (`ExitReason` — `Order.exitReason`, `Fill.reason`, `TradePlan.exitReason`, `closed` 사건의 `details.exitReason`에 같은 값):

| 값 | 화면 | 언제 |
|---|---|---|
| `TARGET` | 목표가 도달 | 확인 가격이 목표가 이상인 것을 2회 연속 확인 |
| `STOP` | 손절가 도달 | 확인 가격이 손절가 이하인 것을 2회 연속 확인 |
| `EXPIRED` | 보유 기한 경과 | `expireDate`가 지난 뒤 첫 정규장 확인 |
| `MANUAL` | 사용자 매도 | 사용자의 전량 매도 (계획 중단의 매도 포함) |

값은 8자 이하다 (DB 열 길이). 화면은 모르는 값이면 그대로 보인다.

### AI 분석 (`backend/analysis`)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/analyses?symbol=&verdict=&mine=` | 페이지, 셋 다 선택. `mine=1`(또는 `true`)이면 내가 요청한 분석만 (요청자 아이디가 나인 것 — 전략·CLI 실행은 빠진다. 응답의 `requestedBy`는 그대로 닉네임. 구현: 2026-10-05 (Claude)) | `200 {"count", "results": AnalysisSummary[]}` (최신순, 팀 전체 공용) |
| `GET /api/analyses/{id}` | – | `200 AnalysisDetail` · `404` |
| `GET /api/analyses/quota` | – | `200 AnalysisQuota` |
| `POST /api/analyses` | `{"symbol"}` | `202 {"jobId": number}` · 한도 초과 `429` · AI 키 없음 `503` |
| `GET /api/jobs/{id}` | – | `200 Job` · 남의 작업 `404` |

- 분석은 몇 분 걸린다. 프론트는 `POST` 뒤 `GET /api/jobs/{id}`를 5초 간격으로 확인하고, `DONE`이면 `result.analysisIds[0]`로 간다.
- 한도(팀원별 하루 횟수, 팀 전체 하루 AI 비용 예산)는 **엔진이 실제로 시작한 작업을 실패해도 센다** (실패는 대부분 AI 비용을 쓴 뒤에 난다).
  팀 전체 예산 `AI_DAILY_BUDGET_USD`는 리포트와 같이 쓴다 (2026-10-08 — 전에는 분석 수만 셌다): 분석 예상 비용(0.3/종목) + 리포트 실제 `cost_usd`(자동 리포트 포함)를 뺀 나머지로
  분석 하나를 더 못 하면 `429 {"detail": "오늘 팀 전체 AI 비용 예산($10, 분석·리포트 합)을 다 썼습니다."}`. 셈은 `reports/limits/budget.py`의 `used_usd`와 같다.
- 분석 결과는 팀 전체가 같이 본다 (요청자 표시). 지금 종가·등락률은 프론트가 `/api/quotes`로 따로 받는다 (장마감 기준).
- 분석 상세의 가격은 `priceAtAnalysis`(분석 시각 가격)이고, 지표·일봉의 기준일은 `dataAsOf`다. 뉴스는 `newsItems`(제목·매체·시각)와 출처 표기 `newsProvider`로 보인다.
- 리포트 탭의 "교차검증 분석" 묶음과 종목 상세의 보조 버튼 "AI 교차검증 분석"이 이 API를 쓴다 (`docs/DECISIONS.md` 13-1 D-1).

---

# AI 리포트 (`backend/reports`) — Agents Orchestration과 Trace

작성 2026-10-02. 종목별로 AI 리포트를 신청하고, 여러 Agent가 협업하는 과정(Trace)을 화면에서 본다. 배경은 `docs/DECISIONS.md` 9장,
개념은 `docs/교육용문서.md`(04 Distributed Collaboration)를 그대로 따른다.
**2026-10-07 구현 (Claude, 사용자 요청 — `docs/design/AI_AGENT_WORKFLOW.md`, `docs/DECISIONS.md` 19장)**: Agent·Orchestrator가 돈다 (`ExecutionPlan.implemented = true`).
엔진 루프(`run_engine`)의 "리포트 실행" 단계가 `requested` 리포트를 하나씩 잡아 실행 계획대로 Worker를 돌리고 Shared State·Trace를 남긴다 (`reports/orchestration/runner.py` → `orchestrator.py`).
팀(`team`)은 둘이다: **`stock_report`**(종목 리포트 — 팀원 신청과 자동 리포트)와 **`stock_selection`**(하루 한 번 자동 리포트할 종목을 고르는 매매 종목 선정 —
`symbol`은 시장 코드 `"KR"`, `source: "auto"`). 선정 실행은 리포트 목록에 기본으로 나오지 않는다 (`?team=stock_selection`으로 본다).

**2026-10-04 추가 (구현 전 계약)**: 장애 주입(`chaos`), 복구 요약(`recovery`), 자동 리포트(`source`), PDF, 복구 지표, 복구 Trace 사건.
그중 PDF(`GET /api/reports/{id}/pdf`)와 선별 결과(`GET /api/reports/screening`)는 2026-10-04에 서버가 내기 시작했다 (표의 "구현" 표시).
2026-10-07(담당 4, T4-1): `ReportSummary`의 `source`·`chaosEnabled`·`costUsd`·`hasPdf`, 자동 리포트의 `requestedBy` "자동", `ReportDetail`의 `chaos`·`recovery`를
서버가 내기 시작했다 ("(구현)" 표시). `recovery`는 Trace 계산(T4-7) 전까지 장애 없음 고정값, `hasPdf`는 `pdf_path` 파일이 있을 때만 true(그 열을 채우는 것은 PDF 쪽 일),
`chaos`는 장애 주입 신청(T4-6) 전까지 늘 null이다.
2026-10-07(담당 4, T4-6): `POST /api/reports`의 `chaos`를 받는다 (`reports/autohealing/chaos.py`). `enabled: false`면 저장하지 않아 `chaos`는 null,
켜면 기본값·seed를 채워 저장한다. 주입한 timeout은 실제로 기다리지 않고 바로 실패로 처리한다 (시험 시간을 줄인다).
2026-10-08: 신청에서 직접 주는 `seed`는 0 이상 2^53 미만 정수만 받는다 (그 밖은 `400`).
2026-10-07(담당 4, T4-7): `recovery`를 Trace로 계산하고(`reports/autohealing/stats.py`, 셈법 `docs/tasks/00-공통.md` 9절 — 화면 `frontend/src/lib/recovery.ts`와 같다), `GET /api/reports/recovery-stats`를 낸다.
아직 끝나지 않은 실행의 장애는 `failures`에만 들고 `recovered`·`unrecovered`에는 들지 않는다.
담당별 할 일은 `docs/tasks/`, 셈법과 모듈 경계는 `docs/tasks/00-공통.md`. 아래에서 "(추가)"로 표시한 것은 아직 서버가 내지 않는다.

## 타입

```ts
type TraceStatus = "started" | "completed" | "failed" | "blocked" | "skipped";
// action (누가 남기는지와 details는 docs/tasks/00-공통.md 9절). 모르는 값도 그대로 보여 준다.
//   workflow_started · workflow_completed · workflow_failed                      actor "orchestrator"
//   agent_started · agent_completed · agent_failed · agent_skipped               actor = Worker id
//   agent_retry · agent_failover  (추가: 복구 과정. 같은 모델 재시도 / 대체 모델 전환)  actor = Worker id
//   review_retry                  (추가: 검토 RETRY → 다시 작성)                   actor "orchestrator"
//   join_completed · join_blocked                                                actor "join_guard", details.step
//   handoff_started · handoff_completed · handoff_blocked                        actor "handoff_guard", details.to
// workflow_failed.details.reason (실패 사유 코드, 00-공통.md 9절): join_blocked · review_failed · timeout · engine_restarted · exception ·
//   agent_failed (2026-10-07 추가: Join이 없는 단계의 필수 Worker가 끝내 실패) · no_llm (2026-10-07 추가: AI 연결 키 없음) ·
//   expired (2026-10-07 추가: 24시간 넘게 기다린 신청을 실행하지 않고 끝냄)
// agent_skipped.details.reason: join_blocked · fail_fast · review_failed, 그 밖에는 workflow_failed의 사유 코드 (timeout·agent_failed 등)
// review_retry.details: {round, target, issues: ["주장 — 문제", ...], instructions}
// agent_completed.details (검토 Worker): verdict, score. 2026-10-12 (DECISIONS 30장): 선정 검토의 마지막 검토가 RETRY였지만 코드 점검(후보 표 밖 종목·고위험 공시·
//   권유 표현·가격·목표가)을 통과해 남은 지적을 기록하고 통과하면 acceptedWithNotes: true (state.results.selection_review_agent에도 같은 키 — 코드만 붙인다)
// agent_completed.details.changed (2026-10-12, 선정 Worker가 검토 RETRY로 다시 쓸 때만): 이전 선정안과 달라진 곳 ["구성·순위" | "<코드> reason" | "<코드> evidence" | "summary"]
//   (빈 목록이면 아무것도 고치지 않은 것)
// workflow_failed.details.message (선택): exception이면 예외 글, review_failed이면 남은 검토 지적 줄을 " / "로 이은 것 (2026-10-12, 300자. 지적이 없으면 "검토 판정 FAIL" 또는 "검토 판정 RETRY")
// agent_failed는 두 가지다: details.final = false 는 LLM 호출 한 번의 실패(재시도·전환으로 이어진다),
// details.final = true 는 그 Worker를 포기한 것. details.injected = true 는 장애 주입으로 일으킨 실패.
// LLM 호출 한 번은 최대 4회 시도한다 (첫 시도 + 재시도 3회, 모델마다 2회 — 00-공통.md 7절). 넘거나 deadline이 지나면 그 Worker를 포기한다.
type ErrorType = "timeout" | "server_error" | "bad_output" | "unknown";

interface TraceEvent {            // 구조화된 Trace의 사건 하나
  step: number;                 // 전체 실행에서의 사건 순서 (1부터)
  actor: string;                // Worker id(예: "market_agent") 또는 Guard("join_guard", "handoff_guard") 또는 "orchestrator"
  action: string;
  status: TraceStatus;
  provider: string | null;      // 실제 LLM 실행 정보 (Guard·Orchestrator 사건은 null)
  model: string | null;
  latencyMs: number | null;     // 응답 또는 실패까지 걸린 시간
  details: Record<string, unknown>;  // 오류와 추가 정보. Guard 사건은 대상을 넣는다: join_guard는 {"step": <Join하는 step id>},
                                     // handoff_guard는 {"to": <넘겨받는 Worker id>} (화면이 이 값으로 그래프의 어느 노드인지 찾는다)
  at: string;
}

interface SharedState {           // Orchestrator만 갱신한다
  taskId: string;               // "report-<id>"
  status: "requested" | "running" | "completed" | "failed";
  currentStep: string | null;   // 실행 계획의 step id (예: "parallel_research". 선정 실행은 "candidate_research" 등)
  results: Record<string, unknown>;   // 출력 계약을 통과한 Worker 결과만
  errors: Record<string, string>;     // Worker id → 오류
  completedAgents: string[];
  failedAgents: string[];
}

interface Worker {
  id: string; title: string; goal: string;
  provider: string | null; model: string | null;   // 아직 정하지 않았으면 null
  fallbacks: string[];          // (추가) 주 모델이 실패하면 쓰는 대체 모델 (지금은 하나 — healing.FALLBACK_POOL에서 차단이 없을 때 고르는 모델. 2026-10-08)
  outputContract: string;       // 역할별 출력 계약 이름
}

interface PlanStep {
  id: string; title: string;
  mode: "parallel" | "sequential";
  workers: string[];            // Worker id
  required: string[];           // 필수 Worker (실패하면 Join을 막는다)
  optional: string[];           // 선택 Worker (실패해도 계속한다)
  dependsOn: string[];          // 먼저 끝나야 하는 step id
  join: boolean;                // 앞 단계 결과를 Join Guard로 확인한 뒤 실행하는지
  timeoutSec: number | null;
  retry: { target: string; maxRounds: number } | null;   // (추가) 검토 단계: RETRY 판정이면 target Worker를 다시 실행 (maxRounds는 1~3)
}

interface ChaosConfig {           // (구현) 장애 주입 설정 (docs/tasks/00-공통.md 5절). 리포트 워크플로우에만 적용된다
  enabled: boolean;
  probability: number;          // 0~1. 호출 하나가 실패할 확률
  errorTypes: ErrorType[];      // 일으킬 실패 종류 (unknown 제외)
  workers: string[] | null;     // 대상 Worker (null이면 전부)
  scope: "primary" | "all";     // primary: 주 모델 호출만 실패 (대체 모델로 복구를 보인다) · all: 대체 모델까지 실패
  seed: number;                 // 같은 시험을 다시 돌릴 수 있게 서버가 정해 저장한다 (신청에서 직접 주면 0 이상 2^53 미만 정수)
}

interface RecoverySummary {       // (구현) 이 리포트의 장애·복구 요약 (Trace에서 계산. 셈법은 00-공통.md 9절)
  failures: number;             // 장애 건수 (Worker 실행마다 첫 실패를 1건으로)
  recovered: number;            // 자동 복구된 건수
  unrecovered: number;          // 포기한 건수
  injected: number;             // 장애 건 중 주입된 것
  recoveryMs: number | null;    // 복구된 건의 복구 시간 합 (없으면 null)
  models: Record<string, string>;   // Worker id → 최종적으로 답한 모델
}

interface Handoff { from: string; to: string; responsibility: string; maxHops: number; }

interface ExecutionPlan {
  team: "stock_report" | "stock_selection"; title: string;   // 2026-10-07: 팀 둘 (GET /api/reports/plan?team=)
  failurePolicy: "fail_fast" | "best_effort" | "required_optional";
  steps: PlanStep[];            // 실행 순서대로
  workers: Worker[];            // steps와 handoffs에 나오는 모든 Worker
  handoffs: Handoff[];
  implemented: boolean;         // Agent 실행이 구현됐는지. 2026-10-07부터 true
}

interface ReportSummary {
  id: number;
  symbol: string; name: string; market: Market;
  status: SharedState["status"];
  currentStep: string | null;
  team: "stock_report" | "stock_selection";   // (구현: 2026-10-07) 어느 팀의 실행인지. 선정 실행은 symbol이 시장 코드("KR"), opinion·oneLiner는 null
  source: "user" | "auto";      // (구현) 팀원 신청 / 자동 리포트(거래대금 상위 선별)
  requestedBy: string;          // 신청한 팀원의 닉네임. 자동 리포트는 "자동"
  chaosEnabled: boolean;        // (구현) 장애 주입을 켜고 신청했는지
  costUsd: number | null;       // (구현) LLM 비용 (끝나기 전엔 지금까지의 합)
  hasPdf: boolean;              // (구현) GET /api/reports/{id}/pdf 가 되는지
  canDelete: boolean;           // (2026-10-08, DECISIONS 25장) 내가 신청했고 끝난(completed·failed) 종목 리포트면 true → DELETE /api/reports/{id}. 자동 리포트·선정 실행·남의 것은 false
  opinion: "buy" | "hold" | "avoid" | null;   // AI 의견 = results.report_agent.verdict. status가 completed일 때만, 그 밖은 null
                                              // (2026-10-04 합의, 컨셉 계획 B3 — 구현: 2026-10-05 (Claude). 2026-10-05: 담당 4 대신 Claude가 `payloads.summary`에 넣는다 — docs/DECISIONS.md 14-2)
  oneLiner: string | null;      // 한 줄 요약 = results.report_agent.oneLiner (80자). opinion과 같은 규칙 (2026-10-04 합의, 컨셉 계획 B3 — 구현: 2026-10-05 (Claude))
                                // 서버는 앞뒤 공백을 지우고 80자로 자른다. 모르는 verdict, 문자열이 아니거나 빈 oneLiner, results 모양이 틀리면 그 필드는 null
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

interface RecoveryStats {         // (구현) GET /api/reports/recovery-stats
  from: string; to: string; days: number;
  reports: number; reportsWithFailures: number;
  failures: number; recovered: number; unrecovered: number; injected: number;
  autoRecoveryRate: number | null;   // recovered ÷ failures × 100 (장애가 없으면 null)
  meanRecoveryMs: number | null;
  byErrorType: { errorType: ErrorType; failures: number; recovered: number }[];
  byWorker: { worker: string; failures: number; recovered: number }[];
  recent: { reportId: number; symbol: string; worker: string; errorType: ErrorType; injected: boolean;
            recovered: boolean; recoveryMs: number | null; at: string }[];   // 최근 20건, 최신순
}

interface ScreeningResult {       // 자동 리포트의 그날 선별 결과 (엔진 screen_market 결과 + 선정 팀 결과. 파일을 그대로 낸다)
  market: Market; at: string; rankCount: number; eligibleCount: number; checked: number;
  picks: Record<string, unknown>[];     // 최종 종목 (선정 전에는 규칙 점수 상위). symbol · name · score · rsi · tradingAmountRank 등은 늘 코드 값
                                        // (구현: 2026-10-07) 선정 뒤에는 + aiRank(number|null) · aiReason(string|null) · theme(string|null) · filledByRule(boolean)
                                        // (구현: 2026-10-08) 다시 시도로 더한 종목은 + retryRound(1|2). picks는 그날 리포트한 종목 전부다 (아래 retries)
  dropped: Record<string, unknown>[];   // 규칙에서 떨어진 종목과 사유
  excluded: Record<string, unknown>[];  // ETF 등 제외 종목과 사유
  reportIds: number[];                  // 그날 만든 자동 리포트 (선정 뒤 auto.request가 채운다)
  recommendationIds: number[];          // 그날 만든 자동 추천 (자동 리포트의 AI 추천, 또는 AUTO_RECOMMEND=demo의 시연 추천 — 아래 "AI 추천" 절)
  // (구현: 2026-10-07, AUTO_REPORT=on — docs/design/AI_AGENT_WORKFLOW.md 1·4·5장) 예전 파일에는 없을 수 있다
  candidates?: Record<string, unknown>[];   // 규칙을 통과한 후보 전부 (점수 순, 최대 30) — 선정 팀이 보는 후보 표
  selection?: { reportId: number | null; status: "running" | "done"; top: number };   // 선정 실행 (Report team "stock_selection"). top = 고를 종목 수 (AUTO_REPORT_TOP)
  selectedBy?: "ai" | "rule" | null;        // ai: 선정 팀이 고르고 선정 Guard가 거름 · rule: Fallback(규칙 점수 상위 → 선정 Guard) · null: 선정 중
  fallbackReason?: string | null;           // rule일 때 사유 코드 (실패 사유 코드 + "no_candidates")
  aiPicks?: { symbol: string; rank: number; reason: string; evidence: string[] }[];   // 선정 팀 원안 (Guard 전)
  filtered?: { symbol: string; name: string | null; reason: string; stage: "candidates" | "warnings" | "filing" | "theme" }[];  // 선정 Guard가 뺀 종목 (후보 밖이면 name null)
  coverSent?: boolean;                      // 그날 표지(선별 요약)를 Discord로 보냈는지
  retries?: number;                         // (구현: 2026-10-08) 다시 시도한 횟수 0~2: 그날 리포트가 모두 끝났는데 손익비가 스윙 기준(1.5) 이상인
                                            // 추천이 없으면 아직 리포트하지 않은 다음 종목 top개를 선정 Guard로 골라 다시 낸다 (docs/DECISIONS.md 22장)
}
// 같은 폴더의 곁 파일: <날짜>-<시장>.skip.json (증권사 조회 불가로 그날 건너뜀 — 다시 하지 않는다), <날짜>-<시장>.cover.html (표지)

interface ReportQuota {           // GET /api/reports/quota — 하루 리포트 한도 (D-7, 2026-10-04 합의 — 구현: 2026-10-05 (Claude))
  limit: number | null;         // 팀원별 하루 한도 AI_DAILY_REPORTS_PER_USER. null = 무제한 (기본값 — 2026-10-08 바뀜, 전 3)
  used: number;                 // 오늘(KST) 내가 신청한 리포트 중 한도에 세는 수 (장애 주입 없이 failed로 끝난 것은 빼고 — 아래 규칙)
  remaining: number | null;     // max(limit − used, 0), 무제한이면 null. 0이면 POST /api/reports가 429
  resetsAt: string;             // 한도가 다시 차는 시각 = 다음 날 00:00 KST
}

interface ReportDetail extends ReportSummary {   // Snapshot
  content: string | null;       // 리포트 본문 (Markdown). Agent 구현 전에는 null
  state: SharedState;
  trace: TraceEvent[];          // step 오름차순
  plan: ExecutionPlan;          // 그 리포트 팀(team)의 실행 계획 (구현: 2026-10-07)
  chaos: ChaosConfig | null;    // (구현) 신청 때의 장애 주입 설정 (서버가 채운 기본값·seed 포함)
  recovery: RecoverySummary;    // (구현) Trace로 계산 (reports/autohealing/stats.py)
}
```

## 엔드포인트

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/reports/plan?team=` | `team` 기본 `stock_report` | `200 ExecutionPlan` (YAML Registry에서 읽은 실행 계획) · 모르는 `team` `400` (구현: 2026-10-07) |
| `GET /api/reports?symbol=&team=` | 페이지, `symbol` 선택, `team` 기본 `stock_report` (`stock_selection`이면 선정 실행 목록) | `200 {"count", "results": ReportSummary[]}` (팀 전체 공용, 최신순) · 잘못된 `team` `400` (구현: 2026-10-07) |
| `POST /api/reports` | `{"symbol", "chaos"?: {"enabled", "probability"?, "errorTypes"?, "workers"?, "scope"?, "seed"?}}` | `201 ReportDetail` · 같은 사람이 같은 종목으로 신청해 아직 끝나지 않은 리포트가 있으면 그것을 `200`으로 (한도를 넘었어도 돌려준다) · 없는 종목·잘못된 `chaos` `400` · 하루 한도 초과 `429 {"detail": string, "limit": number, "used": number}` (한도가 무제한(기본, 2026-10-08)이면 나지 않는다) (`detail` 예: "오늘 리포트 한도(3개)를 다 썼어요. 내일 0시에 다시 만들 수 있어요." — D-7, 구현: 2026-10-05 (Claude)) · (추가) AI 설정 없음 `503` · 증권사 조회 불가 `503` |
| `GET /api/reports/quota` | – | `200 ReportQuota` (D-7 — 구현: 2026-10-05 (Claude)) |
| `GET /api/reports?symbol=&source=&mine=` | 페이지, `symbol`·`source`(`user`\|`auto`)·`mine`(`1`이면 내가 신청한 것만) 선택, 같이 쓸 수 있다 | `source` (구현: 2026-10-07, 잘못된 값 `400`) · `mine=1` (2026-10-04 합의, 컨셉 계획 B8 — 구현: 2026-10-05 (Claude): `ReportsView.get` 한 줄. 자동 리포트는 신청자가 없어 빠진다) |
| `GET /api/reports/{id}` | – | `200 ReportDetail` · `404` (**Snapshot API**: 새로고침·연결 복구에 쓴다. 지운 리포트도 `404`) |
| `DELETE /api/reports/{id}` | – | `204` (2026-10-08, 아래 "리포트·계획 제안 지우기") · 남의 리포트·자동 리포트·선정 실행 `403 {"detail": "내가 신청한 리포트만 지울 수 있어요."}` · 아직 끝나지 않은 리포트 `400 {"detail": "아직 만드는 중인 리포트는 끝난 뒤에 지울 수 있어요."}` · 이 리포트의 계획 제안으로 진행 중인 계획이 있으면 `400 {"detail": "이 계획 제안으로 진행 중인 모의 자동매매가 있어 지울 수 없어요. 계획이 끝난 뒤에 지울 수 있어요."}` · 없거나 이미 지운 리포트 `404` |
| `GET /api/reports/{id}/events` | 헤더 `Last-Event-ID` 또는 `?after=<step>` | `200 text/event-stream` (**SSE**) · 미로그인 `401` JSON · `404` |
| `GET /api/reports/{id}/pdf?view=` | `view`: `easy`(쉬운 판) \| `expert`(자세한 판). 없으면 요청한 사람의 주린이모드(켬 → `easy`) — 2026-10-07 구현, `docs/DECISIONS.md` 20장 | 잘못된 `view` `400 {"detail": "view는 easy 또는 expert입니다."}` · `200 application/pdf` (A4. 처음 부르면 만들어 `PAPER_ROOT/reports/<id>.v<양식 판>.pdf`(Chrome이 없으면 `.html`)에 저장하고 다음부터 그 파일. `pdf_path` 열은 자동 리포트가 Discord로 보낸 파일(2026-10-07부터 쉬운 판)이고 이 API는 쓰지 않는다. 2026-10-05 구현: 양식 판 `TEMPLATE_VERSION`(`backend/reports/output/pdf.py`, 지금 4 — 2: 쉬운 요약·장마감 기준, 3: 이름 종이배·로고 머리, 4: 이름 모매매)을 파일 이름에 넣어, 양식이 바뀌면 판 번호 없는 예전 `<id>.pdf`(1판)·이전 판 파일을 쓰지 않고 새로 만든 뒤 지운다. 2026-10-07: 쉬운 판은 따로 `<id>.v<판>.easy.pdf` — 웹 쉬운 보기와 같은 문장으로 결론·신뢰·쉬운 요약·매매 계획(말로)·근거와 위험·이 의견이 틀리는 경우·세 가지 경우(1주 기준 %)·가격 흐름·조사 자료·용어 풀이를 싣고, 검토 점수·확률·신뢰도·모델 이름·비용은 싣지 않는다. 계좌마다 다른 값(수량·금액)은 넣지 않는다 — 파일이 리포트당 판마다 하나) · 완성 전 `409 {"detail"}` · `404` (선정 실행 `team: "stock_selection"`도 `404` — 2026-10-07) · Chrome이 없으면 `200 text/html`(같은 내용) — 2026-10-04 구현 |
| `GET /api/reports/recovery-stats?days=7` | `days` 1~90, 기본 7 | `200 RecoveryStats` (기간 = 오늘(KST) 포함 최근 `days`일 안에 만든 리포트, 모든 팀) · 잘못된 `days` `400 {"detail": "days는 1~90 사이의 정수입니다."}` — 2026-10-07 구현 (담당 4, T4-7) |
| `GET /api/reports/screening?market=KR&date=` | `date` 기본 오늘(KST) | `200 ScreeningResult` · 그날 선별이 없으면 `404` · 잘못된 `market`·`date` `400` — 2026-10-04 구현 (`reports/autoreport/auto.py`가 남긴 파일을 읽는다. 2026-10-07부터 선정 팀 결과 키가 더해진다) |

SSE 형식 (실행 Event를 발생 즉시 한 방향으로 전달):
- `event: trace` / `id: <step>` / `data: <TraceEvent JSON>` — `after`(또는 `Last-Event-ID`)보다 큰 step만, 순서대로.
- `event: state` / `data: <SharedState JSON>` — 상태가 바뀔 때.
- `event: end` / `data: {"status": ...}` — 전체 종료(completed·failed)이고 남은 사건이 없을 때 보내고 연결을 닫는다.
- 15초마다 `: keep-alive` 주석 줄. 서버는 한 연결을 60초 뒤 닫는다 (브라우저 `EventSource`가 `Last-Event-ID`로 다시 붙는다).
- **SSE가 실행 상태의 유일한 저장소가 되면 안 된다.** 상태와 Trace는 DB에 있고, 프론트는 먼저 Snapshot을 받은 뒤 SSE로 이어 받는다.
  SSE가 끊기거나 안 되면 Snapshot을 3초 간격으로 다시 받는다 (폴링). `plan.implemented`가 false이고 status가 `requested`면 SSE를 열지 않는다.

목록 카드의 결론과 매매 계획 연결 (2026-10-04 합의, 컨셉 계획 B3·B8 — 구현: 2026-10-05 (Claude): B3 `payloads.summary`의 두 필드와 B8 `?mine=1` 모두 Claude. 2026-10-05 바뀜 — B3는 원래 담당 4의 T4-1이었다):
- `opinion`·`oneLiner`는 `status`가 `completed`일 때만 `state.results.report_agent`의 `verdict`·`oneLiner`를 그대로 낸다 (`payloads.summary`).
  대기·실행 중·실패면 `null`이다 — 실행 중의 `report_agent` 결과는 검토 전이거나 RETRY로 다시 쓰이는 중이고, 실패한 리포트의 초안은 검토를 통과하지 않았다.
  `ReportDetail`은 `ReportSummary`를 이어받으므로 상세에도 같은 값이 있다. 쉬운 요약(B1)은 `state.results.report_agent.plainSummary`로 읽는다.
- 리포트와 매매 계획(추천)의 연결은 리포트 API에 넣지 않는다 (reports → autotrade 역방향 의존을 만들지 않는다). 프론트가 추천 API로 맞춘다:
  목록은 `GET /api/recommendations?source=report&status=open&limit=100` 한 번으로 받아 `sourceId`(= 리포트 id)로 카드에 붙이고,
  상세(매매 계획 카드)는 `GET /api/recommendations?source=report&sourceId={리포트 id}&status=all`로 받는다 (기한이 지난 추천까지 와야 "기한 지남" 상태를 보인다).
  두 쿼리는 지금 서버가 된다 (2026-10-04 `autotrade/views.py`로 확인. 페이지 상한은 100).

리포트·계획 제안 지우기 (2026-10-08 사용자 결정, DECISIONS 25장 — `backend/autotrade/hide.py`):
- **만든 사람만** 지운다: 리포트는 신청한 팀원(`canDelete`), 계획 제안(추천)은 `requestedBy`인 팀원. 자동 리포트·선정 실행·자동 추천은 아무도 지우지 않는다 (아래 autotrade의 자동 정리가 내린다).
- 지우기는 **숨김**이다: 행에 `deleted_at`을 적고 목록·상세·PDF·SSE·추천 API에서 뺀다(`404`). 행은 남으므로 AI 비용(`cost_usd`, 비용 예산)·하루 리포트 한도·복구 통계·관리 서버는
  지운 리포트도 그대로 센다 — **지워도 한도를 돌려받지 않는다**. 끝난(`completed`·`failed`) 리포트만 지운다.
- 리포트를 지우면 그 리포트의 계획 제안도 같이 숨기고, 계획 제안을 지우면 출처 리포트도 같이 숨긴다 (분석·시연 추천은 추천만).
- 그 계획 제안으로 **진행 중인 계획**(누구 것이든 `active`·`entry_pending`·`holding`)이 있으면 지우지 않는다 (`400`). 끝난 계획은 그대로 남고 계획 상세(`TradePlanDetail.recommendation`)도 계속 열린다.
- 두 DELETE가 같은 함수(`autotrade/hide.py`)를 쓴다 — 리포트·추천 숨김과 진행 중 계획 확인을 한 트랜잭션에서 추천 행을 잠그고 한다. 활성화도 같은 행을 잠그고 숨김을 다시 본다
  (화면이 읽은 뒤 지워진 추천은 활성화 `404`). reports가 autotrade를 부르는 것은 리포트 끝 알림(`reports/output/alerts.py`)과 같다 — 리포트 API 응답에 추천 정보를 넣지 않는 위 규칙은 그대로다.

리포트 글 후처리와 쉬운 글 Guard (2026-10-08, DECISIONS 23장 — `backend/reports/guardrails/tidy.py`, `guards.easy_jargon`):
- Worker 결과는 출력 계약을 통과한 뒤 State에 넣기 전에 후처리한다: 쉼표 없는 원 금액("201000원" → "201,000원"), 한국어 문장 속 의견 영어
  (buy·hold·watch·sell·avoid → 매수·지켜보기·지켜보기·매도·부정적, 뒤 조사 맞춤). `verdict` 같은 값 필드와 `citations`는 바꾸지 않는다. 추천의 근거·위험도 이 값을 옮긴다.
- 종목 리포트 초안의 쉬운 글(`oneLiner`·`plainSummary`·`reasons`·`risks`)에 전문 용어(`tidy.JARGON` — 이동평균선·지지선·RSI·PER·밸류에이션 등)가 있으면
  검토 Worker가 코드 점검 문제로 RETRY한다(Trace `review_retry`에 걸린 용어). 검토 반복 한도를 넘으면 실패시키지 않고 용어 뒤에 괄호 풀이를 붙여 통과한다.
  전문 용어와 지표 숫자는 `markdown` 본문에만 쓴다. 최소 손익비 숫자는 지금처럼 프롬프트에 넣지 않는다.
- 뉴스 근거에서 블로그·개인 콘텐츠를 뺀다 (네이버 블로그·프리미엄콘텐츠·포스트, 티스토리, 브런치 — 엔진 `data/news.py`). 교차검증 분석·장기투자 뉴스도 같다.
- 화면은 옛 리포트(이 규칙 전)에도 같은 숫자·의견 치환과 용어 풀이(`frontend/src/lib/reports.ts`, `lib/reportTerms.ts`)를 그릴 때 적용한다.

하루 리포트 한도 (2026-10-04 합의, D-7 — 구현: 2026-10-05 (Claude), `backend/reports/limits/quota.py`, `docs/DECISIONS.md` 14-6):
- 팀원마다 오늘(KST) 한도에 세는 리포트 수가 `AI_DAILY_REPORTS_PER_USER`(기본 3)에 닿으면 `POST /api/reports`가 새 리포트를 만들지 않고 `429 {"detail", "limit", "used"}`를 돌려준다.
- 세는 것: 오늘 내가 신청한 리포트에서 **장애 주입 없이 `failed`로 끝난 것을 뺀** 수. 장애 주입을 켠 리포트는 실패해도 센다.
  `chaos` 열이 생기기 전에는 장애 주입 여부를 알 수 없으므로 failed는 모두 빼고 센다 (열이 생기면 `chaos.enabled`가 참인 failed만 센다).
- 같은 종목의 진행 중 리포트를 돌려주는 `200` 경로는 새로 세지 않는다. 자동 리포트(`source: "auto"`)·선정 실행(`team: "stock_selection"`)은 신청자가 없어 세지 않는다.
- 비용 합산 한도(분석 + 리포트 $, `AI_DAILY_BUDGET_USD`)는 팀원(2) 몫이다 — 팀 파일 `backend/reports/limits/budget.py`의 `check(now)`를 `ReportsView.post`에서 횟수 한도 바로 뒤에 부른다
  (구현: 2026-10-08 `dy` — 팀 전체 오늘(KST) 분석 예상 비용 + 리포트 실제 `cost_usd`(실패·자동 리포트 포함)가 한도 이상이면 `429 {"detail": "오늘 AI 비용 예산을 다 썼어요. 내일 0시에 다시 신청할 수 있어요."}`. 자동 리포트 실행은 막지 않는다.
  본문에 `limit`·`used`가 없는 것이 횟수 한도 `429`와 다르다 — 프론트는 이것으로 둘을 나눠 문구를 고른다(2026-10-08). 분석 요청(`POST /api/analyses`)도 같은 예산을 본다)
  (넘으면 `429`, 본문 형식은 2가 이 절에 적는다). `quota.py`(횟수, Claude)와 파일을 나눈다 (`docs/tasks/00-공통.md` 2절).

---

# AI 추천 · 매매 계획 · 자동매매 · 알림 (`backend/autotrade`, `backend/notifications`)

작성 2026-10-04. 서비스의 최종 흐름: **AI가 종목·진입가·목표가·손절가·기대수익을 추천 → 사용자가 웹이나 Discord 링크로 "계획 활성화"
→ 엔진 루프가 계획대로 모의 주문·체결 대기·보유 감시·청산을 자동으로 하고 → 단계마다 웹 알림과 Discord로 알린다.**
배경과 결정은 `docs/DECISIONS.md` 12장, 담당과 남은 일은 `docs/tasks/06-추천·자동매매.md`.

- **AI는 제안만 한다.** 넣을 돈은 사용자가 정하고(2026-10-11 — `budgetPercent` 또는 `budgetKrw`), 수량 계산·한도 점검·활성화 가능 여부·체결은 결정론적 코드(엔진 리스크 엔진 `judge/risk.py`, 모의 체결기)가 정한다.
  최소 손익비 기준(스윙 1.5)은 AI 프롬프트에 넣지 않는다 (리스크 엔진이 거른다). 손절 가격(`targets.stop`)은 코드가 정한다 — 시세 조사 `market_agent`의 `stop` (2026-10-07, `docs/DECISIONS.md` 21장).
  예외 (2026-10-12, `docs/DECISIONS.md` 31장): **시연용 수동 시작**(`manualStart`) — 사용자가 '수동매매 (시연용)'을 누르고 확인한 계획만 리스크 엔진의 손익비·기대값 점검(`reward_risk_low`·`ev_negative`)을 건너뛴다. 나머지 점검은 그대로다 (아래 규칙 "시연용 수동 시작").
- 추천의 출처는 셋이다: `report`(AI 리포트 Agent 워크플로우의 `report_agent` 결과 — 추천 워크플로우 팀이 구현), `analysis`(지금 있는 AI 교차검증 분석의
  BUY 판정), `demo`(**시연용 규칙 추천, AI 아님** — 일봉 ATR로 목표·손절을 정한다. 화면에 "연습용 예시 계획 (AI 아님)"을 표시한다).
- 추천은 팀 전체가 같이 보고, **활성화는 팀원마다 자기 모의 계좌에** 한다 (같은 추천을 여러 명이 각자 활성화할 수 있다).
- 가격은 장마감 기준이다 (공통 규칙): 미리 보기의 `lastPrice`·자산(수량·금액은 진입가로 계산 — 2026-10-11), `priceAtCreation`(모든 출처 — `from_analysis`도 분석 시각 가격이 아니라 만들 때의 종가), 시연 추천의 진입가·일봉. 진입 체결 이후의 진행(체결 확인·재주문·청산)은 장중 확인 가격이다.

## 타입

```ts
type RecommendationSource = "report" | "analysis" | "demo";
type RecommendationStatus = "open" | "expired";   // open: validUntil 전이라 활성화할 수 있음. expired: 기한이 지났거나 가격이 이미 손절가·목표가를 지남 (expiredReason)

interface Recommendation {
  id: number;
  source: RecommendationSource;
  sourceId: number | null;        // report면 리포트 id, analysis면 분석 id, demo면 null
  requestedBy: string | null;     // 리포트·분석을 신청한(또는 시연 추천을 만든) 팀원의 닉네임. 자동이면 null
  symbol: string; name: string; market: Market; currency: Currency;
  priceAtCreation: number | null; // 추천을 만들 때의 직전 장마감 종가 (장마감 기준 — 구현: 2026-10-05 (Claude)). 출처와 무관하게 같다: analysis 추천(`from_analysis`)도
                                  // 분석 시각 가격(`priceAtAnalysis`)이 아니라 추천을 만들 때의 종가. 2026-10-04 전에 만든 추천은 그때 장중 가격(analysis는 분석 시각 가격)
  entryPrice: number;             // AI가 제안한 진입가 (지정가로 주문한다)
  targetPrice: number;            // 목표가
  stopPrice: number;              // 손절가. 0 < stopPrice < entryPrice < targetPrice
  holdingDays: number;            // 보유 기간 (거래일, 1~20)
  targetReturn: number;           // 목표가 도달 시 수익률 = targetPrice / entryPrice - 1 (비용 전)
  stopLossRate: number;           // 손절 시 손실률 = stopPrice / entryPrice - 1 (음수, 비용 전)
  rewardRisk: number;             // 손익비 (수수료·세금·손절 미끄러짐 반영. 리스크 엔진과 같은 계산)
  probability: number;            // 손절 전에 목표가에 도달할 확률 (0~1)
  probabilityAssumed: boolean;    // AI가 확률을 주지 않아 0.5로 둔 경우 true
  expectedReturn: number;         // 기대수익률 = (확률×1주 이익 − (1−확률)×1주 손실) ÷ 진입가 (비용 반영)
  confidence: number | null;      // 0~100 (AI의 확신도. 없으면 null)
  summary: string;                // 한 줄 결론
  reasons: string[];              // 근거 (최대 3)
  risks: string[];                // 리스크 (최대 3)
  riskLevel: "low" | "medium" | "high" | null;   // 리스크 점검 Agent 결과 (없으면 null)
  status: RecommendationStatus;
  expiredReason: "deadline" | "below_stop" | "above_target" | null;   // (2026-10-08, DECISIONS 25장) status가 expired인 까닭 — 기한 지남 / 가격이 이미 손절가 이하 /
                                  // 이미 목표가 이상 (아래 "가격이 지난 계획 제안 자동 정리"). open이면 null
  validUntil: string;             // 이 시각까지 활성화할 수 있고, 계획의 진입 기한도 이 시각이다
  createdAt: string;
  myPlan: { id: number; status: TradePlanStatus } | null;   // 내가 활성화한 계획 (진행 중인 것, 없으면 가장 최근 것)
  planCount: number;              // 이 추천으로 활성화한 계획 수 (팀 전체)
  blockedBy: string[];            // 계좌와 무관하게 지금 시작(활성화)을 막는 사유 코드 — reward_risk_low · ev_negative · expired · halted 중 (아래 "실행 불가 사유 코드"와 같은 코드,
                                  // 같은 계산). 목록·홈에서 '시작할 수 없음'을 미리 보이고 정렬하는 데 쓴다. 비어 있어도 내 계좌 사정으로 막힐 수 있다 — 최종 판단은 RiskPreview
                                  // (2026-10-08, DECISIONS 23장)
  canDelete: boolean;             // (2026-10-08, DECISIONS 25장) 내가 만든(requestedBy가 나) 제안이면 true → DELETE /api/recommendations/{id}. 자동·남의 것은 false
}

interface RiskPreview {           // 리스크 엔진이 "내 계좌"로 계산한 결과 (활성화 전 확인용). 가격·자산은 장마감 기준
                                  // 2026-10-11: 수량 = 사용자가 정한 금액 ÷ 1주 매수 비용(진입가 × (1 + 수수료) × 환율), 국내는 내림 정수 주, 미국은 금액을 센트로 내린 소수점 수량.
                                  //   금액(budgetKrw·budgetPercent)이 없으면 크기 계산 없이 점검만 한다 — quantity·amountKrw·expectedProfitKrw·maxLossKrw 0, limitedBy·maxLossRate null, largeLoss false
  approved: boolean;              // 리스크 엔진 통과 (금액이 없으면 크기와 무관한 점검만 — 손익비·기대값·매수 유의·일일 한도).
                                  // 시연용 수동 시작(manualStart=1)이어도 리스크 엔진의 원래 판정 그대로다 — 건너뛴 사유가 있으면 false (2026-10-12)
  activatable: boolean;           // approved && 추천이 open && 같은 종목의 진행 중 계획·주문 없음 && 중단 스위치 꺼짐
                                  // (금액이 없으면 "금액만 정하면 시작할 수 있음"의 뜻 — 화면 머리 칩·시작할 수 없는 이유에 쓴다)
                                  // 2026-10-12: manualStart=1이면 skippedCodes를 뺀 남은 사유로만 정한다 (approved=false·activatable=true가 될 수 있다)
  reasons: string[];              // 활성화할 수 없는 사유 (activatable이면 [])
  reasonCodes: string[];          // reasons[i]의 사유 코드 = reasonCodes[i] (같은 길이·같은 순서). 코드 표는 아래 "실행 불가 사유 코드"
                                  // (2026-10-04 합의, 컨셉 계획 B4 — 구현: 2026-10-05 (Claude))
  skippedReasons: string[];       // 2026-10-12 (DECISIONS 31장 — 구현: 2026-10-12 (Claude)). 시연용 수동 시작(?manualStart=1)으로 건너뛴 사유 원문 — reasons에는 들지 않는다.
                                  //   일반 미리 보기는 늘 []
  skippedCodes: string[];         // 2026-10-12. skippedReasons[i]의 코드 (같은 길이·같은 순서) — reward_risk_low · ev_negative 중에서만 나온다. 일반 미리 보기는 []
  quantity: number;               // 주문할 수량 (국내는 정수 주)
  amountKrw: number;              // 매수 금액 (원화 환산)
  expectedProfitKrw: number;      // 목표가 도달 시 이익 (비용 반영)
  maxLossKrw: number;             // 손절 시 손실 (비용 반영, 양수)
  limitedBy: string | null;       // 수량을 정한 것: "내가 정한 금액" (2026-10-11 — 전: "건당 위험 한도" | "매수 가능 금액" | "총 금액 한도" | "유동성 한도" | "예산"). 금액이 없으면 null
  budgetMode: "percent" | "amount" | null;   // 2026-10-11. 요청이 budgetPercent면 "percent", budgetKrw면 "amount", 없으면 null
  budgetPercent: number | null;   // 2026-10-11. 요청한 % (1~100 정수, 매수 가능 금액 기준). percent가 아니면 null
  budgetKrw: number | null;       // 사용자가 정한 금액 (원). percent면 floor(buyingPowerKrw × budgetPercent / 100)로 바꾼 값. 없으면 null
  buyingPowerKrw: number;         // 2026-10-11. 매수 가능 금액 = 현금 − 대기 매수 금액 (AccountSummary.buyingPowerKrw와 같다, 음수면 0). budgetPercent의 기준
  equityKrw: number;              // 2026-10-11. 총자산 (장마감 기준, AccountSummary.equityKrw와 같다). maxLossRate의 분모
  maxLossRate: number | null;     // 2026-10-11. maxLossKrw ÷ equityKrw (소수). 금액이 없거나 총자산이 0 이하면 null
  largeLoss: boolean;             // 2026-10-11. 손절 시 손실이 총자산의 1%(엔진 LIMITS SWING risk_per_trade)를 넘음 — 경고만, 활성화를 막지 않는다
  lastPrice: number | null;       // 직전 정규장 종가 (못 받으면 null). 목표가·손절가와 비교하는 가격 (price_passed)
                                  // — 2026-10-08: 기준일 뒤 정규장이 시작됐으면 price_passed는 장중 가격으로 본다 (공통 규칙 "리포트 시세". lastPrice는 그대로 종가)
  lastPriceAsOf: string | null;   // lastPrice의 기준 시각 (Quote.asOf와 같은 규칙. lastPrice가 null이면 null) — 구현: 2026-10-05 (Claude)
  priceBasis: "close";            // 가격 기준. 지금은 "close" 하나뿐 (총자산을 종가로 평가 — 2026-10-11부터 수량·금액은 진입가로 계산) — 구현: 2026-10-05 (Claude)
}

type TradePlanStatus = "active" | "entry_pending" | "holding" | "closed" | "cancelled" | "expired" | "failed";
// active 활성화됨(주문 전) · entry_pending 진입 지정가 주문 체결 대기 · holding 보유 중(목표·손절·기한 자동 감시)
// closed 청산 완료 · cancelled 사용자가 중단 · expired 진입 기한까지 체결되지 않음 · failed 주문할 수 없음(사유)
// 진행 중 = active · entry_pending · holding. 나머지는 끝난 상태다 (다시 바뀌지 않는다).

interface TradePlan {
  id: number;
  recommendationId: number;
  symbol: string; name: string; market: Market; currency: Currency;
  source: RecommendationSource;
  status: TradePlanStatus;
  via: "web" | "discord";         // 어디서 활성화했나 (Discord 링크의 token으로 판단)
  manualStart: boolean;           // 2026-10-12 (DECISIONS 31장 — 구현: 2026-10-12 (Claude)). 시연용 수동 시작 — 손익비·기대값 점검을 건너뛰고 활성화한 계획. 그 밖의 계획은 false
  quantity: number;
  budgetMode: "percent" | "amount" | null;   // 2026-10-11. 넣은 돈을 정한 방식. null = 2026-10-11 전에 활성화한 계획 (리스크 엔진이 수량을 정함)
  budgetPercent: number | null;   // 2026-10-11. percent면 그 % (매수 가능 금액 기준), 아니면 null
  budgetKrw: number | null;       // 사용자가 정한 금액 (원, percent면 활성화 순간 바꾼 값). 2026-10-11 전 계획은 선택 예산 또는 null
  entryPrice: number; targetPrice: number; stopPrice: number; holdingDays: number;   // 활성화 때 추천에서 복사
  entryDeadline: string;          // 진입 기한 (= 추천의 validUntil)
  orderId: number | null;         // 지금 연결된 모의 주문 (Order). 재주문하면 바뀐다
  fillPrice: number | null; filledAt: string | null;
  exitPrice: number | null; exitReason: ExitReason | null; closedAt: string | null;   // ExitReason은 "모의 트레이딩" 절
  pnlKrw: number | null;          // 실현 손익 (청산 뒤)
  failureReason: string | null;   // failed·expired·cancelled의 사유 (사람이 읽는 말)
  activatedAt: string;
  updatedAt: string;
}

type PlanEventKind =
  | "activated"        // 사용자가 활성화 (details: {via, budgetMode, budgetPercent, budgetKrw, acknowledged}. acknowledged는 2026-10-04 합의 B5 — 구현: 2026-10-05 (Claude). budgetMode·budgetPercent는 2026-10-11)
                      //   2026-10-12: 시연용 수동 시작이면 + {manualStart: true, skippedCodes}, message "웹에서 계획 활성화 (시연용 수동 시작)" (일반 계획은 그대로)
  | "risk_checked"     // 리스크 엔진 점검 (details: {approved, quantity, limitedBy, rewardRisk, reasons})
                      //   2026-10-12: 시연용 수동 시작이면 approved false + {manualStart: true, skippedCodes, skippedReasons},
                      //   message "리스크 엔진 점검: {건너뛴 사유를 "; "로 이음} — 시연용 수동 시작으로 건너뜀. {넣은 돈}으로 {수량}"
  | "order_placed"     // 진입 지정가 주문 접수 (details: {orderId, limitPrice, quantity})
  | "order_requeued"   // 지정가가 그날 체결되지 않아 다음 정규장에 다시 주문 (details: {orderId, previousOrderId}, 수량이 줄었으면 + {quantity, previousQuantity})
  | "filled"           // 진입 체결 (details: {orderId, fillPrice, quantity})
  | "exit_requested"   // 사용자가 보유 중 계획을 중단 → 전량 매도 요청·예약 (details: {orderId, reservationId})
  | "closed"           // 청산 (details: {orderId, exitReason, exitPrice, pnlKrw})
  | "cancelled"        // 중단 (details: {reason})
  | "expired"          // 진입 기한 지남 (details: {reason, orderId})
  | "failed";          // 주문할 수 없음 (details: {reason}. 재주문 점검에서 막혔으면 + {orderId, reasonCodes} — reasonCodes는 2026-10-05 구현,
                      //   재주문 수량이 1주 미만이면 + {orderId, quantity}, 엔진이 진입 주문을 취소했으면 + {orderId})
// cancelled·expired·failed의 details.reason = 그 사건의 message = TradePlan.failureReason

interface PlanEvent {
  step: number;                   // 계획별 1부터
  kind: PlanEventKind | string;   // 모르는 값도 그대로 보여 준다
  message: string;                // 사람이 읽는 한 줄 ("삼성전자 28주 71,000원 지정가 매수 주문 접수")
  details: Record<string, unknown>;
  at: string;
}

interface TradePlanDetail extends TradePlan {
  recommendation: Recommendation;
  events: PlanEvent[];            // step 오름차순
}

type NotificationKind =
  | "recommendation" | "plan_activated" | "order_placed" | "order_requeued" | "filled" | "closed"
  | "cancelled" | "expired" | "failed" | "system"
  | "report_completed" | "report_failed"    // 리포트 완성 / 리포트 실패 (2026-10-04 합의, 컨셉 계획 B7 — 구현: 2026-10-05 (Claude)). 아래 "리포트 끝 알림"
  | "daily_move"                            // 오늘의 내 종목 뉴스 묶음 (사용자당 하루 1개, 웹만) — "장기투자" 절. 구현: 2026-10-05 (Claude)
  | "thesis_check";                         // 펀더멘털 점검 결과가 나빠짐 (웹만) — "장기투자" 절. 구현: 2026-10-05 (Claude)
// system은 시험 알림 등 그 밖의 것. 리포트 실패 알림은 system이 아니라 report_failed다.
// 화면은 모르는 kind도 기본 모양으로 보인다.

interface Notification {
  id: number;
  kind: NotificationKind | string;
  title: string;                  // "삼성전자 진입 체결". 받는 사람의 주린이모드에 따라 쉬운 문장·전문가 문장 (아래 규칙의 "알림 문장")
  body: string;                   // 한두 줄 (daily_move는 종목별 한 줄씩 최대 3줄 + 고정 문구)
  link: string | null;            // 웹 경로 ("/plans/3"). 프론트는 그대로 이동한다
  createdAt: string;
  readAt: string | null;
}

interface NotificationSettings {
  discordUserId: string | null;   // Discord 사용자 ID (숫자 17~20자리). 있으면 Discord 알림에 @멘션한다
  discordEnabled: boolean;        // 내 알림을 Discord로도 보낼지 (기본 true). 웹 알림은 항상 남는다
  webhookConfigured: boolean;     // 서버에 DISCORD_WEBHOOK_URL이 있는지 (없으면 Discord로는 아무것도 가지 않는다)
                                  // 2026-10-08부터 늘 false — Discord 알림을 꺼 두었다 (docs/DECISIONS.md 24장. 테스트 알림은 "not_configured")
}
```

## 엔드포인트

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/recommendations?status=open\|all&source=&sourceId=&symbol=` | 페이지. `status` 기본 `open`. `sourceId`는 `source`와 같이 (리포트·분석 화면이 자기 추천을 찾는다) | `200 {"count", "results": Recommendation[]}` (최신순, 팀 전체 공용). `source`가 `report`·`analysis`·`demo`가 아니면 `400` (2026-10-06: `source=day`도 모르는 값이라 `400`) |
| `GET /api/recommendations/{id}` | – | `200 Recommendation` · `404` (지운 추천도 `404`) |
| `DELETE /api/recommendations/{id}` | – | `204` (2026-10-08, AI 리포트 절 "리포트·계획 제안 지우기" — 리포트 추천이면 출처 리포트도 숨긴다) · 남이 만든·자동 추천 `403 {"detail": "내가 만든 계획 제안만 지울 수 있어요."}` · 진행 중인 계획이 있으면 `400 {"detail": "이 계획 제안으로 진행 중인 모의 자동매매가 있어 지울 수 없어요. 계획이 끝난 뒤에 지울 수 있어요."}` · 없거나 이미 지운 추천 `404` |
| `GET /api/recommendations/{id}/preview?budgetPercent=\|budgetKrw=&manualStart=` | 둘 중 하나 또는 없음 (2026-10-11). `budgetPercent`: 1~100 정수 (매수 가능 금액의 %). `budgetKrw`: 양수 (원). 없으면 크기 계산 없이 점검만. `manualStart`(2026-10-12, 선택 — 시연용 수동 시작 미리 보기): `1`·`true`면 켬, 없음·빈 값·`0`·`false`면 끔 (대소문자·앞뒤 공백 무시) | `200 RiskPreview` (장마감 기준 — 구현: 2026-10-05 (Claude)) · 둘 다 보냄 `400 {"detail": "budgetPercent와 budgetKrw 중 하나만 보냅니다."}` · `budgetKrw`가 숫자가 아니거나 0 이하, `budgetPercent`가 1~100 정수가 아님 `400` · `manualStart`가 그 밖의 값 `400 {"detail": "manualStart는 true 또는 false여야 합니다."}` (`reasonCodes` 없음) · 증권사 조회 불가 `503` |
| `POST /api/recommendations/{id}/activate` | `{"budgetPercent": number \| "budgetKrw": number, "token"?: string, "acknowledged"?: boolean, "manualStart"?: boolean}` — 2026-10-11: `budgetPercent`(1~100 정수)와 `budgetKrw`(양수, 원) 중 **하나가 필수** (없으면 `400 {"detail": "투자 금액을 정해 주세요 (budgetPercent 또는 budgetKrw)."}`, 둘 다면 미리 보기와 같은 `400`, 둘 다 `reasonCodes` 없음) | `201 TradePlanDetail` (첫 주문 접수가 거절된 드문 경우도 `201` — 계획 `status: "failed"`, 아래 규칙) · 활성화할 수 없으면 `400 {"detail": 사유들을 "; "로 이은 것, "reasonCodes": string[]}` (`reasonCodes[i]`는 `detail`을 이은 사유 i번째의 코드 — 같은 길이·같은 순서, 미리 보기의 사유 + 장중 확인의 `price_passed` + 동시 활성화의 `plan_exists`. `Response`를 직접 돌려준다 — 구현: 2026-10-05 (Claude)) · 입력 오류(`budgetPercent`·`budgetKrw`·`acknowledged` 형식, 금액 없음, `token`이 만료·위조)는 `400 {"detail"}` (`reasonCodes` 없음) · `404` · 증권사 조회 불가 `503`. `acknowledged`: 실행 확인 체크리스트를 모두 켰는지 → `activated` 사건 details `{via, budgetMode, budgetPercent, budgetKrw, acknowledged}`에 남긴다 (없으면 `false`, 불리언이 아니면 `400`. 서버가 활성화를 막지는 않는다 — 체크리스트는 화면 테스트로 보장) — (2026-10-04 합의, 컨셉 계획 B5 — 구현: 2026-10-05 (Claude)) `manualStart` (2026-10-12, DECISIONS 31장 — 구현: 2026-10-12 (Claude)): 시연용 수동 시작 — 없으면 `false`, JSON 불리언이 아니면(`"true"`·`1`·`null` 포함) `400 {"detail": "manualStart는 true 또는 false여야 합니다."}` (검사 순서: 넣을 돈 형식 → 금액 없음 → `acknowledged` → `manualStart` → `token`). `true`면 `reward_risk_low`·`ev_negative`만 건너뛰고(남은 사유가 있으면 위 `400 {"detail", "reasonCodes"}` — 건너뛴 코드는 넣지 않는다) `201 TradePlanDetail`(`manualStart: true`). 남은 사유가 없는데 건너뛸 것도 없으면 `400 {"detail": "손익비·기대값 점검에 막히지 않은 계획은 수동 시작(시연용) 없이 시작합니다."}` (`reasonCodes` 없음, 계획을 만들지 않는다) |
| `POST /api/recommendations/demo` | `{"symbol"?: string}` (없으면 시연 종목 목록에서 고른다) | `201 Recommendation` (source `demo`. 진입가는 직전 장마감 종가, ATR은 완성 일봉으로 — 구현: 2026-10-05 (Claude)) · 시연 추천이 꺼져 있으면(`AUTOTRADE_DEMO=off`) `403` · 하루 한도(`AUTOTRADE_DEMO_PER_USER`, 기본 5) 초과 `429` · 없는 종목·일봉 부족 `400` · 증권사 조회 불가 `503` |
| `GET /api/trade-plans?status=active\|all` | 페이지. 기본 `active`(진행 중 셋) | `200 {"count", "results": TradePlan[]}` (**내 것만**, 최신순) |
| `GET /api/trade-plans/{id}` | – | `200 TradePlanDetail` · 남의 계획 `404` |
| `POST /api/trade-plans/{id}/cancel` | – | `200 TradePlanDetail` · 이미 끝난 계획 `400` · 남의 계획 `404` |
| `GET /api/notifications?unread=1` | 페이지. `unread=1`이면 안 읽은 것만 | `200 {"count", "unreadCount", "results": Notification[]}` (내 것만, 최신순) |
| `POST /api/notifications/read` | `{"ids"?: number[], "all"?: boolean}` (둘 중 하나) | `204` (남의 알림 id는 무시) |
| `GET /api/notification-settings` | – | `200 NotificationSettings` |
| `PATCH /api/notification-settings` | `{"discordUserId"?: string \| null, "discordEnabled"?: boolean}` | `200 NotificationSettings` · `discordUserId`가 숫자 17~20자리가 아니면 `400` (빈 문자열·null이면 지운다) |
| `POST /api/notification-settings/test` | – | `202 {"detail": string, "discord": "queued" \| "not_configured" \| "disabled"}` (웹 알림 하나를 만들고, 가능하면 Discord로도 보낸다) · 1분에 한 번만 (넘으면 `429`) |

규칙:
- **활성화** = 그 순간 사용자가 정한 금액으로 수량을 계산하고 리스크 엔진이 점검한 뒤(`RiskPreview`와 **같은 계산**, 화면에 보인 수량이 주문 수량이 된다) 계획을 `active`로 만든 뒤, 바로 한 번 진행해
  **진입 지정가 주문**(가격 = `entryPrice`, 목표·손절 = 추천 값, 기한 = `holdingDays`를 달력 일수로 바꾼 값)을 낸다. 주문은 기존 모의 주문
  (`POST /api/orders`와 같은 `trading.service.buy`, 요청자 `plan:<계획 id>`)이라 "내 주식"·주문 목록에도 보인다.
  **활성화 점검**(미리 보기 계산 + 아래 장중 확인)에서 막히면 `400 {"detail", "reasonCodes"}`이고 아무것도 만들지 않는다. 점검을 통과해 계획을 만든 뒤 첫 주문 접수가
  거절되면(점검과 접수 사이의 드문 경합 — 그사이 현금이 줄었거나 같은 종목 주문이 생김 등) 활성화는 `201`이고 계획은 이미 `failed`(`failureReason` "주문할 수 없음: …", `failed` 사건)로 돌아온다.
  화면은 `201`의 `status`를 보고 실패를 보인다. 증권사 조회의 일시 오류로 첫 주문을 못 내면 계획은 `active`로 남고 엔진 루프가 다시 낸다.
- **넣을 돈** (2026-10-11 사용자 결정, DECISIONS 28장 — 구현: 2026-10-11 (Claude)): 사용자가 정한다. 리스크 엔진(건당 위험 1%)은 수량을 정하지도 줄이지도 않는다.
  - `budgetPercent`는 그 순간의 매수 가능 금액(`buyingPowerKrw`)에 곱해 원 단위로 내린 금액이다 (계획의 `budgetKrw`에 그 값을 남긴다). 미리 보기와 활성화 사이에 매수 가능 금액이 바뀌면 수량도 바뀐다 (드문 경합).
  - 수량 = 금액 ÷ 1주 매수 비용(진입가 × (1 + 수수료) × 환율). 국내는 내림 정수 주, 미국은 금액을 센트로 내린 소수점 수량. 1주(미국 $1) 미만이면 `budget_too_small`.
  - 한도는 **점검만** 한다 — 넘으면 줄이지 않고 막는다 (장기 매수 `assess_position`과 같은 방식): 매수 금액(수수료 포함)이 매수 가능 금액보다 크면 `cash_short`, 총 금액 한도를 넘으면 `total_limit`.
    그 밖의 점검(손익비·기대값·매수 유의·일일 손실 한도·기한·같은 종목·중단 스위치·`price_passed`)은 그대로다.
  - 손절 시 손실이 총자산의 1%를 넘으면 `largeLoss: true` — 화면은 경고 한 줄만 보이고 막지 않는다 (손실 금액은 실행 확인 체크로 받는다).
- **시연용 수동 시작** (2026-10-12 사용자 결정, DECISIONS 31장 — 구현: 2026-10-12 (Claude)): 금액 없는 미리 보기가 **손익비·기대값(`reward_risk_low`·`ev_negative`)으로만** 막은 계획을
  사용자가 '수동매매 (시연용)'(매매 계획 카드·실행 확인의 막힌 화면 → `/recommendations/{id}?manual=1`)으로 직접 시작한다. 이 기능이 보이는 모든 자리에 "시연용"을 쓴다.
  - 건너뛰는 것은 그 둘뿐이고(`backend/autotrade/plans/risk.py` `MANUAL_SKIP_CODES` = 화면 `frontend/src/lib/autotrade.ts` `MANUAL_SKIP_CODES`), 건너뛰는 때는 셋뿐이다:
    미리 보기 `?manualStart=1`, 활성화 본문 `"manualStart": true`, `TradePlan.manualStart`인 계획의 재주문 점검. 설정 키로 켜고 끄지 않는다 (`AUTOTRADE_DEMO`와 무관).
  - 그대로인 것: 넣을 돈 필수(28장)와 수량 계산, 매수 유의·일일 손실·일일 거래 한도, `budget_too_small`·`cash_short`·`total_limit`, `expired`, `plan_exists`·`position_exists`, `halted`,
    `price_passed`(활성화의 장중 확인 포함), 주문 접수 때 엔진 모의 체결기의 점검. 엔진(`judge/risk.py`)은 그대로다 — 웹의 활성화 판단에서 사유를 `reasons`에서 `skippedReasons`로 옮길 뿐이다.
  - 기록: `TradePlan.manualStart`(활성화 때 한 번 쓰고 바꾸지 않는다), `activated`·`risk_checked` 사건 details(`manualStart`·`skippedCodes`·`skippedReasons`, `approved: false`)와 message,
    이 계획의 모든 알림 제목 앞 `[시연용 수동 시작] ` (웹 알림·Discord 편지함, 본문·숫자 줄은 그대로). 화면: 계획·목록·홈의 배지 "시연용 수동 시작", 실행 확인의 경고색 안내·넷째 확인 체크·"모의 수동매매 시작 (시연용)" 버튼(전문가 보기 "수동매매 활성화 (시연용)"), Discord 링크(`?t=`)로 들어왔으면 위쪽 Discord 띠 문장도 시연용 수동 시작을 말한다.
  - 재주문도 같은 둘만 건너뛴다 (나머지 사유로 막히면 지금처럼 `failed`). 추천의 `blockedBy`와 목록·홈의 '시작할 수 없음' 표시는 바뀌지 않는다.
- **활성화의 장중 확인** (구현: 2026-10-05 (Claude)): 미리 보기와 같은 계산을 통과한 뒤 하나를 더 본다. 그 시장이 정규장 중이고 장중 확인 가격이 이미
  목표가 이상이거나 손절가 이하면 활성화하지 않는다 (`400`, `reasonCodes`에 `price_passed`. 문장: "장중 가격이 이미 목표가 이상이에요" / "장중 가격이 이미 손절가 이하예요" —
  장중 가격 숫자는 문장에 넣지 않는다). 정규장 밖이면 이 확인은 없다 (종가 기준 판단만).
  2026-10-08: 기준일 뒤 정규장이 시작됐으면(정규장 중, KR 15:30~15:40) 종가 점검 대신 장중 확인 가격으로만 본다 — 종가는 지난 가격이다 (공통 규칙 "리포트 시세").
- 엔진 루프(`run_engine`)가 진행 중 계획을 계속 진행한다: 체결되면 `holding`, 지정가가 그날 정규장에 체결되지 않아 취소되면 진입 기한 안에서
  다음 정규장에 **다시 주문**(`order_requeued`), 기한이 지나면 주문을 취소하고 `expired`, 보유 중 목표·손절·기한으로 청산되면 `closed`.
  모의 주문을 "내 주식"에서 직접 취소하면 계획은 `cancelled`, 직접 매도하면 `closed`(`MANUAL`)가 된다.
  재주문 때는 리스크 엔진으로 다시 점검하고 **같은 수량**으로 낸다 — 매수 가능 금액·총 금액 한도가 모자라면 그 안으로 **줄이기만** 한다 (늘리지 않는다. 2026-10-11 바뀜: 건당 위험 한도로 다시 계산하지 않는다 — 2026-10-11 전 계획도 같다.
  재주문의 가격 점검은 지금처럼 장중 확인 가격). 줄인 수량이 1주(미국 $1) 미만이면 `budget_too_small`로 막힌다. 그때 막히면(지금 가격이 목표가 이상·손절가 이하, 매수 가능 금액 부족 등)
  계획은 `failed`로 끝난다 (`failureReason` "다시 주문할 수 없음: 장중 가격이 이미 목표가 이상이에요" 등 — 장중 가격 숫자를 넣지 않는다, 공통 규칙). 엔진이 체결 시점에 취소한 진입 주문(현금 부족 등)도 `failed`다 (`cancelled`는 사용자가 멈춘 경우만).
- **중단**(`cancel`): `active`·`entry_pending`이면 주문을 취소하고 `cancelled`. `holding`이면 전량 매도를 요청하고(정규장 밖이면 매도 예약)
  `exit_requested`를 남긴다 — 계획은 매도가 끝나면 `closed`(`MANUAL`)가 된다. 이미 매도 예약이 있으면 사건을 다시 남기지 않고 지금 계획을 `200`으로 돌려준다.
- **가격이 지난 계획 제안 자동 정리** (2026-10-08 사용자 결정, DECISIONS 25장 — `autotrade/sources.invalidate`): 엔진 루프 "추천 수집"이 1분에 한 번 open 추천의 현재가
  (실시간 시세와 같은 값, 정규장 밖이면 마지막 가격)를 보고 **손절가 이하면 `expired`·`expiredReason: "below_stop"`, 목표가 이상이면 `"above_target"`**으로 바꾼다. 다시 open으로 돌리지 않는다.
  현재가를 받지 못한 종목은 다음 번에 본다. 목록 `status=open`에서 빠지고 `blockedBy`에 `expired`가 들어간다. 이미 시작한 계획은 자기 값으로 그대로 진행한다.
  목록의 `blockedBy`는 지금처럼 시세를 보지 않는다(23장) — 시세는 이 정리 단계가 엔진에서 한 번 본다. 화면 문장(장중 가격 숫자는 넣지 않는다): 쉬운 보기 "가격이 이미 손절 가격 아래로 내려가 끝난 제안이에요" ·
  "가격이 이미 목표 가격을 넘어 끝난 제안이에요", 전문가 보기 "손절가 이탈로 만료" · "목표가 도달로 만료".
- AI가 준 진입·목표·손절은 추천을 만들 때 **호가 단위로 내려** 맞춘다 (모의 주문에 들어가는 값과 같게). 미국 종목은 정한 금액만큼 소수점(금액) 수량으로 산다.
- 같은 종목에는 진행 중 계획이 **하나만** 있다 (모의 계좌의 "같은 종목은 포지션 하나만" 규칙과 같다).
- **Discord 활성화 링크** = `{PUBLIC_BASE_URL}/recommendations/{id}?t=<token>`. 웹 화면이 `t`를 읽어 활성화 요청의 `token`으로 보낸다.
  token은 서버가 서명한 값(추천 id + 만료 = `validUntil`)이고, 맞으면 `via: "discord"`로 기록한다. **로그인은 링크로도 필요하다**
  (링크는 팀 채널에 올라가므로 링크만으로 남의 계좌에 계획을 만들 수 없게 한다).
- 알림: 추천이 생기면 신청한 팀원(없으면 팀 전체)에게, 계획의 상태가 바뀌면 그 계획의 주인에게 웹 알림을 만든다. Discord는 서버의
  `DISCORD_WEBHOOK_URL` 채널 하나로 보내고(없고 `OPENCLAW_TARGET`이 있으면 openclaw로), 주인의 `discordUserId`가 있으면 멘션한다. Discord 전송은 엔진 루프가 보낸다
  (실패하면 1회 재시도 → 첨부 없이 글만 → 그래도 안 되면 실패로 기록. 웹 알림은 그대로 남는다. 한 바퀴에 15초까지만 보내고 나머지는 다음 바퀴로).
  AI가 쓴 글 속의 멘션(`<@…>`·`@everyone`)은 무력화하고, 우리가 붙인 받는 사람 멘션만 울린다. 시험 API의 `not_configured`는 Webhook·openclaw가 모두 없다는 뜻이다.
- **알림 문장** (2026-10-04 합의, 컨셉 계획 B6 — 구현: 2026-10-05 (Claude)): 웹 알림의 `title`·`body`는 **받는 사람의 주린이모드**를 따른다.
  켬(진단 전 기본)이면 쉬운 문장("모의 계좌에서 삼성전자를 70,600원에 3주 샀어요. 77,000원이 되면 팔고, 67,700원 아래로 내려가면 손실이 더 커지지 않게 팔아요."),
  끔이면 전문가 문장(2026-10-04 전 문장 — 이미 "모의 주문 #…"이 들어 있다). 문장은 `backend/autotrade/text.py`에 모은다. Discord(팀 공용 채널 하나)는 받는 사람과 무관하게
  쉬운 문장 + 숫자 한 줄로 하나만 보내고 맨 앞에 **`[모매매 · 모의투자]`**를 붙인다(2026-10-07 서비스 이름을 "모매매"로 바꿈 — 전에는 `[종이배 · 모의투자]`, 그 전은 `[AI 리포트 데스크 · 모의투자]`). `PlanEvent.message`·`failureReason`은 원래 용어 그대로다 (전문가 보기).
  - **주문·체결·청산·예약·계획 활성화를 말하는 쉬운 문장에는 "모의"를 꼭 넣는다** ("모의 계좌에서 …", "모의 자동매매 …") — 공용 채널·초보 화면에서 실제 매매로 읽히지 않게.
    테스트(`autotrade/tests`): `text.py`의 쉬운 문장 중 그 kind(`plan_activated`·`order_placed`·`order_requeued`·`filled`·`closed`·`cancelled`·`expired`·`failed`)마다 "모의"가 들어 있고,
    Discord 글이 `[모매매 · 모의투자]`로 시작한다.
  - 권유 표현은 쓰지 않는다 — 공통 규칙 "금지 표현"의 `PERSUASION` (`forbidden_phrases(text)`가 빈 목록인지 쉬운 문장·전문가 문장 전부 테스트).
- **Discord로 보내지 않는 알림** (웹 알림만): `daily_move`·`thesis_check`(사용자별 묶음이라 팀 채널 하나에 사람 수만큼 쌓이고, 등락 설명이 공개 채널에서 권유로 읽힐 수 있다). 구현: 2026-10-05 (Claude).
- **알림 합치기** (2026-10-08, DECISIONS 23장): 한 계획에서 몇 초 안에 이어진 사건(활성화 → 주문 접수 → 체결처럼 활성화 요청 하나 안에서 일어난 것)은
  웹 알림·Discord를 **마지막 상태 하나**로 보낸다 (예: 바로 체결되면 "샀어요" 하나). 사건 기록(`PlanEvent`, 계획 타임라인)은 그대로 다 남긴다.
  구현 (2026-10-08, `autotrade/plans/executor.py` `activate`): 바로 체결 → `filled` 하나("모의 자동매매를 시작하자마자 모의 계좌에서 … 샀어요"),
  지정가 대기 → `order_placed` 하나(제목 "{종목} 모의 자동매매를 시작하고 매수 주문을 냈어요", 본문에 매도 규칙·진입 기한), 실패 → `failed` 하나,
  첫 주문을 일시 오류로 못 냄 → `plan_activated` 하나. 엔진 루프가 나중에 만드는 사건(체결·재주문·청산 등)은 지금처럼 하나씩이다.
- 프론트 폴링: 알림 개수 15초, 진행 중 계획 5초(진행 중 계획이 있을 때만. 없으면 30초 — 2026-10-08), 추천 목록 30초.

### 실행 불가 사유 코드 (`RiskPreview.reasonCodes`, 2026-10-04 합의, 컨셉 계획 B4 — 구현: 2026-10-05 (Claude))

화면이 사유 문장을 맞추지 않고 코드로 쉬운 문장(`frontend/src/lib/plainText.ts`, 컨셉 계획 4-5)을 고른다. 서버는 **이 표의 코드만** 낸다 (새 사유를 더하면 이 표를 먼저 고친다).
화면은 모르는 코드면 같은 자리의 사유 원문(`reasons[i]`, 또는 `detail`을 `"; "`로 나눈 i번째)을 보인다. 사람이 읽는 원문(`reasons`, `400`의 `detail`)은 그대로 둔다.

**코드가 나가는 자리** (이 밖의 응답에는 `reasonCodes`가 없다):

| 자리 | 형식 |
|---|---|
| `RiskPreview.reasonCodes` (`GET /api/recommendations/{id}/preview`) | `reasons`와 같은 길이·같은 순서 |
| 활성화 거절 `POST /api/recommendations/{id}/activate` → `400 {"detail", "reasonCodes"}` | `detail`을 이은 사유와 같은 길이·같은 순서 (`price_passed`·`plan_exists` 포함) |
| 장기 매수의 비중 점검 거절 `POST /api/orders`(long) → `400 {"detail", "reasonCodes"}` | 같은 규칙 (`cash_short`·`position_limit`·`total_limit`) |
| `RiskPreview.skippedCodes` (미리 보기 `?manualStart=1`일 때만, 2026-10-12) · 시연용 수동 시작 계획의 `activated`·`risk_checked` 사건 details `skippedCodes` | `skippedReasons`와 같은 길이·같은 순서. `reward_risk_low`·`ev_negative` 중에서만 |

시연용 수동 시작(위 규칙, DECISIONS 31장)이면 `reward_risk_low`·`ev_negative`는 `reasonCodes`가 아니라 `skippedCodes`로 간다 (화면 상수 `frontend/src/lib/autotrade.ts` `MANUAL_SKIP_CODES`와 같다).
`400` 본문에 `reasonCodes`가 있으면 "실행 불가 사유", 없으면 입력 오류다 (화면이 둘을 나눈다). 본문에 `detail` 밖의 필드가 있으므로 `Response`를 직접 돌려준다 (`config.api`의 예외는 `detail` 밖을 버린다).
엔진 `RiskAssessment.codes`·`assess_position`의 `codes`가 사유와 같은 길이·순서로 코드를 내고, `autotrade/risk.preview`가 (코드, 문장) 짝으로 중복을 지운다.
엔진 접수 점검의 거절 `OrderRejected.codes`(`buy_checks`)에는 이 표 밖의 내부 코드(`invalid_order`·`market_closed`·`order_too_large`·`fx_unavailable`)도 있다 — API로 내지 않는다 (`trading.service`가 `400 {"detail"}`로 바꾸고, 쉬운 알림 문장은 이 표에 있는 코드만 쓴다. 2026-10-05 구현).

| 코드 | 조건 (지금 `reasons` 원문을 내는 곳) |
|---|---|
| `reward_risk_low` | 손익비가 최소 기준(스윙 1.5)보다 낮음 (리스크 엔진 `assess`) |
| `ev_negative` | 비용을 반영한 기대값이 0 이하 (`assess`) |
| `daily_loss_limit` | 일일 손실 한도 도달 (`assess`. SWING 한도(AI 추천 계획)는 style swing 주문의 손실만 센다 — 2026-10-05 구현, 장기 보유 손실은 어느 한도에도 세지 않는다) |
| `daily_trades_limit` | 일일 매매 건수 한도 도달 (`assess`. SWING에는 건수 한도가 없어 지금은 나오지 않는다 — 2026-10-06 단타 폐기로 하루 10건 한도(DAY)가 없어졌다) |
| `warning_stock` | 매수 유의 종목 (투자경고 등, `assess`) |
| `size_too_small` | 리스크 엔진이 정한 수량이 1주 미만 (미국 종목은 최소 주문 금액 미만) (`assess` — 엔진 CLI·엔진 자체 계좌. 2026-10-11부터 계획 미리 보기·활성화에서는 나오지 않는다) |
| `budget_too_small` | 내가 정한 금액(`budgetKrw`, 또는 `budgetPercent`로 바꾼 금액)으로 1주 미만 (미국 종목은 최소 주문 금액 $1 미만). 재주문에서 한도 안으로 줄인 수량이 1주 미만일 때도 (`assess_budget` — 2026-10-11) |
| `expired` | 추천의 활성화 기한(`validUntil`)이 지남 |
| `plan_exists` | 같은 종목에 진행 중인 내 계획이 있음 |
| `position_exists` | 같은 종목에 진행 중인 모의 주문이 있음 (같은 종목은 포지션 하나만) |
| `halted` | 중단 스위치가 켜져 있음 (새 모의 매수 중단) |
| `price_passed` | 가격이 이미 목표가 이상이거나 손절가 이하 — 미리 보기·활성화는 기준일 뒤 정규장이 시작됐으면(정규장 중 등, 공통 규칙 "리포트 시세" — 2026-10-08) 장중 가격으로(문장 "장중 가격이 이미 …"), 아니면 직전 종가로 본다. 재주문은 장중 확인 가격으로 본다 |
| `cash_short` | 장기 보유 매수 금액(수량 × 지정가 또는 직전 종가, 수수료 포함)이 매수 가능 금액보다 큼 (`assess_position`) — `POST /api/orders`(long). 구현: 2026-10-05 (Claude). 2026-10-11: 계획 미리 보기·활성화도 — 내가 정한 금액으로 산 매수 금액(수량 × 진입가, 수수료 포함)이 매수 가능 금액보다 큼 (`assess_budget`) |
| `position_limit` | 장기 보유 매수가 종목당 비중 한도(100%)를 넘음 (`assess_position`). 한도가 100%라 거의 나오지 않는다 — `POST /api/orders`(long). 구현: 2026-10-05 (Claude) |
| `total_limit` | 장기 보유 매수 뒤 총 투자 금액이 총 금액 한도(`MAX_TOTAL_INVEST_KRW`)를 넘음 (`assess_position`) — `POST /api/orders`(long). 구현: 2026-10-05 (Claude). 2026-10-11: 계획 미리 보기·활성화도 같은 조건 (`assess_budget`) |

### 리포트 끝 알림 (2026-10-04 합의, 컨셉 계획 B7 — 2026-10-04 규칙 바뀜, 구현: 2026-10-05 (Claude))

리포트 하나가 끝나면 신청자에게 알림이 **한 번만** 간다 (웹 알림 + Discord, `notifications.service.notify`). **알림은 모두 새 파일 `backend/reports/output/alerts.py`(Claude 담당)가 보낸다** —
팀원의 runner·healing은 사용자 알림을 보내지 않아도 된다 (`docs/DECISIONS.md` 14-5, `docs/tasks/00-공통.md` 8절). `backend/reports/autoreport/auto.py`(자동 리포트 B9)는 2026-10-07 사용자 요청으로 Claude가 구현했다 (`docs/DECISIONS.md` 19장).
- **보내는 자리 둘** (어느 쪽이 먼저 처리해도 한 번):
  - `alerts.notify_finished(report) -> None` — 끝난 리포트 하나를 바로 처리한다. 예외를 밖으로 내지 않는다. 팀 코드(runner 또는 팀의 `auto.after_finish`)가 리포트를 끝낸 뒤 불러도 되고 부르지 않아도 된다.
  - `alerts.sweep_finished(now, log) -> int` — `run_engine`의 "리포트 알림" 단계(추천 수집 다음)가 매 바퀴 부른다. 최근 24시간 안에 끝난 리포트 중 아직 알림이 없는 것을 처리하고 보낸 수를 돌려준다.
    그래서 팀 코드가 `notify_finished`를 부르지 않아도 엔진 루프 한 바퀴 안에 간다.
- **대상**: 팀원 신청 종목 리포트만 (`team: "stock_report"`). 선정 실행(`stock_selection`)과 자동 리포트(`source: "auto"`. 열이 없으면 `"user"`로 본다)는 건너뛴다 — 자동 리포트의 PDF·Discord 발송은 추천 워크플로우 팀 몫이다
  (B9, 01 T1-5의 자동 리포트 부분 — 팀 파일 `auto.py`의 `auto.after_finish(report)`, runner가 끝난 리포트마다 부른다. `00-공통.md` 8절).
- **완성** (`completed`): 이 리포트로 추천이 있으면(`verdict` buy이고 `0 < stop < entry < target` — `00-공통.md` 10절) `report_completed`를 보내지 않는다 —
  추천 알림(`recommendation`)의 본문 첫 줄 "리포트가 완성됐어요"가 그 역할이다. 판단 전에 추천을 만들 수 있으면 먼저 만든다(`autotrade.recommend.sources.from_report`, 이미 있으면 그대로).
  추천이 없으면(지켜보기·부정적·가격 조건이 맞지 않음) `report_completed` 하나 (`link`: `/reports/{id}`).
- **실패** (`failed`, 엔진 재시작 정리 포함): `report_failed` 하나 (`link`: `/reports/{id}`). 본문은 실패 사유 코드(`00-공통.md` 9절의 `join_blocked`·`review_failed`·`timeout`·`engine_restarted`·`exception`·`agent_failed`·`no_llm`·`expired`)의
  쉬운 문장 (`backend/reports/output/text.py`). 사유는 Trace의 마지막 `workflow_failed.details.reason`이고, 없거나 모르는 코드면 "리포트를 만들지 못했어요. 다시 만들 수 있어요".
- **중복 방지**: 같은 사용자에게 같은 kind·같은 `link`의 알림이 이미 있으면 보내지 않는다 (두 경로가 겹치거나 엔진이 다시 떠도 한 번).
- 예전 계획의 `system` kind와 `healing.notify_failure`의 사용자 알림은 쓰지 않는다.

---

# 장기투자 (`backend/longterm`) — 오늘의 내 종목 뉴스 · 산 이유와 펀더멘털 점검

작성 2026-10-04 (2026-10-04 합의 — 구현: 2026-10-05 (Claude)). 확장 1단계다. 원문은 `docs/plans/투자서비스확장계획.md` 3-2, 조사는
`docs/research/장기투자_뉴스·펀더멘털_조사.md` 4~5장, 결정은 `docs/DECISIONS.md` 14-3.

- 장기 보유(`style: "long"`, "모의 트레이딩" 절의 "보유 방식")에는 자동 매도가 없다. 대신 매일 장 마감 뒤 **오늘의 내 종목 뉴스**를, 정기공시가 나오면 **펀더멘털 점검**을 준다.
- **숫자와 판정은 결정론적 코드가 한다.** 등락 분해·근거 목록·펀더멘털 판정은 코드다. LLM은 오늘의 내 종목 뉴스의 설명 문장(종목당 하루 0~1회)에만 쓴다.
  장기 "매수 추천"·매도 권유·자동 매도는 없다.
- 오늘의 내 종목 뉴스는 **국내(KR) 종목만** 만든다 (화면 "국내 종목만"). 펀더멘털 점검은 국내 일반 기업에만 적용한다.
- 화면 고정 문구 (오늘의 내 종목 뉴스 카드·알림): "등락의 원인을 단정하지 않습니다. 같은 날 나온 소식을 모은 것이며 투자 권유가 아닙니다."
  펀더멘털 점검(종목 상세의 지표 표·산 이유 점검): "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다" — 서버가 `caption` 필드로 낸다. 종합 판정은 중립 표기("기준 충족"·"주의"·"확인 필요"·"적용하지 않음")로 보인다.
- 출처 표기: 시세 = `MarketStatus.quoteProvider`, 공시·재무 = "금융감독원 OpenDART", 뉴스 제목 = "Google 뉴스 검색 결과", 시장 = 대용 ETF 이름("KODEX 200 기준").

## 타입

```ts
// ── 오늘의 내 종목 뉴스 ──
interface DailyMoveEvidence {     // 근거 하나. LLM은 이 id로만 말한다 — 구현: 2026-10-05 (Claude)
  id: string;                     // "E1", "E2" … (기록 하나 안에서 유일)
  kind: "disclosure" | "flow" | "broker" | "news";
                                  // disclosure 그날 DART 공시(사실) · flow 수급(숫자 — 외국인·기관·개인 각각 하나씩, 최대 3개) · broker 증권사 목표가 헤드라인(제목 파싱) · news 뉴스 제목(신뢰 낮음)
  text: string;                   // 한 줄: 공시 제목 / "외국인 순매수 = 거래량의 12.0%" / 헤드라인 / 뉴스 제목. 제어 문자를 지우고 200자로 자른 것
  source: string;                 // 출처 이름: "금융감독원 OpenDART" · 시세 출처(quoteProvider) · 매체 이름(헤드라인·뉴스)
  at: string | null;              // 게시·접수 시각 (ISO). 날짜만 아는 자료(공시 접수일·수급)는 null — 날짜는 DailyMove.date
  url: string | null;             // 공시면 DART 공시 원문 주소 (접수번호 rcept_no로 만든다). 그 밖은 null (뉴스 링크는 내지 않는다)
  reliability: "high" | "medium" | "low";   // disclosure·flow high · broker medium · news low
}

interface DailyMove {             // 종목 하나의 하루 기록 (longterm.DailyMoveNote — 종목·날짜당 하나, 팀 공용) — 구현: 2026-10-05 (Claude)
  symbol: string; name: string; market: "KR";
  date: string;                   // 거래일 YYYY-MM-DD
  asOf: string;                   // 그날 정규장 종료 시각 (장마감 기준)
  close: number;                  // 그날 종가
  prevClose: number;              // 전 거래일 종가
  changeRate: number;             // 종목 등락률 = close / prevClose − 1
  marketProxy: { symbol: string; name: string; changeRate: number | null };
                                  // 시장 대용 ETF: 코스피 종목 "069500" "KODEX 200", 코스닥 종목 "229200" "KODEX 코스닥150". 등락률을 못 받으면 changeRate null
  excessChangeRate: number | null;   // 시장 대비 초과 등락 = changeRate − marketProxy.changeRate (β=1, 회계식 분해이지 원인이 아니다). 시장 등락이 없으면 null
  sectorChangeRate: null;         // 업종 등락. v1은 업종 자료가 없어 늘 null (화면 "업종 자료 없음")
  volatility20: number | null;    // 최근 20거래일 일간 등락률의 표준편차 (소수). 일봉이 모자라면 null
  flows: { foreign: number | null; institution: number | null; individual: number | null } | null;
                                  // 그날 투자자별 순매수 수량 ÷ 그날 거래량 (소수, 음수 = 순매도). 수급 자료가 없으면 null
  headline: string;               // 한 줄 제목 (60자까지)
  summary: string[];              // 설명 문장 1~3개 (각 120자까지)
  drivers: string[];              // 설명이 기댄 근거 id (evidence[].id). 템플릿이면 []
  uncertain: boolean;             // 근거가 약함 (근거가 뉴스 제목뿐 등) → 화면 "뚜렷한 소식을 찾지 못했어요"
  method: "template" | "llm";     // template: 템플릿 문장 (LLM 생략 규칙·LLM 설정 없음·검사 2번 위반) · llm: 검사를 통과한 LLM 설명
  evidence: DailyMoveEvidence[];  // 그날 근거 목록 (없으면 [])
  missing: string[];              // 비운 칸과 이유 한 줄씩 ("공시: DART 키가 없어 받지 못했어요", "업종: 업종 자료 없음"). 없으면 []
  createdAt: string;
}

// ── 산 이유와 펀더멘털 점검 ──
type FundamentalKey =             // 구현: 2026-10-05 (Claude)
  | "revenueGrowth" | "operatingIncomeGrowth" | "operatingMargin" | "roe" | "debtRatio"
  | "currentRatio" | "interestCoverage" | "operatingCashFlow" | "earningsQuality";   // 아래 "지표와 판정" 표 순서
type ThesisAxis = "growth" | "profitability" | "balance_sheet";   // 점검 축: 성장 · 수익성 · 재무 안정 — 구현: 2026-10-05 (Claude)
type CheckStatus = "ok" | "warn" | "bad" | "na";   // 구현: 2026-10-05 (Claude)
// ok ✓ · warn △ · bad ✗ · na 판정 없음 (자료 없음 · 적용하지 않음 · 기준선이 필요한데 없음)
type FundamentalsOverall = "solid" | "caution" | "review" | "na";   // 구현: 2026-10-05 (Claude)
// 화면 표기는 중립 문구로 (2026-10-05 확정 — 좋다·나쁘다로 읽히는 "견조"·"점검 필요"는 쓰지 않는다. 값은 그대로):
// solid "기준 충족" · caution "주의" · review "확인 필요" · na "적용하지 않음" (적용하지 않는 종목이거나 판정한 지표가 없음 — 이유는 reason·note).
// 나쁜 순서 solid < caution < review

interface FundamentalsRow {        // 구현: 2026-10-05 (Claude)
  key: FundamentalKey;
  label: string;                  // 화면 이름 ("매출 성장")
  axis: ThesisAxis;               // 이 지표가 속한 점검 축
  value: number | null;           // 최신 값 (unit 기준). 자료가 없으면 null
  unit: "ratio" | "times" | "krw";   // ratio 비율(소수, 0.12 = 12%) · times 배 · krw 원
  baseline: number | null;        // 기준선 = 산 이유를 처음 저장할 때의 값 (같은 unit). 기준선을 쓰지 않는 지표이거나 기준선이 없으면 null
  change: number | null;          // value − baseline (ratio면 %p를 소수로: −0.02 = −2%p). 둘 중 하나가 null이면 null
  status: CheckStatus;
  note: string | null;            // 판정 이유 한 줄 ("기준선 대비 −3.4%p", "2개 보고서 연속 감소", "근사: 영업이익 ÷ 금융비용", "기준선이 있어야 판정해요").
                                  // value와 다른 지표로 판정한 행(earningsQuality)은 판정한 지표 이름과 값을 꼭 적는다 ("판정: 영업외 손익이 세전이익의 62%")
}

interface ThesisCheck {           // 산 이유 점검 한 번 (longterm.ThesisCheck) — 구현: 2026-10-05 (Claude)
  id: number;
  checkedAt: string;              // 점검 시각
  trigger: "filing" | "weekly";   // filing: 그날 새 정기공시 · weekly: 매주 월요일 전체 재점검
  period: string | null;          // 점검에 쓴 보고서의 표시 이름 ("2026 반기보고서"). 자료가 없으면 null
  receivedAt: string | null;      // 그 보고서 접수일 YYYY-MM-DD
  overall: FundamentalsOverall;
  previousOverall: FundamentalsOverall | null;   // 직전 점검의 종합 (첫 점검이면 null)
  rows: FundamentalsRow[];        // 9개 지표 (기준선 비교 포함)
  newBad: FundamentalKey[];       // 이번에 새로 bad가 된 지표 (직전 점검에서 bad가 아니던 것. 첫 점검이면 bad 전부)
  notified: boolean;              // 이 점검으로 thesis_check 알림을 보냈는지
  caption: string;                // 고정 문구 "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다" (서버가 늘 이 값을 낸다. 화면은 판정 옆에 그대로 보인다)
}

interface Thesis {                // 산 이유 (longterm.InvestmentThesis — 사용자·종목당 하나) — 구현: 2026-10-05 (Claude)
  symbol: string; name: string; market: Market;
  reasons: string[];              // 산 이유 1~3개 (각 1~100자)
  axes: ThesisAxis[];             // 점검할 축 (사용자가 고른 것, 중복 없음). 비면 셋 다로 본다. 판정은 바꾸지 않고, 화면·알림이 이 축의 지표를 먼저 보인다
  baseline: Partial<Record<FundamentalKey, number | null>>;
                                  // 기준선: 처음 저장할 때의 지표 값 (FundamentalsRow.value와 같은 unit). 자료가 없으면 {} (다음 점검에서 채운다).
                                  // 9개 지표 값을 모두 담는다 — 판정에 쓰는 것은 operatingMargin·roe·debtRatio 셋 (2026-10-05 구현)
  baselinePeriod: string | null;  // 기준선의 보고서 (ThesisCheck.period와 같은 형식)
  active: boolean;                // 점검 대상인지 = 이 종목을 장기 보유(style long, 체결 대기·보유 중 — 장기 보유 매수 예약이 있어도) 중인지. 서버가 정한다 (보유가 끝나면 false — 점검·알림을 멈춘다)
  lastCheck: ThesisCheck | null;  // 가장 최근 점검 (아직 없으면 null)
  createdAt: string; updatedAt: string;
}

interface FundamentalsView {      // GET /api/stocks/{symbol}/fundamentals — 보유 여부와 상관없이 그 종목의 최근 지표와 절대 기준 판정 — 구현: 2026-10-05 (Claude)
  symbol: string; name: string; market: Market;
  applicable: boolean;            // 일반 기업용 점검을 적용하는지. 금융업·ETF·ETN·리츠·미국 종목은 false
  reason: string | null;          // applicable이 false거나 자료가 없을 때의 이유 한 줄 ("금융업은 일반 기업용 점검을 적용하지 않아요", "공시 자료를 받지 못했어요")
  overall: FundamentalsOverall;   // rows로 계산한 종합 (아래 규칙). applicable이 false면 "na"
  rows: FundamentalsRow[];        // 9개 지표 (표 순서). baseline·change는 늘 null (기준선이 필요한 판정은 절대 기준 부분만). applicable이 false면 []
  asOf: { period: string | null; receivedAt: string | null } | null;   // 지표의 출처 보고서와 접수일. 자료가 없으면 null
  source: string;                 // "금융감독원 OpenDART"
  caption: string;                // 고정 문구 "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다" (ThesisCheck.caption과 같은 값. applicable이 false여도 낸다)
  thesis: Thesis | null;          // 이 종목에 대한 내 산 이유와 최근 점검 (없으면 null). 기준선 비교 판정은 thesis.lastCheck에 있다
}
```

### 지표와 판정 (엔진 `judge/fundamentals_check.py`, 순수 함수. 제안값 E-5 — 과거 공시 몇 종목으로 검산한 뒤 확정)

| key | 화면 이름 | 축 | unit | 값 (DART `fundamentals`) | ok ✓ | warn △ | bad ✗ |
|---|---|---|---|---|---|---|---|
| `revenueGrowth` | 매출 성장 | growth | ratio | 최신 보고서 누적 매출의 전년 같은 기간 대비 (`interimRevenueGrowth`, 없으면 `annualRevenueGrowth`) | ≥ 0 | −0.10 이상 0 미만 | < −0.10, 또는 2개 보고서 연속 감소 |
| `operatingIncomeGrowth` | 영업이익 성장 | growth | ratio | 같은 방식 (`interim…`·`annualOperatingIncomeGrowth`). 비교 기간 흑자 → 지금 적자면 값 null | ≥ 0 | −0.20 이상 0 미만 | < −0.20, 또는 적자 전환 (값이 null이어도 bad, `note` "적자 전환") |
| `operatingMargin` | 영업이익률(TTM) | profitability | ratio | `ratios.operatingMargin` | change ≥ −0.01 | −0.03 ≤ change < −0.01 | change < −0.03, 또는 값이 음수 |
| `roe` | ROE(TTM) | profitability | ratio | **순이익(TTM) ÷ 자본총계(최신 보고서 기말)** = `ttm.netIncome ÷ balance.totalEquity` (자본총계가 0 이하·없으면 null). 보고서 종류(연간·분기)와 상관없이 늘 12개월 기준이라 기준선과 비교할 수 있다. DART 공시 지표 `reported.roe`는 분기 보고서면 누적·연환산 아님이라 **쓰지 않는다** (평균 자본이 아니라 기말 자본 — 근사, `note`에 적는다) | 값 > 0 이고 change ≥ −0.02 | 값 > 0 이고 change < −0.02 | 값 ≤ 0 |
| `debtRatio` | 부채비율 | balance_sheet | ratio | `reported.debtRatio` (1.5 = 150%) | change ≤ +0.20 | +0.20 < change ≤ +0.50 | change > +0.50 |
| `currentRatio` | 유동비율 | balance_sheet | ratio | `reported.currentRatio` | ≥ 1.0 | 0.8 이상 1.0 미만 | < 0.8 |
| `interestCoverage` | 이자보상배율(근사) | balance_sheet | times | **같은 기간끼리**: 영업이익 ÷ 금융비용, 둘 다 최신 보고서의 같은 누적 기간(`nonOperating.period` — 금융비용은 `nonOperating.financeCosts`, 영업이익은 그 기간의 `interim.operatingIncome`, 연간 보고서면 `annual.operatingIncome`). 분자·분모 기간이 같아 연환산이 필요 없다 (TTM 영업이익을 누적 금융비용으로 나누지 않는다). 금융비용이 0이거나 없으면 null | ≥ 3 | 1 이상 3 미만 | < 1 |
| `operatingCashFlow` | 영업현금흐름 | profitability | krw | 현금흐름표 영업활동현금흐름 누적 (`ifrs-full_CashFlowsFromUsedInOperatingActivities`, 파싱 추가). 비교하는 순이익도 **같은 누적 기간** 값. 아래 칸의 흑자 = 순이익 > 0, 적자 = 순이익 ≤ 0 | 영업현금흐름 > 0 이고 순이익 흑자 | 순이익 흑자인데 영업현금흐름 ≤ 0 (처음), 또는 순이익 적자인데 영업현금흐름 > 0 | 순이익 흑자·영업현금흐름 ≤ 0이 2개 보고서 연속, 또는 순이익 적자이고 영업현금흐름 ≤ 0 |
| `earningsQuality` | 이익의 질 | profitability | times | 순이익 ÷ 영업이익 (`netIncomeToOperatingIncome`) — 보이는 값. **판정은 다른 지표** `nonOperatingShareOfPretaxIncome`(영업외 손익 ÷ 세전이익)로 하고 `note`에 그 지표와 값을 적는다 ("판정: 영업외 손익이 세전이익의 62%") | 판정 지표의 절댓값 < 0.5 | 영업외 손익이 세전이익의 절반 이상 (판정 지표의 절댓값 ≥ 0.5) | (없음 — 경고만) |

- **판정 우선순위는 bad > warn > ok** (2026-10-05 확정): 한 행에서 여러 칸의 조건이 함께 맞으면 앞의 것을 고른다 (예: `operatingMargin`이 음수면 change와 상관없이 bad, `revenueGrowth`가 −5%여도 2개 보고서 연속 감소면 bad).
- 판정에 쓰는 값이 null이면 그 행은 `na`다 — 보통 `value`. 예외: `earningsQuality`는 판정 지표(`nonOperatingShareOfPretaxIncome`)가 null이면 `na`(`value`가 있어도), `operatingCashFlow`는 영업현금흐름·같은 기간 순이익 중 하나라도 null이면 `na`, `operatingIncomeGrowth`의 적자 전환은 값이 null이어도 bad.
- **종합**: bad가 하나라도 있으면 `review`("확인 필요"), warn이 둘 이상이면 `caution`("주의"), 나머지는 `solid`("기준 충족"). `na` 행은 세지 않는다. 판정한 행이 하나도 없거나 `applicable`이 false면 `na`("적용하지 않음").
- **기간을 맞춘다**: 기준선과 비교하는 지표는 보고서 종류에 따라 값의 기간이 바뀌지 않아야 한다 — `operatingMargin`·`roe`는 TTM, `debtRatio`는 기말 잔액이라 연간·분기 보고서를 섞어도 비교된다.
  누적 기간 값(`reported.*`의 손익 지표, 누적 금융비용 등)을 TTM 값과 섞지 않는다.
- 기준선을 쓰는 지표는 `operatingMargin`·`roe`·`debtRatio` 셋이다. 기준선이 없으면(`FundamentalsView`, 기준선을 아직 못 잡은 점검) **절대 기준 부분만** 본다:
  `operatingMargin`은 음수면 bad, `roe`는 0 이하면 bad, 그 밖은 `na`("기준선이 있어야 판정해요"). `debtRatio`는 `na`.
- "2개 보고서 연속" 조건은 산 이유 점검(`ThesisCheck`)에서 직전 점검(다른 보고서 기간)과 비교할 때만 본다 (`FundamentalsView`는 보지 않는다).
- 판정은 모든 지표에 한다. `Thesis.axes`는 판정·종합을 바꾸지 않는다.
- 적용하지 않음: 금융업(은행·보험·증권 등 — DART 회사 개황의 업종으로 가린다), ETF·ETN, 리츠, 미국 종목 → `applicable: false`, `rows: []`.

## 엔드포인트

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/longterm/daily-moves?date=` | `date` 선택 (YYYY-MM-DD) | `200 {"date": string \| null, "results": DailyMove[]}` — 내가 지금 보유(EXIT_WATCHING) 중인 국내 종목 중 그날 기록이 있는 것 (종목 이름순). `date`가 없으면 내 보유 종목의 기록이 있는 가장 최근 날짜, 기록이 하나도 없으면 `{"date": null, "results": []}` · 잘못된 `date` `400` (2026-10-05: 봉투 이름 `items` → `results`, 공통 규칙 "목록 봉투") |
| `GET /api/longterm/daily-moves/{symbol}?date=` | `date` 선택 | `200 DailyMove` (보유 여부와 상관없이 팀 공용 기록. `date`가 없으면 그 종목의 가장 최근 기록) · 기록이 없으면 `404` · 잘못된 `date` `400` |
| `GET /api/longterm/theses` | – | `200 {"results": Thesis[]}` (내 것만, `updatedAt` 최신순) |
| `PUT /api/longterm/theses/{symbol}` | `{"reasons": string[], "axes"?: ThesisAxis[]}` | `200 Thesis` — 없으면 만들고, 있으면 `reasons`·`axes`만 바꾼다 (`axes`를 빼면 그대로, 새로 만들 때는 `[]`). 처음 만들 때만 DART로 기준선을 잡는다 (조회가 실패하면 `baseline: {}`로 만들고 다음 점검에서 채운다 — 요청은 성공). `reasons`가 1~3개가 아님·빈 문자열·100자 넘음(앞뒤 공백을 지운 뒤), `axes`에 모르는 값·중복, 모르는 키면 `400` · 없는 종목 `404` |
| `DELETE /api/longterm/theses/{symbol}` | – | `204` (산 이유와 점검 기록을 지운다) · 없으면 `404` |
| `GET /api/stocks/{symbol}/fundamentals` | – | `200 FundamentalsView` (DART 자료는 종목별 하루 캐시) · 없는 종목 `404` · DART 조회 실패·키 없음도 `200` (`rows`의 값이 null, `reason`에 이유) |

규칙 (만드는 시각과 알림 — `run_engine`의 "장기투자" 단계 `longterm.jobs.tick`, 설정 `LONGTERM_JOBS` 기본 on):
- **오늘의 내 종목 뉴스**
  - 대상: 팀원 누군가가 보유(EXIT_WATCHING) 중인 국내 종목의 합집합 (보유 방식과 무관). 종목·날짜당 한 번 만든다 (`DailyMoveNote(symbol, day)` 유일 — 여러 사람이 같은 종목을 가져도, 엔진이 다시 떠도 한 번).
  - 시각: 국내 거래일, KR 기준일이 오늘이 된 뒤 `DAILY_MOVE_AT`(기본 16:30 KST) 이후 하루 한 번.
  - 순서: ① 숫자 분해(`changeRate`·`marketProxy`·`excessChangeRate`·`volatility20`·`flows`) ② 근거 목록 (입력은 제어 문자 제거·길이 제한)
    ③ LLM 생략 — |초과 등락| < 0.01이면서 |초과 등락| < `volatility20`이고 그날 공시·헤드라인이 없으면 템플릿 ("오늘은 시장과 비슷하게 움직였어요").
       `volatility20`이나 초과 등락이 null이면 비교할 수 없으므로 생략하지 않는다 (2026-10-05 구현에서 분명히 함)
    ④ LLM 1회 (`DAILY_MOVE_MODEL` → 없으면 `APPROVER` → 없으면 템플릿. 출력 `{headline, summary, drivers, uncertain}`)
    ⑤ 검사: `drivers`의 id가 근거 목록에 있음, 문장의 숫자가 분해·근거 숫자와 맞음, 금지 표현 없음 — 공통 규칙 "금지 표현"의 `forbidden_phrases(headline + summary, causal=True)`가 빈 목록
    (권유 `PERSUASION` 매수·매도 모두 + 인과 단정 `CAUSAL` + 예측 `PREDICTION`. 따로 목록을 두지 않는다), 근거가 뉴스 제목뿐이면 `uncertain: true`. 템플릿 문장도 같은 검사를 통과해야 한다 (테스트).
    위반이면 1번 다시 요청하고, 또 위반이면 템플릿.
  - 알림 `daily_move`: 그날 기록이 생긴 국내 보유 종목이 있는 사용자마다 하루 1개 묶음, **웹만** (Discord로 보내지 않는다). 제목 "오늘의 내 종목 뉴스 · N종목",
    본문은 종목별 한 줄(등락률 · 시장 대비) 최대 3줄 + 고정 문구. `link`: `/` (홈의 오늘의 내 종목 뉴스 카드).
    화면은 이 알림을 누르면 `/#daily-move`로 가서 그 카드로 스크롤·포커스한다 (`frontend/src/lib/nav.ts` `notificationHref` — 화면 쪽 규칙이고 `link` 계약은 그대로, 2026-10-05).
  - 속도 (2026-10-05 구현): 엔진 루프 한 바퀴에 최대 3종목을 만든다. 실패(그날 봉이 아직 없음 등)한 종목은 10분 뒤 다시, 3번까지 한다.
    알림은 그날 대상 종목이 모두 끝난 뒤(만들었거나 3번 실패해 포기) 보낸다 (엔진이 다시 떠도 사용자당 하루 1개).
- **펀더멘털 점검**
  - 대상: `active`인 산 이유.
  - 시각: 국내 거래일 `THESIS_CHECK_AT`(기본 18:00 KST) 이후 하루 한 번 — 그날 정기공시(DART 공시 검색 `pblntf_ty=A`, 마지막 쪽까지)가 접수된 종목을 점검한다 (`trigger: "filing"`).
    매주 월요일 같은 시각 이후에는 `active` 전부를 다시 점검한다 (`trigger: "weekly"`, 휴장일이어도 한다).
  - 기준선이 빈 산 이유는 그 점검에서 기준선을 채운다 (그 점검의 기준선 비교는 `na`).
  - 속도 (2026-10-05 구현): 산 이유 하나는 하루 한 번, 엔진 루프 한 바퀴에 최대 5개를 점검한다. DART 키가 없으면 점검 기록을 남기지 않고,
    DART에 그 회사 재무제표가 없으면 모든 지표가 `na`인 점검을 남긴다.
  - "2개 보고서 연속" 조건을 보려고 점검마다 판정용 값(보고서·매출 성장률·같은 누적 기간의 순이익·영업현금흐름)을 함께 저장한다 (`thesis_checks.facts`, API에는 내지 않는다).
  - 알림 `thesis_check`: `newBad`가 비어 있지 않거나, 직전 점검보다 종합이 나빠졌을 때만 (첫 점검은 `newBad`로만 판단) — **웹만**.
    제목은 사실 문장("삼성전자 펀더멘털 점검: 확인할 항목이 생겼어요"), 본문은 바뀐 지표 이름과 값. 매도 권유를 넣지 않는다 (공통 규칙 "금지 표현" `PERSUASION` 검사를 테스트로). `link`: `/stocks/{symbol}`.
- 자료가 없으면 그 칸을 비우고 이유를 `missing`(오늘의 내 종목 뉴스)·`reason`·`note`(펀더멘털)에 적는다. 자료: 일봉·수급은 증권사 조회, 공시·재무는 OpenDART, 뉴스·헤드라인은 Google 뉴스 RSS.
