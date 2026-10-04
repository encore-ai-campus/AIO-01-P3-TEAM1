# 04. AutoHealing 백엔드 (담당 4)

목표: LLM 호출의 **실패를 감지·분류하고 재시도 → 대체 모델 전환 → Circuit Breaker로 복구**하며, 장애를 일부러 일으키는 **장애 주입**과 **복구 지표**를 만든다.
`TEAM_DEV_PLAN.md` 5-1~5-3. 약속은 `00-공통.md` 3절(모델 열), 5절(장애 주입), 7절(호출기), 9절(Trace와 셈법). 산출물 책임: **장애 복구 보고서 ②**(장애 유형표·감지 조건·복구 전략·지표), 8장 시험 시나리오와 결과표.

## 받는 것 · 주는 것

| 받는 것 | 누구에게서 |
|---|---|
| `contracts.validate` (bad_output 판정) | 2 |
| `fallbacks` 스키마 (`plan.workers[].fallbacks`) | 3 (10/5 오전) |
| `fake_worker` | 3 |

| 주는 것 | 누구에게 |
|---|---|
| 마이그레이션 0002 (새 열 전부), `payloads.py` 새 필드 | 모두 |
| `healing.LlmCaller`·`make_caller`·`LlmReply`·`LlmGaveUp`, `fake_llm` fixture | 2, 3 |
| `chaos.parse(body) -> dict` (요청 검증·기본값·seed), `ReportsView.post`의 `chaos` 처리 | 5 (요청 형식), 1 (자동 리포트는 `chaos=None`) |
| `stats.report_recovery(events) -> RecoverySummary`, `stats.recovery_stats(days)`, `GET /api/reports/recovery-stats` | 5 (화면), 1 (PDF 꼬리의 복구 요약) |
| 복구 Trace 사건 (`agent_failed(final:false)`, `agent_retry`, `agent_failover`) | 5 |

## 2026-10-04 바뀐 것 — 알림 통로와 PDF 경로가 먼저 생겼다

| 관련 작업 | 지금 있는 것 | 담당 4가 할 일 |
|---|---|---|
| T4-8 담당자 알림 | `notifications.service.notify(users, kind, title, body, link=…)` (웹 알림 + Discord 보낼 편지함 → 엔진 루프가 발송, 실패 시 재시도 → 글만), `config.engine.notifier()` | `healing.notify_failure(report, reason)`는 `notices.notify(report.user 또는 None, "system", "리포트 실패: 종목", 사유, link=f"/reports/{id}")`로. Webhook이 없어도 웹 알림은 남는다 |
| T4-1 `hasPdf`·`pdf_path` | PDF API가 먼저 생겼다: `reports/pdf.py`의 `ensure_report_file`이 `PAPER_ROOT/reports/<id>.pdf`(Chrome이 없으면 `.html`)에 저장 | 마이그레이션 0002에 `pdf_path`를 넣으면 담당 5와 `ensure_report_file`이 그 열을 쓰게 맞춘다. `hasPdf`는 그 파일이 있는지로 |
| T4-6 `ReportsView.post` | 변경 없음 | – |

복구 로직은 리포트 워크플로우에만 해당한다. 추천·자동매매(`backend/autotrade`)는 LLM을 부르지 않으므로 장애 주입과 무관하다.

## 작업

