# 02. Worker·출력 계약 (담당 2)

> **파일 위치 (2026-10-11)**: `backend/reports`의 코드를 기능 폴더로 정리했다. 아래의 파일 이름은 그대로이고 폴더만 바뀌었다 — 어느 폴더인지는 `AGENTS.md` "구조", 정리 내용은 `docs/DECISIONS.md` 29장.

> **2026-10-07 — T2-3~T2-8 → Claude가 구현** (사용자 요청, `docs/DECISIONS.md` 19장): `agents/prompts.py`, 종목 리포트 Worker 6개(`agents/report_team/market.py` 등, 등록 `agents/report_team/team.py`), 매매 종목 선정 Worker 5개(`agents/selection_team/news_screen.py` 등, 등록 `agents/selection_team/team.py`), 선정 팀 출력 계약 4개, YAML 모델 값(00-공통 4절 초안 그대로). 2의 계약 보강(dy `ce98783`)을 그 위에 합쳤다.
> 2에게 남는 것: **T2-10 실제 모델로 프롬프트 다듬기**, T2-9의 비용 예산(`budget.py`), T2-11 설계서 ① 역할 표.

> **할 일 (2026-10-05 단순화 — `docs/plans/TEAM_DEV_PLAN.md` 11장)**: ① 추천 워크플로우: Worker 6개·출력 계약(B1 `plainSummary` 포함)·프롬프트 · ② UI/UX: 리포트 문장 품질 · ③ 추가 기능 논의: 뉴스 출처 대안, 장기투자 AI 문장 · ④ 테스트: 출력 계약 테스트, LLM 장애 시나리오 일부.
> 그 밖의 확정된 변경은 Claude가 구현한다(`docs/DECISIONS.md` 14장). 아래 세부 표는 워크플로우 개발의 약속·참고로 남긴다.

목표: 조사 3개·작성·검토·리스크 Worker 6개가 자료를 모아 LLM을 한 번 부르고 **출력 계약에 맞는 결과**를 돌려준다. `docs/plans/TEAM_DEV_PLAN.md` 4-2의 A·B·H·I.
약속은 `00-공통.md` 6절(Worker 인터페이스), 7절(호출기), 10절(출력 계약). 산출물 책임: 설계서 ①의 "역할·책임·입출력" 표.

> **2026-10-05**: `docs/DECISIONS.md` 14-2에 따라 Claude가 맡게 된 줄(일부만이면 그 부분)에 "→ Claude가 구현 (2026-10-05)"을 붙였다 (줄은 지우지 않았다). 표시가 붙은 일은 하지 않는다.
> T2-4는 표시 없이 내용이 바뀌었다 — `market_agent`는 장마감 기준(`trading.market.close_price`·`completed_candles`, `MarketResult.asOf`)으로 만든다 (`00-공통.md` 10절, 14-2 표).
> (2026-10-08, Claude) 장 중에 만들면 가격만 현재가다 — `MarketResult.priceBasis: "live"` (`docs/DECISIONS.md` 26장, `docs/API.md` "리포트 시세").

## 2026-10-07 구현 메모 — Worker가 코드로 정하는 것 (AI는 제안만)

