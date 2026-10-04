# 웹 API 계약 (1차: 로그인 · 모의 트레이딩 · AI 분석 대시보드 · My Page · 랭킹)

작성 2026-10-02. 백엔드(`backend/`)와 프론트엔드(`frontend/`)가 같이 따르는 계약이다. 배경 결정은 `docs/DECISIONS.md` 8장.
바꾸려면 이 파일을 먼저 고치고 양쪽 작업자에게 알린다. 프론트 타입(`frontend/src/api/types.ts`)은 지금은 이 문서를 보고
손으로 쓰고, OpenAPI 자동 생성(`drf-spectacular` → `openapi-typescript`) 비교는 CI 단계(4E)에서 붙인다.

**2026-10-04 합의 (구현 전 계약)**: 서비스 컨셉 변경(`docs/컨셉변경계획.md` 8장, 결정 `docs/DECISIONS.md` 13장)의 계약 변경 B3·B4·B5·B7·B8·B10을
아래 각 절에 넣었다. "(2026-10-04 합의, 컨셉 계획 B○ — 미구현, 담당 ○)"로 표시한 것은 **아직 서버가 내지 않는다** (괄호의 담당이 만든다).
B1(`ReportDraft.plainSummary`)은 HTTP가 아니라 리포트 출력 계약이라 `docs/tasks/00-공통.md` 10절에 있다 (화면은 `state.results.report_agent.plainSummary`로 읽는다).

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
- **실시간 = 폴링.** 프론트는 화면에 보이는 종목의 시세(`/api/quotes`, `/api/stocks/{symbol}`)를 **1초**, 계좌(`/api/account`)를 2초,
  랭킹·주문·작업 상태를 5초 간격으로 다시 받는다. 백엔드는 현재가를 1초 캐시한다 (같은 종목은 팀원이 몇 명이 봐도 증권사 조회 1번).
  시세와 계좌는 로그인해 있는 동안 탭이 가려져도 계속 받고, 나머지는 탭이 보이지 않으면 멈춘다.
  간격은 `frontend/src/api/queries.ts`의 `POLL`, 캐시는 `backend/trading/market.py`의 `PRICE_TTL`.

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
                          // (2026-10-04 합의, 컨셉 계획 B10 — 미구현, 담당 1)
}

// 투자자 프로필 (2026-10-04 합의, 컨셉 계획 B10 — 미구현, 담당 1). 문항·보기 값·점수표는 아래 "투자자 프로필" 절
type ExperienceLevel = "intro" | "novice" | "intermediate" | "expert";   // 경험 단계: 입문 · 초급 · 중급 · 숙련
type RiskProfile = "stable" | "stable_seeking" | "neutral" | "active" | "aggressive";
// 투자 성향 5단계: 안정형 · 안정추구형 · 위험중립형 · 적극투자형 · 공격투자형

interface InvestorAnswers {       // 투자 성향·경험 진단 7문항의 답 (영문 코드)
  q1: "none" | "under_1y" | "1_3y" | "over_3y";
  q2: ("deposit" | "fund_etf" | "kr_stock" | "us_stock" | "derivatives")[];   // 여럿 고름 (1개 이상)
  q3: "never" | "yearly" | "monthly" | "daily";
  q4: "unknown" | "heard" | "explain";
  q5: "no_loss" | "loss_10" | "loss_20" | "more";
  q6: "years" | "weeks" | "intraday";
  q7: "practice" | "growth" | "short_term";
}

interface InvestorProfile {
  beginnerMode: boolean;                    // 지금 주린이모드. 진단 전 기본 true
  answers: InvestorAnswers | null;          // 진단 전이면 null (아래 여섯도 null)
  experienceScore: number | null;           // 경험 점수 0~11
  experienceLevel: ExperienceLevel | null;
  riskScore: number | null;                 // 성향 점수 0~8
  riskProfile: RiskProfile | null;
  recommendedBeginnerMode: boolean | null;  // 진단이 추천하는 주린이모드 (경험 단계가 intro·novice면 true)
  assessedAt: string | null;                // 마지막 진단 제출 시각
}

interface Quote {
  symbol: string;
  name: string | null;
  currency: Currency;
  price: number | null;        // 현재가. 조회 실패면 null
  prevClose: number | null;    // 전 거래일 종가. 그날 처음 보는 종목은 잠깐 null일 수 있다 (한 요청이 새로 받는 수를 제한한다. 다음 폴링에 채워진다)
  change: number | null;       // price - prevClose
  changeRate: number | null;   // price / prevClose - 1
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
  quote: Quote;
  candles: Candle[];           // 일봉, 과거 → 최신, 최근 120개 (장중이면 마지막은 오늘 미완성 봉)
  warnings: string[];          // 매수 유의 (투자경고 등). 없으면 []
}

interface MarketStatus {
  markets: { market: Market; isOpen: boolean; opensAt: string | null; closesAt: string | null }[];
  // isOpen: 지금 정규장인지. opensAt: 다음(또는 오늘) 정규장 시작, closesAt: 지금 열려 있으면 오늘 종료 시각
  halted: boolean;             // 새 모의 매수 중단 스위치
  brokerReady: boolean;        // 증권사 조회 키가 있는지 (없으면 시세·주문이 안 된다)
}

type OrderStatus = "ENTRY_PENDING" | "EXIT_WATCHING" | "CLOSED" | "CANCELED";
// ENTRY_PENDING 체결 대기 · EXIT_WATCHING 보유 중 · CLOSED 종료(매도 완료) · CANCELED 취소

