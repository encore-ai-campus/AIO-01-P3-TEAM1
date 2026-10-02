# 04 Distributed Collaboration

이 단원은 선택된 여러 Agent를 Sequential 또는 Parallel로 실행하고, 결과를 Join하거나
다른 Agent에게 책임을 Handoff하며 전체 Shared State와 Trace를 관리하는 방법을
학습합니다.

```text
Execution Plan
→ Sequential 또는 Parallel 실행
→ 결과 계약 검증
→ Join 또는 Handoff
→ Shared State 갱신
→ 명시적인 전체 종료
```

여기서 Distributed는 여러 Agent가 논리적으로 분리되어 협업한다는 의미입니다. 실제
Backend·Queue·Worker Process 분산은 10의 통합 서비스에서 구현합니다.

## 이전 단원과의 연결

- 01에서 Sequential, Parallel+Join, Handoff를 작은 예제로 미리 확인했습니다.
- 02에서 Role, Task, 역할별 출력 계약을 만들었습니다.
- 03에서 Router와 Supervisor가 실행할 Worker를 선택했습니다.
- 04에서는 선택된 Worker들이 결과를 주고받고 통합하는 실제 실행을 다룹니다.
- 결과 평가와 Retry·Failover는 05에서 확장합니다.

## 실행

모든 명령은 과정 루트에서 실행합니다.

```powershell
cd C:\aidevs\07_multi-agent-service-ops
.\.venv\Scripts\Activate.ps1
$env:PYTHONPATH = (Get-Location).Path

python .\04_orchestration\01_execution_plan.py
python .\04_orchestration\02_sequential_workflow.py
python .\04_orchestration\03_parallel_workers.py
python .\04_orchestration\04_join_results.py
python .\04_orchestration\05_partial_failure.py
python .\04_orchestration\06_handoff_workflow.py
python .\04_orchestration\07_distributed_workflow.py
```

`01`, `05`는 API Key 없이 실행할 수 있습니다. 나머지는 실제 LLM을 호출합니다. 선택
부록 `10_optional_langgraph`는 일반 Python 흐름을 이해한 뒤 실행합니다.

## Lab 진행 순서

| Lab | 학습 질문 | 주요 LLM | 예상 호출 |
| --- | --- | --- | ---: |
| `01` | 어떤 Agent가 독립적이고 어떤 결과를 기다려야 하는가? | 없음 | 0회 |
| `02` | 앞 결과가 필수 입력이면 어떻게 실행하는가? | Gemini→GPT→Gemma | 최대 3회 |
| `03` | 독립 Worker의 결과를 누가 안전하게 수집하는가? | Gemini·Llama·GPT | 3회 |
| `04` | 병렬 실행 완료와 안전한 Join은 무엇이 다른가? | Gemma | 1회 |
| `05` | 일부 Agent 실패가 항상 전체 실패인가? | 없음 | 0회 |
| `06` | 함수 호출과 책임 Handoff는 무엇이 다른가? | Gemini→Gemma | 최대 2회 |
| `07` | 병렬·Join·State·Trace와 운영형 Registry를 어떻게 통합하는가? | 네 LLM | 최대 4회 |

모든 Lab을 정상 실행하면 약 13회 LLM 호출이 발생합니다. 각 Lab은 독립 실행할 수
있으므로 수업에서는 필요한 흐름만 선택해 호출할 수 있습니다.

## Execution Plan

Agent를 실행하기 전에 의존성을 먼저 표현합니다.

```text
Research Step
├─ Weather Agent
├─ Place Agent
└─ Budget Agent

Compose Step
└─ Itinerary Agent
   depends_on: Research
   join: true
```

계획 검증은 존재하지 않는 앞 단계, 중복 Step ID와 잘못된 의존성을 LLM 호출 전에
차단합니다.

## Sequential Workflow

앞 결과가 다음 Agent의 필수 입력이면 순차 실행합니다.

```text
Gemini Research Agent
→ GPT Writer Agent
→ Gemma Reviewer Agent
```

앞 Agent가 실패하면 뒤 Agent는 실행하지 않습니다. 실패한 결과를 빈 Context나 고정된
성공 결과로 바꾸지 않습니다.

## Parallel Workers

