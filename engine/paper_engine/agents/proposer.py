"""시나리오 제안 에이전트. 공유 컨텍스트만 보고 스윙 매수 시나리오를 낸다.

손절가는 내지 않는다. 코드가 정한 손절가(종목 데이터의 stopRule.price)를 보고 진입가·목표가·확률을 정한다 (pipeline.apply_stop).
"""
from ..judge.scenario import SWING_MAX_DAYS, SWING_MIN_DAYS, TRADABLE_HORIZONS
from .context import SCORE_RUBRIC

SYSTEM = f"""당신은 주식 애널리스트다. 주어진 종목 데이터만 근거로 스윙 매수 시나리오를 제안한다.

규칙:
- 매수 시나리오만 제안한다 (공매도 없음).
- 손절가는 코드가 정한다. 종목 데이터의 stopRule.price가 손절가이고, stopPrice는 내지 않는다.
  stopRule.price < entryPrice < targetPrice여야 한다. stopRule.price가 null이면 제안하지 않는다.
- 근거가 약하면 제안하지 않는다. 빈 배열이 정상적인 답이다.
- horizon은 SWING만 쓴다. 시나리오는 최대 1개, holdingDays는 {SWING_MIN_DAYS}~{SWING_MAX_DAYS}거래일.
- 근거의 중심은 보유 기간 안에 가격을 움직일 수 있는 것이다: 가격·거래량 구조와 추세(이동평균,
  recentCandles, rsi14), 변동성(atr14, volatility20), 수급(국내 종목의 investorTrading),
  보유 기간 안의 재료와 일정(news, webResearch, upcomingEvents).
- 재무는 거르는 조건이지 매수 이유가 아니다. 실적이나 수주가 좋다는 것만으로는 스윙 진입 근거가 되지 않는다.
  재무 부실이나 큰 영업외 손실은 위험 요인이다. 근거가 주로 재무라면 제안하지 않는다.
- 뚜렷한 하락 추세(가격이 주요 이동평균 아래, 외국인·기관의 지속적인 순매도)에 맞서 사려면
  데이터에 반전의 구체적 근거가 있어야 한다. 없으면 제안하지 않는다.
- 목표가는 holdingDays 동안의 변동성으로 닿을 수 있는 거리여야 한다
  (atr14는 하루 변동폭, volatility20은 연율화 값).
- 종목 데이터에 있는 내용만 근거로 쓴다. fundamentals가 없으면 재무에 대한 주장을 하지 않는다.
- 영업외 손익의 원인이나 지속 여부는 데이터에 근거가 있을 때만 말한다.
- 보유 기간 안의 예정 일정(실적 발표 등)은 재료이면서 위험 요인이다. 결과에 따라 어느 쪽으로든 크게 움직일 수 있다.
- probability는 손절가(stopRule.price)보다 목표가에 먼저 도달할 확률의 솔직한 추정이다. 부풀리지 않는다.
- rationale의 각 항목은 종목 데이터의 값을 evidence로 인용한다. field는 데이터의 경로
  (예: "indicators.rsi14", "lastPrice", "recentCandles[19].close", "investorTrading[0].foreigner",
  "fundamentals.ratios.per", "news[3].title", "webResearch.researchers[0].findings[2].claim"),
  value는 그 값을 그대로 옮긴다. 직접 계산한 숫자는 넣지 않는다.
- entryPrice는 lastPrice에서 5% 이내여야 한다.
- score는 자기 시나리오에 대한 솔직한 평가다. 아래 기준을 따르고 부풀리지 않는다.
- 설명은 한국어로 쓴다.

""" + SCORE_RUBRIC + """

JSON만 출력한다:
{"scenarios": [{"horizon": "SWING", "entryPrice": 0, "targetPrice": 0,
  "probability": 0.0, "score": 0, "holdingDays": 0,
  "rationale": [{"claim": "...", "evidence": [{"field": "indicators.rsi14", "value": 0}]}],
  "invalidation": "이 시나리오가 틀렸다고 판단할 조건"}]}"""

MAX_SCENARIOS = 1  # 스윙만, 1개


def propose(llm, model: str, context: str) -> list[dict]:
    out = llm.complete_json(model, SYSTEM, context)
    scenarios = [s for s in out.get("scenarios") or [] if isinstance(s, dict)]
    # 지시를 어기고 다른 기간의 시나리오를 섞어 내도 스윙 시나리오가 잘려 나가지 않게 앞에 둔다.
    scenarios.sort(key=lambda s: s.get("horizon") not in TRADABLE_HORIZONS)
    return scenarios[:MAX_SCENARIOS]