| # | 할 일 | 파일 | 완료 기준 |
|---|---|---|---|
| T4-1 | **모델 열과 마이그레이션** — 00-공통 3절 그대로: `user` null 허용, `source`, `chaos`, `cost_usd`, `pdf_path`, 색인. `payloads.summary`에 `source`·`chaosEnabled`·`costUsd`·`hasPdf`(`pdf_path`가 있고 파일이 있으면), `requestedBy`는 `source == "auto"`면 `"자동"`. `detail`에 `chaos`, `recovery`(T4-6 전까지는 0으로 채운 고정값). `docs/API.md`의 "(추가)" 타입과 같은지 확인 | `models.py`, `migrations/0002_*.py`, `payloads.py`, `tests/test_reports_api.py` | **10/5 오전 첫 PR**. `makemigrations --check` 통과 |
| T4-2 | **재시도 없는 호출** — `LlmClient.complete_json_once(model, system, user, timeout) -> tuple[dict, float]`: `_post` 한 번, `extract_json`, (응답, 이번 호출 비용). `LlmTimeout`·`LlmError`는 그대로 올린다. 엔진 테스트 추가 | `engine/paper_engine/llm.py`, `engine/tests/test_llm.py` | 표준 라이브러리만. 기존 `complete_json` 동작은 그대로 |
| T4-3 | **호출기 뼈대** — 7절의 `ErrorType`·`LlmReply`·`LlmGaveUp`·`LlmCaller`·`make_caller`. 1차는 "한 번 부르고 실패면 `LlmGaveUp`"만. `fake_llm` fixture: `FakeLlm(script: dict[str, list])` — 키는 모델 이름, 값은 호출 순서대로 `"timeout"`·`"server_error"`·`"bad_output"`·응답 dict·`{"__delay__": 초}`; `calls` 기록; `complete_json_once`와 같은 서명 | `healing.py`, `tests/conftest.py`, `tests/test_healing.py` | **10/5 오전** (3번째 뼈대 PR). 2·3이 import해서 쓴다 |
| T4-4 | **실패 분류와 재시도·대체 모델** — 7절의 순서 그대로: 모델 목록 `[model] + fallbacks`, 모델당 `MAX_ATTEMPTS_PER_MODEL = 2`, 전체 `MAX_ATTEMPTS = 4`, `deadline` 안에서. `timeout` → 바로 다음 모델. `server_error` → `RETRY_BACKOFF_SEC` 뒤 같은 모델. `bad_output` → 오류 내용을 user 끝에 붙여("이전 응답의 문제: … JSON 객체만 출력하세요") 같은 모델. 계약 검증(`contracts.validate`)도 여기서 → 실패는 `bad_output`. 성공하면 `LlmReply`를 `calls`에 넣고 돌려준다. Trace: 실패마다 `agent_failed(final:false)`, 같은 모델 재시도 전 `agent_retry`, 다음 모델로 갈 때 `agent_failover` (9절 details 그대로, provider·model·latency_ms 채운다). 모두 실패 → `LlmGaveUp(error_type=마지막, attempts, last_model)` | `healing.py`, 테스트 | 테스트(`fake_llm`, 대기 상수는 monkeypatch로 0): timeout→failover→성공, server_error→retry→성공, bad_output→재요청→성공, 4번 모두 실패→GaveUp, deadline 초과→GaveUp, Trace 사건 순서와 details |
| T4-5 | **Circuit Breaker** — 모델별 연속 실패 수·열린 시각을 모듈 전역 dict에 (엔진 프로세스 하나). `BREAKER_FAILURES = 3`, `BREAKER_OPEN_SEC = 300`. 열린 모델은 건너뛰고 `agent_failover(reason: "circuit_open")`. 성공하면 그 모델 카운터 0. `reset()`(테스트용) | `healing.py`, 테스트 | 테스트: 3번 연속 실패 뒤 4번째 호출은 주 모델을 부르지 않는다, 시간이 지나면 다시 시도한다(`now` 주입) |
| T4-6 | **장애 주입** — `chaos.parse(body) -> dict | None`: `docs/API.md`의 `ChaosConfig` 검증(`enabled` 필수, `probability` 0~1, `errorTypes` ⊂ 셋, `workers`는 `registry.worker_ids()` 안, `scope`, `seed` 정수 또는 서버가 `secrets.randbits(31)`). `chaos.should_fail(chaos, worker_id, model, is_primary, attempt) -> ErrorType | None` (5절의 재현 가능한 판정). 호출기에서 **실제 호출 직전**에 판정해 timeout이면 `LlmTimeout`, server_error면 `LlmError("HTTP 503 (주입)")`, bad_output이면 깨진 응답(`{"trend": "bullish"}`처럼 계약 위반 또는 JSON 아님)을 흉내 낸다 → 그 뒤는 **진짜 복구 경로**. Trace `injected: true`. `ReportsView.post`에서 `chaos.parse(request.data.get("chaos"))`로 저장 (잘못되면 400) | `chaos.py`, `healing.py`, `views.py`, `tests/test_chaos.py` | 같은 seed로 두 번 돌리면 같은 판정. `scope: "primary"`에서 대체 모델은 실패하지 않는다 |
| T4-7 | **복구 요약과 지표** — `stats.report_recovery(events: list[TraceEvent]) -> dict`(API의 `RecoverySummary`, 9절 셈법). `payloads.detail`에서 쓴다. `stats.recovery_stats(days, now) -> dict`(API의 `RecoveryStats`): 기간 안의 리포트 Trace를 읽어 유형별·Worker별·최근 20건. `RecoveryStatsView` + `urls.py` 한 줄. 쿼리는 리포트 수에 비례(사건을 리포트별로 한 번에 읽는다) | `stats.py`, `payloads.py`, `views.py`, `urls.py`, `tests/test_stats.py` | 테스트: 가짜 Trace로 복구 1건·포기 1건·주입 1건 → 수치가 셈법대로. `days` 범위 밖은 400 |
| T4-8 | **엔진 재시작 정리와 알림 연결** — `runner.recover()`(3)가 `running` 리포트를 실패로 정리할 때와 `workflow_failed`일 때 담당자 알림을 보내는 자리: `healing.notify_failure(report, reason)` → `config.engine`의 notifier(1이 Webhook을 넣는다. 없으면 콘솔). 복구 실패 = "수동 개입 조건" | `healing.py` | DR-LLM-04: 필수 Worker 전부 실패 → 실패 종료 + 알림 호출 (가짜 notifier로 확인) |
| T4-9 | **장애 복구 보고서 ② 표** — 5-1 표를 실제 상수·동작으로 채운다 (감지 조건 = 예외·상태 코드, 복구 = 코드의 순서, 최종 실패 조건, 수동 개입 조건, 알림). 지표 계산 기준(9절)을 그대로 적는다 | `docs/장애복구보고서.md` | 10/8 초안 |
| T4-10 | **시험 시나리오 준비** — `TEAM_DEV_PLAN.md` 8장의 DR-LLM-01~04, DR-CRT-01~02, DR-SEC-01에 맞는 **chaos 설정 값**(workers·errorTypes·scope·seed)을 표로 만들고, 로컬에서 `fake_llm` 없이 실제 모델로 한 번씩 돌려 기대 동작을 확인한다 (비용: 시나리오당 $0.5 안) | `docs/장애복구보고서.md` | 시나리오마다 "이 설정으로 신청하면 이렇게 된다"가 적혀 있다 |