interface Order {                // 매수 주문 하나 = 포지션 하나
  id: number;
  symbol: string; name: string; market: Market; currency: Currency;
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  quantity: number;
  status: OrderStatus;
  entryPrice: number;          // 계획 진입가 (시장가는 주문 시점 가격)
  fillPrice: number | null; filledAt: string | null;
  targetPrice: number | null; stopPrice: number | null; expireDate: string | null;
  exitPrice: number | null; exitReason: "TARGET" | "STOP" | "EXPIRED" | "MANUAL" | null; closedAt: string | null;
  pnlKrw: number | null;       // 실현 손익 (수수료·세금 포함)
  note: string | null;         // 취소 사유 등
  createdAt: string;
}

interface Position {             // 보유 중(EXIT_WATCHING)인 주문의 평가
  orderId: number;
  symbol: string; name: string; market: Market; currency: Currency;
  quantity: number;
  avgPrice: number;            // 매수 체결가
  lastPrice: number | null;    // 현재가. 못 받으면 null (그때는 체결가로 평가)
  costKrw: number;             // 매수 원금 (체결가 × 수량 × 체결 환율)
  valueKrw: number;            // 평가 금액
  profitKrw: number;           // valueKrw - costKrw
  profitRate: number | null;
  targetPrice: number | null; stopPrice: number | null; expireDate: string | null;
  filledAt: string;
}

interface AccountSummary {       // My Page · 홈 자산 카드
  initialCapitalKrw: number;
  cashKrw: number;
  holdingsValueKrw: number;    // 보유 평가액
  equityKrw: number;           // 총자산 = 현금 + 보유 평가액
  investedKrw: number;         // 투자금액 = 보유 종목 매수 원금 합계
  profitKrw: number;           // equityKrw - initialCapitalKrw
  profitRate: number;          // 수익률 = equityKrw / initialCapitalKrw - 1
  pendingKrw: number | null;   // 대기 매수 금액
  buyingPowerKrw: number | null; // 매수 가능액 = 현금 - 대기 매수 금액
  positions: Position[];
  notes: string[];             // "현재가를 받지 못해 체결가로 평가: ..." 같은 안내
  asOf: string;
}

interface Fill {
  id: number; orderId: number;
  symbol: string; name: string; currency: Currency;
  side: "BUY" | "SELL";
  price: number; quantity: number; amount: number;
  commission: number; tax: number;
  cashChangeKrw: number;       // 현금 증감 (매수 음수)
  reason: "ENTRY" | "TARGET" | "STOP" | "EXPIRED" | "MANUAL";
  filledAt: string;
}

