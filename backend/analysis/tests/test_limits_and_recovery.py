"""한도가 실패한 실행도 세는지, 엔진 재시작·종료 때 실행 중 작업을 정리하는지, 요청자를 닉네임으로 내는지."""
import sys
import threading
import time

import pytest
from accounts.models import profile_of
from django.utils import timezone

from analysis import jobs
from analysis.models import Job

from .conftest import candidate, entry, run_log, write_run

pytestmark = pytest.mark.django_db


def make_job(user, symbol="005930", **fields):
    return Job.objects.create(user=user, payload={"symbol": symbol}, **fields)


def test_quota_counts_failed_jobs_that_started(api, user, ai, limits):
    """실패는 대부분 엔진이 AI 비용을 쓴 뒤에 난다. 엔진을 시작한 작업은 실패해도 한도에 센다."""
    now = timezone.now()
    make_job(user, status=Job.FAILED, started_at=now, finished_at=now)   # 엔진이 돌다 실패: 센다
    make_job(user, "000660", status=Job.FAILED)                          # 엔진을 띄우기 전에 실패: 세지 않는다
    body = api.get("/api/analyses/quota").json()
    assert (body["usedToday"], body["remaining"]) == (1, 4)


def test_failed_runs_use_up_the_limit(api, user, ai, limits, monkeypatch):
    monkeypatch.setenv("AI_DAILY_ANALYSES_PER_USER", "2")
    now = timezone.now()
    for symbol in ("005930", "000660"):
        make_job(user, symbol, status=Job.FAILED, started_at=now, finished_at=now)
    response = api.post("/api/analyses", {"symbol": "035420"}, content_type="application/json")
    assert response.status_code == 429 and "한도" in response.json()["detail"]


def test_recover_fails_running_jobs_left_by_previous_engine(user):
    running = make_job(user, status=Job.RUNNING, started_at=timezone.now())
    queued = make_job(user, "000660")
    assert jobs.recover() == 1
    running.refresh_from_db()
    queued.refresh_from_db()
    assert (running.status, running.error) == (Job.FAILED, jobs.RESTARTED) and running.finished_at
    assert queued.status == Job.QUEUED
    assert jobs._claim().id == queued.id  # 큐가 바로 다시 돈다 (정리하지 않으면 25분 동안 멈춘다)


def test_shutdown_stops_running_subprocess_and_fails_job(user, tmp_path):
    job = make_job(user, status=Job.RUNNING, started_at=timezone.now())
    result = {}
    thread = threading.Thread(target=lambda: result.update(
        out=jobs.run_subprocess([sys.executable, "-c", "import time; time.sleep(60)"], tmp_path, 60)))
    thread.start()
    deadline = time.time() + 10
    while jobs._proc is None and time.time() < deadline:
        time.sleep(0.02)
    assert jobs._proc is not None
    jobs.shutdown()
    thread.join(10)
    assert not thread.is_alive() and result["out"][0] not in (0, None)  # 신호로 끝났다
    assert jobs._proc is None
    job.refresh_from_db()
    assert (job.status, job.error) == (Job.FAILED, jobs.STOPPED)


def test_requested_by_is_nickname_not_login_id(api, user, runs):
    """로그인 아이디는 다른 팀원에게 내지 않는다. 팀원이 요청한 분석은 닉네임으로, cli·전략은 그대로 보인다."""
    profile = profile_of(user)
    profile.nickname = "앨리스"
    profile.save()
    write_run(runs, "20261002-090000.json", run_log(entry(candidates=[candidate()]), requested_by="alice"))
    write_run(runs, "20261002-100000.json",
              run_log(entry(symbol="000660", name="SK하이닉스"), requested_by="cli", started="2026-10-02T10:00:00+09:00"))
    results = {r["symbol"]: r for r in api.get("/api/analyses").json()["results"]}
    assert results["005930"]["requestedBy"] == "앨리스" and results["000660"]["requestedBy"] == "cli"
    detail = api.get(f"/api/analyses/{results['005930']['id']}").json()
    assert detail["requestedBy"] == "앨리스"
