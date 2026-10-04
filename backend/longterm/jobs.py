"""장기투자 예약 작업 — run_engine의 "장기투자" 단계 (docs/API.md "장기투자"의 규칙, docs/DECISIONS.md 14-3).

- 오늘의 내 종목 뉴스 (daily.tick): 국내 거래일, KR 기준일이 오늘이 된 뒤 DAILY_MOVE_AT(기본 16:30 KST) 이후 하루 한 번.
- 펀더멘털 점검 (theses.tick): THESIS_CHECK_AT(기본 18:00 KST) 이후 그날 정기공시 종목(거래일) + 매주 월요일 전체.
- LONGTERM_JOBS(기본 on)가 off면 아무것도 하지 않는다 (외부를 부르므로 루트 conftest.py가 테스트에서 off로 끈다).
한 작업의 오류는 콘솔에 한 줄 남기고 다른 작업은 계속한다. 둘 다 같은 날 다시 불려도 한 번만 만든다 (DB 기록으로 판단).
"""
from config import engine

from . import conf, daily, theses


def tick(now, log) -> None:
    """엔진 루프 한 바퀴의 장기투자 작업. now는 시간대가 있는 지금 시각, log는 콘솔에 한 줄 남기는 함수."""
    if not conf.jobs_enabled() or engine.broker_client() is None:
        return
    for label, run in (("오늘의 내 종목 뉴스", daily.tick), ("펀더멘털 점검", theses.tick)):
        try:
            run(now, log)
        except Exception as e:  # 한 작업의 오류가 다른 작업을 막지 않게
            log(f"장기투자 {label} 실패: {type(e).__name__}: {e}")