| Worker | 코드가 정하거나 덮어쓰는 것 |
|---|---|
| `market_agent` | `price`·`changePct`·`asOf`(`trading.market.closes`, 없으면 마지막 완성 봉), `rsi`(14), `volatilityPct`(최근 20 완성 봉 일간 수익률 표준편차 %, 연환산 아님), `support`·`resistance`(최근 20 완성 봉 최저·최고), `volumeRank`(그날 선별 파일의 거래대금 순위, 없으면 null). 일봉·종가가 없으면 `WorkerError` |
| `fundamental_agent` | `metrics`(PER = 종가 ÷ EPS(TTM, 양수일 때), PBR = 종가 ÷ BPS, ROE·매출 성장·영업이익률은 % — DART 자료). DART를 30초까지만 기다리고(LLM 시간 100초 남김) 못 받으면 "자료 없음"·`metrics` null. `recentFilings`는 받은 공시 목록에 있는 것만 |
| `news_agent` | `headlines`는 받은 뉴스 제목에 있는 것만. 뉴스가 하나도 없으면 `sentiment` neutral·`score` null. 제목·매체는 `clean_text` |
| `report_agent` | 인용(`citations`)은 조사 결과의 evidence에 있는 것만 (없으면 evidence로 채움). 프롬프트에 손익비 기준·"손익비"라는 말이 없다 (테스트) |
| `review_agent` | `buy` 초안의 진입·목표·손절 순서가 틀리거나 진입가가 종가에서 5% 넘게 떨어지면 PASS를 RETRY로. 투자유의 종목이면 `handoff`(risk_agent)를 붙인다 |
| `risk_agent` | 투자유의가 있으면 `level`은 최소 medium, 투자경고·투자위험·거래정지·정리매매·관리종목이면 high. 프롬프트에 `user_id`·`task_id`를 넣지 않는다 |
| `news_screen_agent` | 후보 밖 종목 항목은 버린다. 뉴스가 없는 후보는 중립·재료 없음. 기사 날짜는 KST (뉴스 Worker 둘 다) |
| 선정 팀 조사 셋 | 단계 제한 시간에서 LLM 몫 70초를 남기고 조회한다. 조회 하나가 그 몫을 넘기면 끊고 그 뒤 후보는 "자료 없음" |
| `filing_screen_agent` | 30일 공시 전부(프롬프트에는 후보마다 최신 10개) 중 고위험 공시 낱말(관리종목·상장폐지·횡령·배임·감사의견·의견거절·불성실공시·회생·파산·부도·거래정지·자본잠식 등)이 제목에 있으면 `severity` high. 해제·아님·종결·취소·해소 공시는 빼고, 우선주는 보통주 공시를 본다 |
| `flow_agent` | 외국인·기관 순매수 5일·20일 합계(주 수)를 코드가 계산. AI는 해석만 |
| `selection_review_agent` | 후보 밖 종목·고위험 공시 종목·권유 표현·가격 표기가 선정안에 있으면 PASS를 RETRY로 (지적의 problem은 "코드 확인:"으로 시작) |

## 받는 것 · 주는 것

| 받는 것 | 누구에게서 | 없을 때 |
|---|---|---|
| `ctx.llm` 호출기(`LlmCaller`), `fake_llm` fixture | 4 (10/5 오전 뼈대) | 뼈대 전에는 `lambda system, user, contract=None, timeout=None: LlmReply(...)` 가짜로 개발 |
| `guards.clean_text` | 3 | 들어오기 전에는 그대로 넣고, 들어오면 바꾼다 |
| 조회 자료 | 엔진 (`docs/plans/TEAM_DEV_PLAN.md` 4-2 표) | 키가 없으면 "자료 없음"으로 |

| 주는 것 | 누구에게 |
|---|---|
| `contracts.validate(name, data)`, `contracts.NAMES` | 3 (결과 확인), 4 (bad_output 판정) |
| `agents.base.WorkerContext`·`Worker`·`WorkerError`, `agents.WORKERS` | 3 |
| `worker_definitions.yaml`의 `provider`·`model`·`fallbacks` 값 | 4 (대체 모델 순서), 5 (화면의 모델 이름) |
| `reports/limits/quota.py` → Claude가 구현 (2026-10-05) (횟수 한도. 2에게는 비용 예산 `reports/limits/budget.py`가 남는다) | 4 (`ReportsView.post`에서 같이 부른다) |

## 2026-10-04 바뀐 것 — 리포트가 "AI 추천"으로 이어진다

서비스 최종 흐름(`06-추천·자동매매.md`): 리포트가 `completed`로 끝나면 엔진 루프가 **`report_agent` 결과(ReportDraft)로 AI 추천**을 만들고,
팀원이 그 추천을 웹·Discord에서 활성화하면 모의 자동매매가 진행된다. 그래서 담당 2의 출력이 사용자의 실제 매매 계획 숫자가 된다.

