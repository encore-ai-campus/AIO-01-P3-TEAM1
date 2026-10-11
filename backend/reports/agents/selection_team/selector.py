"""종목 선정 Worker `selector_agent` → SelectionDraft (docs/design/AI_AGENT_WORKFLOW.md 2~4장).

후보 표(코드 값) + 조사 결과(뉴스·공시·수급 — 가격을 "(가격)"으로 가린 사본)를 보고 스윙 매매로 살펴볼 종목 최대 5개의 순위와 근거를 낸다.
가격은 내지 않는다 (진입·목표·손절은 뒤의 종목 리포트가 정한다). 검토가 RETRY면 이전 선정안과 수정 지시를 붙여 다시 쓴다 —
지시받지 않은 종목의 순위·reason·evidence는 글자 그대로 두게 한다 (RETRY_PREFIX).
finish가 코드로 정리한다: evidence에서 가격·목표가·"(가격)"이 든 항목을 지우고, 계약 상한(200자)에서 잘린 reason은 마지막 문장 끝까지
줄이고, 다시 쓴 경우 이전 선정안과 달라진 곳을 `_changed`로 붙인다 (Orchestrator가 agent_completed.details.changed로 남긴다 —
docs/DECISIONS.md 30장).
후보 표 밖 종목을 여기서 지우지 않는다 — 선정 Guard가 빼고 그 사실을 기록한다 (검토도 RETRY로 되돌린다).
"""
import re

from ...guardrails import contracts
from ..base import WorkerContext
from ..prompts import system_prompt, user_prompt
from .team import candidate_table, candidates_of, changed_parts, has_price, research_sections

ROLE = """너는 규칙 선별을 통과한 후보 중에서 스윙 매매(며칠~몇 주 보유)로 살펴볼 종목의 순위를 매기는 선정 담당이다.
후보 표의 점수·지표와 조사 결과(뉴스 재료·악재, 공시 위험, 수급)를 함께 보고 고른다."""

# 검토 기준(selection_review.RULES)과 같은 기준으로 쓰게 한다: 기대·전망 유지, 수급·우려 방향, summary는 고른 종목에 맞게 (2026-10-12)
RULES = f"""- 반드시 후보 표에 있는 종목 중에서만 고른다. 후보 표에 없는 종목 코드를 쓰면 그 순위는 버려진다.
- 최대 {contracts.MAX_SELECTION}개, rank는 1부터 중복 없이 매긴다. 고를 만한 후보가 적으면 적게 고른다.
- 공시 점검에서 severity가 high인 종목은 고르지 않는다. 악재가 뚜렷한 종목은 피한다. 같은 theme은 2개까지만 고른다.
- reason은 왜 골랐는지 한두 문장({contracts.LIST_ITEM_MAX}자 안)으로, 그 종목의 조사 결과와 후보 표에 있는 사실에만 근거한다.
  조사 결과에 '기대'·'전망'으로 적힌 것은 reason에도 기대·전망으로 쓴다 ('확인됐다'처럼 확정된 사실로 바꾸지 않는다).
  수급은 수급 해석의 signal·note와 같은 방향으로 쓴다 (mixed이면 엇갈린다고 쓴다). 뉴스 점검의 concerns가 있는 종목은 가장 중요한 우려 하나를 짧게 같이 쓴다.
  고르지 않은 종목이나 다른 종목 항목의 재료를 그 종목의 사실처럼 쓰지 않는다.
- evidence는 종목마다 최대 {contracts.MAX_ITEMS}개다 (넘으면 뒤가 버려진다). reason의 주장을 뒷받침하는 그 종목의 조사 결과(뉴스 제목, 공시 제목, 수급 해석,
  후보 표의 지표 이름과 값)를 항목 하나에 하나씩 짧게 옮긴다.
- 가격·목표가·손절가·진입가는 쓰지 않는다 (가격은 뒤의 종목 리포트가 정한다). 자료의 "(가격)"은 코드가 가린 가격이다 —
  reason·summary에 쓰지 않고, evidence로 옮길 때는 "(가격)"과 목표가·목표주가 표현을 뺀다 (남아 있는 evidence 항목은 코드가 지운다).
  숫자는 후보 표·조사 결과에 있는 것만 쓴다.
- summary는 오늘 선정의 흐름(어떤 재료·테마가 많았는지, 무엇을 피했는지)을 2~3문장으로 쓴다.
  고른 종목 모두에 맞는 말만 쓰고(일부만 해당하면 그 종목을 밝힌다), 고르지 않은 종목의 재료를 고른 종목 것처럼 쓰지 않는다.
- 이전 선정안과 검토의 수정 지시가 있으면 지시한 종목·항목만 고친 JSON 전체를 낸다.
  지시받지 않은 종목의 순위·reason·evidence는 이전 선정안의 글을 그대로 옮긴다. 고친 내용 때문에 summary가 어긋나면 그 문장만 맞춘다."""

# 검토 RETRY로 다시 쓸 때 수정 지시 앞에 붙인다 (report.RETRY_PREFIX와 같은 방식)
RETRY_PREFIX = ("이전 선정안에서 지시받지 않은 종목의 순위·reason·evidence는 글자 그대로 두세요. 수정 지시의 각 항목만 고치세요. "
                f"evidence는 종목마다 {contracts.MAX_ITEMS}개까지라, 근거를 더 넣으라는 지시는 그 안에서 덜 중요한 항목과 바꾸세요.\n")
# 문장 끝. 숫자 바로 뒤의 점은 아니다 ("3.18%"의 점, 200자에서 잘려 "… 주가 3."으로 끝난 소수점)
SENTENCE_END = re.compile(r"(?<!\d)[.!?。](?=\s|$)")


class SelectorAgent:
    id = "selector_agent"
    output_contract = "SelectionDraft"

    def run(self, ctx: WorkerContext) -> dict:
        rows = candidates_of(ctx)
        sections = {"후보 표 (규칙 선별 점수 순, 코드가 계산한 값)": candidate_table(rows), **research_sections(ctx.inputs)}
        previous = ctx.inputs.get(self.id)
        instructions = RETRY_PREFIX + ctx.instructions if ctx.instructions else None
        user = user_prompt(sections, instructions=instructions, previous=previous)
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user, contract=self.output_contract)
        return finish(reply.data, previous)


def finish(draft: dict, previous: dict | None = None) -> dict:
    """계약을 통과한 선정안을 코드로 정리한다.

    종목마다 reason은 잘린 문장을 덜어 내고(_trim), evidence는 가격·목표가·"(가격)"이 든 항목을 지운다 (0~3개가 될 수 있다).
    다시 쓴 경우(previous가 이전 선정안)에는 달라진 곳 목록을 `_changed`로 붙인다 (빈 목록이면 아무것도 고치지 않은 것). 첫 실행에는 없다.
    """
    picks = [pick | {"reason": _trim(pick["reason"]), "evidence": [item for item in pick["evidence"] if not has_price(item)]}
             for pick in draft["picks"]]
    result = draft | {"picks": picks}
    if isinstance(previous, dict):
        result["_changed"] = changed_parts(previous, result)["바뀜"]
    return result


def _trim(reason: str) -> str:
    """계약 상한(contracts.LIST_ITEM_MAX)에서 잘린 reason을 마지막으로 끝난 문장까지 줄인다. 문장 끝이 없으면 그대로."""
    if len(reason) < contracts.LIST_ITEM_MAX:
        return reason
    ends = [m.end() for m in SENTENCE_END.finditer(reason)]
    return reason[:ends[-1]] if ends else reason
