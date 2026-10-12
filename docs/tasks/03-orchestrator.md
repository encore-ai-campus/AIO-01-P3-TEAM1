# 03. Orchestrator (담당 3)

> **파일 위치 (2026-10-11)**: `backend/reports`의 코드를 기능 폴더로 정리했다. 아래의 파일 이름은 그대로이고 폴더만 바뀌었다 — 어느 폴더인지는 `AGENTS.md` "구조", 정리 내용은 `docs/DECISIONS.md` 29장.

> **2026-10-07 — T3-2~T3-9·T3-12 → Claude가 구현** (사용자 요청, `docs/DECISIONS.md` 19장): `orchestrator.py`, `guards.py`(입력·Join·Handoff Guard), `runner.py`, `run_engine` 연결, `fake_worker`, `state.add_cost`·팀별 확인. 실패 사유 코드에 `agent_failed`·`no_llm`·`expired`를 더했다(00-공통 9절). `AGENTS_IMPLEMENTED = True`.
> 3에게 남는 것: **T3-10 실제 키로 리포트 한 건 끝까지**, T3-11 설계서 ① 총괄, 화면에서 진행 단계 표시 확인.

> **할 일 (2026-10-05 단순화 — `docs/plans/TEAM_DEV_PLAN.md` 11장)**: ① 추천 워크플로우: Orchestrator·Guard·runner·Handoff·실패 사유 코드 · ② UI/UX: 진행 단계 표시 확인 · ③ 추가 기능 논의: ~~단타 AI 팀(`day_plan`·`day_review`) 설계~~(2026-10-06 단타 폐기로 없어짐) · ④ 테스트: 오케스트레이션 테스트, 장애 시험.
> 그 밖의 확정된 변경은 Claude가 구현한다(`docs/DECISIONS.md` 14장). 아래 세부 표는 워크플로우 개발의 약속·참고로 남긴다.

목표: 실행 계획대로 Worker를 **병렬·순차로 돌리고**, Join Guard·부분 실패 정책·검토 반복·Handoff를 판단하며, State와 Trace를 남기고, `run_engine` 루프에서 리포트를 집어 실행한다.
`docs/plans/TEAM_DEV_PLAN.md` 4-2의 C~G·J. 약속은 `00-공통.md` 8절(지키는 것), 9절(Trace 사건), 4절(스키마). 산출물 책임: **설계서 ① 총괄** (흐름·Handoff·공유 상태·정상·재시도·실패·종료).

가장 무거운 역할이다. 밀리면 Handoff(T3-7)부터 줄인다.

> **2026-10-05**: B7 줄·T3-4·T3-12는 `docs/DECISIONS.md` 14-2 표로 읽는다 (줄은 고치지 않았다) — 팀원 리포트의 완성·실패 알림은 Claude의 `reports/output/alerts.py`가 보낸다 (`00-공통.md` 8절).
> runner는 끝난 리포트마다 `auto.after_finish(report)`(1, 자동 리포트만)만 부르면 되고 `healing.notify_failure`는 부르지 않아도 된다 (T3-12 완료 기준의 "`notify_failure` 호출 1번"도 빠진다). 알림에 관해 3이 지킬 것은 실패로 끝낼 때 `workflow_failed.details.reason`을 9절 사유 코드로 남기는 것이다.

## 받는 것 · 주는 것

| 받는 것 | 누구에게서 |
|---|---|
| `agents.WORKERS`, `contracts.validate` | 2 |
| `healing.make_caller`, `LlmGaveUp`, `fake_llm` | 4 |
| 모델 새 열(`chaos`, `source`, `cost_usd`) | 4 (10/5 오전) |

