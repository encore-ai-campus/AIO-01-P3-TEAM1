"""장기투자 알림 문장 (docs/API.md "장기투자" 규칙). 웹만 보낸다 (Discord로 보내지 않는다).

문장은 사실만 적는다. 권유·인과 단정·예측 표현은 쓰지 않는다 (paper_engine.wording.forbidden_phrases — 테스트로 확인).
"""
from paper_engine.judge import fundamentals_check as fc
from paper_engine.longterm import daily_move as dm

DAILY_MOVE_CAPTION = dm.CAPTION
FUNDAMENTALS_CAPTION = fc.CAPTION
DAILY_MOVE_LINES = 3  # 알림 본문의 종목 줄 수 상한


def move_line(name: str, change_rate: float, excess: float | None) -> str:
    """"삼성전자 +1.2% · 시장 대비 +0.8%p" (시장 등락이 없으면 "시장 등락 자료 없음")."""
    market = f"시장 대비 {dm.signed_pp(excess)}" if excess is not None else "시장 등락 자료 없음"
    return f"{name} {dm.signed_pct(change_rate)} · {market}"


def daily_move_notice(notes: list) -> tuple[str, str]:
    """오늘의 내 종목 뉴스 묶음 알림 (제목, 본문). notes는 DailyMoveNote 목록 (한 사용자의 그날 보유 종목).

    본문은 많이 움직인 종목부터 최대 3줄(등락률 · 시장 대비) + 나머지 수 + 고정 문구.
    """
    ordered = sorted(notes, key=lambda n: (-abs(n.excess_change_rate if n.excess_change_rate is not None
                                               else n.change_rate), n.name))
    lines = [move_line(n.name, n.change_rate, n.excess_change_rate) for n in ordered[:DAILY_MOVE_LINES]]
    if len(ordered) > DAILY_MOVE_LINES:
        lines.append(f"외 {len(ordered) - DAILY_MOVE_LINES}종목")
    lines.append(DAILY_MOVE_CAPTION)
    return f"오늘의 내 종목 뉴스 · {len(notes)}종목", "\n".join(lines)


def thesis_notice(name: str, rows: list[dict], new_bad: list[str], overall: str,
                  previous_overall: str | None) -> tuple[str, str]:
    """펀더멘털 점검 알림 (제목, 본문). 새로 bad가 된 지표가 있으면 그 지표, 없으면(종합만 나빠짐) warn·bad 지표를 적는다."""
    title = (f"{name} 펀더멘털 점검: 확인할 항목이 생겼어요" if new_bad
             else f"{name} 펀더멘털 점검: 종합 판정이 바뀌었어요")
    shown = [r for r in rows if r["key"] in new_bad] or [r for r in rows if r["status"] in (fc.BAD, fc.WARN)]
    lines = []
    for r in shown:
        line = f"{r['label']} {fc.value_text(r['value'], r['unit'])}"
        lines.append(f"{line} ({r['note']})" if r.get("note") else line)
    if previous_overall:
        lines.append(f"종합: {fc.OVERALL_LABELS.get(previous_overall, previous_overall)} → "
                     f"{fc.OVERALL_LABELS.get(overall, overall)}")
    else:
        lines.append(f"종합: {fc.OVERALL_LABELS.get(overall, overall)}")
    lines.append(FUNDAMENTALS_CAPTION)
    return title, "\n".join(lines)