| 바뀐 곳 | 내용 |
|---|---|
| 출력 계약 `ReportDraft.targets` (T2-1) | `{entry, target, stop, holdingDays, probability}`로 두 필드를 더했다 (`00-공통.md` 10절). `holdingDays`: 보유 거래일 1~20(없으면 10), `probability`: 손절 전에 목표가에 도달할 확률 0~1(없으면 0.5로 보고 화면에 "가정"). 둘 다 null 허용 |
| `report_agent` 프롬프트 (T2-7) | `verdict`가 `"buy"`(소문자)이고 `targets`가 `0 < stop < entry < target`일 때만 추천이 생긴다. 진입·목표는 조사 결과의 가격·지지·저항에 근거해서. **손절은 코드가 정한다** (시세 조사의 `stop`, 엔진 `judge/stops.py` — 2026-10-07). **손익비 기준(스윙 1.5)은 프롬프트에 넣지 않는다** (리스크 엔진이 거른다). `oneLiner`는 추천 카드·Discord 제목 아래 한 줄로, `reasons`·`risks` 3개씩은 추천 화면에 그대로 나온다 |
| `risk_agent` (T2-7) | 결과의 `level`(`low`·`medium`·`high`)이 추천의 "리스크 단계" 배지가 된다 |
| 비용·한도 (T2-9) | 추천·계획·시연 추천은 AI를 부르지 않는다 (비용 0). 한도 계산에 넣지 않는다 |
| 시험 (T2-10) | 실제 모델로 한 번 돌릴 때 `targets`의 네 숫자가 늘 채워지는지도 본다. 리포트가 끝나고 5초 안에 `/recommendations`에 추천이 뜨면 연결 확인 끝 |

## 2026-10-04 합의 — 쉬운 요약(B1)과 프롬프트 요건 (`docs/DECISIONS.md` 13장)

서비스 컨셉이 "주식이 처음인 사람도 리포트를 만들고 · 쉬운 말로 검토하고 · 모의 자동매매로 연습하는 **AI 리포트 데스크**"로 바뀌었다 (`docs/plans/컨셉변경계획.md`). (2026-10-05 이름을 "종이배"로, 2026-10-07 **"모매매"**로 바꿨다 — `docs/DECISIONS.md` 15-7·18장)
Worker 6개·비용·한도의 구조는 그대로이고, 담당 2의 일은 아래만 늘었다. 이미 있던 작업 줄(T2-1·T2-7·T2-9·T2-10)을 고쳤다.

| 바뀐 곳 | 내용 |
|---|---|
| 출력 계약 `ReportDraft.plainSummary` (B1, **확정** — T2-1, 10/5 오전 뼈대 PR에 처음부터) | 쉬운 문장 1~3개(프롬프트는 3개), 항목당 100자, **숫자(0-9)가 들면 `ContractError`** → `bad_output` 재요청. 규칙 원문은 `00-공통.md` 10절 |
| `report_agent` 프롬프트 (T2-7) | `plainSummary` 규칙(숫자·권유형 금지, 조사 결과에 없는 주장 금지), `reasons` 중 하나는 **"목표 가격 ○○원의 근거: …"** 한 줄, `risks` 중 하나는 **"이 의견이 틀리는 경우"** 한 줄("○○원 아래로 내려가거나 ○○이 나오면 의견을 다시 봐야 해요" 형식). 계약 변경 없음 |
| 권유형 문장 금지 (T2-3·T2-7) | 모든 Worker의 글(`oneLiner`·`reasons`·`plainSummary`·`markdown`)에 "사세요"·"사 볼 만해요"·"좋아요" 같은 명령형·권유형을 쓰지 않는다. 주어는 "AI 의견"으로 (화면 배지가 "AI 의견: 긍정적·지켜보기·부정적") |
| `review_agent` 대조 항목 (T2-7) | `plainSummary`도 대조한다: 근거에 없는 주장이거나 `verdict`와 반대 방향이면 `RETRY` |
| 하루 한도 (T2-9, D-7) | **장애 주입이 없는 `failed` 리포트는 하루 한도에서 뺀다** (초보가 시스템 실패로 기회를 잃지 않게). 장애 주입을 켠 리포트는 실패해도 센다 (`docs/API.md` "AI 리포트" 끝) → Claude가 구현 (2026-10-05) (`reports/limits/quota.py`) |

## 작업

