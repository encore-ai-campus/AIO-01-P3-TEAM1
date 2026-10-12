# yubeen 브랜치 리뷰: 별도 Orchestrator 구현과 timeout fallback 정책 (2026-10-08)

대상: 브랜치 `yubeen`, 끝 커밋 `81373bf` "inhye AutoHealing 작업 통합" (2026-10-08 11:14). 갈라진 곳은 `5c79c0e`로,
Claude가 Agent 워크플로우 전체를 main에 넣은 `fa04ea2`(2026-10-07, `docs/DECISIONS.md` 19장)보다 **앞**이다.
main(`9b99bbd`) 대비 앞 6커밋·뒤 39커밋 (yubeen이 합쳐 둔 dy 쪽 커밋 5개는 2026-10-08 `dy`를 main에 합치며 들어갔다).

| 커밋 | 내용 |
|---|---|
| `82bd8b7` | Orchestrator 실행 흐름과 timeout fallback 정책 구현 — `orchestrator.py`(+336)·`guards.py`(+140)·`healing.py`(+304), 쟁점 Q1~Q4·Q8 결정 기록 (`00-공통.md`·`03-orchestrator.md`·`결정필요사항.md`) |
| `f45076c` · `81373bf` | inhye AutoHealing 합침 · `runner.py`(+119)·`run_engine` 연결·`docs/설계서.md`(+66) |
| `1c1a3bc` "1008" | `env.team`(+99) |

검사: yubeen 브랜치에서 `backend`·`engine/tests` 1645개 중 1644개 통과. 실패 1개(`test_create_team_accounts.py::test_creates_five_accounts`)는
단독으로 돌리면 통과하고 브랜치 CI도 통과했다 — 실행 순서 문제로 보이며 timeout과 무관하다. yubeen의 timeout 테스트 7개는 모두 통과.

상태: **main에 합치지 않음** (2026-10-08, 사용자). 살릴 부분만 아래 3장에서 시험했고, 고르면 main 구현 위에 옮긴다.
**Q1은 절충안으로 결정·반영** (2026-10-08, 사용자 — `Hwanseok` 브랜치, `healing.py`·테스트·문서·프론트 예시 ③. `docs/DECISIONS.md` 19장).
반영본은 시험의 절충안과 한 가지가 다르다: 주 모델 timeout인데 넘어갈 대체 모델이 없으면(모두 차단) 주 모델로 한 번 더 한다
(시험의 절충안은 이때 바로 포기해 `test_gives_up_when_no_fallback_left`가 깨졌다 — 지금 규칙보다 나빠지지 않게).
그래서 깨진 기존 테스트는 11개가 아니라 10개였고, 새 규칙 테스트 4개를 더했다. 나머지 항목(4장)은 그대로 남는다.

**다시 확인 (2026-10-08 오후, main `0121f1d`)**: `yubeen` 끝 커밋은 그대로 `81373bf`(새 커밋 없음), 다른 팀 브랜치는 모두 main에 들어갔다.
4장의 살릴 테스트를 지금 main에 얹어 돌렸다 (임시 작업 트리, 커밋 안 함): `test_llm_once.py` 4개 통과, `test_healing_decisions.py`는 Q2·Q8 통과,
Q1(`test_timeout_goes_directly_to_fallback`)은 대체 모델 이름 `"fallback"`을 main의 `FALLBACK_POOL` 첫 모델 `gpt-5.6-luna`로 바꾸면 통과한다
(YAML `fallbacks`를 쓰지 않는 main 방식 차이일 뿐, 순서는 절충안과 같다). `env.team`은 `.gitignore`에 넣었다. 테스트 두 파일과 설계서는 아직 옮기지 않았다.

## 1. 판단

