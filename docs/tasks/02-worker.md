# 02. Worker·출력 계약 (담당 2)

목표: 조사 3개·작성·검토·리스크 Worker 6개가 자료를 모아 LLM을 한 번 부르고 **출력 계약에 맞는 결과**를 돌려준다. `TEAM_DEV_PLAN.md` 4-2의 A·B·H·I.
약속은 `00-공통.md` 6절(Worker 인터페이스), 7절(호출기), 10절(출력 계약). 산출물 책임: 설계서 ①의 "역할·책임·입출력" 표.

## 받는 것 · 주는 것

| 받는 것 | 누구에게서 | 없을 때 |
|---|---|---|
| `ctx.llm` 호출기(`LlmCaller`), `fake_llm` fixture | 4 (10/5 오전 뼈대) | 뼈대 전에는 `lambda system, user, contract=None, timeout=None: LlmReply(...)` 가짜로 개발 |
| `guards.clean_text` | 3 | 들어오기 전에는 그대로 넣고, 들어오면 바꾼다 |
| 조회 자료 | 엔진 (`TEAM_DEV_PLAN.md` 4-2 표) | 키가 없으면 "자료 없음"으로 |

| 주는 것 | 누구에게 |
|---|---|
| `contracts.validate(name, data)`, `contracts.NAMES` | 3 (결과 확인), 4 (bad_output 판정) |
| `agents.base.WorkerContext`·`Worker`·`WorkerError`, `agents.WORKERS` | 3 |
| `worker_definitions.yaml`의 `provider`·`model`·`fallbacks` 값 | 4 (대체 모델 순서), 5 (화면의 모델 이름) |
| `reports/quota.py` | 4 (`ReportsView.post`에서 같이 부른다) |

## 2026-10-04 바뀐 것 — 리포트가 "AI 추천"으로 이어진다

서비스 최종 흐름(`06-추천·자동매매.md`): 리포트가 `completed`로 끝나면 엔진 루프가 **`report_agent` 결과(ReportDraft)로 AI 추천**을 만들고,
팀원이 그 추천을 웹·Discord에서 활성화하면 모의 자동매매가 진행된다. 그래서 담당 2의 출력이 사용자의 실제 매매 계획 숫자가 된다.

| 바뀐 곳 | 내용 |
|---|---|
| 출력 계약 `ReportDraft.targets` (T2-1) | `{entry, target, stop, holdingDays, probability}`로 두 필드를 더했다 (`00-공통.md` 10절). `holdingDays`: 보유 거래일 1~20(없으면 10), `probability`: 손절 전에 목표가에 도달할 확률 0~1(없으면 0.5로 보고 화면에 "가정"). 둘 다 null 허용 |
| `report_agent` 프롬프트 (T2-7) | `verdict`가 `"buy"`(소문자)이고 `targets`가 `0 < stop < entry < target`일 때만 추천이 생긴다. 진입·목표·손절은 조사 결과의 가격·지지·저항에 근거해서. **손익비 기준(2.0)은 프롬프트에 넣지 않는다** (리스크 엔진이 거른다). `oneLiner`는 추천 카드·Discord 제목 아래 한 줄로, `reasons`·`risks` 3개씩은 추천 화면에 그대로 나온다 |
| `risk_agent` (T2-7) | 결과의 `level`(`low`·`medium`·`high`)이 추천의 "리스크 단계" 배지가 된다 |
| 비용·한도 (T2-9) | 추천·계획·시연 추천은 AI를 부르지 않는다 (비용 0). 한도 계산에 넣지 않는다 |
| 시험 (T2-10) | 실제 모델로 한 번 돌릴 때 `targets`의 네 숫자가 늘 채워지는지도 본다. 리포트가 끝나고 5초 안에 `/recommendations`에 추천이 뜨면 연결 확인 끝 |

## 작업

