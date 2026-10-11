"""리포트 작성 Worker `report_agent` (docs/tasks/02-worker.md T2-7, 2026-10-04 합의 — 쉬운 요약·추천으로 이어지는 targets).

입력은 Join Guard가 넘긴 조사 결과(`ctx.inputs`의 market_agent·fundamental_agent·news_agent)뿐이다.
검토가 RETRY면 Orchestrator가 `ctx.instructions`(수정 지시)와 이전 초안(`ctx.inputs["report_agent"]`)을 같이 넣어 다시 부른다.
`verdict == "buy"`이고 targets가 `0 < stop < entry < target`이면 엔진 루프가 이 초안으로 AI 추천을 만든다 (autotrade.recommend.sources.from_report).
손익비 기준은 프롬프트에 넣지 않는다 (리스크 엔진이 거른다). citations는 조사 결과의 evidence에 있는 것만 남긴다.
손절 가격은 코드가 정한다: 시세 조사의 stop(엔진 judge/stops.py)을 프롬프트로 알려 주고, 초안의 targets.stop은 그 값으로 덮어쓴다.
쉬운 글(plainSummary·oneLiner·reasons·risks)에는 전문 용어(tidy.JARGON)를 쓰지 않게 한다 — 검토의 쉬운 글 Guard가 확인하고,
금액 쉼표·의견 영어·남은 용어의 괄호 풀이는 Orchestrator가 State에 넣기 전에 후처리한다 (tidy.tidy_result).
"""
from ...guardrails.tidy import JARGON
from ..base import WorkerContext, WorkerError
from ..prompts import system_prompt, user_prompt

RESEARCH = {"market_agent": "시세·차트 조사", "fundamental_agent": "재무·공시 조사", "news_agent": "뉴스·심리 조사"}
MAX_CITATIONS = 10   # ReportDraft.citations 상한
UNITS = {"KR": "원", "US": "달러"}
# 쉬운 글에 쓰지 않는 전문 용어 (Guard와 같은 표). "손익비"는 말 자체도 프롬프트에 넣지 않는다 (DECISIONS 21·22 — 쓰면 Guard가 잡는다)
JARGON_LIST = "·".join(name for name, _, _ in JARGON if name != "손익비")

ROLE = ("너는 모의투자 서비스 '모매매'의 AI 리포트 팀에서 리포트를 쓰는 작성 AI다. "
        "조사 AI 세 명(시세·차트, 재무·공시, 뉴스·심리)의 결과만 근거로 종목 리포트 초안을 쓴다. "
        "독자에는 주식이 처음인 사람도 있다.")