- **그대로 합칠 수 없다.** main과 28개 파일이 충돌한다 (`reports/agents/*` 8개, `contracts.py`·`guards.py`·`orchestrator.py`·`runner.py`·`state.py`,
  `worker_definitions.yaml`, `views.py`, `run_engine.py`, 테스트 5개, 문서·프론트 7개). 같은 일을 main이 이미 한다:
  Orchestrator·Guard·Runner·State(`fa04ea2`), 호출기 `healing.py`(PR #3), 장애 주입(PR #5), 복구 지표(`feat/4-stats`), 비용 예산(`dy`).
- yubeen이 10-08에 정한 쟁점 다섯 가지 중 **넷은 main이 이미 같게 한다** (2장). 다른 것은 **Q1(timeout이면 같은 모델을 다시 부르지 않고 바로 대체 모델)** 하나다.
- Q1을 main에 옮기면 주 모델이 계속 멈출 때 복구가 60초 빨라진다. 대신 기존 테스트 11~12개와 문서·프론트 예시를 같이 고쳐야 하고,
  yubeen 안 그대로면 실패 사유가 `join_blocked`로 바뀌는 문제가 생긴다 (3장). **절충안**(주 모델 timeout만 바로 대체, 대체 모델 timeout은 한 번 더)이 시험한 경우 모두에서 같거나 낫다.
  바꿀지는 팀장 결정이다 (`docs/결정필요사항.md` U21).

## 2. yubeen의 2026-10-08 결정과 main

| 쟁점 | yubeen | main (지금) | 근거 |
|---|---|---|---|
| Q1 timeout 규칙 | 같은 모델 재호출 없이 바로 다음 fallback | **다름** — 같은 모델 1회 더 → 대체 모델 (2026-10-07 결정, `00-공통.md` 7절, `healing.py` `RETRY_SAME_MODEL`에 `TIMEOUT` 포함) | yubeen 테스트 `test_timeout_goes_directly_to_fallback`이 main에서 실패 |
| Q2 제한 시간 | 단계 `timeout`이 전체 상한, 호출마다 단계 남은 시간까지 | 같다 (`healing.py` `limit = min(timeout or CALL_TIMEOUT_SEC, deadline - clock())`) | yubeen 테스트 `test_each_call_is_limited_by_remaining_stage_time`이 main에서 통과 |
| Q3 필수 Worker timeout 사유 | 직접 원인이 시간 초과면 `timeout` | 단계 시간을 **다 썼을 때만** `timeout` (`orchestrator.py:409` `timed_out=clock() >= deadline`). 지금 Q1에서는 timeout이 이어지면 60초×3 = 180초를 다 써서 결과가 같다 | 3장 "실패 사유" |
| Q4 검토 입력 | 최신 초안 + 성공한 조사 결과 전체 | 같다 (`orchestrator._inputs` — 앞 단계 결과 전부) | `test_orchestrator.py:355`가 재작성 뒤 검토에 고친 초안이 들어가는지 본다 |
| Q8 `attempt` 뜻 | `agent_started`는 Worker 실행 횟수, `agent_failed`·`agent_retry`는 실행 안의 LLM 호출 순번 | 같다 (`LlmCaller.attempt`는 Worker 실행마다 새로 센다) | yubeen 테스트 `test_server_error_retry_attempt_is_scoped_to_worker_run`이 main에서 통과 |

## 3. timeout fallback 시험 (2026-10-08)

방법: main(`9b99bbd`) 임시 작업 트리에서 가짜 시계·가짜 LLM으로 돌렸다 (실제 LLM 호출 없음, 커밋하지 않음). 호출 상한 `CALL_TIMEOUT_SEC` 60초, 단계 180초 (지금 YAML).
정책 셋:

- **main**: 지금 그대로 (timeout도 같은 모델 1회 → 대체 모델)
- **yubeen**: `RETRY_SAME_MODEL`에서 `TIMEOUT`을 뺌 (timeout이면 어느 모델이든 다시 부르지 않음)
- **절충**: 주 모델 timeout만 바로 대체 모델로, 대체 모델 timeout은 한 번 더 (호출기 조건 한 줄)

### 호출기 하나 (`LlmCaller`, 주 모델 gemini-3.8-flash → 대체 gpt-5.6-luna)

| 상황 | main | yubeen | 절충 |
|---|---|---|---|
| S1 주 모델이 계속 멈춤, 대체 모델은 5초에 답 | 성공 125초 (주60·주60·대체5) | **성공 65초** (주60·대체5) | **성공 65초** |
| S2 주 모델이 한 번만 멈춤, 다시 부르면 5초에 답 | 성공 65초, **주 모델**로 끝 | 성공 65초, 대체 모델로 끝 | 성공 65초, 대체 모델로 끝 |
| S3 주 모델 멈춤, 대체 모델도 첫 호출은 멈추고 두 번째에 5초 | **실패** 180초 (주60·주60·대체60) | **실패** 120초 (주60·대체60, 다시 안 부름) | **성공 125초** (주60·대체60·대체5) |
| S4 둘 다 계속 멈춤 | 실패 180초 | 실패 120초 (60초 빨리 포기) | 실패 180초 |

### 리포트 하나를 끝까지 (Orchestrator + `stats`, 시세 Worker의 주 모델이 계속 멈춤)

| | main | yubeen | 절충 |
|---|---|---|---|
| 결과 | 완료 | 완료 | 완료 |
| 조사 단계에 걸린 시간 | 125초 | 65초 | 65초 |
| 시세 Worker Trace | `agent_failed → agent_retry → agent_failed → agent_failover → agent_completed` (시도 3) | `agent_failed → agent_failover → agent_completed` (시도 2) | yubeen과 같다 |
| `agent_completed.recoveryMs` | 65000 | 5000 | 5000 |

### 실패 사유 (필수 시세 Worker의 주·대체 모델이 모두 멈춤)

| | main | yubeen | yubeen + `orchestrator.py:409` 고침 | 절충 |
|---|---|---|---|---|
| `workflow_failed.reason` | `timeout` (180초) | **`join_blocked`** (120초) | `timeout` (120초) | `timeout` (180초) |

yubeen 안만 옮기면 120초에 포기해 단계 시간이 남으므로 409행이 시간 초과로 보지 않고 Join Guard가 막는다 — yubeen 자신의 Q3 결정과 어긋난다.
고침: 409행에서 `LlmGaveUp`의 `error_type`이 `TIMEOUT`이면 단계 시간이 남아도 `timed_out`으로 본다 (시험에서 확인). 절충안은 180초를 다 써서 고치지 않아도 `timeout`이다.

### 정책을 바꾸면 고칠 것

- 기존 테스트 — yubeen 안 12개, 절충안 11개가 깨진다. 모두 "timeout도 같은 모델로 한 번 더"를 기대하는 값이다:
  `test_healing.py` 8개(`test_retry_same_model_once[timeout]`, `test_no_wait_for_other_errors[timeout]`, `test_failover_after_two_failures`, `test_gives_up_after_four_attempts`,
  `test_stops_at_deadline`, `test_recovers_within_180_seconds`, `test_last_call_gets_what_is_left`(yubeen 안만), `test_gives_up_when_no_fallback_left`),
  `test_chaos.py` 3개(`test_injected_primary_recovers_on_fallback`, `test_injected_failures_count_in_report_breaker_only`, `test_report_with_chaos_still_completes`),
  `test_orchestrator.py::test_step_timeout_with_fake_clock`.
- **장애 주입 시연의 Circuit Breaker**: 호출 한 번에 주 모델 실패가 2번에서 1번으로 줄어, 연속 3번 실패해야 열리는 차단이 늦게 열린다
  (`test_injected_failures_count_in_report_breaker_only` — 두 번째 Worker 뒤에도 안 열림). 담당 4의 장애 주입 결과표(DR)·시연 프리셋을 다시 본다.
- 문서: `docs/tasks/00-공통.md` 7절, `healing.py` 머리 설명, `docs/tasks/04-autohealing.md` T4-4, `docs/plans/TEAM_DEV_PLAN.md` 5-1·DR-LLM-01, `docs/DECISIONS.md` 19장, `docs/결정필요사항.md` U21.
- 프론트 예시 ③ "모델 실패 → 대체 모델로 복구"(`frontend/src/lib/reportExamples.ts`, `reports.test.tsx`)가 "시간 초과 → 같은 모델 재시도 → 대체 모델"을 보여 준다.

## 4. 살릴 것과 버릴 것

| 항목 | 판단 | 옮길 때 |
|---|---|---|
| Q1 timeout 정책 | **절충안으로 결정·반영** (2026-10-08, 사용자). S3에서 유일하게 복구, 나머지는 yubeen 안과 같거나 S4처럼 시간을 다 쓸 뿐 | 반영함 (`Hwanseok`) — 3장 "고칠 것" 전부. `orchestrator.py:409`는 고치지 않음(절충안은 180초를 다 써서 `timeout`) |
| `engine/tests/test_llm_once.py` (4개) | 그대로 옮겨도 된다 — main 엔진에서 4개 모두 통과 (`complete_json_once`가 재시도하지 않고, 실패해도 든 비용을 남기는지) | 파일 하나 추가 |
| `backend/reports/tests/test_healing_decisions.py` | Q2·Q8 두 개는 main에서 통과 — 회귀 테스트로 옮길 수 있다. Q1도 절충안 반영 뒤 대체 모델 이름만 바꾸면 통과 (2026-10-08 오후 확인) | main의 `test_healing.py` 형식(가짜 시계·`FALLBACK_POOL`)으로 고쳐서 |
| `docs/설계서.md` (설계서 ①) | 담당 3의 설계서 몫이라 살린다. 그대로는 안 된다 | 이름 "종이배" → "모매매"(`DECISIONS.md` 18장). "timeout은 YAML의 다음 fallback" → main은 `FALLBACK_POOL`에서 하나(Q1 결정에 따라). 실패 사유 코드에 `agent_failed`·`no_llm`·`expired` 추가(`orchestrator.FAILURE_REASONS`) |
| Orchestrator·Guard·Runner·`healing.py`·`state.py` 별도 구현, `agents/*` | 버린다 — main 구현과 중복 | — |
| `env.team` | 버린다 — 실수로 커밋된 설정 파일. 키 값(키움·DevPass·DART·Django·DB 비밀번호)은 모두 비어 있어 비밀 유출은 없다. `.gitignore`에는 `.env.team`만 있고 `env.team`은 없다 | `.gitignore`에 `env.team` 추가함 (2026-10-08) — 브랜치의 파일은 yubeen이 지운다 |

재현: 시험 파일과 실험용 스위치 패치는 커밋하지 않았다. 다시 돌리려면 main 임시 트리에서 `healing.py`의 `RETRY_SAME_MODEL`(yubeen 안) 또는
"`error_type is TIMEOUT and model == primary`면 같은 모델 재시도를 건너뜀"(절충안) 조건을 바꾸고, `test_healing.py`의 가짜 시계 `Client`로 위 대본을 돌린다.
