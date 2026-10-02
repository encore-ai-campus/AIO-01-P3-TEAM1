"""테스트는 실제 증권사에 조회를 보내지 않는다. 개발자 .env의 증권사 설정과 키를 모든 테스트에서 비운다.

엔진 설정은 환경 변수가 .env보다 우선이라(config._env), 빈 값으로 덮으면 .env의 BROKER와 실제 키를 읽지 않는다.
키가 필요한 테스트는 자기 fixture에서 가짜 값을 넣는다.
"""
import pytest

BROKER_ENV = ("BROKER", "CLIENT_ID", "CLIENT_SECRET", "KIWOOM_APPKEY", "KIWOOM_SECRETKEY")


@pytest.fixture(autouse=True)
def no_real_broker_keys(monkeypatch):
    for key in BROKER_ENV:
        monkeypatch.setenv(key, "")