## 일정

- **10/5(월) 오전**: T4-1 (첫 PR), T4-3 (뼈대 PR). 오후: T4-2, T4-4 시작.
- **10/6(화)**: T4-4, T4-5, T4-6.
- **10/7(수)**: T4-7, T4-8. 3·2와 붙여 실제 키로 장애 주입 리포트 한 건.
- **10/8(목)**: T4-9, T4-10, 통합 수정.
- **10/9~**: 8장 시험 진행(LLM 시나리오), 결과표.

## 주의

- **주입은 호출 직전 한 곳**에서만. 복구 코드에 "주입이면 이렇게"라는 분기를 두지 않는다 (복구 로직은 진짜 장애와 같은 길을 탄다). 주입 여부는 Trace의 `injected`에만 남긴다.
- 무한 재시도 금지: 시도 수와 `deadline` 둘 다로 막는다. 대기 시간 상수는 모듈 상수로 두어 테스트가 0으로 바꾼다.
- 호출기는 `state.record`만 부른다. `add_result`·`add_error`·`finish`는 Orchestrator 몫.
- `agent_failed`에 `final: false`를 **꼭** 넣는다 (화면·지표가 포기(`final: true`)와 구분한다).
- Circuit Breaker 상태는 웹 프로세스에서 보이지 않는다 (엔진 프로세스 메모리). 지표 화면에는 Trace의 `circuit_open` 사유로만 나타난다.
- 비용 기록: `LlmReply.cost_usd`는 게이트웨이가 준 값. 주입으로 실패한 시도는 비용 0.
- `views.py`의 `ReportsView.post`는 2(한도)도 고친다. 4가 먼저(chaos), 2가 그 뒤에 한도를 넣는다.