| # | 할 일 | 파일 | 완료 기준 |
|---|---|---|---|
| T2-1 | **출력 계약 6개** — 10절 표대로. `validate(name, data) -> dict`: 모르는 키 제거, 필수 키·형·enum·범위 확인, 문자열 길이 자르기(상한 넘으면 자른다, 오류 아님), 목록 상한 넘으면 앞에서 자른다. 틀리면 `ContractError(사유)` — 사유는 LLM에 다시 보여 줄 수 있게 구체적으로 ("`trend`는 up/down/sideways 중 하나여야 합니다: 'bullish'") | `contracts.py`, `tests/test_contracts.py` | 계약마다 정상 1·오류 3개 이상 테스트. **10/5 오전** |
| T2-2 | **`agents/base.py`** — 6절의 `WorkerContext`·`Worker`·`WorkerError`를 그대로. `agents/__init__.py`에 `WORKERS = {}` (T2-4~T2-7에서 채운다) | `agents/base.py`, `agents/__init__.py` | import만 되면 됨. **10/5 오전** |
| T2-3 | **프롬프트 틀** — 공통 system 프롬프트(역할, "JSON 객체만 출력", 계약 필드 설명을 계약 정의에서 자동 생성, 한국어, 근거 없는 주장 금지, 숫자는 자료에 있는 것만) + Worker별 user 프롬프트 함수. `contracts.describe(name) -> str`(필드와 형을 사람이 읽는 글로)을 만들어 프롬프트에 쓴다 | `agents/prompts.py`, `contracts.py` | 프롬프트에 비밀 값·사용자 아이디가 들어갈 자리가 없다 |
| T2-4 | **시세·차트 Worker** `market_agent` — `build_snapshot`(현재가·일봉·이동평균·RSI·ATR)과 `market.py` 캐시 시세로 자료를 만들어 `MarketResult`. 일봉이 없으면 `WorkerError` | `agents/market.py` | `fake_llm`으로 테스트: 정상, 일봉 없음 |
| T2-5 | **재무·공시 Worker** `fundamental_agent` — `DartClient`·`fina_stat`. `DART_API_KEY`가 없거나 조회 실패면 "자료 없음"으로 LLM에 넘기고 `metrics`는 null | `agents/fundamental.py` | 키 없음·조회 실패에도 결과가 나온다 |
| T2-6 | **뉴스·심리 Worker** `news_agent` — `fetch_news`, `broker_reports`. 본문은 `guards.clean_text`를 거친다(지운 사유 → `_guarded`). 미국 종목이면 뉴스 소스를 맞춘다(없으면 자료 없음) | `agents/news.py` | 지시문이 든 가짜 뉴스로 테스트: `_guarded`가 채워진다 |
| T2-7 | **작성·검토·리스크 Worker** — `report_agent`(`ctx.inputs`의 조사 결과 + `ctx.instructions`가 있으면 "이전 초안의 문제와 수정 지시"를 넣어 재작성 → `ReportDraft`), `review_agent`(초안 + 조사 결과를 주고 근거 대조 → `ReviewResult`. 투자 유의·고위험 신호가 있으면 `handoff: {"to": "risk_agent"}`), `risk_agent`(`client.warnings(symbol)`·스냅샷 `warnings` + `ctx.handoff` → `RiskResult`) | `agents/report.py`, `review.py`, `risk.py` | 검토 RETRY면 `instructions`가 비어 있지 않다 (계약) |
| T2-8 | **`WORKERS` 등록**과 YAML 값 — `agents/__init__.py`에 6개 등록. `worker_definitions.yaml`에 `provider: devpass`, `model`, `fallbacks`(00-공통 4절 초안을 비용 보고 확정) | `agents/__init__.py`, `worker_definitions.yaml` | `registry.execution_plan()["workers"]`에 모델이 전부 채워진다 |
| T2-9 | **비용·한도** — `reports/quota.py`: `check(user) -> None | LimitExceeded`. 팀원별 하루 리포트 수 `AI_DAILY_REPORTS_PER_USER`(기본 3, 새 키 → `.env.example`에 더하고 1에게), 전체 하루 예산 `AI_DAILY_BUDGET_USD`에 분석(`analysis.quota`의 추정)과 리포트 실제 `cost_usd` 합을 같이 넣어 비교. 자동 리포트(`source=auto`)는 팀원 한도에서 빼고 예산에는 넣는다. `ReportsView.post`에서 부르는 것은 4와 순서를 맞춘다 (4가 chaos를 먼저 넣으면 그 뒤에) | `quota.py`, `tests/test_quota.py`, `views.py`(한 줄) | 한도 넘으면 `429 {"detail", "limit", "used"}` (`docs/API.md`) |
| T2-10 | **실제 모델로 한 번** — `.env`에 키가 있는 PC에서 종목 하나로 Worker를 직접 돌려 보고(비용 약 $0.3~0.5) 프롬프트를 다듬는다. 응답이 계약을 자주 어기는 필드가 있으면 프롬프트나 계약(상한·null 허용)을 고친다 | – | 6개 Worker 모두 한 번에 계약 통과 (재시도 없이) |
| T2-11 | **설계서 ① 표** — 역할·책임·입출력·사용 자료·모델·실패 시 처리를 Worker마다 한 줄. `docs/교육용문서.md`의 용어로 | `docs/설계서.md`(3이 뼈대를 만들면 그 안에) | |

## 일정

- **10/5(월) 오전**: T2-1, T2-2 (뼈대 PR). 오후: T2-3, T2-4.
- **10/6(화)**: T2-5, T2-6, T2-7.
- **10/7(수)**: T2-8, T2-9, T2-10. 3의 Orchestrator와 붙여 리포트 하나를 끝까지 (3과 같이).
- **10/8(목)**: 프롬프트 다듬기, T2-11, 통합 지원.

## 주의

- Worker는 **State를 바꾸지 않고 Trace도 남기지 않는다.** `ctx.llm`만 부른다. 결과를 꾸미거나(실패를 빈 성공으로 바꾸는 것) 고정값으로 채우지 않는다.
- 조사 Worker의 `evidence`에는 자료의 출처(일봉 날짜 범위, 공시 제목·날짜, 뉴스 제목·매체)를 적는다. 검토 Agent가 이것과 초안을 대조한다.
- 미국 종목(`market == "US"`)은 자료가 적다. `MARKETS=KR`이 기본이므로 KR을 먼저 맞추고 US는 "자료 없음" 처리만 확인한다.
- 숫자는 LLM이 계산하지 않게 한다: RSI·변동성·등락률은 스냅샷이 준 값을 그대로 결과에 넣도록 프롬프트에 적고, 검증에서 자료 값과 크게 다르면(±1%) 자료 값으로 바꾼다 (AI는 제안만 한다).
- 테스트는 `fake_llm`과 가짜 조회 클라이언트(`backend/trading/tests`에 쓰는 것을 참고)로. 실제 호출은 T2-10에서만, 한 종목만.
