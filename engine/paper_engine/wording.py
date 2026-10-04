"""사용자에게 보이는 문장에 쓰지 않는 표현 (docs/API.md 공통 규칙 "금지 표현", docs/DECISIONS.md 14-7).

목록의 원본은 이 모듈 하나다. 알림 문장(B6), 오늘의 내 종목 뉴스(LLM 설명·템플릿), 펀더멘털 점검 알림이 모두
forbidden_phrases로 검사한다. 화면 고정 문구는 코드 검사 대상이 아니라 이 목록을 보고 쓴다.
목록을 더하면 docs/API.md의 표도 같이 고친다.

  PERSUASION  권유 (매수·매도 모두). 우리가 만드는 모든 사용자 문장 (causal=False)
  CAUSAL      인과 단정. 시장 움직임을 설명하는 문장 (causal=True)
  PREDICTION  예측. causal=True일 때 같이 본다

비교는 공백을 모두 지운 뒤 부분 문자열로 한다 ("사 볼 만해요"와 "사볼만해요"를 같게 본다).
"""

PERSUASION = (
    "사세요", "사 볼 만해요", "사 볼 만", "매수하세요", "매수 기회", "지금 사면", "담으세요", "좋아요",
    "파세요", "팔아야", "매도하세요", "매도 기회", "지금 팔면", "정리하세요", "비중을 줄이세요", "비중을 늘리세요",
    "손절하세요",
)
CAUSAL = ("때문에", "덕분에", "원인은", "탓에", "영향으로")
PREDICTION = ("오를 것", "내릴 것", "오를 거", "내릴 거", "상승할 것", "하락할 것", "반등할 것")


def _squash(text: str) -> str:
    return "".join(text.split())


def forbidden_phrases(text: str, *, causal: bool = False) -> list[str]:
    """text에 들어 있는 금지 표현 (목록에 적힌 모양 그대로, 목록 순서). 없으면 [].

    causal=False는 권유(PERSUASION)만, causal=True는 권유 + 인과 단정(CAUSAL) + 예측(PREDICTION)을 본다.
    """
    squashed = _squash(text)
    phrases = PERSUASION + (CAUSAL + PREDICTION if causal else ())
    return [p for p in phrases if _squash(p) in squashed]
