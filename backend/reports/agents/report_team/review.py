"""검토 Worker `review_agent` (docs/tasks/02-worker.md T2-7, 2026-10-04 합의 — plainSummary 대조).

입력: 조사 결과 + 초안(`ctx.inputs["report_agent"]`). LLM이 초안의 주장을 조사 결과와 대조해 PASS·RETRY·FAIL을 낸다.
결정론적 안전장치 두 가지 (LLM이 빠뜨려도 코드가 채운다):
- 코드 점검: buy인데 진입·목표·손절이 비었거나 `0 < stop < entry < target`이 아니거나 진입이 시세 조사의 기준 가격(price — 장 중이면 현재가, 아니면 직전 종가)에서 5% 밖이면 PASS를 RETRY로.
- 투자유의 지정(`trading.market.warnings`)이 있으면 `handoff = {"to": "risk_agent", "reason": "투자유의: …"}`. 조회 실패는 모름으로 둔다.
- 쉬운 글 Guard(`guards.easy_jargon`): 첫 검토에서만, 초안의 쉬운 글(plainSummary·oneLiner·reasons·risks)에 전문 용어가 있으면 RETRY.
  검토 LLM의 '코드 점검 결과'에는 넣지 않고 finish에서만 더한다 (LLM 규칙과 부딪혀 FAIL이 나지 않게). 두 번째부터는 저장 때 괄호 풀이로 통과.
  검토 반복 한도(YAML review 단계의 retry.max_rounds)를 다 쓴 마지막 검토에서는 더하지 않는다 — 리포트를 실패시키지 않고,
  State에 저장할 때 붙인 괄호 풀이(tidy.explain_jargon)를 단 채로 통과한다.
"""
from ...guardrails import contracts, guards
from ...orchestration import registry
from ..base import WorkerContext, WorkerError
from ..prompts import system_prompt, user_prompt
from .risk import labels_text, warning_labels

RESEARCH = {"market_agent": "시세·차트 조사", "fundamental_agent": "재무·공시 조사", "news_agent": "뉴스·심리 조사"}
ENTRY_BAND = 0.05   # 진입 가격이 시세 조사의 기준 가격(price)에서 벗어나도 되는 비율 (작성 프롬프트의 "price에서 5% 안"과 같다)
MAX_ISSUES = 10     # ReviewResult.issues 상한

ROLE = ("너는 모의투자 서비스 '모매매'의 AI 리포트 팀에서 검토를 맡은 AI다. "
        "리포트 초안이 조사 결과와 맞는지 대조한다. 초안을 직접 고쳐 쓰지 않고 문제와 수정 지시만 낸다.")
RULES = """- 대조 항목: oneLiner·plainSummary·reasons·risks·markdown의 주장마다 조사 결과(evidence 포함)에 근거가 있는지,
  plainSummary가 verdict와 반대 방향이 아닌지, targets가 시세 조사의 price·support·resistance에 근거하는지
  (buy이면 0 < stop < entry < target), 권유형·명령형 문장이 없는지, "목표 가격 …의 근거"와 "이 의견이 틀리는 경우" 줄이 있는지.
- verdict: 문제가 없으면 PASS. 고칠 수 있는 문제가 있으면 RETRY이고, instructions에 무엇을 어떻게 고칠지 구체적으로 쓴다 (비우지 않는다).
  초안 전체가 조사 결과와 정면으로 어긋나 고쳐 쓸 수 없으면 FAIL.
- issues는 문제마다 claim(초안의 문장), problem(무엇이 틀렸나), fix(고치는 방법)이다. 문제가 없으면 빈 목록이다.
- score는 초안이 근거와 맞는 정도(0~100)다.
- handoff: 투자유의 지정이 있거나 고위험 신호(아주 큰 변동성, 거래정지·감사의견 같은 공시 등)가 있으면 {"to": "risk_agent", "reason": "…"}, 없으면 null.
- "코드 점검 결과"에 문제가 있으면 반드시 issues에 넣고 PASS를 내지 않는다.
- 쉬운 글(plainSummary·oneLiner·reasons·risks)의 전문 용어는 코드가 따로 점검한다. 그것만으로 RETRY·FAIL을 내지 않는다."""


