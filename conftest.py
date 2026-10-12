"""테스트는 실제 증권사에 조회를 보내지 않고 실제 Discord·openclaw로 알리지 않는다.
개발자 .env의 증권사 설정과 키, 알림 설정을 모든 테스트에서 비운다.

엔진 설정은 환경 변수가 .env보다 우선이라(config._env), 빈 값으로 덮으면 .env의 BROKER와 실제 키를 읽지 않는다.
키가 필요한 테스트는 자기 fixture에서 가짜 값을 넣는다.
"""
import pytest

BROKER_ENV = ("BROKER", "CLIENT_ID", "CLIENT_SECRET", "KIWOOM_APPKEY", "KIWOOM_SECRETKEY")
NOTIFY_ENV = ("DISCORD_WEBHOOK_URL", "OPENCLAW_TARGET")


@pytest.fixture(autouse=True)
def no_real_broker_keys(monkeypatch):
    for key in BROKER_ENV + NOTIFY_ENV:
        monkeypatch.setenv(key, "")
    # 매일 자동 추천(선별 = 증권사 조회 100번 이상)은 테스트가 직접 켤 때만. autotrade.conf는 빈 값이면 .env를 읽으므로 off로 덮는다
    monkeypatch.setenv("AUTO_RECOMMEND", "off")
    # 장기투자 예약 작업(증권사·DART·뉴스·LLM 조회)도 테스트가 직접 켤 때만. 빈 값이 아니라 off (빈 값은 .env 값으로 넘어간다)
    monkeypatch.setenv("LONGTERM_JOBS", "off")
    # 매일 자동 리포트(규칙 선별 → 선정 팀 → 자동 리포트)도 테스트가 직접 켤 때만 (reports.autoreport.conf도 빈 값이면 .env를 읽는다)
    monkeypatch.setenv("AUTO_REPORT", "off")
    # 리포트 하루 한도(reports.limits.quota)는 개발자 .env 값과 상관없이 3으로 고정한다 (기본값은 무제한. 다른 값이 필요한 테스트는 자기가 덮는다)
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "3")
