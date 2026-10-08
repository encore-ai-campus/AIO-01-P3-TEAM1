"""최종 컨펌 에이전트. 판정과 리스크 엔진을 통과한 시나리오만 검토해 승인 또는 거부한다.

응답을 받지 못하거나 형식이 틀리면 승인하지 않는다. 시간 초과는 호출한 쪽에서 처리하도록 그대로 올린다.
"""
import json
from dataclasses import asdict

from ..judge.scenario import SWING_MAX_DAYS, SWING_MIN_DAYS
from ..judge.verdict import Approval, Candidate
from ..llm import LlmError, LlmTimeout
from .critic import public_view

SYSTEM = f"""당신은 투자위원회의 최종 승인권자다. 애널리스트들의 교차검증과 리스크 한도를 통과한 스윙 매수 시나리오
(보유 {SWING_MIN_DAYS}~{SWING_MAX_DAYS}거래일)를 마지막으로 검토해 승인 또는 거부한다.
승인된 시나리오는 팀에 매수 추천으로 전달되고 모의 계좌에서 매수되며, 결과는 모델별 성적으로 기록된다.

규칙:
- 의심스러우면 거부한다. 놓친 기회보다 잘못된 매매의 비용이 크다.
- 검증자들이 지적한 약점이 해소되지 않았는데도 점수가 높게 나왔는지 본다.
- 근거가 종목 데이터와 맞는지, 불리한 사실(수급, 뉴스, 예정 일정, 영업외 손익)을 무시하지 않았는지 본다.
- 근거의 중심이 보유 기간 안에 가격을 움직일 수 있는 것(가격·거래량 구조와 추세, 변동성, 수급,
  기간 안의 재료와 일정)이어야 한다. 근거가 주로 실적·수주 같은 재무라면 거부한다.
  재무는 거르는 조건이지 매수 이유가 아니다.
- 뚜렷한 하락 추세(가격이 주요 이동평균 아래, 외국인·기관의 지속적인 순매도)에서 사는데
  데이터에 반전의 구체적 근거가 없으면 거부한다.
- 목표가가 holdingDays 동안의 변동성으로 닿을 수 있는지 본다 (atr14는 하루 변동폭, volatility20은 연율화 값).
  손절가는 코드가 정한 값(stopRule)이라 손절가 위치만으로 거부하지 않는다.
- reachCheck는 코드가 계산한 목표가 도달 가능성이다 (목표까지 거리 ÷ atr14×√holdingDays).
  "주의"가 붙었는데 그만큼 강한 근거가 없으면 거부한다.
- 새 시나리오를 제안하거나 가격을 고치지 않는다. 주어진 시나리오를 그대로 승인하거나 거부한다.
- 설명은 한국어로 쓴다.

JSON만 출력한다:
{{"decision": "APPROVE", "reason": "두세 문장", "concerns": ["사용자가 알아야 할 남은 위험"]}}
decision은 APPROVE 또는 REJECT."""

TIMEOUT_SEC = 150


def approve(llm, model: str, context: str, c: Candidate) -> Approval:
    a = c.assessment
    case = {
        "scenario": public_view(c.raw) | {"probability": None},
        "proposerProbability": c.scenario.probability,
        "proposerScore": c.proposer_score,
        "reviews": [{"score": q.score, "probability": q.probability, "weaknesses": q.weaknesses,
                     "comment": q.comment} for q in c.critiques],
        "reachCheck": c.reach.note if c.reach else None,
        "verdict": {"score": round(c.score, 1), "consensusProbability": round(c.consensus_probability, 3)},
        "risk": {k: round(v, 4) if isinstance(v, float) else v for k, v in asdict(a).items()
                 if k in ("quantity", "amount", "reward_risk", "expected_profit", "max_loss",
                          "expected_value", "expected_return")},
    }
    user = f"{context}\n\n승인 여부를 정할 안건:\n{json.dumps(case, ensure_ascii=False)}"
    try:
        out = llm.complete_json(model, SYSTEM, user, timeout=TIMEOUT_SEC)
    except LlmTimeout:
        raise
    except LlmError as e:
        return Approval(False, f"최종 컨펌 응답을 받지 못함: {e}", [], model)
    decision = out.get("decision")
    if decision not in ("APPROVE", "REJECT"):
        return Approval(False, f"최종 컨펌 응답 형식 오류: decision={decision!r}", [], model)
    return Approval(decision == "APPROVE", str(out.get("reason", "")),
                    [str(x) for x in (out.get("concerns") or [])][:5], model)
