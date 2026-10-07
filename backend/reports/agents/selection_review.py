"""선정 검토 Worker `selection_review_agent` → ReviewResult (docs/AI_AGENT_WORKFLOW.md 2장).

선정안(selector_agent) + 조사 결과 + 후보 표를 주고 근거를 대조하게 한다 (PASS · RETRY · FAIL).
LLM 뒤에 코드가 한 번 더 본다: 후보 표 밖 종목, 공시 위험 high 종목, 권유 표현, 가격(…원)이 선정안에 있으면
LLM이 PASS라 해도 RETRY로 바꾸고 구체적인 수정 지시를 붙인다 (RETRY였으면 지시를 앞에 더하고, FAIL은 그대로).
선정 팀에는 Handoff가 없으므로 handoff는 늘 null이다.
"""
import re

from paper_engine.wording import forbidden_phrases

from .base import WorkerContext, WorkerError
from .prompts import system_prompt, user_prompt
from .selection_team import candidate_table, candidates_of, research_sections

# 가격 모양: "70,000원"·"70000원"·"7만 2천원"·"8.5만원", 가격 낱말 뒤의 숫자("목표가 9만", "주가 950"), 달러("$185"·"185달러").
# "1조원 수주"·"500억원"처럼 금액은 걸리지 않는다
PRICE = re.compile(
    r"\d{1,3}(?:,\d{3})+\s*원|\d{4,}\s*원"
    r"|\d+(?:\.\d+)?\s*만\s*(?:\d+\s*천\s*)?원"
    r"|(?:목표|진입|손절|매수|매도)\s*가(?:격)?\s*(?:은|는|이|가|을|를|도|:)?\s*(?:약\s*)?\$?\s*\d"
    r"|(?:주가|현재가|종가)\s*(?:은|는|이|가|을|를|도|:)?\s*(?:약\s*)?\$?\s*\d"
    r"|\$\s*\d|\d+(?:\.\d+)?\s*달러")

ROLE = """너는 매매 종목 선정안이 조사 결과와 맞는지 대조하는 검토 담당이다.
선정안의 순위마다 이유와 근거가 후보 표·조사 결과에 실제로 있는 내용인지 확인한다."""

RULES = """- 대조 항목: 후보 표에 있는 종목인가, reason·evidence가 조사 결과(뉴스·공시·수급)와 후보 표에 있는 사실인가,
  조사 결과와 반대로 해석하지 않았나, 공시 위험 high 종목이나 악재가 뚜렷한 종목을 고르지 않았나,
  가격·목표가를 쓰지 않았나, 권유 표현이 없나.
- verdict: PASS = 문제 없음. RETRY = 고치면 되는 문제가 있음 (instructions에 무엇을 어떻게 고칠지 종목 코드와 함께 구체적으로).
  FAIL = 선정안 전체가 조사 결과와 어긋나 다시 써도 쓸 수 없음.
- issues에는 문제마다 claim(선정안의 문장), problem(무엇이 틀렸나), fix(어떻게 고치나)를 쓴다. 문제가 없으면 빈 목록.
- score는 선정안 근거의 충실도 0~100.
- handoff는 늘 null로 둔다."""


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
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user_prompt(sections),
                        contract=self.output_contract)
        return settle(reply.data, code_issues(draft, rows, ctx.inputs.get("filing_screen_agent")))


def code_issues(draft: dict, rows: list[dict], filing: dict | None) -> list[dict]:
    """선정안에서 코드가 찾은 문제 [{claim, problem, fix}] (ReviewResult.issues 모양)."""
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


def settle(review: dict, issues: list[dict]) -> dict:
    """계약을 통과한 검토 결과에 코드가 찾은 문제를 더한다. handoff는 늘 null."""
    review = review | {"handoff": None}
    if not issues or review["verdict"] == "FAIL":
        return review
    fixes = list(dict.fromkeys(issue["fix"] for issue in issues))
    if review["verdict"] == "RETRY" and review["instructions"]:
        fixes.append(review["instructions"])
    return review | {"verdict": "RETRY", "issues": issues + review["issues"], "instructions": "\n".join(fixes)}


def _wording(claim: str, text: str) -> list[dict]:
    issues = []
    phrases = forbidden_phrases(text)
    if phrases:
        issues.append(_issue(claim, f"권유 표현({phrases[0]})이 있습니다.", "권유 표현을 빼고 근거만 쓰세요."))
    if PRICE.search(text):
        issues.append(_issue(claim, "가격을 썼습니다.", "가격(…원)을 빼세요. 가격은 뒤의 종목 리포트가 정합니다."))
    return issues


def _issue(claim: str, problem: str, fix: str) -> dict:
    return {"claim": claim[:200], "problem": f"코드 확인: {problem}", "fix": fix}
