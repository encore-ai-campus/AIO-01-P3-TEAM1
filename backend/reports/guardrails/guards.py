"""AI 리포트 Guard (docs/tasks/00-공통.md 8절, 03-orchestrator.md T3-5·T3-7·T3-8).

- 입력 Guard `clean_text`: 뉴스·공시 같은 외부 글을 프롬프트에 넣기 전에 지시문·비밀 값 모양을 지우고 길이를 줄인다.
  Worker가 부르고, 지운 사유가 있으면 결과에 `_guarded: [사유, ...]`로 붙인다 (Orchestrator가 Trace `details.guarded`로 남긴다).
- Join Guard `join`: `join: true` 단계 앞에서 앞 단계의 필수 결과가 있고 계약을 통과했는지 보고, 다음 Worker에 줄 입력을 고른다.
  판정을 Trace(`join_completed`·`join_blocked`)로 남긴다. 막히면 Orchestrator가 리포트를 `join_blocked`로 끝낸다.
- Handoff Guard `handoff`: 검토 Worker가 다른 Worker에게 책임을 넘기기 전에 경로·Hop 수·요청자·비밀 값을 확인한다 (판정만, 기록은 Orchestrator).
- 쉬운 글 Guard `easy_jargon`: 종목 리포트 초안의 쉬운 글(plainSummary·oneLiner·reasons·risks)에 전문 용어(tidy.JARGON)가 있으면
  검토 Worker가 코드 점검 문제로 더해 RETRY(사유에 걸린 용어)로 고쳐 쓰게 한다. 검토 반복 한도를 넘으면 더하지 않는다 —
  그때는 State에 저장할 때 붙인 괄호 풀이(tidy.explain_jargon)를 단 채로 통과한다 (agents/report_team/review.py).
"""
import json
import re
from dataclasses import dataclass, field

from . import contracts, tidy
from ..orchestration import state

TEXT_MAX = 2000  # 외부 글 하나의 길이 상한 (넘으면 자른다)

# 사유 코드 (Trace details.guarded에 그대로 남는다)
INSTRUCTION, SECRET, TOO_LONG = "instruction", "secret", "too_long"

_INSTRUCTIONS = re.compile(
    r"(이전|위의?|앞의?|모든)\s*(지시|명령|규칙|지침)[을를은는이가]?\s*(모두\s*)?(무시|잊어|따르지\s*마)\S*"
    r"|시스템\s*프롬프트|system\s*prompt"
    r"|ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions|prompts?|rules)"
    r"|disregard\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions|prompts?|rules)"
    r"|(api|API)\s*(키|key)[를을]?\s*(출력|알려|보여|print|reveal|show)\S*"
    r"|(비밀\s*번호|비밀번호|password|토큰|token)[를을]?\s*(출력|알려|보여|print|reveal|show)\S*"
    r"|you\s+are\s+now\s+|act\s+as\s+(an?\s+)?(admin|developer|system)",
    re.IGNORECASE,
)
_SECRETS = re.compile(r"sk-[A-Za-z0-9_\-]{20,}|(?<![A-Za-z0-9])[A-Za-z0-9_\-]{40,}(?![A-Za-z0-9])")


def clean_text(text: str | None, limit: int = TEXT_MAX) -> tuple[str, list[str]]:
    """(정리된 글, 지운 사유 코드 목록). 사유는 INSTRUCTION·SECRET·TOO_LONG 중 하나씩, 나온 순서대로 중복 없이.

    지시문은 "[지시문 삭제]", 비밀 값 모양은 "[비밀 값 삭제]"로 바꾼다. None·문자열이 아닌 값은 빈 글로 본다.
    """
    if not isinstance(text, str):
        return "", []
    reasons: list[str] = []
    cleaned, count = _INSTRUCTIONS.subn("[지시문 삭제]", text)
    if count:
        reasons.append(INSTRUCTION)
    cleaned, count = _SECRETS.subn("[비밀 값 삭제]", cleaned)
    if count:
        reasons.append(SECRET)
    if len(cleaned) > limit:
        cleaned = cleaned[:limit]
        reasons.append(TOO_LONG)
    return cleaned, reasons


def merge_reasons(*groups: list[str]) -> list[str]:
    """여러 clean_text 사유 목록을 순서를 지키며 중복 없이 합친다 (Worker의 `_guarded` 값)."""
    return list(dict.fromkeys(reason for group in groups for reason in group))


JOIN_GUARD = "join_guard"  # Join Guard 사건의 actor


@dataclass(frozen=True)
class JoinDecision:
    """Join Guard 판정. inputs = 다음 Worker에 줄 앞 단계 결과 {Worker id: 결과} (막히면 빈 dict)."""
    ok: bool
    inputs: dict[str, dict] = field(default_factory=dict)
    required: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    reason: str | None = None   # 막은 이유 (사람이 읽는 문장). 통과면 None


@dataclass(frozen=True)
class HandoffDecision:
    ok: bool
    reason: str | None = None   # 거절 이유 (사람이 읽는 문장). 허용이면 None


def upstream_workers(plan: dict, step: dict) -> list[str]:
    """step의 앞 단계 전부(depends_on을 거슬러 올라간 모든 단계)의 Worker id. 실행 계획의 단계 순서대로."""
    steps = {item["id"]: item for item in plan["steps"]}
    seen: set[str] = set()
    pending = list(step["dependsOn"])
    while pending:
        sid = pending.pop()
        if sid not in seen:
            seen.add(sid)
            pending.extend(steps[sid]["dependsOn"])
    return [wid for item in plan["steps"] if item["id"] in seen for wid in item["workers"]]


