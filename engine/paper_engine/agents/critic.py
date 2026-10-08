"""검증 에이전트. 한 번의 호출로 다른 모델이 낸 시나리오 전체를 채점한다."""
import json

from ..judge.scenario import SWING_MAX_DAYS, SWING_MIN_DAYS
from .context import SCORE_RUBRIC

SYSTEM = f"""당신은 리스크 심사역이다. 다른 애널리스트들이 낸 스윙 매수 시나리오(보유 {SWING_MIN_DAYS}~{SWING_MAX_DAYS}거래일)를
종목 데이터에 비추어 비판적으로 검토한다.

규칙:
- 시나리오마다 따로 평가한다. 다른 시나리오와 비교해 상대 평가하지 않는다.
- 약점을 먼저 찾는다. 근거가 데이터와 맞지 않거나, 불리한 데이터를 무시했는지 본다.
- 목표가가 holdingDays 동안의 변동성으로 닿기 어려운 거리인지 본다 (atr14는 하루 변동폭, volatility20은 연율화 값).
  손절가는 코드가 정한 값(stopRule)이다. 손절가의 위치는 약점으로 꼽지 말고 probability 추정에 반영한다.
- 근거의 중심이 보유 기간 안에 가격을 움직일 수 있는 것(가격·거래량 구조와 추세, 변동성, 수급,
  기간 안의 재료와 일정)인지 본다. 재무는 거르는 조건이지 매수 이유가 아니다.
  근거가 주로 실적·수주 같은 재무라면 점수를 낮춘다. 재무 부실이나 큰 영업외 손실을 무시했다면 약점이다.
- 뚜렷한 하락 추세(가격이 주요 이동평균 아래, 외국인·기관의 지속적인 순매도)에서 사는 시나리오인데
  데이터에 반전의 구체적 근거가 없으면 점수를 낮춘다.
- reachCheck는 코드가 계산한 목표가 도달 가능성이다 (목표까지 거리 ÷ atr14×√holdingDays).
  "주의"가 붙었으면 목표가가 기간에 비해 먼 것이니 근거가 그만큼 강한지 본다.
- 시나리오가 webResearch의 불리한 사실이나 보유 기간 안의 예정 일정을 무시했는지도 본다.
- probability는 손절가보다 목표가에 먼저 도달할 확률에 대한 당신 자신의 추정이다.
- score는 아래 기준에 따른 당신의 평가다.
- 받은 시나리오를 빠짐없이 평가하고, id를 그대로 돌려준다.
- 설명은 한국어로 쓴다. weaknesses는 중요한 순서로 최대 5개.

""" + SCORE_RUBRIC + """

JSON만 출력한다:
{"reviews": [{"id": "S1", "score": 0, "probability": 0.0, "weaknesses": ["..."],
  "comment": "한 문장 요약"}]}"""

PUBLIC_FIELDS = ("horizon", "entryPrice", "targetPrice", "stopPrice", "probability",
                 "holdingDays", "rationale", "invalidation")


def public_view(raw: dict) -> dict:
    """검증자에게 보여줄 시나리오. 제안자가 누구인지와 자기 평가 점수는 넘기지 않는다."""
    return {k: raw.get(k) for k in PUBLIC_FIELDS}


def review(llm, model: str, context: str, scenarios: dict[str, dict],
           reach_notes: dict[str, str] | None = None) -> dict[str, dict]:
    """scenarios는 {시나리오 id: 원본}, reach_notes는 {시나리오 id: 목표가 도달 가능성 점검 결과}.
    {시나리오 id: 평가}를 반환한다.

    형식이 틀렸거나 받지 않은 id에 대한 평가는 버린다.
    """
    notes = reach_notes or {}
    listing = [{"id": sid, **public_view(raw)} | ({"reachCheck": notes[sid]} if sid in notes else {})
               for sid, raw in scenarios.items()]
    user = f"{context}\n\n검토할 시나리오:\n{json.dumps(listing, ensure_ascii=False)}"
    out = llm.complete_json(model, SYSTEM, user)
    reviews = {}
    for r in out.get("reviews") or []:
        try:
            sid = r["id"]
            if sid not in scenarios or sid in reviews:
                continue
            reviews[sid] = {
                "score": min(max(float(r["score"]), 0.0), 100.0),
                "probability": min(max(float(r["probability"]), 0.0), 1.0),
                "weaknesses": [str(w) for w in (r.get("weaknesses") or [])][:5],
                "comment": str(r.get("comment", "")),
            }
        except (KeyError, TypeError, ValueError):
            continue
    return reviews