interface Reservation {          // 정규장 밖 시장가 매수·매도 → 다음 정규장 시작에 실행
  id: number;
  kind: "BUY" | "SELL";
  symbol: string; name: string; market: Market;
  quantity: number;
  orderId: number | null;      // SELL이면 팔 주문(포지션)
  targetPrice: number | null; stopPrice: number | null; days: number | null;
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

interface Ranking {
  results: RankingEntry[];     // 내 정보 공개(isPublic)를 켠 사용자만
  me: { isPublic: boolean; rank: number | null; profitRate: number }; // 내가 비공개면 rank는 null
  asOf: string;
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
  priceAtAnalysis: number | null; // 분석 시점 현재가
  best: Scenario | null;       // 대표 시나리오: 승인된 것 중 최고 점수, 없으면 전체 중 최고 점수. 시나리오가 없으면 null
  scenarioCount: number;
  requestedBy: string | null;  // 요청한 팀원의 닉네임 (로그인 아이디는 내지 않는다), 전략 실행이면 "strategy:<번호>", CLI면 "cli"
  costUsd: number | null;
}

interface AnalysisDetail extends AnalysisSummary {
  scenarios: Scenario[];
  news: string[];              // 뉴스 제목
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
  remaining: number;           // 내 한도와 전체 예산 중 작은 쪽의 남은 횟수
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
| `GET /api/me/investor-profile` | – | `200 InvestorProfile` (진단 전이면 `beginnerMode: true`, 나머지는 null) — (2026-10-04 합의, 컨셉 계획 B10 — 미구현, 담당 1) |
| `PUT /api/me/investor-profile` | `{"answers": InvestorAnswers}` (`answers` 필수) | `200 InvestorProfile` — 진단 제출. 서버가 아래 점수표로 `experienceScore`·`experienceLevel`·`riskScore`·`riskProfile`·`recommendedBeginnerMode`를 계산해 저장한다 (다시 내면 덮어쓴다). **`beginnerMode`는 바꾸지 않는다** · 빠진 문항·모르는 키·모르는 값, `q2`가 비었거나 `deposit`이 다른 보기와 같이 오면 `400` — (2026-10-04 합의, 컨셉 계획 B10 — 미구현, 담당 1) |
| `PATCH /api/me/investor-profile` | `{"beginnerMode": boolean}` | `200 InvestorProfile` — 주린이모드 스위치만 (진단 전에도 된다) · 불리언이 아니면 `400` — (2026-10-04 합의, 컨셉 계획 B10 — 미구현, 담당 1) |

#### 투자자 프로필과 주린이모드 (2026-10-04 합의, 컨셉 계획 B10 — 미구현, 담당 1)

마이 메뉴의 투자 성향·경험 진단(7문항)과 주린이모드 스위치. 원문은 `docs/투자서비스확장계획.md` 2장, 결정은 `docs/DECISIONS.md` 13-2(E-1·E-2).

- 주린이모드는 **계정(서버)에 저장**한다. 기기를 바꿔도 같고, 웹 알림 문장이 같은 모드를 따른다. 진단 전 기본값은 **켬**(`true`).
  리포트 상세의 "이 화면만 자세히 보기"(`?view=expert`)는 화면만 바꾸고 이 값을 바꾸지 않는다 (서버 변경 없음).
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
| `GET /api/quotes?symbols=005930,000660` | 쉼표 구분, 최대 50개 | `200 {"quotes": Quote[], "asOf": string}` (모르는 종목은 빠진다) |
| `GET /api/account` | – | `200 AccountSummary` |
| `GET /api/account/equity?days=30` | – | `200 {"points": {"day": string, "equityKrw": number}[]}` (일별 자산, 과거 → 최신) |
| `GET /api/orders?status=active\|all` | 기본 `active`(대기·보유), 페이지 | `200 {"count", "results": Order[]}` (최신순) |
| `POST /api/orders` | `{"symbol", "quantity", "orderType": "MARKET"\|"LIMIT", "limitPrice"?, "targetPrice"?, "stopPrice"?, "days"?}` | `201 OrderResult` · 거절 `400` |
| `PATCH /api/orders/{id}` | `{"targetPrice"?, "stopPrice"?, "days"?}` | `200 Order` |
| `POST /api/orders/{id}/sell` | – (보유 전량 매도. 대기 주문이면 취소) | `200 OrderResult` |
| `POST /api/orders/{id}/cancel` | – (체결 대기 주문만) | `200 Order` |
| `GET /api/fills` | 페이지 | `200 {"count", "results": Fill[]}` (최신순) |
| `GET /api/reservations` | – | `200 {"results": Reservation[]}` |
| `DELETE /api/reservations/{id}` | – | `204` |
| `GET /api/ranking` | – | `200 Ranking` |

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

### AI 분석 (`backend/analysis`)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/analyses?symbol=&verdict=` | 페이지, 둘 다 선택 | `200 {"count", "results": AnalysisSummary[]}` (최신순, 팀 전체 공용) |
| `GET /api/analyses/{id}` | – | `200 AnalysisDetail` · `404` |
| `GET /api/analyses/quota` | – | `200 AnalysisQuota` |
| `POST /api/analyses` | `{"symbol"}` | `202 {"jobId": number}` · 한도 초과 `429` · AI 키 없음 `503` |
| `GET /api/jobs/{id}` | – | `200 Job` · 남의 작업 `404` |

- 분석은 몇 분 걸린다. 프론트는 `POST` 뒤 `GET /api/jobs/{id}`를 5초 간격으로 확인하고, `DONE`이면 `result.analysisIds[0]`로 간다.
- 한도(팀원별 하루 횟수, 전체 하루 횟수)는 **엔진이 실제로 시작한 작업을 실패해도 센다** (실패는 대부분 AI 비용을 쓴 뒤에 난다).
- 분석 결과는 팀 전체가 같이 본다 (요청자 표시). 현재가·등락률은 프론트가 `/api/quotes`로 따로 받는다.

---

# AI 리포트 (`backend/reports`) — Agents Orchestration과 Trace

작성 2026-10-02. 종목별로 AI 리포트를 신청하고, 여러 Agent가 협업하는 과정(Trace)을 화면에서 본다. 배경은 `docs/DECISIONS.md` 9장,
개념은 `docs/교육용문서.md`(04 Distributed Collaboration)를 그대로 따른다.
**Agent와 Orchestrator 실행 코드는 아직 없다** (`ExecutionPlan.implemented = false`). 지금은 신청·실행 계획·Shared State·Trace를
담고 보여 주는 구조만 있다. 신청한 리포트는 `requested` 상태로 남는다.

**2026-10-04 추가 (구현 전 계약)**: 장애 주입(`chaos`), 복구 요약(`recovery`), 자동 리포트(`source`), PDF, 복구 지표, 복구 Trace 사건.
그중 PDF(`GET /api/reports/{id}/pdf`)와 선별 결과(`GET /api/reports/screening`)는 2026-10-04에 서버가 내기 시작했다 (표의 "구현" 표시).
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
// agent_failed는 두 가지다: details.final = false 는 LLM 호출 한 번의 실패(재시도·전환으로 이어진다),
// details.final = true 는 그 Worker를 포기한 것. details.injected = true 는 장애 주입으로 일으킨 실패.
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
  currentStep: string | null;   // 실행 계획의 step id (예: "parallel_research")
  results: Record<string, unknown>;   // 출력 계약을 통과한 Worker 결과만
  errors: Record<string, string>;     // Worker id → 오류
  completedAgents: string[];
  failedAgents: string[];
}

interface Worker {
  id: string; title: string; goal: string;
  provider: string | null; model: string | null;   // 아직 정하지 않았으면 null
  fallbacks: string[];          // (추가) 주 모델이 실패하면 차례로 쓰는 대체 모델
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
  retry: { target: string; maxRounds: number } | null;   // (추가) 검토 단계: RETRY 판정이면 target Worker를 다시 실행 (최대 maxRounds번)
}

interface ChaosConfig {           // (추가) 장애 주입 설정 (docs/tasks/00-공통.md 5절). 리포트 워크플로우에만 적용된다
  enabled: boolean;
  probability: number;          // 0~1. 호출 하나가 실패할 확률
  errorTypes: ErrorType[];      // 일으킬 실패 종류 (unknown 제외)
  workers: string[] | null;     // 대상 Worker (null이면 전부)
  scope: "primary" | "all";     // primary: 주 모델 호출만 실패 (대체 모델로 복구를 보인다) · all: 대체 모델까지 실패
  seed: number;                 // 같은 시험을 다시 돌릴 수 있게 서버가 정해 저장한다
}

interface RecoverySummary {       // (추가) 이 리포트의 장애·복구 요약 (Trace에서 계산. 셈법은 00-공통.md 9절)
  failures: number;             // 장애 건수 (Worker 실행마다 첫 실패를 1건으로)
  recovered: number;            // 자동 복구된 건수
  unrecovered: number;          // 포기한 건수
  injected: number;             // 장애 건 중 주입된 것
  recoveryMs: number | null;    // 복구된 건의 복구 시간 합 (없으면 null)
  models: Record<string, string>;   // Worker id → 최종적으로 답한 모델
}

interface Handoff { from: string; to: string; responsibility: string; maxHops: number; }

interface ExecutionPlan {
  team: string; title: string;
  failurePolicy: "fail_fast" | "best_effort" | "required_optional";
  steps: PlanStep[];            // 실행 순서대로
  workers: Worker[];            // steps와 handoffs에 나오는 모든 Worker
  handoffs: Handoff[];
  implemented: boolean;         // Agent 실행이 구현됐는지. 지금은 false
}

interface ReportSummary {
  id: number;
  symbol: string; name: string; market: Market;
  status: SharedState["status"];
  currentStep: string | null;
  source: "user" | "auto";      // (추가) 팀원 신청 / 자동 리포트(거래대금 상위 선별)
  requestedBy: string;          // 신청한 팀원의 닉네임. 자동 리포트는 "자동"
  chaosEnabled: boolean;        // (추가) 장애 주입을 켜고 신청했는지
  costUsd: number | null;       // (추가) LLM 비용 (끝나기 전엔 지금까지의 합)
  hasPdf: boolean;              // (추가) GET /api/reports/{id}/pdf 가 되는지
  opinion: "buy" | "hold" | "avoid" | null;   // AI 의견 = results.report_agent.verdict. status가 completed일 때만, 그 밖은 null
                                              // (2026-10-04 합의, 컨셉 계획 B3 — 미구현, 담당 4)
  oneLiner: string | null;      // 한 줄 요약 = results.report_agent.oneLiner (80자). opinion과 같은 규칙 (2026-10-04 합의, 컨셉 계획 B3 — 미구현, 담당 4)
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

interface RecoveryStats {         // (추가) GET /api/reports/recovery-stats
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

interface ScreeningResult {       // (추가) 자동 리포트의 그날 선별 결과 (엔진 screen_market 결과를 그대로)
  market: Market; at: string; rankCount: number; eligibleCount: number; checked: number;
  picks: Record<string, unknown>[];     // 점수 순. symbol · name · score · tradingAmountRank 등
  dropped: Record<string, unknown>[];   // 규칙에서 떨어진 종목과 사유
  excluded: Record<string, unknown>[];  // ETF 등 제외 종목과 사유
  reportIds: number[];                  // 그날 만든 리포트 (자동 리포트 신청 T1-4가 채운다)
  recommendationIds: number[];          // 그날 만든 자동 추천 (AUTO_RECOMMEND=demo — 아래 "AI 추천" 절)
}

interface ReportDetail extends ReportSummary {   // Snapshot
  content: string | null;       // 리포트 본문 (Markdown). Agent 구현 전에는 null
  state: SharedState;
  trace: TraceEvent[];          // step 오름차순
  plan: ExecutionPlan;
  chaos: ChaosConfig | null;    // (추가) 신청 때의 장애 주입 설정 (서버가 채운 기본값·seed 포함)
  recovery: RecoverySummary;    // (추가)
}
```

## 엔드포인트

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/reports/plan` | – | `200 ExecutionPlan` (YAML Registry에서 읽은 실행 계획) |
| `GET /api/reports?symbol=` | 페이지, `symbol` 선택 | `200 {"count", "results": ReportSummary[]}` (팀 전체 공용, 최신순) |
| `POST /api/reports` | `{"symbol", "chaos"?: {"enabled", "probability"?, "errorTypes"?, "workers"?, "scope"?, "seed"?}}` | `201 ReportDetail` · 같은 사람이 같은 종목으로 신청해 아직 끝나지 않은 리포트가 있으면 그것을 `200`으로 · 없는 종목·잘못된 `chaos` `400` · (추가) 하루 한도 초과 `429 {"detail", "limit", "used"}` · (추가) AI 설정 없음 `503` · 증권사 조회 불가 `503` |
| `GET /api/reports?symbol=&source=&mine=` | 페이지, `symbol`·`source`(`user`\|`auto`)·`mine`(`1`이면 내가 신청한 것만) 선택, 같이 쓸 수 있다 | (추가 `source`) · `mine=1` (2026-10-04 합의, 컨셉 계획 B8 — 미구현, 담당 1: `ReportsView.get` 한 줄. 자동 리포트는 신청자가 없어 빠진다) |
| `GET /api/reports/{id}` | – | `200 ReportDetail` · `404` (**Snapshot API**: 새로고침·연결 복구에 쓴다) |
| `GET /api/reports/{id}/events` | 헤더 `Last-Event-ID` 또는 `?after=<step>` | `200 text/event-stream` (**SSE**) · 미로그인 `401` JSON · `404` |
| `GET /api/reports/{id}/pdf` | – | `200 application/pdf` (A4. 처음 부르면 만들어 `PAPER_ROOT/reports/<id>.pdf`에 저장하고 다음부터 그 파일. `pdf_path` 열이 생기면 그 열로) · 완성 전 `409 {"detail"}` · `404` · Chrome이 없으면 `200 text/html`(같은 내용) — 2026-10-04 구현 |
| (추가) `GET /api/reports/recovery-stats?days=7` | `days` 1~90, 기본 7 | `200 RecoveryStats` |
| `GET /api/reports/screening?market=KR&date=` | `date` 기본 오늘(KST) | `200 ScreeningResult` · 그날 선별이 없으면 `404` · 잘못된 `market`·`date` `400` — 2026-10-04 구현 (`reports/auto.py`가 남긴 파일을 읽는다) |

SSE 형식 (실행 Event를 발생 즉시 한 방향으로 전달):
- `event: trace` / `id: <step>` / `data: <TraceEvent JSON>` — `after`(또는 `Last-Event-ID`)보다 큰 step만, 순서대로.
- `event: state` / `data: <SharedState JSON>` — 상태가 바뀔 때.
- `event: end` / `data: {"status": ...}` — 전체 종료(completed·failed)이고 남은 사건이 없을 때 보내고 연결을 닫는다.
- 15초마다 `: keep-alive` 주석 줄. 서버는 한 연결을 60초 뒤 닫는다 (브라우저 `EventSource`가 `Last-Event-ID`로 다시 붙는다).
- **SSE가 실행 상태의 유일한 저장소가 되면 안 된다.** 상태와 Trace는 DB에 있고, 프론트는 먼저 Snapshot을 받은 뒤 SSE로 이어 받는다.
  SSE가 끊기거나 안 되면 Snapshot을 3초 간격으로 다시 받는다 (폴링). `plan.implemented`가 false이고 status가 `requested`면 SSE를 열지 않는다.

목록 카드의 결론과 매매 계획 연결 (2026-10-04 합의, 컨셉 계획 B3·B8 — 미구현):
- `opinion`·`oneLiner`는 `status`가 `completed`일 때만 `state.results.report_agent`의 `verdict`·`oneLiner`를 그대로 낸다 (담당 4, `payloads.summary`).
  대기·실행 중·실패면 `null`이다 — 실행 중의 `report_agent` 결과는 검토 전이거나 RETRY로 다시 쓰이는 중이고, 실패한 리포트의 초안은 검토를 통과하지 않았다.
  `ReportDetail`은 `ReportSummary`를 이어받으므로 상세에도 같은 값이 있다. 쉬운 요약(B1)은 `state.results.report_agent.plainSummary`로 읽는다.
- 리포트와 매매 계획(추천)의 연결은 리포트 API에 넣지 않는다 (reports → autotrade 역방향 의존을 만들지 않는다). 프론트가 추천 API로 맞춘다:
  목록은 `GET /api/recommendations?source=report&status=open&limit=100` 한 번으로 받아 `sourceId`(= 리포트 id)로 카드에 붙이고,
  상세(매매 계획 카드)는 `GET /api/recommendations?source=report&sourceId={리포트 id}&status=all`로 받는다 (기한이 지난 추천까지 와야 "기한 지남" 상태를 보인다).
  두 쿼리는 지금 서버가 된다 (2026-10-04 `autotrade/views.py`로 확인. 페이지 상한은 100).
- 하루 리포트 한도(`429`, 담당 2의 T2-9)는 **장애 주입 없이 `failed`로 끝난 리포트를 세지 않는다** (`docs/DECISIONS.md` 13-1 D-7 — 미구현, 담당 2). 장애 주입을 켠 리포트는 실패해도 센다.

---

# AI 추천 · 매매 계획 · 자동매매 · 알림 (`backend/autotrade`, `backend/notifications`)

작성 2026-10-04. 서비스의 최종 흐름: **AI가 종목·진입가·목표가·손절가·기대수익을 추천 → 사용자가 웹이나 Discord 링크로 "계획 활성화"
→ 엔진 루프가 계획대로 모의 주문·체결 대기·보유 감시·청산을 자동으로 하고 → 단계마다 웹 알림과 Discord로 알린다.**
배경과 결정은 `docs/DECISIONS.md` 12장, 담당과 남은 일은 `docs/tasks/06-추천·자동매매.md`.

- **AI는 제안만 한다.** 수량·한도·활성화 가능 여부·체결은 결정론적 코드(엔진 리스크 엔진 `judge/risk.py`, 모의 체결기)가 정한다.
  최소 손익비 기준(2.0)은 AI 프롬프트에 넣지 않는다 (리스크 엔진이 거른다).
- 추천의 출처는 셋이다: `report`(AI 리포트 Agent 워크플로우의 `report_agent` 결과 — 담당 2·3·4가 구현), `analysis`(지금 있는 AI 교차검증 분석의
  BUY 판정), `demo`(**시연용 규칙 추천, AI 아님** — 일봉 ATR로 목표·손절을 정한다. 화면에 "시연용"을 표시한다).
- 추천은 팀 전체가 같이 보고, **활성화는 팀원마다 자기 모의 계좌에** 한다 (같은 추천을 여러 명이 각자 활성화할 수 있다).

## 타입

```ts
type RecommendationSource = "report" | "analysis" | "demo";
type RecommendationStatus = "open" | "expired";   // open: validUntil 전이라 활성화할 수 있음

interface Recommendation {
  id: number;
  source: RecommendationSource;
  sourceId: number | null;        // report면 리포트 id, analysis면 분석 id, demo면 null
  requestedBy: string | null;     // 리포트·분석을 신청한(또는 시연 추천을 만든) 팀원의 닉네임. 자동이면 null
  symbol: string; name: string; market: Market; currency: Currency;
  priceAtCreation: number | null; // 추천을 만들 때의 가격
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
  validUntil: string;             // 이 시각까지 활성화할 수 있고, 계획의 진입 기한도 이 시각이다
  createdAt: string;
  myPlan: { id: number; status: TradePlanStatus } | null;   // 내가 활성화한 계획 (진행 중인 것, 없으면 가장 최근 것)
  planCount: number;              // 이 추천으로 활성화한 계획 수 (팀 전체)
}

interface RiskPreview {           // 리스크 엔진이 "내 계좌"로 계산한 결과 (활성화 전 확인용)
  approved: boolean;              // 리스크 엔진 통과
  activatable: boolean;           // approved && 추천이 open && 같은 종목의 진행 중 계획·주문 없음 && 중단 스위치 꺼짐
  reasons: string[];              // 활성화할 수 없는 사유 (activatable이면 [])
  reasonCodes: string[];          // reasons[i]의 사유 코드 = reasonCodes[i] (같은 길이·같은 순서). 코드 표는 아래 "실행 불가 사유 코드"
                                  // (2026-10-04 합의, 컨셉 계획 B4 — 미구현, 담당 1)
  quantity: number;               // 주문할 수량 (국내는 정수 주)
  amountKrw: number;              // 매수 금액 (원화 환산)
  expectedProfitKrw: number;      // 목표가 도달 시 이익 (비용 반영)
  maxLossKrw: number;             // 손절 시 손실 (비용 반영, 양수)
  limitedBy: string;              // 수량을 정한 제약: "건당 위험 한도" | "매수 가능 금액" | "총 금액 한도" | "유동성 한도" | "예산"
  budgetKrw: number | null;       // 요청한 예산 (없으면 null)
  lastPrice: number | null;       // 지금 가격 (못 받으면 null)
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
  quantity: number;
  budgetKrw: number | null;
  entryPrice: number; targetPrice: number; stopPrice: number; holdingDays: number;   // 활성화 때 추천에서 복사
  entryDeadline: string;          // 진입 기한 (= 추천의 validUntil)
  orderId: number | null;         // 지금 연결된 모의 주문 (Order). 재주문하면 바뀐다
  fillPrice: number | null; filledAt: string | null;
  exitPrice: number | null; exitReason: "TARGET" | "STOP" | "EXPIRED" | "MANUAL" | null; closedAt: string | null;
  pnlKrw: number | null;          // 실현 손익 (청산 뒤)
  failureReason: string | null;   // failed·expired·cancelled의 사유 (사람이 읽는 말)
  activatedAt: string;
  updatedAt: string;
}

type PlanEventKind =
  | "activated"        // 사용자가 활성화 (details: {via, budgetKrw}. 2026-10-04 합의 B5 — 미구현, 담당 1: + acknowledged)
  | "risk_checked"     // 리스크 엔진 점검 (details: {approved, quantity, limitedBy, rewardRisk, reasons})
  | "order_placed"     // 진입 지정가 주문 접수 (details: {orderId, limitPrice, quantity})
  | "order_requeued"   // 지정가가 그날 체결되지 않아 다음 정규장에 다시 주문 (details: {orderId, previousOrderId}, 수량이 줄었으면 + {quantity, previousQuantity})
  | "filled"           // 진입 체결 (details: {orderId, fillPrice, quantity})
  | "exit_requested"   // 사용자가 보유 중 계획을 중단 → 전량 매도 요청·예약 (details: {orderId, reservationId})
  | "closed"           // 청산 (details: {orderId, exitReason, exitPrice, pnlKrw})
  | "cancelled"        // 중단 (details: {reason})
  | "expired"          // 진입 기한 지남 (details: {orderId})
  | "failed";          // 주문할 수 없음 (details: {reason})

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
  | "report_completed" | "report_failed";   // (2026-10-04 합의, 컨셉 계획 B7 — 미구현, 담당 1·4) 리포트 완성 / 리포트 실패
// system은 시험 알림 등 그 밖의 것. 리포트 실패 알림은 system이 아니라 report_failed다 (보내는 규칙은 아래 "리포트 끝 알림")

interface Notification {
  id: number;
  kind: NotificationKind | string;
  title: string;                  // "삼성전자 진입 체결"
  body: string;                   // 한두 줄
  link: string | null;            // 웹 경로 ("/plans/3"). 프론트는 그대로 이동한다
  createdAt: string;
  readAt: string | null;
}

interface NotificationSettings {
  discordUserId: string | null;   // Discord 사용자 ID (숫자 17~20자리). 있으면 Discord 알림에 @멘션한다
  discordEnabled: boolean;        // 내 알림을 Discord로도 보낼지 (기본 true). 웹 알림은 항상 남는다
  webhookConfigured: boolean;     // 서버에 DISCORD_WEBHOOK_URL이 있는지 (없으면 Discord로는 아무것도 가지 않는다)
}
```

## 엔드포인트

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/recommendations?status=open\|all&source=&sourceId=&symbol=` | 페이지. `status` 기본 `open`. `sourceId`는 `source`와 같이 (리포트·분석 화면이 자기 추천을 찾는다) | `200 {"count", "results": Recommendation[]}` (최신순, 팀 전체 공용) |
| `GET /api/recommendations/{id}` | – | `200 Recommendation` · `404` |
| `GET /api/recommendations/{id}/preview?budgetKrw=` | `budgetKrw` 선택 (양수, 원) | `200 RiskPreview` · `budgetKrw`가 숫자가 아니거나 0 이하 `400` · 증권사 조회 불가 `503` |
| `POST /api/recommendations/{id}/activate` | `{"budgetKrw"?: number, "token"?: string, "acknowledged"?: boolean}` | `201 TradePlanDetail` · 활성화할 수 없으면 `400 {"detail": 사유들을 "; "로 이은 것}` · `token`이 만료·위조면 `400` · `404` · 증권사 조회 불가 `503`. `acknowledged`: 실행 확인 체크리스트를 모두 켰는지 → `activated` 사건 details `{via, budgetKrw, acknowledged}`에 남긴다 (없으면 `false`, 불리언이 아니면 `400`. 서버가 활성화를 막지는 않는다 — 체크리스트는 화면 테스트로 보장) — (2026-10-04 합의, 컨셉 계획 B5 — 미구현, 담당 1) |
| `POST /api/recommendations/demo` | `{"symbol"?: string}` (없으면 시연 종목 목록에서 고른다) | `201 Recommendation` (source `demo`) · 시연 추천이 꺼져 있으면(`AUTOTRADE_DEMO=off`) `403` · 하루 한도(`AUTOTRADE_DEMO_PER_USER`, 기본 5) 초과 `429` · 없는 종목·일봉 부족 `400` · 증권사 조회 불가 `503` |
| `GET /api/trade-plans?status=active\|all` | 페이지. 기본 `active`(진행 중 셋) | `200 {"count", "results": TradePlan[]}` (**내 것만**, 최신순) |
| `GET /api/trade-plans/{id}` | – | `200 TradePlanDetail` · 남의 계획 `404` |
| `POST /api/trade-plans/{id}/cancel` | – | `200 TradePlanDetail` · 이미 끝난 계획 `400` · 남의 계획 `404` |
| `GET /api/notifications?unread=1` | 페이지. `unread=1`이면 안 읽은 것만 | `200 {"count", "unreadCount", "results": Notification[]}` (내 것만, 최신순) |
| `POST /api/notifications/read` | `{"ids"?: number[], "all"?: boolean}` (둘 중 하나) | `204` (남의 알림 id는 무시) |
| `GET /api/notification-settings` | – | `200 NotificationSettings` |
| `PATCH /api/notification-settings` | `{"discordUserId"?: string \| null, "discordEnabled"?: boolean}` | `200 NotificationSettings` · `discordUserId`가 숫자 17~20자리가 아니면 `400` (빈 문자열·null이면 지운다) |
| `POST /api/notification-settings/test` | – | `202 {"detail": string, "discord": "queued" \| "not_configured" \| "disabled"}` (웹 알림 하나를 만들고, 가능하면 Discord로도 보낸다) · 1분에 한 번만 (넘으면 `429`) |

규칙:
- **활성화** = 그 순간 리스크 엔진으로 수량을 정하고(`RiskPreview`와 같은 계산) 계획을 `active`로 만든 뒤, 바로 한 번 진행해
  **진입 지정가 주문**(가격 = `entryPrice`, 목표·손절 = 추천 값, 기한 = `holdingDays`를 달력 일수로 바꾼 값)을 낸다. 주문은 기존 모의 주문
  (`POST /api/orders`와 같은 `trading.service.buy`, 요청자 `plan:<계획 id>`)이라 "내 주식"·주문 목록에도 보인다.
- 엔진 루프(`run_engine`)가 진행 중 계획을 계속 진행한다: 체결되면 `holding`, 지정가가 그날 정규장에 체결되지 않아 취소되면 진입 기한 안에서
  다음 정규장에 **다시 주문**(`order_requeued`), 기한이 지나면 주문을 취소하고 `expired`, 보유 중 목표·손절·기한으로 청산되면 `closed`.
  모의 주문을 "내 주식"에서 직접 취소하면 계획은 `cancelled`, 직접 매도하면 `closed`(`MANUAL`)가 된다.
  재주문 때는 리스크 엔진을 다시 돌려 **수량을 새 계산값 이하로 줄여** 낸다(늘리지 않는다). 그때 막히면(지금 가격이 목표가 이상·손절가 이하, 매수 가능 금액 부족 등)
  계획은 `failed`로 끝난다. 엔진이 체결 시점에 취소한 진입 주문(현금 부족 등)도 `failed`다 (`cancelled`는 사용자가 멈춘 경우만).
- **중단**(`cancel`): `active`·`entry_pending`이면 주문을 취소하고 `cancelled`. `holding`이면 전량 매도를 요청하고(정규장 밖이면 매도 예약)
  `exit_requested`를 남긴다 — 계획은 매도가 끝나면 `closed`(`MANUAL`)가 된다. 이미 매도 예약이 있으면 사건을 다시 남기지 않고 지금 계획을 `200`으로 돌려준다.
- AI가 준 진입·목표·손절은 추천을 만들 때 **호가 단위로 내려** 맞춘다 (모의 주문에 들어가는 값과 같게). 미국 종목의 예산 제한은 소수점(금액) 기준이다.
- 같은 종목에는 진행 중 계획이 **하나만** 있다 (모의 계좌의 "같은 종목은 포지션 하나만" 규칙과 같다).
- **Discord 활성화 링크** = `{PUBLIC_BASE_URL}/recommendations/{id}?t=<token>`. 웹 화면이 `t`를 읽어 활성화 요청의 `token`으로 보낸다.
  token은 서버가 서명한 값(추천 id + 만료 = `validUntil`)이고, 맞으면 `via: "discord"`로 기록한다. **로그인은 링크로도 필요하다**
  (링크는 팀 채널에 올라가므로 링크만으로 남의 계좌에 계획을 만들 수 없게 한다).
- 알림: 추천이 생기면 신청한 팀원(없으면 팀 전체)에게, 계획의 상태가 바뀌면 그 계획의 주인에게 웹 알림을 만든다. Discord는 서버의
  `DISCORD_WEBHOOK_URL` 채널 하나로 보내고(없고 `OPENCLAW_TARGET`이 있으면 openclaw로), 주인의 `discordUserId`가 있으면 멘션한다. Discord 전송은 엔진 루프가 보낸다
  (실패하면 1회 재시도 → 첨부 없이 글만 → 그래도 안 되면 실패로 기록. 웹 알림은 그대로 남는다. 한 바퀴에 15초까지만 보내고 나머지는 다음 바퀴로).
  AI가 쓴 글 속의 멘션(`<@…>`·`@everyone`)은 무력화하고, 우리가 붙인 받는 사람 멘션만 울린다. 시험 API의 `not_configured`는 Webhook·openclaw가 모두 없다는 뜻이다.
- 프론트 폴링: 알림 개수 15초, 진행 중 계획 5초, 추천 목록 30초.

### 실행 불가 사유 코드 (`RiskPreview.reasonCodes`, 2026-10-04 합의, 컨셉 계획 B4 — 미구현, 담당 1)

화면이 사유 문장을 맞추지 않고 코드로 쉬운 문장(담당 5의 `lib`, 컨셉 계획 4-5)을 고른다. 서버는 **이 표의 코드만** 낸다 (새 사유를 더하면 이 표를 먼저 고친다).
화면은 모르는 코드면 같은 자리의 `reasons[i]` 원문을 보인다. `reasons`(사람이 읽는 원문)와 활성화 `400`의 `detail`은 그대로다.

| 코드 | 조건 (지금 `reasons` 원문을 내는 곳) |
|---|---|
| `reward_risk_low` | 손익비가 최소 기준(2.0)보다 낮음 (리스크 엔진 `assess`) |
| `ev_negative` | 비용을 반영한 기대값이 0 이하 (`assess`) |
| `daily_loss_limit` | 일일 손실 한도 도달 (`assess`) |
| `daily_trades_limit` | 일일 매매 건수 한도 도달 (`assess`) |
| `warning_stock` | 매수 유의 종목 (투자경고 등, `assess`) |
| `size_too_small` | 리스크 엔진이 정한 수량이 1주 미만 (미국 종목은 최소 주문 금액 미만) — 예산과 무관 (`assess`) |
| `budget_too_small` | 예산(`budgetKrw`)으로 줄인 수량이 1주 미만 (미국 종목은 최소 주문 금액 미만) (`risk.preview`) |
| `expired` | 추천의 활성화 기한(`validUntil`)이 지남 |
| `plan_exists` | 같은 종목에 진행 중인 내 계획이 있음 |
| `position_exists` | 같은 종목에 진행 중인 모의 주문이 있음 (같은 종목은 포지션 하나만) |
| `halted` | 중단 스위치가 켜져 있음 (새 모의 매수 중단) |
| `price_passed` | 지금 가격이 이미 목표가 이상이거나 손절가 이하 |

### 리포트 끝 알림 (2026-10-04 합의, 컨셉 계획 B7 — 미구현, 담당 1·4)

리포트 하나가 끝나면 신청자에게 알림이 **한 번만** 간다 (웹 알림 + Discord, `notifications.service.notify`).
- **완성** — 팀원 신청 리포트(`source: "user"`)가 `completed`로 끝나면 runner(담당 3)가 부르는 `auto.after_finish(report)`(담당 1)가 보낸다.
  이 리포트로 추천이 생기면(`verdict` buy이고 `0 < stop < entry < target` — `00-공통.md` 10절) `report_completed`를 보내지 않고, 추천 알림(`recommendation`)의 본문 첫 줄을 "리포트가 완성됐어요"로 한다.
  추천이 생기지 않으면(지켜보기·부정적·가격 조건이 맞지 않음) `report_completed` 하나 (`link`: `/reports/{id}`).
- **실패** — `failed`로 끝나면(엔진 재시작 정리 `engine_restarted` 포함) 담당 4의 `healing.notify_failure(report, reason)` 한 곳에서 `report_failed`를 신청자에게 보낸다
  (`link`: `/reports/{id}`, 본문은 실패 사유 코드(`00-공통.md` 9절)의 쉬운 문장). 예전 계획의 `system`은 쓰지 않는다.
- **자동 리포트**(`source: "auto"`)는 웹 알림을 만들지 않고 01 T1-5의 Discord 발송(PDF 첨부 또는 실패 글)만 한다.