| # | 할 일 | 파일 | 완료 기준 |
|---|---|---|---|
| T2-1 | **출력 계약 6개** — 10절 표대로 (**`ReportDraft.plainSummary` 포함 — B1, 2026-10-04 확정**: 숫자(0-9)가 든 항목은 `ContractError`, 비면 `ContractError`, 100자 넘으면 자른다). `validate(name, data) -> dict`: 모르는 키 제거, 필수 키·형·enum·범위 확인, 문자열 길이 자르기(상한 넘으면 자른다, 오류 아님), 목록 상한 넘으면 앞에서 자른다. 틀리면 `ContractError(사유)` — 사유는 LLM에 다시 보여 줄 수 있게 구체적으로 ("`trend`는 up/down/sideways 중 하나여야 합니다: 'bullish'") | `contracts.py`, `tests/guardrails/test_contracts.py` | 계약마다 정상 1·오류 3개 이상 테스트 (`plainSummary`: 숫자 든 항목·빈 목록 오류, 100자 넘으면 잘림). **10/5 오전** |
| T2-2 | **`agents/base.py`** — 6절의 `WorkerContext`·`Worker`·`WorkerError`를 그대로. `agents/__init__.py`에 `WORKERS = {}` (T2-4~T2-7에서 채운다) | `agents/base.py`, `agents/__init__.py` | import만 되면 됨. **10/5 오전** |
| T2-3 | **프롬프트 틀** — 공통 system 프롬프트(역할, "JSON 객체만 출력", 계약 필드 설명을 계약 정의에서 자동 생성, 한국어, 근거 없는 주장 금지, 숫자는 자료에 있는 것만) + Worker별 user 프롬프트 함수. `contracts.describe(name) -> str`(필드와 형을 사람이 읽는 글로)을 만들어 프롬프트에 쓴다 | `agents/prompts.py`, `contracts.py` | 프롬프트에 비밀 값·사용자 아이디가 들어갈 자리가 없다 |
| T2-4 | **시세·차트 Worker** `market_agent` — `build_snapshot`(현재가·일봉·이동평균·RSI·ATR)과 `market.py` 캐시 시세로 자료를 만들어 `MarketResult`. 일봉이 없으면 `WorkerError` | `agents/report_team/market.py` | `fake_llm`으로 테스트: 정상, 일봉 없음 |
| T2-5 | **재무·공시 Worker** `fundamental_agent` — `DartClient`·`fina_stat`. `DART_API_KEY`가 없거나 조회 실패면 "자료 없음"으로 LLM에 넘기고 `metrics`는 null | `agents/report_team/fundamental.py` | 키 없음·조회 실패에도 결과가 나온다 |
| T2-6 | **뉴스·심리 Worker** `news_agent` — `fetch_news`, `broker_reports`. 본문은 `guards.clean_text`를 거친다(지운 사유 → `_guarded`). 미국 종목이면 뉴스 소스를 맞춘다(없으면 자료 없음) | `agents/report_team/news.py` | 지시문이 든 가짜 뉴스로 테스트: `_guarded`가 채워진다 |
| T2-7 | **작성·검토·리스크 Worker** — `report_agent`(`ctx.inputs`의 조사 결과 + `ctx.instructions`가 있으면 "이전 초안의 문제와 수정 지시"를 넣어 재작성 → `ReportDraft`), `review_agent`(초안 + 조사 결과를 주고 근거 대조 → `ReviewResult`. 투자 유의·고위험 신호가 있으면 `handoff: {"to": "risk_agent"}`), `risk_agent`(`client.warnings(symbol)`·스냅샷 `warnings` + `ctx.handoff` → `RiskResult`). **2026-10-04 합의**: `report_agent`는 `plainSummary` 3개(숫자·권유형 금지), 근거 하나는 "목표 가격 ○○원의 근거: …", 위험 하나는 "이 의견이 틀리는 경우"로. `review_agent`는 `plainSummary`도 대조(근거에 없거나 `verdict`와 반대면 RETRY) | `agents/report_team/report.py`, `review.py`, `risk.py` | 검토 RETRY면 `instructions`가 비어 있지 않다 (계약). `fake_llm` 테스트: 숫자가 든 `plainSummary` → `bad_output` 재요청 |
| T2-8 | **`WORKERS` 등록**과 YAML 값 — `agents/__init__.py`에 6개 등록. `worker_definitions.yaml`에 `provider: devpass`, `model`, `fallbacks`(00-공통 4절 초안을 비용 보고 확정) | `agents/__init__.py`, `worker_definitions.yaml` | `registry.execution_plan()["workers"]`에 모델이 전부 채워진다 |
| T2-9 | **횟수 한도 부분 → Claude가 구현 (2026-10-05)** (`quota.py`·`429`·`GET /api/reports/quota`. 2에게 남는 것은 **비용 예산** — 새 팀 파일 `reports/limits/budget.py`의 `check(now) -> None`, `tests/limits/test_budget.py`, `ReportsView.post`에 `quota.check` 다음 한 줄. `docs/DECISIONS.md` 14-2) **비용·한도** — `reports/limits/quota.py`: `check(user) -> None | LimitExceeded`. 팀원별 하루 리포트 수 `AI_DAILY_REPORTS_PER_USER`(기본 3, 새 키 → `.env.example`에 더하고 1에게), 전체 하루 예산 `AI_DAILY_BUDGET_USD`에 분석(`analysis.quota`의 추정)과 리포트 실제 `cost_usd` 합을 같이 넣어 비교. 자동 리포트(`source=auto`)는 팀원 한도에서 빼고 예산에는 넣는다. **장애 주입 없이(`chaos`가 없거나 `enabled: false`) `failed`로 끝난 리포트는 팀원 한도에서 뺀다** (2026-10-04 결정 D-7. 예산에는 실제 비용을 그대로 넣는다). `ReportsView.post`에서 부르는 것은 4와 순서를 맞춘다 (4가 chaos를 먼저 넣으면 그 뒤에) | `quota.py`, `tests/limits/test_quota.py`, `views.py`(한 줄) | 한도 넘으면 `429 {"detail", "limit", "used"}` (`docs/API.md`). 테스트: 주입 없는 failed는 `used`에 안 들어가고, 주입한 failed는 들어간다 |
| T2-10 | **실제 모델로 한 번** — `.env`에 키가 있는 PC에서 종목 하나로 Worker를 직접 돌려 보고(비용 약 $0.3~0.5) 프롬프트를 다듬는다. 응답이 계약을 자주 어기는 필드가 있으면 프롬프트나 계약(상한·null 허용)을 고친다. `plainSummary`에 숫자가 자주 들어가 재요청이 나면 프롬프트를 고친다 (재요청도 장애 1건으로 세어진다) | – | 6개 Worker 모두 한 번에 계약 통과 (재시도 없이) |
| T2-11 | **설계서 ① 표** — 역할·책임·입출력·사용 자료·모델·실패 시 처리를 Worker마다 한 줄. `docs/교육용문서.md`의 용어로 | `docs/설계서.md`(3이 뼈대를 만들면 그 안에) | |

