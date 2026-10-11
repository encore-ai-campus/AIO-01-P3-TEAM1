"""리포트 끝 알림의 사람이 읽는 문장 (컨셉 계획 B7 — docs/API.md "리포트 끝 알림", docs/DECISIONS.md 14-5). Claude 파일.

- 실패 사유 코드(Trace `workflow_failed.details.reason`, docs/tasks/00-공통.md 9절)마다 쉬운 문장 하나.
  join_blocked·review_failed·timeout·engine_restarted·exception에 Orchestrator가 내는 agent_failed(Join이 없는 단계의
  필수 Worker가 끝내 실패)·no_llm(AI 연결 설정 없음), 실행기가 내는 expired(24시간 넘게 기다린 신청)를 더한 8개다. 이 밖의 코드는 FAILURE_FALLBACK.
  화면의 같은 표는 frontend/src/lib/plainText.ts의 REPORT_FAILURE_TEXT다 (문장을 바꾸면 둘 다 고친다).
- 쉬운 문장(주린이모드 켬·Discord)과 전문가 문장(끔)을 한 벌(notifications.service.Notice)로 만든다.
- 권유 표현을 쓰지 않는다 (paper_engine.wording.forbidden_phrases — reports/tests/output/test_alerts.py가 검사한다).
"""
from notifications.service import Notice

# 리포트로 추천이 생기면 추천 알림(recommendation) 본문의 첫 줄이 이것이다 — 그 알림이 완성 알림을 대신한다 (autotrade/text.py)
COMPLETED_LINE = "리포트가 완성됐어요"

FAILURE_TEXT = {
    "join_blocked": "자료를 모으는 AI가 응답하지 않아 리포트를 쓸 수 없었어요",
    "review_failed": "검토 AI가 근거와 맞지 않는 주장을 찾아 완성하지 않았어요",
    "timeout": "시간이 너무 오래 걸려 멈췄어요",
    "engine_restarted": "서버가 다시 시작돼 중단됐어요",
    "exception": "예상하지 못한 오류로 멈췄어요",
    "agent_failed": "필요한 AI가 끝내 응답하지 않아 멈췄어요",
    "no_llm": "AI 연결 설정이 없어 리포트를 쓰지 못했어요",
    "expired": "오래 기다린 신청이라 실행하지 않았어요",
}
FAILURE_FALLBACK = "리포트를 만들지 못했어요. 다시 만들 수 있어요"

# 선정 팀이 실패해 규칙으로 고른 날의 사유 (ScreeningResult.fallbackReason). 리포트를 말하는 문장만 선정에 맞게 바꾼다.
# 화면의 같은 표는 frontend/src/lib/plainText.ts의 SELECTION_FALLBACK_TEXT다 (문장을 바꾸면 둘 다 고친다).
SELECTION_FALLBACK_TEXT = {
    **FAILURE_TEXT,
    "join_blocked": "후보를 조사하는 AI가 응답하지 않아 AI가 고르지 못했어요",
    "review_failed": "검토 AI가 근거와 맞지 않는 선정을 찾아 AI 선정안을 쓰지 않았어요",
    "no_llm": "AI 연결 설정이 없어 AI가 고르지 못했어요",
    "expired": "선정 실행이 오래 기다리다 실행되지 않아 AI가 고르지 못했어요",
    "no_candidates": "규칙 선별을 통과한 종목이 없었어요",
}

# AI 의견 (ReportDraft.verdict). 쉬운 이름은 화면의 배지(OPINION_TEXT)와 같다
OPINION_LABEL = {"buy": "AI 의견: 긍정적", "hold": "AI 의견: 지켜보기", "avoid": "AI 의견: 부정적"}
EXPERT_VERDICT = {"buy": "매수", "hold": "보유", "avoid": "회피"}
NO_PLAN = {
    "buy": "가격 조건이 맞지 않아 이번 리포트로는 매매 계획을 만들지 않았어요",
    "hold": "지켜보기 의견이라 매매 계획은 없어요",
    "avoid": "부정적 의견이라 매매 계획은 없어요",
}


def selection_fallback_sentence(reason) -> str | None:
    """선정 Fallback 사유 코드 → 쉬운 문장. 모르는 코드면 None (리포트 실패 문장을 대신 쓰지 않는다)."""
    return SELECTION_FALLBACK_TEXT.get(reason) if isinstance(reason, str) else None


def failure_sentence(reason) -> str:
    """실패 사유 코드 → 쉬운 문장. 없거나 모르는 코드면 FAILURE_FALLBACK."""
    return FAILURE_TEXT.get(reason, FAILURE_FALLBACK) if isinstance(reason, str) else FAILURE_FALLBACK


def completed(name: str, symbol: str, verdict: str | None) -> Notice:
    """report_completed — 추천이 없는 완성 리포트 (지켜보기·부정적·가격 조건이 맞지 않음)."""
    verdict = verdict if verdict in OPINION_LABEL else None
    easy = f"{OPINION_LABEL[verdict]}. {NO_PLAN[verdict]}." if verdict else "이번 리포트로는 매매 계획을 만들지 않았어요."
    expert = f"판단 {EXPERT_VERDICT[verdict]}" if verdict else "판단 없음"
    return Notice(title=f"{name} 리포트가 완성됐어요", body=f"{easy} 근거와 위험은 리포트에서 볼 수 있어요.",
                  expert_title=f"{name} ({symbol}) 리포트 완료", expert_body=f"{expert} · 추천 없음")


def failed(name: str, symbol: str, reason) -> Notice:
    """report_failed — 본문은 실패 사유 코드의 쉬운 문장."""
    sentence = failure_sentence(reason)
    body = f"{sentence}." if sentence == FAILURE_FALLBACK else f"{sentence}. 다시 만들 수 있어요."
    code = reason if isinstance(reason, str) and reason else "없음"
    return Notice(title=f"{name} 리포트를 만들지 못했어요", body=body,
                  expert_title=f"{name} ({symbol}) 리포트 실패", expert_body=f"실패 사유 코드: {code}")