| 주는 것 | 누구에게 |
|---|---|
| `registry.py` 스키마(`fallbacks`, `retry`) | 2 (YAML 값), 4 (대체 모델 순서), 5 (`plan.workers[].fallbacks`, `steps[].retry`) |
| `guards.clean_text` | 2 |
| `fake_worker` fixture | 4 (호출기 통합 테스트), 1 (자동 리포트 테스트) |
| `runner.tick/recover/shutdown`, `run_engine` 연결, 끝난 뒤 `auto.after_finish` 호출 | 1 |
| Trace 사건 전부 (9절) | 4 (지표), 5 (화면) |
| (2026-10-04 합의) 리포트 실패 사유 코드 목록 (`00-공통.md` 9절, T3-12) | 4 (`notify_failure` 본문), 5 (사유 문장 표) |

## 2026-10-04 바뀐 것 — 리포트 다음 단계(AI 추천)는 이미 연결돼 있다

서비스 최종 흐름(`06-추천·자동매매.md`)에서 리포트는 **AI 추천의 출처**다. 담당 3이 할 일은 늘지 않는다:
`finish(completed, content)`로 끝내고 `results["report_agent"]`에 계약을 통과한 `ReportDraft`가 있으면, 엔진 루프의 "추천 수집" 단계
(`autotrade.recommend.sources.collect`, 최근 7일 안에 끝난 리포트를 본다)가 추천을 만들고 신청자에게 웹·Discord로 알린다. 따로 부를 함수가 없다.

- `run_engine.py`에는 이미 단계가 넷 더 있다: … 분석 작업 → 추천 수집 → 자동 추천 → 자동매매 → 알림 발송 (커밋 `09a9ada`).
  T3-4의 `runner.tick()`은 **"분석 작업" 다음, "추천 수집" 앞**에 한 줄로 넣는다 ("알림 발송"이 마지막이게).
- `failed`로 끝난 리포트·`verdict`가 buy가 아닌 리포트는 추천이 생기지 않는다 (정상).
- 실패 알림(담당 4의 T4-8)도 같은 알림 통로(`notifications.service.notify`)를 쓰면 웹과 Discord에 같이 남는다.

## 2026-10-04 합의 — 실패 사유 코드와 설계서의 "사용자 3단계 ↔ Agent" 표 (`docs/DECISIONS.md` 13장)

서비스 컨셉이 "주식이 처음인 사람도 리포트를 ① 만들고 · ② 검토하고 · ③ 모의 자동매매로 실행하는 **AI 리포트 데스크**"로 바뀌었다 (`docs/plans/컨셉변경계획.md`). (2026-10-05 이름을 "종이배"로, 2026-10-07 **"모매매"**로 바꿨다 — `docs/DECISIONS.md` 15-7·18장)
**Orchestrator 구조·Trace 규칙·일정은 그대로다.** 담당 3에게 더해진 것은 아래 셋이다 (T3-12, T3-11 고침).

| 바뀐 곳 | 내용 |
|---|---|
| 실패 사유 코드 (T3-12) | `workflow_failed.details.reason`을 `00-공통.md` 9절의 목록(`join_blocked`·`review_failed`·`timeout`·`engine_restarted`·`exception`)에서만 낸다. 화면·실패 알림이 이 코드로 쉬운 문장을 고른다 ("자료를 모으는 AI가 응답하지 않아 리포트를 쓸 수 없었어요" 등) |
| 리포트 끝 알림 (B7) | runner는 끝난 리포트마다 `auto.after_finish(report)`(1)를 부르고(팀원 리포트의 완성 알림도 여기서 나간다), 실패로 끝나면 `healing.notify_failure(report, reason)`(4)를 한 번 부른다 (`00-공통.md` 8절) |
| 설계서 ① (T3-11) | "목적과 대표 사용자 시나리오"에 컨셉 1-1의 시나리오 셋(정상 · 복구 · 실패)과 1-2의 **"사용자 3단계 ↔ Agent" 표**를 넣는다 |
| 쉬운 요약 (B1) | 바뀌지 않는다. Join Guard가 검토(`review_agent`)에 초안 전체를 넘기는지만 확인한다 (`plainSummary`가 대조 대상이다) |

## 작업