서로의 결과가 없어도 시작할 수 있는 Agent는 병렬 실행할 수 있습니다.

```text
Gemini Weather Agent ─┐
Llama Place Agent    ─┼→ Orchestrator 결과 수집
GPT Budget Agent     ─┘
```

Worker가 Shared State를 직접 수정하지 않고 독립 결과만 반환합니다. Main Thread의
Orchestrator가 완료된 Future를 수집해 State를 갱신합니다. 완료 순서는 실행 요청
순서와 다를 수 있습니다.

## Join Guard

병렬 작업이 끝났다는 사실만으로 Join하지 않습니다.

```text
필수 결과 존재 확인
→ 역할별 계약 확인
→ 실패 결과 제외
→ 최소 Context 선택
→ Itinerary Agent 실행
```

04는 미리 검증된 Pydantic 결과로 Join 경계를 확인하고 실제 Gemma Itinerary Agent만
1회 호출합니다.

## Partial Failure

실패 정책은 실행 중 LLM이 즉석에서 정하지 않고 업무 요구사항으로 미리 정의합니다.

| 정책 | 동작 |
| --- | --- |
| Fail Fast | 하나라도 실패하면 전체 중단 |
| Best Effort | 성공 결과만으로 제한된 결과 생성 |
| Required/Optional | 필수 Agent 실패일 때만 중단 |

05 예제에서는 Weather와 Budget이 필수이고 Place는 선택 결과입니다. 같은 실패라도
정책에 따라 계속 실행 여부가 달라집니다.

## Handoff

함수 호출과 Handoff는 책임의 소유자가 다릅니다.

```text
함수 호출
Agent A → 계산 요청 → 결과 수신 → Agent A가 계속 책임

Handoff
Support Agent → 책임과 최소 Context 이전 → Refund Agent가 책임 인수
```

Handoff 계약에는 `task_id`, `trace_id`, `from_agent`, `to_agent`, `responsibility`,
`context`, `user_id`, `hop_count`가 포함됩니다. Python Guard는 사용자, 허용 경로,
민감정보와 최대 Hop을 확인합니다.

## Shared State

07의 Orchestrator만 다음 State를 갱신합니다.

```python
state = {
    "task_id": "travel-001",
    "status": "running",
    "current_step": "parallel_research",
    "results": {},
    "errors": {},
    "completed_agents": [],
    "failed_agents": [],
    "trace": [],
}
```

Worker 결과가 계약을 통과한 경우에만 `results`와 `completed_agents`에 추가됩니다.

## 구조화된 Trace

| 필드 | 의미 |
| --- | --- |
| `step` | 전체 실행에서의 사건 순서 |
| `actor` | Agent 또는 Guard |
| `action` | 시작·완료·실패·Join·종료 |
| `status` | `started`, `completed`, `failed`, `blocked`, `skipped` |
| `provider`, `model` | 실제 LLM 실행 정보 |
| `latency_ms` | 응답 또는 실패까지 걸린 시간 |
| `details` | 오류와 추가 정보 |

주요 Action은 `agent_started`, `agent_completed`, `agent_failed`, `join_completed`,
`join_blocked`, `workflow_completed`입니다.

## 네 LLM 전체 Workflow

07에서는 앞선 Lab에서 Python으로 직접 보았던 반복 Worker 설정을 YAML Registry로
분리합니다. Coordinator, 병렬 실행, 필수 결과 판단, Join과 종료 정책은 Python에
그대로 남깁니다.

```text
worker_definitions.yaml ─┐
team_definitions.yaml   ─┴→ worker_registry.py → Python Orchestrator
```

| Python에 유지 | YAML로 관리 |
| --- | --- |
| 병렬 실행과 완료 수집 | Worker 이름·목표·Provider |
| 필수 결과와 부분 실패 판단 | Worker 출력 계약 이름 |
| Join·Timeout·전체 종료 | 병렬·필수·선택 Worker 구성과 Timeout 값 |

```text
Gemini Weather ─┐
Llama Place    ─┼→ Join Guard → Gemma Itinerary → 완료
GPT Budget     ─┘
```