RULES = """- verdict는 소문자 buy·hold·avoid 중 하나다 (buy = AI 의견 긍정적, hold = 지켜보기, avoid = 부정적).
- targets의 entry(진입)·target(목표) 가격은 시세 조사의 price·support·resistance와 변동성에 근거한다. entry는 price에서 5% 안이다.
- 손절 가격은 코드가 정한다. 시세 조사의 stop이 손절 가격이고, targets.stop에는 그 값을 그대로 쓴다 (코드가 다시 덮어쓴다).
  buy이면 entry·target을 채우고 stop < entry < target이어야 한다. 시세 조사의 stop이 null이면 buy를 내지 않는다.
  hold·avoid이면 세 가격을 null로 둘 수 있다.
- holdingDays는 보유할 거래일 수(1~20 정수), probability는 그 손절 가격보다 목표 가격에 먼저 닿을 확률의 솔직한 추정(0~1)이다. 부풀리지 않는다.
- confidence는 이 의견을 얼마나 확신하는지(0~100)다.
- plainSummary는 쉬운 문장 정확히 3개다. 중학생도 읽을 말로 쓰고 "~예요", "~어요"로 끝낸다.
  숫자(0-9)를 쓰지 않는다 (가격·비율은 화면이 따로 보여 준다). 조사 결과에 없는 주장을 넣지 않는다. verdict와 반대 방향으로 쓰지 않는다.
- oneLiner는 80자 안의 한 줄 결론이다. 주어는 "AI 의견"이다.
- 쉬운 글(plainSummary·oneLiner·reasons·risks)에는 다음 말을 쓰지 말고 쉬운 말로 풀어 쓴다: {jargon}.
  예: "최근 한 달 평균 가격보다 낮아요", "이 가격 아래로 내려가면 더 떨어질 수 있어요", "회사가 버는 돈에 비해 주가가 낮은 편이에요".
  이런 말과 지표 숫자는 markdown 본문에만 쓴다.
- 글에 buy·hold·avoid 같은 영어 의견을 쓰지 않는다 (긍정적·지켜보기·부정적처럼 한국어로). 금액은 천 단위 쉼표를 넣어 쓴다 (예: 201,000{unit}).
- reasons는 최대 3개다. targets.target이 있으면 그중 하나는 "목표 가격 ○○{unit}의 근거: …" 형식으로 목표 가격을 정한 근거를 쓴다.
- risks는 최대 3개다. 그중 하나는 "이 의견이 틀리는 경우: ○○{unit} 아래로 내려가거나 ○○이 나오면 의견을 다시 봐야 해요" 형식이고,
  ○○{unit}에는 손절 가격을 쓴다.
- markdown은 리포트 본문이다. "## 한눈에 보기", "## 시세·차트", "## 재무·공시", "## 뉴스·심리", "## AI 의견과 가격 제안", "## 위험 요인" 절로 쓰고,
  조사 결과가 없는 절에는 "자료 없음"이라고 쓴다.
- citations에는 본문에서 실제로 사용한 조사 결과의 evidence 항목을 글자 그대로 옮긴다 (최대 10개).
  개별 뉴스 기사·증권사 목표주가를 언급했다면 그 출처를 빠뜨리지 않는다. 10개를 넘으면 실제로 쓴 근거를 우선하고, 인용할 수 없는 주장은 본문에서 뺀다.
- 뉴스 심리를 설명할 때 news_agent의 sentiment와 반대되는 표현을 단정하지 않는다. 상반된 개별 기사가 있으면 전체 심리 판단과 구분해 쓴다.
- title은 "○○ 종목 리포트"처럼 짧게 쓴다.
- 이전 초안과 검토의 수정 지시가 있으면 지시한 항목을 모두 고친 JSON 전체를 반환한다. 지시받지 않은 사실·가격·근거는 유지한다."""

RETRY_PREFIX = ("이전 초안에서 지시받지 않은 사실·가격·근거는 유지하세요. "
                "수정 지시의 각 항목을 관련 필드와 markdown 양쪽에 반영하고, "
                "기사·증권사 목표주가를 썼다면 해당 evidence 문구를 citations에 그대로 복사하세요.\n")


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
        sections["citations에 그대로 복사할 근거 후보"] = list(dict.fromkeys(
            evidence for result in research.values() for evidence in result.get("evidence") or []))
        instructions = RETRY_PREFIX + ctx.instructions if ctx.instructions else None
        prompt = user_prompt(sections, instructions=instructions, previous=ctx.inputs.get("report_agent"))
        system = system_prompt(ROLE, self.output_contract, RULES.replace("{unit}", unit).replace("{jargon}", JARGON_LIST))
        reply = ctx.llm(system, prompt, contract=self.output_contract)
        return finish(reply.data, research)


def finish(answer: dict, research: dict[str, dict]) -> dict:
    """손절 가격을 코드 값으로 바꾸고, citations는 조사 결과의 evidence에 있는 것만으로
    (하나도 맞지 않으면 조사 결과의 evidence 앞에서부터).

    진입·목표 가격이 하나라도 있으면 targets.stop = 시세 조사의 stop이다 (코드가 정한 값. 정하지 못했으면 null → 추천이 생기지 않는다).
    """
    result = dict(answer)
    targets = result.get("targets")
    if isinstance(targets, dict) and (targets.get("entry") is not None or targets.get("target") is not None):
        result["targets"] = {**targets, "stop": (research.get("market_agent") or {}).get("stop")}
    evidence = list(dict.fromkeys(e for r in research.values() for e in r.get("evidence") or []))
    known = {_squash(e): e for e in evidence}
    cited = list(dict.fromkeys(known[key] for c in result.get("citations") or [] if (key := _squash(c)) in known))
    result["citations"] = (cited or evidence)[:MAX_CITATIONS]
    return result


def _squash(text) -> str:
    return "".join(str(text or "").split())
