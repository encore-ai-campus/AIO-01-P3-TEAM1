"""리포트 워크플로우의 입력·단계 연결을 검사하는 Guard.

현재는 외부 뉴스·공시 문자열을 LLM 프롬프트에 넣기 전에 정리하는
``clean_text``를 제공한다. Join/Handoff Guard는 Orchestrator 단계에서 추가한다.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from . import contracts

MAX_EXTERNAL_TEXT_LENGTH = 2_000

# 외부 자료가 모델의 역할이나 지시를 바꾸려는 문구만 제거한다. 일반적인 기사
# 문장까지 넓게 지우지 않도록, 비밀 이름 자체보다 지시·출력 요구가 있는 표현을
# 우선 구체적으로 잡는다.
_INSTRUCTION_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"(?:이전|앞선|위의)\s*(?:모든\s*)?(?:지시|지침|명령)(?:사항)?(?:을|를)?\s*무시(?:하(?:고|라|세요)?)?", re.IGNORECASE),
        "이전 지시 무시 문구 제거",
    ),
    (
        re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|commands?)", re.IGNORECASE),
        "이전 지시 무시 문구 제거",
    ),
    (
        re.compile(r"(?:system\s*prompt|시스템\s*프롬프트)", re.IGNORECASE),
        "시스템 프롬프트 요구 제거",
    ),
    (
        re.compile(r"(?:API\s*키|api\s*keys?)\s*(?:를|을|:|=)?\s*(?:출력|공개|보여\s*줘|말해\s*줘|print|show|reveal|expose)?", re.IGNORECASE),
        "API 키 요구 제거",
    ),
    (
        re.compile(r"(?:비밀번호|암호|passwords?)\s*(?:를|을)?\s*(?:출력|공개|보여\s*줘|말해\s*줘|print|show|reveal|expose)", re.IGNORECASE),
        "비밀번호 요구 제거",
    ),
)

_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}(?![A-Za-z0-9])"), "비밀 키 형식 제거"),
    (
        re.compile(r"(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{40,}(?![A-Za-z0-9_\-])"),
        "긴 토큰 형식 제거",
    ),
)


@dataclass(frozen=True)
class JoinDecision:
    ok: bool
    inputs: dict[str, dict]
    missing: list[str]
    reason: str | None


def join(report, step: dict, plan: dict) -> JoinDecision:
    """앞 단계의 성공 결과만 골라 Worker 입력으로 전달한다.

    의존 단계의 모든 조상을 보므로 review 단계는 YAML의 ``join`` 표기와 무관하게
    최신 초안과 성공한 조사 결과 전체를 받는다(Q4).
    """
    steps = {item["id"]: item for item in plan["steps"]}
    worker_specs = {item["id"]: item for item in plan["workers"]}
    dependency_steps = _dependency_closure(step, steps)
    candidate_ids = [
        worker_id
        for dependency in dependency_steps
        for worker_id in dependency["workers"]
    ]
    candidate_ids = list(dict.fromkeys(candidate_ids))
    required_ids = {
        worker_id
        for dependency in dependency_steps
        for worker_id in dependency.get("required", [])
    }

    inputs: dict[str, dict] = {}
    for worker_id in candidate_ids:
        result = report.results.get(worker_id)
        if result is None or worker_id in report.failed_agents:
            continue
        try:
            contract = worker_specs[worker_id]["outputContract"]
            inputs[worker_id] = contracts.validate(contract, result)
        except (KeyError, contracts.ContractError):
            continue

    missing = [worker_id for worker_id in candidate_ids if worker_id in required_ids and worker_id not in inputs]
    reason = "join_blocked" if missing else None
    return JoinDecision(ok=not missing, inputs=inputs, missing=missing, reason=reason)


def _dependency_closure(step: dict, steps: dict[str, dict]) -> list[dict]:
    ordered: list[dict] = []
    seen: set[str] = set()

    def visit(step_id: str) -> None:
        if step_id in seen:
            return
        dependency = steps[step_id]
        for parent in dependency.get("dependsOn", []):
            visit(parent)
        seen.add(step_id)
        ordered.append(dependency)

    for dependency_id in step.get("dependsOn", []):
        visit(dependency_id)
    return ordered


def clean_text(text: str) -> tuple[str, list[str]]:
    """외부 문자열에서 지시문·비밀 값 모양을 지우고 길이를 제한한다.

    반환하는 사유는 발견 순서대로 한 번씩만 들어간다. 호출자는 이 목록을
    ``_guarded`` 결과와 Trace에 남겨 어떤 입력이 바뀌었는지 설명할 수 있다.
    """
    if not isinstance(text, str):
        raise TypeError("clean_text의 text는 문자열이어야 합니다.")

    cleaned = unicodedata.normalize("NFKC", text)
    reasons: list[str] = []

    for pattern, reason in (*_INSTRUCTION_PATTERNS, *_SECRET_PATTERNS):
        cleaned, count = pattern.subn(" ", cleaned)
        if count:
            reasons.append(reason)

    # 제거한 문구 양옆의 공백만 정리하되 기사 제목의 줄 구조는 보존한다.
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r" *\n *", "\n", cleaned).strip()

    if len(cleaned) > MAX_EXTERNAL_TEXT_LENGTH:
        cleaned = cleaned[:MAX_EXTERNAL_TEXT_LENGTH].rstrip()
        reasons.append(f"본문 {MAX_EXTERNAL_TEXT_LENGTH:,}자로 자름")

    return cleaned, list(dict.fromkeys(reasons))
