# Worker 출력 계약 코드 리뷰 (2026-10-07)

대상: 브랜치 `feat/2-worker`, 커밋 `acdb038` "리포트 Worker 출력 계약 6종과 공통 인터페이스 추가" (`main` 대비 파일 4개, +494줄).

- `backend/reports/guardrails/contracts.py` (+279) — 출력 계약 6종 검증(`validate`)과 LLM용 설명(`describe`)
- `backend/reports/agents/base.py` (+50) — Worker 공통 인터페이스(`WorkerError`, `LlmCallerProtocol` 등)
- `backend/reports/agents/__init__.py` (+5)
- `backend/reports/tests/guardrails/test_contracts.py` (+160)

기준 문서: `docs/tasks/02-worker.md`(T2-1~T2-7), `docs/tasks/00-공통.md`(6·7·10장), `docs/API.md`(PERSUASION).
검사: `uv run ruff check` 통과, 테스트 28개 통과. 아래 표의 "확인"은 `validate`를 직접 불러 재현한 항목이고, 나머지는 코드와 명세를 대조해 찾은 것이다.

상태: **전부 미수정** (2026-10-07). 고치면 상태 열을 바꾸고 커밋 해시를 적는다.

## 1. 바로 고쳐야 할 것 — 장애로 이어짐

| # | 위치 | 문제 | 영향 | 고치는 방법 | 상태 |
|---|---|---|---|---|---|
| 1 | `contracts.py:62` `_number` | NaN·±Infinity가 통과한다. NaN은 비교가 늘 False라 `minimum`/`maximum`도 빠져나간다 (확인) | `paper_engine/llm.py`의 `extract_json`(`json.loads`)은 `NaN`을 받는다 → PostgreSQL jsonb 저장 시 `DataError`, SQLite에서는 DRF `JSONRenderer`가 `GET /api/reports/<id>`에 500, SSE는 브라우저 `JSON.parse`에서 깨짐 | `math.isfinite` 검사 추가 (`autotrade/sources._price`와 같게) | 미수정 |
| 2 | `contracts.py:151` `_fundamental` | `metrics`가 JSON 객체만 받는다. T2-5는 "DART 키가 없거나 조회 실패면 `metrics`는 null", `describe()`도 "null 가능"이라고 LLM에 알려 준다 | 개발·CI·테스트는 기본으로 `DART_API_KEY`가 없다 → `fundamental_agent`가 매번 실패 → 필수 Join 입력이라 `join_blocked`로 리포트 실패. Worker가 직접 `metrics=None`을 넣어도 Orchestrator 2차 검증에서 같은 오류 | `_metrics`를 nullable로 | 미수정 |
| 3 | `contracts.py:270` `validate` | 모르는 계약 이름도 `ContractError`를 낸다. LLM 호출부는 이것을 `bad_output`으로 취급한다 | YAML `output_contract` 오타 하나로 healing이 모델을 바꿔 가며 `MAX_ATTEMPTS=4`번 재시도(비용 발생). 실패가 `BREAKER_FAILURES=3`에 쌓여 정상 모델이 다른 Worker에도 300초 차단됨 | 모르는 이름은 `KeyError`/`LookupError`로. `registry._worker`에서 `output_contract`를 `NAMES`와 대조 | 미수정 |

## 2. 불필요한 재시도·비용을 늘리는 것

| # | 위치 | 문제 | 영향 | 고치는 방법 | 상태 |
|---|---|---|---|---|---|
| 4 | `contracts.py:249` `_DESCRIPTIONS` | LLM 설명에 실제 검사 규칙이 빠졌다: `recentFilings[].impact`는 positive/negative/neutral, `targets.holdingDays`는 1~20 정수, `probability`는 0~1, `volumeRank`는 정수, rsi·support·targets 하위 필드는 "키는 필수, 값은 null 가능" | 한국어 프롬프트에서 LLM이 `impact: '호재'`(확인: ContractError), `probability: 55`, `holdingDays: 30`을 낸다 → `bad_output` 재시도, 비용, 복구 통계 오염, `LlmGaveUp` 가능 | 설명에 규칙을 넣는다. 근본 해결은 12번 | 미수정 |
| 5 | `contracts.py:220` `_review` | RETRY일 때 `instructions` 검사가 `not instructions`라 공백만 있어도 통과 (확인) | 빈 지시로 `report_agent`를 다시 돌려 초안이 안 바뀜 → maxRounds까지 RETRY → `review_failed`. T2-7 위반 | `not (instructions or '').strip()` | 미수정 |
| 6 | `contracts.py:185` 외 | `plainSummary`는 개수만 검사해 `[""]`가 통과 (확인). 필수 문자열 `markdown`·`summary`·`title`도 빈 값 허용 | 주린이 "쉬운 요약 3줄" 칸이 빈다(명세상 빈 요약은 ContractError). `markdown: ""`이면 본문 없는 리포트가 `completed`로 끝남 | 필수 문자열은 strip 후 빈 값 거부 | 미수정 |
| 7 | `contracts.py:122` 외 | 숫자 필드가 null을 거부한다: `MarketResult.price`·`changePct`, `NewsResult.score`, `ReportDraft.confidence`, `ReviewResult.score`. 헤드라인 `date`·`source`도. `00-공통` 10장은 "숫자는 null을 허용한다" | 뉴스가 없을 때(미국 종목, Google News 실패) LLM이 `score: null`·`date: null`을 내면 실패 (확인). `price`·`changePct`는 Worker가 자기 데이터로 덮어쓰는데도 LLM이 반드시 만들어야 함. 프론트 `frontend/src/lib/reports.ts`는 이미 date·source를 nullable로 다룸 | 명세대로 nullable | 미수정 |
| 8 | `contracts.py:219` | `instructions`를 `SUMMARY_MAX`(600자), `markdown`을 20,000자에서 표시 없이 자른다. 명세의 길이 제한은 `summary`(600)와 목록 항목(200)뿐 | 리뷰가 지적 8개·900자를 쓰면 앞 600자만 전달 → 마지막 수정 사항이 빠져 RETRY 반복 → `review_failed` | 명세에 없는 자르기 제거, 또는 초과 시 ContractError | 미수정 |
| 9 | `contracts.py:93` | 오류 메시지에 `value!r` 전체를 넣는다. `00-공통` 7장에 따라 이 메시지는 재시도 프롬프트 끝에 붙는다 | LLM이 enum 필드(`trend`, `verdict`)에 10KB 문자열을 넣으면 그대로 재시도 프롬프트에 붙어 입력 토큰이 크게 늘어남 | `repr(value)[:80]`처럼 줄인다 | 미수정 |