| Agent | Provider | Model |
| --- | --- | --- |
| Weather Agent | Gemini | `gemini-3.5-flash` |
| Place Agent | Ollama | `llama3.2` |
| Budget Agent | OpenAI | `gpt-4.1-mini` |
| Itinerary Agent | Gemma | `gemma3:4b` |

Weather와 Budget은 필수이고 Place는 선택 결과입니다. Llama가 포함된 병렬 그룹이
모두 끝난 후 Gemma를 실행하므로 공용 Ollama에서 두 로컬 Model을 동시에 실행하지
않습니다.

## SSE로 실행 Event 전달하기

CLI Lab에서는 Trace를 최종 State에 모아 출력합니다. 미니 프로젝트에서는 같은 Trace를
Redis Stream에 기록하고 SSE로 화면에 전달합니다.

```text
Agent Event → Redis Stream → FastAPI SSE → Streamlit
                    └──────→ Snapshot API
```

- SSE는 Agent 시작·완료·실패 Event를 발생 즉시 단방향 전달합니다.
- Redis Hash의 Snapshot은 새로고침과 연결 복구에 사용합니다.
- SSE가 실행 상태의 유일한 저장소가 되어서는 안 됩니다.
- 02에서 배운 Polling은 Snapshot 복구 방식으로 계속 활용할 수 있습니다.

## LangGraph 선택 부록

분기와 반복이 적으면 일반 Python이 더 읽기 쉽습니다. State 전이, 재개, 조건 분기와
Graph 시각화가 많아질 때 LangGraph를 검토합니다. LangGraph 자체가 Agent인 것은
아니며 Graph Node 안에 Agent나 결정적인 Workflow 함수를 배치합니다.

## 핵심

- 의존성을 먼저 그린 뒤 Sequential과 Parallel을 선택합니다.
- Worker는 Shared State를 직접 수정하지 않고 독립 결과를 반환합니다.
- 병렬 실행 완료와 계약 검증을 통과한 Join은 서로 다릅니다.
- 부분 실패 정책은 업무 요구사항으로 미리 정의합니다.
- Handoff에서는 결과가 아니라 업무 책임의 소유자가 바뀝니다.
- Orchestrator가 State, 실패, Join과 전체 종료를 통제합니다.
- 모든 실행 사건을 구조화된 Trace로 남깁니다.
- 반복 Worker와 Team 선언은 YAML로 관리해도 실행 정책은 Python이 통제합니다.
- 실시간 Event 전달과 현재 상태 저장을 SSE와 Snapshot으로 분리합니다.

## 완료 기준

- 실행 계획에서 의존성과 병렬 구간을 설명할 수 있습니다.
- Sequential 중간 실패 시 뒤 Agent가 실행되지 않는 이유를 설명할 수 있습니다.
- 병렬 Worker와 Shared State 갱신 책임을 분리할 수 있습니다.
- 필수 결과를 확인한 후에만 Join Agent를 실행할 수 있습니다.
- Fail Fast, Best Effort, Required/Optional 정책을 비교할 수 있습니다.
- 함수 호출과 Handoff의 책임 차이를 설명할 수 있습니다.
- 네 LLM Workflow의 State와 Trace에서 전체 종료 이유를 확인할 수 있습니다.
- Python 실행 정책과 YAML Registry의 책임을 구분할 수 있습니다.
- SSE Event와 Snapshot 상태가 각각 필요한 이유를 설명할 수 있습니다.

## 직접 확인하기

- `01_execution_plan.py`에서 Budget가 Weather 결과에 의존하도록 바꾸고 병렬 가능 여부를 판단하세요.
- `03_parallel_workers.py`에서 완료 순서가 매번 같은지 확인하세요.
- `04_join_results.py`에서 Place 결과를 제거하고 Join Guard 오류를 확인하세요.
- `05_partial_failure.py`에서 Budget 실패 사례로 세 정책을 비교하세요.
- `06_handoff_workflow.py`의 Context에 `payment_token`을 추가해 Guard를 확인하세요.
- `07_distributed_workflow.py`에서 실패 Agent 이후 Itinerary가 실행되지 않는지 Trace로 확인하세요.
- `team_definitions.yaml`에서 Place를 필수 Worker로 바꾸고 실패 정책의 차이를 확인하세요.