class ReviewAgent:
    id = "review_agent"
    output_contract = "ReviewResult"

    def run(self, ctx: WorkerContext) -> dict:
        draft = ctx.inputs.get("report_agent")
        if not draft:
            raise WorkerError("검토할 리포트 초안이 없습니다.")
        problems = check_draft(draft, ctx.inputs.get("market_agent"))
        # 쉬운 글 용어는 첫 검토에서만 한 번 고쳐 쓰게 한다 (비용 상한 — 작성·검토 1번씩 더). 검토 LLM에는 주지 않는다
        jargon = guards.easy_jargon(draft) if ctx.attempt == 1 and retry_rounds() >= 1 else []
        labels = warning_labels(ctx.symbol)
        sections = {"종목": {"symbol": ctx.symbol, "name": ctx.name, "market": ctx.market}}
        sections |= {f"{title} ({wid})": ctx.inputs.get(wid) for wid, title in RESEARCH.items()}
        sections |= {"리포트 초안 (report_agent)": draft, "투자유의 지정 (코드 조회)": labels_text(labels),
                     "코드 점검 결과": problems or "문제 없음"}
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user_prompt(sections),
                        contract=self.output_contract)
        return finish(reply.data, problems + jargon, labels)


def retry_rounds() -> int:
    """종목 리포트 실행 계획에서 이 검토가 초안을 고쳐 쓰게 할 수 있는 횟수 (review 단계의 retry.maxRounds, 없으면 0).

    Orchestrator는 검토 시도 n번째의 RETRY를 n <= maxRounds일 때만 고쳐 쓰기로 이어 간다 (넘으면 review_failed).
    """
    plan = registry.execution_plan(registry.TEAM)
    step = next((item for item in plan["steps"] if ReviewAgent.id in item["workers"]), None)
    return ((step or {}).get("retry") or {}).get("maxRounds", 0)


def check_draft(draft: dict, market_result: dict | None) -> list[dict]:
    """초안의 가격 제안을 코드로 점검한다 (추천으로 이어지는 buy만). 문제마다 {claim, problem, fix}."""
    if draft.get("verdict") != "buy":
        return []
    targets = draft.get("targets") or {}
    entry, target, stop = (targets.get(key) for key in ("entry", "target", "stop"))
    claim = f"targets: entry {entry}, target {target}, stop {stop}"
    if None in (entry, target, stop) or not 0 < stop < entry < target:
        return [{"claim": claim, "problem": "AI 의견이 buy인데 진입·목표·손절 가격이 비었거나 0 < 손절 < 진입 < 목표 순서가 아닙니다.",
                 "fix": "시세 조사의 price·support·resistance에 근거해 0 < stop < entry < target이 되게 세 가격을 모두 채운다."}]
    price = (market_result or {}).get("price")
    if price and abs(entry / price - 1) > ENTRY_BAND:
        shown = f"{price:,.2f}".rstrip("0").rstrip(".")
        name = "장중 가격" if (market_result or {}).get("priceBasis") == "live" else "직전 종가"
        return [{"claim": claim, "problem": f"진입 가격이 {name} {shown}에서 {ENTRY_BAND:.0%} 넘게 떨어져 있습니다.",
                 "fix": f"진입 가격을 {name} {shown}에서 {ENTRY_BAND:.0%} 안으로 다시 정하고 목표·손절도 맞춘다."}]
    return []


def finish(answer: dict, problems: list[dict], labels: list[str] | None) -> dict:
    """코드 점검 문제가 있으면 issues 앞에 넣고 PASS를 RETRY로 (지시에 고치는 방법을 붙인다). 지정이 있으면 handoff를 채운다.

    코드만 붙이는 키(acceptedWithNotes — 선정 검토 전용, docs/DECISIONS.md 30장)는 LLM이 보내도 지운다.
    """
    result = {key: value for key, value in answer.items() if key != contracts.REVIEW_ACCEPTED}
    if problems:
        result["issues"] = [*problems, *[i for i in result.get("issues") or [] if i not in problems]][:MAX_ISSUES]
        if result["verdict"] == "PASS":
            result["verdict"] = "RETRY"
        fixes = [p["fix"] for p in problems if p["fix"] not in (result.get("instructions") or "")]
        result["instructions"] = "\n".join(filter(None, [(result.get("instructions") or "").strip(), *fixes]))
    if labels and not result.get("handoff"):
        result["handoff"] = {"to": "risk_agent", "reason": f"투자유의: {', '.join(labels)}"}
    return result
