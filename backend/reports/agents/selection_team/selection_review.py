"""선정 검토 Worker `selection_review_agent` → ReviewResult (docs/design/AI_AGENT_WORKFLOW.md 2장).

선정안(selector_agent) + 조사 결과 + 후보 표를 주고 근거를 대조하게 한다 (PASS · RETRY · FAIL). 조사 결과는 가격을 "(가격)"으로 가린 사본이다.
LLM 뒤에 코드가 한 번 더 본다: 후보 표 밖 종목, 공시 위험 high 종목, reason·summary의 권유 표현·가격·목표가·"(가격)"이 선정안에 있으면
LLM이 PASS라 해도 RETRY로 바꾸고 구체적인 수정 지시를 붙인다 (RETRY였으면 지시를 앞에 더하고, FAIL은 그대로).
evidence는 보지 않는다 — 가격이 든 evidence 항목은 selector.finish가 지운다.
다시 하는 검토(ctx.retry)에는 직전 검토의 지적과 코드가 이전 선정안과 비교한 "바뀐 부분"을 주고, 지적이 고쳐졌는지부터 보게 한다.
마지막 검토(시도 수 > select_review 단계의 retry.maxRounds)는 코드가 판정한다: 코드 점검 문제가 없으면 LLM의 RETRY를
PASS + acceptedWithNotes: true로 바꿔 남은 지적을 기록한 채 통과시킨다. 코드 점검 문제가 남거나 FAIL이면 그대로다 (docs/DECISIONS.md 30장).
선정 팀에는 Handoff가 없으므로 handoff는 늘 null이다.
"""
from paper_engine.wording import forbidden_phrases

from ...guardrails import contracts
from ...orchestration import registry
from ..base import WorkerContext, WorkerError
from ..prompts import system_prompt, user_prompt
from .team import candidate_table, candidates_of, changed_parts, has_price, research_sections

ROLE = """너는 매매 종목 선정안이 조사 결과와 맞는지 대조하는 검토 담당이다.
선정안의 순위마다 이유와 근거가 후보 표·조사 결과에 실제로 있는 내용인지 확인한다."""

# RETRY는 사실·해석 문제일 때만 낸다. 출처 누락·일부 생략·문체는 RETRY 사유가 아니다 (2026-10-12)
RULES = f"""- 대조 항목: 후보 표에 있는 종목인가, reason·summary의 사실이 조사 결과(뉴스·공시·수급)나 후보 표에 있는가,
  조사 결과와 반대로 해석하지 않았나 (예: 수급 mixed를 '동반 순매수'로, 악재를 호재로), 조사 결과의 '기대·전망'을 확정된 사실처럼 쓰지 않았나,
  고르지 않은 종목의 재료를 고른 종목 것처럼 쓰지 않았나, summary가 실제로 고른 종목과 어긋나지 않나,
  공시 위험 high 종목이나 악재가 뚜렷한 종목을 고르지 않았나, 가격·목표가나 권유 표현이 없나.
- RETRY는 위 대조 항목에 어긋나는 문제가 있을 때만 낸다. 다음은 RETRY 사유가 아니다 (이것만 있으면 PASS):
  reason의 사실이 조사 결과에 있는데 그 출처가 그 종목 evidence에 없는 것 (evidence는 종목마다 최대 {contracts.MAX_ITEMS}개인 참고 자료이고 화면에 보이지 않는다),
  조사 결과의 우려나 수급 기간(5일·20일) 중 일부만 쓴 것 (reason은 한두 문장 요약이다), 종목마다 서술 방식·길이가 다른 것,
  더 다듬으면 좋겠다는 정도의 의견.
- evidence에 근거를 더 넣으라고 지시하지 않는다. 근거 없는 주장이면 reason에서 빼거나 고치라고 한다.
- 자료의 "(가격)"은 코드가 가린 가격이다. 가격·목표가 문구는 코드가 따로 점검한다.
- verdict: PASS = RETRY 사유가 없음. RETRY = 고쳐야 할 문제가 있음 (instructions에 무엇을 어떻게 고칠지 종목 코드와 함께 구체적으로 쓰고,
  고치지 않을 종목은 그대로 두라고 쓴다). FAIL = 선정안 전체가 조사 결과와 어긋나 다시 써도 쓸 수 없음.
- issues에는 고쳐야 할 문제만 claim(선정안의 문장을 글자 그대로), problem(무엇이 틀렸나), fix(어떻게 고치나)로 쓴다. PASS면 빈 목록.
- score는 선정안 근거의 충실도 0~100.
- handoff는 늘 null로 둔다."""

# 다시 하는 검토일 때만 RULES 뒤에 붙인다
RECHECK = """- 다시 하는 검토다. "이전 검토"의 지적이 고쳐졌는지부터 하나씩 확인하고, 고쳐지지 않은 것만 다시 낸다.
- "이번에 바뀐 부분"(코드가 이전 선정안과 비교한 것)은 대조 항목 전체로 본다. 바뀌지 않은 부분은 이전 검토가 이미 대조했으므로
  다시 문제 삼지 않는다 (바뀐 부분 때문에 어긋나게 된 문장은 낸다).
- 이전 지적이 모두 고쳐졌고 바뀐 부분에 새 문제가 없으면 PASS다."""