## 3. 안전 규칙 보강

| # | 위치 | 문제 | 영향 | 고치는 방법 | 상태 |
|---|---|---|---|---|---|
| 10 | `contracts.py:186` | `plainSummary`·`oneLiner`는 숫자만 검사하고 권유 문구는 검사하지 않는다. `docs/API.md`는 PERSUASION 목록이 사용자에게 보이는 모든 문장에 적용된다고 한다 | `"AI 의견으로는 지금 사 볼 만해요"`가 통과해 주린이 쉬운 보기와 PDF에 나감 | `paper_engine.wording.forbidden_phrases`로 검사해 `bad_output` 처리 | 미수정 |
| 11 | `contracts.py:187` | 숫자 금지 검사가 ASCII `[0-9]`라 전각·유니코드 숫자가 통과 (확인: `"목표가 ７만원이에요"`) | 숫자 없는 쉬운 요약에 가격이 들어감 | `\d` 또는 글자마다 `str.isdigit` | 미수정 |

## 4. 구조·테스트

| # | 위치 | 문제 | 고치는 방법 | 상태 |
|---|---|---|---|---|
| 12 | `contracts.py:249` | 계약이 `NAMES`, `_VALIDATORS`, 손으로 쓴 `_DESCRIPTIONS` 세 곳에 나뉘어 있다. T2-3은 필드 설명을 계약 정의에서 만들어 내라고 했다. 4번이 이 때문에 생겼다 | 필드 표(타입·nullable·enum·범위·길이) 하나로 `validate`와 `describe`를 함께 만든다. `NAMES = tuple(_VALIDATORS)`. `_number`/`_integer`의 중복 범위 검사, `_headline`/`_issue`/`_metrics`의 반복 dict comprehension도 정리됨 | 미수정 |
| 13 | `contracts.py:191` | enum·한도를 다시 적었다. 이미 있는 것: `payloads.OPINIONS`, `payloads.ONE_LINER_MAX=80`, `autotrade/recommend/sources.py`의 `RISK_LEVELS`, `MIN/MAX_HOLDING_DAYS=1,20`, `MAX_ITEMS=3` | `contracts.py`에 한 번 정의하고 그쪽에서 import. 안 그러면 계약을 바꿀 때 읽는 쪽이 옛 값으로 조용히 자르거나 버림 | 미수정 |
| 14 | `agents/base.py:21` | `LlmCallerProtocol.__call__`이 `Any`를 돌려준다. `00-공통` 6·7장은 `LlmReply`. Orchestrator가 쓰는 `.calls`·`.cost_usd`도 선언 안 됨 | 6장 인터페이스대로 반환형 `LlmReply`, 속성 선언 (T2-2: "6장 인터페이스를 그대로") | 미수정 |
| 15 | `tests/guardrails/test_contracts.py:70` | `assert "ignored" not in result`가 MarketResult에서만 의미가 있다. 다른 5개 fixture엔 `ignored` 키가 없고, 안쪽 객체(targets, metrics, records, handoff)의 모르는 키 제거는 테스트하지 않는다 | 모든 계약·안쪽 객체에 모르는 키를 넣어 검사. 1·5·6·11번 경우도 테스트 추가 | 미수정 |

## 5. 고치는 순서 제안

1. **1·2·3·5·6·11번** — 간단하고 영향이 큼. 테스트와 함께 한 커밋.
2. **7·8·9·10번** — 명세 대조가 필요. 7번은 `00-공통` 10장 기준으로 필드별로 정한다.
3. **12·4·13번** — 계약 정의를 한 곳으로 모으는 구조 변경. 따로 커밋하고, `describe()` 출력이 바뀌므로 프롬프트 영향을 같이 확인한다.
4. **14·15번** — 1~3과 함께 해도 된다.