| # | 할 일 | 파일 | 완료 기준 |
|---|---|---|---|
| T3-1 | **스키마** — `_worker`에 `fallbacks`(이름 목록, 중복·주 모델과 겹침 금지, 기본 `[]`), `_step`에 `retry: {target, max_rounds}`(target은 `depends_on` 단계의 Worker, max_rounds 1 이상 정수; 기본 null). 계획 JSON에 `fallbacks`, `retry: {target, maxRounds}`. YAML에 빈 값·`review` 단계에 `retry: {target: report_agent, max_rounds: 2}`. `test_registry.py`에 오류 케이스 | `registry.py`, YAML 두 개, `tests/orchestration/test_registry.py` | **10/5 오전 첫 PR**. `GET /api/reports/plan`에 새 필드 |
| T3-2 | **`fake_worker` fixture** — `FakeWorker(id, result=..., error=..., delay=0, calls=[...])`: 정해진 결과/예외를 내고, `ctx`를 기록한다 (테스트가 `attempt`·`instructions`·`inputs`를 확인) | `tests/conftest.py` | |
| T3-3 | **Orchestrator 1차 (정상 경로)** — `run_report(report, *, workers=None, llm_client=None, now=None)`: `start` → 단계마다 `set_step` → parallel은 `ThreadPoolExecutor(max_workers=len(step.workers))`, sequential은 차례로 → Worker 실행(`agent_started` → `make_caller`로 `ctx.llm` → `run` → `_`키 꺼내기 → `validate` → `add_result` → `agent_completed`(details는 9절, `ctx.llm.calls`에서 attempts·model·costUsd)) → `workflow_completed` → `finish(completed, content)`. 본문 = `report_agent` 결과의 `markdown`. 예외는 전부 잡아 `workflow_failed` + `finish(failed)` | `orchestrator.py`, `tests/orchestration/test_orchestrator.py` | `fake_worker` 6개로 정상 경로 테스트: Trace 순서·State가 `docs/plans/TEAM_DEV_PLAN.md` 4-4대로. **10/5 오후** |
| T3-4 | **실행기** — `runner.tick()`: `requested` 리포트 하나를 잡아(`select_for_update(skip_locked=True)`, 생성 순) 스레드에서 `run_report`. `MAX_CONCURRENT = 1`. `recover()`: 뜰 때 `running`으로 남은 리포트마다 `record("orchestrator", "workflow_failed", "failed", details={"reason": "engine_restarted"})` → `finish(failed)` (00-공통 8절). `shutdown()`: 도는 스레드를 최대 10초 기다린다. 스레드 끝에 `connections.close_all()`. 끝난 뒤 `auto.after_finish(report)`가 있으면 부른다. `run_engine.py`의 루프에 `runner.tick()`, 시작에 `runner.recover()`, 끝에 `runner.shutdown()` (`analysis.jobs`와 나란히). `registry.AGENTS_IMPLEMENTED = True`는 **T3-5까지 끝난 뒤** | `runner.py`, `tests/orchestration/test_runner.py`, `run_engine.py` | `run_engine --once`로 requested → completed. 두 번 불러도 같은 리포트를 두 번 돌리지 않는다 |
| T3-5 | **Join Guard와 부분 실패 정책** — `guards.join(report, step, plan) -> JoinDecision(ok, inputs, missing, reason)`: 필수 결과 존재·계약 통과 확인, 실패 결과 제외, `inputs`는 앞 단계 결과 중 **그 단계가 쓰는 것만**(조사 3개 → 작성에 전부, 작성·조사 → 검토에 초안+조사). `failurePolicy` 셋을 구현. 막히면 `join_blocked` → 뒤 Worker `agent_skipped(reason: "join_blocked")` → `workflow_failed` → `finish(failed)`. Worker 실패 처리(`LlmGaveUp`·`WorkerError`·`TimeoutError`·그 밖 예외 → `add_error` + `agent_failed(final: true)`). 단계 `timeoutSec` = Worker `deadline`; `future.result(timeout=…)`로 넘긴 Worker는 실패로 | `guards.py`, `orchestrator.py`, `tests/guardrails/test_guards.py` | 테스트: 선택 실패 → 계속, 필수 실패 → 차단·건너뜀·실패 종료, fail_fast, best_effort, 시간 초과 |
| T3-6 | **검토 반복** — `review_agent` 결과 `verdict`: `PASS` → 계속, `RETRY` → `review_retry(round, target, issues, instructions)` → `retry.target`을 `attempt+1`, `instructions`로 다시 실행 → 다시 검토. `maxRounds`를 넘으면 `FAIL`로. `FAIL` → `agent_skipped`(뒤 단계) + `workflow_failed(reason: "review_failed")` + `finish(failed)`. 본문에는 마지막 PASS 초안 | `orchestrator.py`, 테스트 | 테스트: RETRY 뒤 PASS(2라운드), 계속 RETRY → 한도에서 실패 (무한 실행 방지), `agent_started.details.attempt`가 2 |
| T3-7 | **Handoff와 Guard** — `review_agent` 결과의 `handoff`가 있으면 `plan.handoffs`에서 경로 확인 → `guards.handoff(report, plan, from, to, message) -> HandoffDecision`: 허용 경로, `hop_count < maxHops`, 전달 데이터에 비밀 값 모양 없음, `user_id` 있음 → `handoff_started` → `risk_agent` 실행(`ctx.handoff` = 4-3 전달 데이터) → `handoff_completed`. 거절 → `handoff_blocked(reason)` 후 그대로 완료. `risk_agent` 결과가 있으면 본문 맨 위에 경고 블록 | `guards.py`, `orchestrator.py`, 테스트 | 테스트: 허용 경로 성공, 계획에 없는 경로 거절, Hop 초과 거절, 비밀 값 포함 거절 |
| T3-8 | **입력 Guard** — `guards.clean_text(text) -> (정리된 글, [지운 사유])`: 지시문 패턴(한·영: "이전 지시를 무시", "ignore previous instructions", "system prompt", "API 키", "비밀번호를 출력" 등), 비밀 값 모양(`sk-[A-Za-z0-9]{20,}`, 40자 이상 토큰), 지나치게 긴 본문 자르기(2,000자). 2가 쓴다 | `guards.py`, 테스트 | DR-SEC-01: 지시문이 든 뉴스가 결과의 `_guarded`와 `agent_completed.details.guarded`에 남는다 |
| T3-9 | **비용 집계** — Worker마다 `ctx.llm.cost_usd`를 더해 `Report.cost_usd`에 저장(`state`에 `add_cost(report, usd)`를 더한다 — `state.py`는 공용이라 **함수 하나만** 더하고 4·2에게 알린다). `workflow_completed.details.costUsd` | `state.py`, `orchestrator.py` | |
| T3-10 | **`AGENTS_IMPLEMENTED = True`**와 통합 — 2의 Worker·4의 호출기와 붙여 실제 키로 리포트 하나 끝까지 (10/7). 화면(5)에서 노드가 실시간으로 바뀌는지 같이 본다 | `registry.py` | 신청 → 몇 분 안에 본문. `uv run pytest` 통과 |
| T3-11 | **설계서 ① 뼈대와 흐름** — 목적·대표 시나리오(2026-10-04 합의: 컨셉 계획 1-1의 대표 페르소나와 시나리오 셋 — ① 정상: 만들기 → 검토 통과 → 실행 ② 복구: 뉴스 AI 장애 → 대체 모델로 완성 → 실행 ③ 실패: 필수 AI 전부 실패 → 이유 안내 + 담당자 알림), **"사용자 3단계 ↔ Agent" 표**(컨셉 계획 1-2: ① 만들기 = Orchestrator → 조사 Agent 셋(병렬) → Join Guard → 작성 Agent, ② 검토 = 검토 Agent(PASS·RETRY·FAIL) → Handoff 리스크 점검 Agent·입력 Guard, ③ 실행 = 결정론적 코드(리스크 엔진 → 모의 체결기 → 알림, AI 아님), 공통 = Planner(`team_definitions.yaml`)·Memory Keeper(`state.py`), 서비스 전체 = Docker·CI/CD·인프라 장애 — 단계마다 "장애가 나면 사용자에게 보이는 것" 열 포함), 협업 구조와 선정 이유(가이드의 "에이전트별 컨테이너"에 대한 우리 선택 — `docs/plans/TEAM_DEV_PLAN.md` 7장), 실행 계획 그래프, 정상·재시도·실패·종료 흐름(순서도), Handoff 조건과 전달 데이터, 공유 상태 관리, 역할 중복·공백 점검. 2(역할 표), 4(복구 흐름)가 채울 자리를 남긴다 | `docs/설계서.md` | 10/8 초안 |
| T3-12 | **실패 사유 코드** (2026-10-04 합의, 컨셉 계획 4-4·9장) — `workflow_failed.details.reason`은 `00-공통.md` 9절 "리포트 실패 사유 코드"에서만: Join 막힘 `join_blocked`(T3-5), 검토 실패 `review_failed`(T3-6), 시간 초과 `timeout`(T3-5 — 필수 Worker의 시간 초과를 `join_blocked`·`timeout` 중 어느 쪽으로 낼지 정해 9절 표에 적는다), 엔진 재시작 `engine_restarted`(T3-4), 그 밖 예외 `exception`(T3-3). 새 경우는 9절 표에 코드를 먼저 더하고 5에게 알린다. runner는 실패로 끝난 리포트(`run_report`가 failed로 돌려줌·`recover()`)마다 4의 `healing.notify_failure(report, reason)`를 한 번 부르고(없으면 `getattr`로 건너뜀), 끝난 리포트마다 `auto.after_finish(report)`를 부른다 (둘 다 예외를 삼킨다) | `orchestrator.py`, `runner.py`, 테스트 | 테스트: 실패 경로마다 `reason`이 목록 안이고, 실패 1건에 `notify_failure` 호출 1번 |

