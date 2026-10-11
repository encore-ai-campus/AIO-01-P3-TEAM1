"""run_engine의 추천·자동매매·알림 단계: 순서, 한 단계의 오류, 증권사 키가 없을 때 (단계 함수는 전부 가짜)."""
from io import StringIO

import pytest
from analysis import jobs
from autotrade.recommend import auto, sources
from autotrade.plans import executor
from django.core.management import call_command
from longterm import jobs as longterm_jobs
from notifications import dispatch
from reports.output import alerts
from reports.orchestration import runner
from reports.autoreport import auto as reports_auto

from trading import service

pytestmark = pytest.mark.django_db

ALL = ["체결 확인", "예약 실행", "일별 자산 기록", "분석 작업", "리포트 실행", "자동 리포트", "추천 수집", "리포트 알림", "자동 추천",
       "자동매매", "장기투자", "알림 발송"]
WITHOUT_BROKER = ["분석 작업", "리포트 실행", "자동 리포트", "추천 수집", "리포트 알림", "알림 발송"]


@pytest.fixture
def steps(monkeypatch):
    """단계 함수들을 부른 순서대로 기록하는 가짜로 바꾼다. fail에 이름을 넣으면 그 단계가 예외를 낸다."""
    called: list[str] = []
    fail: set[str] = set()

    def fake(label):
        def run(*args, **kwargs):
            called.append(label)
            if label in fail:
                raise RuntimeError(f"{label} 오류")
        return run

    for target, name, label in ((service, "sync_accounts", "체결 확인"), (service, "run_reservations", "예약 실행"),
                                (service, "record_equity", "일별 자산 기록"), (jobs, "tick", "분석 작업"),
                                (runner, "tick", "리포트 실행"), (reports_auto, "tick", "자동 리포트"),
                                (sources, "collect", "추천 수집"), (alerts, "sweep_finished", "리포트 알림"),
                                (auto, "tick", "자동 추천"), (executor, "tick", "자동매매"),
                                (longterm_jobs, "tick", "장기투자"), (dispatch, "tick", "알림 발송")):
        monkeypatch.setattr(target, name, fake(label))
    return called, fail


def run_once() -> tuple[str, str]:
    out, err = StringIO(), StringIO()
    call_command("run_engine", "--once", stdout=out, stderr=err)
    return out.getvalue(), err.getvalue()


def test_steps_run_in_order(steps, fake):
    called, _ = steps
    _, err = run_once()
    assert called == ALL and err == ""


def test_step_error_does_not_stop_next_steps(steps, fake):
    called, fail = steps
    fail.update({"추천 수집", "자동매매"})
    _, err = run_once()
    assert called == ALL
    assert "추천 수집 실패: RuntimeError: 추천 수집 오류" in err
    assert "자동매매 실패: RuntimeError: 자동매매 오류" in err


def test_without_broker_skips_auto_recommend_and_autotrade(steps):
    called, _ = steps
    out, err = run_once()
    assert called == WITHOUT_BROKER and err == ""
    assert "자동 추천·자동매매를 건너뛰고" in out


def test_real_steps_run_quietly_without_work(fake):
    """가짜 없이: 추천·계획·알림이 없으면 새 단계들이 아무 말 없이 지나간다 (AUTO_RECOMMEND는 루트 conftest가 off로)."""
    out, err = run_once()
    assert err == "" and "[자동 추천]" not in out