def join(report, step: dict, plan: dict) -> JoinDecision:
    """`join: true` 단계 앞의 Join Guard. 판정을 Trace(actor join_guard)로 남기고 돌려준다.

    - required = 바로 앞 단계(depends_on)들의 필수 Worker. 계획의 failurePolicy가 fail_fast면 선택 Worker도 필수로 본다.
    - inputs = 앞 단계 전부의 결과 중 출력 계약을 다시 통과한 것 (결과가 없거나 계약 위반이면 뺀다).
    - missing = inputs에 없는 required. 비어 있으면 통과. best_effort는 바로 앞 단계 결과가 하나라도 있으면 통과.
    """
    steps = {item["id"]: item for item in plan["steps"]}
    contract_of = {worker["id"]: worker["outputContract"] for worker in plan["workers"]}
    direct = [steps[sid] for sid in step["dependsOn"]]
    key = "workers" if plan["failurePolicy"] == "fail_fast" else "required"
    required = [wid for item in direct for wid in item[key]]
    inputs: dict[str, dict] = {}
    for wid in upstream_workers(plan, step):
        result = (report.results or {}).get(wid)
        if result is None:
            continue
        try:
            inputs[wid] = contracts.validate(contract_of[wid], result)
        except (contracts.ContractError, KeyError):
            continue  # 계약 위반 결과는 다음 Worker에 넘기지 않는다
    missing = [wid for wid in required if wid not in inputs]
    if plan["failurePolicy"] == "best_effort":
        ok = any(wid in inputs for item in direct for wid in item["workers"])
    else:
        ok = not missing
    state.record(report, JOIN_GUARD, "join_completed" if ok else "join_blocked", "completed" if ok else "blocked",
                 details={"step": step["id"], "required": required, "missing": missing, "inputs": list(inputs)})
    if ok:
        return JoinDecision(True, inputs, required, missing)
    reason = f"필수 결과가 없습니다: {', '.join(missing)}" if missing else "앞 단계 결과가 하나도 없습니다."
    return JoinDecision(False, {}, required, missing, reason)


def handoff(report, plan: dict, frm: str, to: str, payload, hop_count: int) -> HandoffDecision:
    """Handoff Guard. hop_count는 이 실행에서 이미 넘긴 횟수 (첫 Handoff면 0).

    허용 조건: 실행 계획(plan.handoffs)에 frm → to 경로가 있고, hop_count < 그 경로의 maxHops,
    전달 데이터의 user_id가 리포트 요청자(팀원 id, 자동 리포트는 "auto")와 같고, 전달 데이터에 비밀 값 모양이 없다.
    """
    route = next((item for item in plan.get("handoffs") or [] if item["from"] == frm and item["to"] == to), None)
    if route is None:
        return HandoffDecision(False, f"실행 계획에 없는 경로입니다: {frm} → {to}")
    if hop_count >= route["maxHops"]:
        return HandoffDecision(False, f"최대 Hop 수({route['maxHops']})를 넘습니다.")
    if not isinstance(payload, dict):
        return HandoffDecision(False, "전달 데이터가 객체가 아닙니다.")
    user_id = payload.get("user_id")
    if user_id is None or not str(user_id).strip():
        return HandoffDecision(False, "전달 데이터에 요청자(user_id)가 없습니다.")
    if str(user_id) != str(report.user_id or "auto"):
        return HandoffDecision(False, "전달 데이터의 요청자(user_id)가 리포트 요청자와 다릅니다.")
    if _SECRETS.search(json.dumps(payload, ensure_ascii=False, default=str)):
        return HandoffDecision(False, "전달 데이터에 비밀 값 모양이 있습니다.")
    return HandoffDecision(True)


EASY_FIELD_NAMES = {"oneLiner": "한 줄 결론", "plainSummary": "쉬운 요약", "reasons": "근거", "risks": "위험"}
EXAMPLES_MAX = 3   # fix에 붙이는 용어 풀이 예시 수 (ReviewResult issue 글 상한 200자 안에)


def easy_jargon(draft: dict | None) -> list[dict]:
    """종목 리포트 초안의 쉬운 글에 있는 전문 용어 → 검토 issues 모양 [{claim, problem, fix}] (필드마다 하나, 없으면 []).

    claim은 용어가 처음 나온 글, problem은 걸린 용어 이름들, fix는 쉬운 말 예시다 (Trace review_retry에 그대로 보인다).
    """
    if not isinstance(draft, dict):
        return []
    issues = []
    for key in tidy.EASY_FIELDS:
        value = draft.get(key)
        texts = value if isinstance(value, list) else [value]
        hits = [(text, tidy.jargon_terms(text)) for text in texts if isinstance(text, str)]
        terms = list(dict.fromkeys(term for _, found in hits for term in found))
        if not terms:
            continue
        label = f"{EASY_FIELD_NAMES[key]}({key})"
        claim = next(text for text, found in hits if found)
        # 예시는 작성 Worker 지시로 간다 — "손익비"는 예시에 넣지 않는다 (작성 프롬프트에 그 말을 넣지 않는 규칙, report.py)
        examples = ", ".join(f"{term} → '{tidy.PLAIN[term]}'" for term in [t for t in terms if t != "손익비"][:EXAMPLES_MAX])
        examples = examples or "쉬운 말로"
        issues.append({"claim": f"{label}: {claim}"[:200],
                       "problem": f"코드 확인: {label}에 쉬운 글에 쓰지 않는 전문 용어가 있습니다: {', '.join(terms)}",
                       "fix": f"{label}의 전문 용어를 쉬운 말로 풀어 쓴다 (예: {examples}). 용어와 지표 숫자는 markdown 본문에만 쓴다."})
    return issues