## 일정

- **10/5(월) 오전**: T3-1 (첫 PR), T3-2. 오후: T3-3, T3-4 (뼈대 PR).
- **10/6(화)**: T3-5, T3-6.
- **10/7(수)**: T3-7, T3-8, T3-9, T3-10 (2·4와 함께 실제 실행).
- **10/8(목)**: T3-11(사용자 3단계 ↔ Agent 표 포함), 통합에서 나온 문제 수정. T3-12는 T3-3~T3-6을 만들면서 같이 (실패 경로를 만들 때 코드를 정한다).

## 주의

- **State와 Trace는 `state.*`로만** 바꾼다 (`docs/DECISIONS.md` 9-4). ORM으로 직접 `Report`를 저장하지 않는다. `finish` 뒤에는 `record`가 `StateError`를 낸다 — `workflow_completed`를 **먼저** 남기고 `finish`.
- 병렬 스레드에서 `state.record`를 동시에 불러도 step 번호는 겹치지 않는다 (잠금·재시도가 들어 있다). 스레드마다 Django DB 연결이 따로 생기니 끝날 때 닫는다.
- 실패한 결과를 빈 값이나 고정된 성공으로 바꾸지 않는다. 앞이 실패하면 뒤는 실행하지 않고 `skipped`.
- Worker 하나가 `deadline`을 넘기면 스레드는 끝날 때까지 남는다 (파이썬은 스레드를 죽일 수 없다). 결과만 버리고 실패로 처리하되, `shutdown`에서 너무 오래 기다리지 않게 한다.
- 비용 상한: `MAX_CONCURRENT = 1`. 테스트에서 실제 LLM을 부르지 않는다. 실제 실행은 T3-10에서 1~2건만.
- `run_engine.py`는 `trading` 앱 파일이다. 한 줄씩만 더하고, 1이 뒤에 `auto.tick()`을 더한다.