# 다시 하는 검토의 프롬프트 덩어리 제목 (user_prompt가 "## 제목"으로 쓴다)
PREVIOUS_REVIEW = "이전 검토 (직전 라운드의 지적 — 고쳐졌는지부터 본다)"
CHANGED = "이번에 바뀐 부분 (코드가 이전 선정안과 비교)"


class SelectionReviewAgent:
    id = "selection_review_agent"
    output_contract = "ReviewResult"

    def run(self, ctx: WorkerContext) -> dict:
        rows = candidates_of(ctx)
        draft = ctx.inputs.get("selector_agent")
        if not isinstance(draft, dict) or not draft.get("picks"):
            raise WorkerError("검토할 선정안이 없습니다")
        sections = {"선정안 (selector_agent)": draft, "후보 표 (규칙 선별 점수 순, 코드가 계산한 값)": candidate_table(rows),
                    **research_sections(ctx.inputs)}
        rules = RULES
        again = ctx.retry or {}
        if isinstance(again.get("review"), dict):  # 다시 하는 검토: 직전 지적과 그 검토가 본 선정안에서 바뀐 부분
            previous = again["review"]
            sections[PREVIOUS_REVIEW] = {"issues": previous.get("issues") or [], "instructions": previous.get("instructions")}
            if isinstance(again.get("draft"), dict):
                sections[CHANGED] = changed_parts(again["draft"], draft)
            rules = f"{RULES}\n{RECHECK}"
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, rules), user_prompt(sections),
                        contract=self.output_contract)
        return settle(reply.data, code_issues(draft, rows, ctx.inputs.get("filing_screen_agent")),
                      last=ctx.attempt > retry_rounds())


def retry_rounds() -> int:
    """선정 팀 실행 계획에서 이 검토가 선정안을 고쳐 쓰게 할 수 있는 횟수 (select_review 단계의 retry.maxRounds, 없으면 0).

    Orchestrator는 검토 시도 n번째의 RETRY를 n <= maxRounds일 때만 고쳐 쓰기로 이어 간다. n > maxRounds가 마지막 검토다.
    """
    plan = registry.execution_plan(registry.SELECTION_TEAM)
    step = next((item for item in plan["steps"] if SelectionReviewAgent.id in item["workers"]), None)
    return ((step or {}).get("retry") or {}).get("maxRounds", 0)


def code_issues(draft: dict, rows: list[dict], filing: dict | None) -> list[dict]:
    """선정안에서 코드가 찾은 문제 [{claim, problem, fix}] (ReviewResult.issues 모양). evidence는 보지 않는다 (selector가 지운다)."""
    names = {row["symbol"]: row.get("name") or row["symbol"] for row in rows}
    high = {item.get("symbol") for item in (filing or {}).get("items") or [] if item.get("severity") == "high"}
    issues = []
    for pick in draft.get("picks") or []:
        symbol = str(pick.get("symbol") or "")
        claim = f"{pick.get('rank')}위 {names.get(symbol, symbol)}({symbol}): {pick.get('reason') or ''}"
        if symbol not in names:
            issues.append(_issue(claim, "후보 표에 없는 종목입니다.",
                                 f"후보 표에 없는 종목 {symbol}를 빼고 후보 안에서 다시 고르세요."))
        elif symbol in high:
            issues.append(_issue(claim, "공시 점검에서 위험 high인 종목입니다.",
                                 f"공시 위험이 높은 종목 {symbol}를 빼고 다시 고르세요."))
        issues += _wording(claim, pick.get("reason") or "")
    return issues + _wording(f"summary: {draft.get('summary') or ''}", draft.get("summary") or "")


def settle(review: dict, issues: list[dict], *, last: bool = False) -> dict:
    """계약을 통과한 검토 결과에 코드가 찾은 문제를 더한다. handoff는 늘 null.

    LLM이 보낸 acceptedWithNotes는 먼저 지운다 (코드만 붙이는 키). FAIL은 그대로. 코드 문제가 있으면 RETRY로 바꾸고 코드의 수정 지시를
    앞에 둔다. 코드 문제가 없는 마지막 검토(last)의 RETRY는 PASS + acceptedWithNotes: true — LLM의 issues·instructions는 기록으로 남긴다.
    """
    review = {key: value for key, value in review.items() if key != contracts.REVIEW_ACCEPTED} | {"handoff": None}
    if review["verdict"] == "FAIL":
        return review
    if issues:
        fixes = list(dict.fromkeys(issue["fix"] for issue in issues))
        if review["verdict"] == "RETRY" and review["instructions"]:
            fixes.append(review["instructions"])
        return review | {"verdict": "RETRY", "issues": issues + review["issues"], "instructions": "\n".join(fixes)}
    if last and review["verdict"] == "RETRY":
        return review | {"verdict": "PASS", contracts.REVIEW_ACCEPTED: True}
    return review


def _wording(claim: str, text: str) -> list[dict]:
    issues = []
    phrases = forbidden_phrases(text)
    if phrases:
        issues.append(_issue(claim, f"권유 표현({phrases[0]})이 있습니다.", "권유 표현을 빼고 근거만 쓰세요."))
    if has_price(text):
        issues.append(_issue(claim, "가격·목표가를 썼습니다.",
                             "가격(…원, (가격))·목표가 표현을 빼세요. 가격은 뒤의 종목 리포트가 정합니다."))
    return issues


def _issue(claim: str, problem: str, fix: str) -> dict:
    return {"claim": claim[:200], "problem": f"코드 확인: {problem}", "fix": fix}
