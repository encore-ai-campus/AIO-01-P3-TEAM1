"""종목 선정 Worker `selector_agent` → SelectionDraft (docs/AI_AGENT_WORKFLOW.md 2~4장).

후보 표(코드 값) + 조사 결과(뉴스·공시·수급)를 보고 스윙 매매로 살펴볼 종목 최대 5개의 순위와 근거를 낸다. 가격은 내지 않는다
(진입·목표·손절은 뒤의 종목 리포트가 정한다). 검토가 RETRY면 이전 선정안과 수정 지시를 붙여 다시 쓴다.
후보 표 밖 종목을 여기서 지우지 않는다 — 선정 Guard가 빼고 그 사실을 기록한다 (검토도 RETRY로 되돌린다).
"""
from .. import contracts
from .base import WorkerContext
from .prompts import system_prompt, user_prompt
from .selection_team import candidate_table, candidates_of, research_sections

ROLE = """너는 규칙 선별을 통과한 후보 중에서 스윙 매매(며칠~몇 주 보유)로 살펴볼 종목의 순위를 매기는 선정 담당이다.
후보 표의 점수·지표와 조사 결과(뉴스 재료·악재, 공시 위험, 수급)를 함께 보고 고른다."""

RULES = f"""- 반드시 후보 표에 있는 종목 중에서만 고른다. 후보 표에 없는 종목 코드를 쓰면 그 순위는 버려진다.
- 최대 {contracts.MAX_SELECTION}개, rank는 1부터 중복 없이 매긴다. 고를 만한 후보가 적으면 적게 고른다.
- 공시 점검에서 severity가 high인 종목은 고르지 않는다. 악재가 뚜렷한 종목은 피한다. 같은 theme은 2개까지만 고른다.
- reason은 왜 골랐는지 한두 문장으로, 조사 결과와 후보 표에 있는 사실에만 근거한다.
- evidence에는 근거가 된 조사 결과(뉴스 제목, 공시 제목, 수급 해석, 후보 표의 지표 이름과 값)를 그대로 짧게 쓴다.
- 가격·목표가·손절가·진입가는 쓰지 않는다 (가격은 뒤의 종목 리포트가 정한다). 숫자는 후보 표·조사 결과에 있는 것만 쓴다.
- summary는 오늘 선정의 흐름(어떤 재료·테마가 많았는지, 무엇을 피했는지)을 2~3문장으로 쓴다."""


class SelectorAgent:
    id = "selector_agent"
    output_contract = "SelectionDraft"

    def run(self, ctx: WorkerContext) -> dict:
        rows = candidates_of(ctx)
        sections = {"후보 표 (규칙 선별 점수 순, 코드가 계산한 값)": candidate_table(rows), **research_sections(ctx.inputs)}
        user = user_prompt(sections, instructions=ctx.instructions, previous=ctx.inputs.get(self.id))
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user, contract=self.output_contract)
        return reply.data