## 일정

- **10/5(월) 오전**: T2-1, T2-2 (뼈대 PR — B1 `plainSummary` 포함, 2026-10-04 확정). 오후: T2-3, T2-4.
- **10/6(화)**: T2-5, T2-6, T2-7.
- **10/7(수)**: T2-8, T2-9, T2-10. 3의 Orchestrator와 붙여 리포트 하나를 끝까지 (3과 같이).
- **10/8(목)**: 프롬프트 다듬기, T2-11, 통합 지원.

## 주의

- Worker는 **State를 바꾸지 않고 Trace도 남기지 않는다.** `ctx.llm`만 부른다. 결과를 꾸미거나(실패를 빈 성공으로 바꾸는 것) 고정값으로 채우지 않는다.
- 조사 Worker의 `evidence`에는 자료의 출처(일봉 날짜 범위, 공시 제목·날짜, 뉴스 제목·매체)를 적는다. 검토 Agent가 이것과 초안을 대조한다.
- 미국 종목(`market == "US"`)은 자료가 적다. `MARKETS=KR`이 기본이므로 KR을 먼저 맞추고 US는 "자료 없음" 처리만 확인한다.
- 숫자는 LLM이 계산하지 않게 한다: RSI·변동성·등락률은 스냅샷이 준 값을 그대로 결과에 넣도록 프롬프트에 적고, 검증에서 자료 값과 크게 다르면(±1%) 자료 값으로 바꾼다 (AI는 제안만 한다).
- 테스트는 `fake_llm`과 가짜 조회 클라이언트(`backend/trading/tests`에 쓰는 것을 참고)로. 실제 호출은 T2-10에서만, 한 종목만.
