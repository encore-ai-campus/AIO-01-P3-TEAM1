"""검토 Worker `review_agent` (docs/tasks/02-worker.md T2-7, 2026-10-04 합의 — plainSummary 대조).

입력: 조사 결과 + 초안(`ctx.inputs["report_agent"]`). LLM이 초안의 주장을 조사 결과와 대조해 PASS·RETRY·FAIL을 낸다.
결정론적 안전장치 두 가지 (LLM이 빠뜨려도 코드가 채운다):
- 코드 점검: buy인데 진입·목표·손절이 비었거나 `0 < stop < entry < target`이 아니거나 진입이 종가에서 5% 밖이면 PASS를 RETRY로.
- 투자유의 지정(`trading.market.warnings`)이 있으면 `handoff = {"to": "risk_agent", "reason": "투자유의: …"}`. 조회 실패는 모름으로 둔다.
"""
from .base import WorkerContext, WorkerError
from .prompts import system_prompt, user_prompt
from .risk import labels_text, warning_labels

RESEARCH = {"market_agent": "시세·차트 조사", "fundamental_agent": "재무·공시 조사", "news_agent": "뉴스·심리 조사"}
ENTRY_BAND = 0.05   # 진입 가격이 직전 종가에서 벗어나도 되는 비율 (작성 프롬프트의 "price에서 5% 안"과 같다)
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
- "코드 점검 결과"에 문제가 있으면 반드시 issues에 넣고 PASS를 내지 않는다."""


class ReviewAgent:
    id = "review_agent"
    output_contract = "ReviewResult"

    def run(self, ctx: WorkerContext) -> dict:
        draft = ctx.inputs.get("report_agent")
        if not draft:
            raise WorkerError("검토할 리포트 초안이 없습니다.")
        problems = check_draft(draft, ctx.inputs.get("market_agent"))
        labels = warning_labels(ctx.symbol)
        sections = {"종목": {"symbol": ctx.symbol, "name": ctx.name, "market": ctx.market}}
        sections |= {f"{title} ({wid})": ctx.inputs.get(wid) for wid, title in RESEARCH.items()}
        sections |= {"리포트 초안 (report_agent)": draft, "투자유의 지정 (코드 조회)": labels_text(labels),
                     "코드 점검 결과": problems or "문제 없음"}
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user_prompt(sections),
                        contract=self.output_contract)
        return finish(reply.data, problems, labels)


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
        close = f"{price:,.2f}".rstrip("0").rstrip(".")
        return [{"claim": claim, "problem": f"진입 가격이 직전 종가 {close}에서 {ENTRY_BAND:.0%} 넘게 떨어져 있습니다.",
                 "fix": f"진입 가격을 직전 종가 {close}에서 {ENTRY_BAND:.0%} 안으로 다시 정하고 목표·손절도 맞춘다."}]
    return []


def finish(answer: dict, problems: list[dict], labels: list[str] | None) -> dict:
    """코드 점검 문제가 있으면 issues 앞에 넣고 PASS를 RETRY로 (지시에 고치는 방법을 붙인다). 지정이 있으면 handoff를 채운다."""
    result = dict(answer)
    if problems:
        result["issues"] = [*problems, *[i for i in result.get("issues") or [] if i not in problems]][:MAX_ISSUES]
        if result["verdict"] == "PASS":
            result["verdict"] = "RETRY"
        fixes = [p["fix"] for p in problems if p["fix"] not in (result.get("instructions") or "")]
        result["instructions"] = "\n".join(filter(None, [(result.get("instructions") or "").strip(), *fixes]))
    if labels and not result.get("handoff"):
        result["handoff"] = {"to": "risk_agent", "reason": f"투자유의: {', '.join(labels)}"}
    return result
