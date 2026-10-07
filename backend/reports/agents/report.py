"""리포트 작성 Worker `report_agent` (docs/tasks/02-worker.md T2-7, 2026-10-04 합의 — 쉬운 요약·추천으로 이어지는 targets).

입력은 Join Guard가 넘긴 조사 결과(`ctx.inputs`의 market_agent·fundamental_agent·news_agent)뿐이다.
검토가 RETRY면 Orchestrator가 `ctx.instructions`(수정 지시)와 이전 초안(`ctx.inputs["report_agent"]`)을 같이 넣어 다시 부른다.
`verdict == "buy"`이고 targets가 `0 < stop < entry < target`이면 엔진 루프가 이 초안으로 AI 추천을 만든다 (autotrade.sources.from_report).
손익비 기준은 프롬프트에 넣지 않는다 (리스크 엔진이 거른다). citations는 조사 결과의 evidence에 있는 것만 남긴다.
"""
from .base import WorkerContext, WorkerError
from .prompts import system_prompt, user_prompt

RESEARCH = {"market_agent": "시세·차트 조사", "fundamental_agent": "재무·공시 조사", "news_agent": "뉴스·심리 조사"}
MAX_CITATIONS = 10   # ReportDraft.citations 상한
UNITS = {"KR": "원", "US": "달러"}

ROLE = ("너는 모의투자 서비스 '모매매'의 AI 리포트 팀에서 리포트를 쓰는 작성 AI다. "
        "조사 AI 세 명(시세·차트, 재무·공시, 뉴스·심리)의 결과만 근거로 종목 리포트 초안을 쓴다. "
        "독자에는 주식이 처음인 사람도 있다.")
RULES = """- verdict는 소문자 buy·hold·avoid 중 하나다 (buy = AI 의견 긍정적, hold = 지켜보기, avoid = 부정적).
- targets의 entry(진입)·target(목표)·stop(손절) 가격은 시세 조사의 price·support·resistance와 변동성에 근거한다. entry는 price에서 5% 안이다.
  buy이면 세 가격을 모두 채우고 0 < stop < entry < target이어야 한다. hold·avoid이면 세 가격을 null로 둘 수 있다.
- holdingDays는 보유할 거래일 수(1~20 정수), probability는 손절 가격보다 목표 가격에 먼저 닿을 확률의 솔직한 추정(0~1)이다. 부풀리지 않는다.
- confidence는 이 의견을 얼마나 확신하는지(0~100)다.
- plainSummary는 쉬운 문장 정확히 3개다. 중학생도 읽을 말로 쓰고 "~예요", "~어요"로 끝낸다.
  숫자(0-9)를 쓰지 않는다 (가격·비율은 화면이 따로 보여 준다). 조사 결과에 없는 주장을 넣지 않는다. verdict와 반대 방향으로 쓰지 않는다.
- oneLiner는 80자 안의 한 줄 결론이다. 주어는 "AI 의견"이다.
- reasons는 최대 3개다. targets.target이 있으면 그중 하나는 "목표 가격 ○○{unit}의 근거: …" 형식으로 목표 가격을 정한 근거를 쓴다.
- risks는 최대 3개다. 그중 하나는 "이 의견이 틀리는 경우: ○○{unit} 아래로 내려가거나 ○○이 나오면 의견을 다시 봐야 해요" 형식이다.
- markdown은 리포트 본문이다. "## 한눈에 보기", "## 시세·차트", "## 재무·공시", "## 뉴스·심리", "## AI 의견과 가격 제안", "## 위험 요인" 절로 쓰고,
  조사 결과가 없는 절에는 "자료 없음"이라고 쓴다.
- citations에는 근거로 쓴 조사 결과의 evidence 항목을 글자 그대로 옮긴다 (최대 10개).
- title은 "○○ 종목 리포트"처럼 짧게 쓴다.
- 이전 초안과 검토의 수정 지시가 있으면 지시를 모두 반영해 초안 전체를 다시 쓴다."""


class ReportAgent:
    id = "report_agent"
    output_contract = "ReportDraft"

    def run(self, ctx: WorkerContext) -> dict:
        research = {wid: ctx.inputs[wid] for wid in RESEARCH if ctx.inputs.get(wid)}
        if "market_agent" not in research:
            raise WorkerError("시세 조사 결과가 없어 리포트를 쓸 수 없습니다.")
        unit = UNITS.get(ctx.market, "")
        sections = {"종목": {"symbol": ctx.symbol, "name": ctx.name, "market": ctx.market, "priceUnit": unit}}
        sections |= {f"{title} ({wid})": research.get(wid) for wid, title in RESEARCH.items()}
        prompt = user_prompt(sections, instructions=ctx.instructions, previous=ctx.inputs.get("report_agent"))
        system = system_prompt(ROLE, self.output_contract, RULES.replace("{unit}", unit))
        reply = ctx.llm(system, prompt, contract=self.output_contract)
        return finish(reply.data, research)


def finish(answer: dict, research: dict[str, dict]) -> dict:
    """citations를 조사 결과의 evidence에 있는 것만으로 (하나도 맞지 않으면 조사 결과의 evidence 앞에서부터)."""
    result = dict(answer)
    evidence = list(dict.fromkeys(e for r in research.values() for e in r.get("evidence") or []))
    known = {_squash(e): e for e in evidence}
    cited = list(dict.fromkeys(known[key] for c in result.get("citations") or [] if (key := _squash(c)) in known))
    result["citations"] = (cited or evidence)[:MAX_CITATIONS]
    return result


def _squash(text) -> str:
    return "".join(str(text or "").split())
