import sys
from datetime import timedelta

import pytest
from django.utils import timezone

from analysis import jobs
from analysis.models import AnalysisRun, Job

from .conftest import SECRET, candidate, entry, run_log, write_run

pytestmark = pytest.mark.django_db


@pytest.fixture
def inline(monkeypatch):
    """작업 스레드 대신 같은 스레드에서 바로 처리한다 (테스트 DB 트랜잭션 안에서 보이게)."""
    monkeypatch.setattr(jobs, "_start", jobs.execute)


class FakeRunner:
    """가짜 엔진 실행기. 실제 분석(AI 비용)을 돌리지 않는다. behave(args)가 (종료 코드, 출력)을 돌려준다."""

    def __init__(self):
        self.calls = []
        self.behave = lambda args: (0, "")

    def __call__(self, args, cwd, timeout):
        self.calls.append((args, cwd, timeout))
        return self.behave(args)


@pytest.fixture
def runner(monkeypatch, runs):
    fake = FakeRunner()
    monkeypatch.setattr(jobs, "run_subprocess", fake)
    return fake


def queue(user, symbol="005930", **fields):
    return Job.objects.create(user=user, payload={"symbol": symbol}, **fields)


def engine_writes(runs, name, *entries, by="alice", code=0, output="소요 90초 · AI 비용 $0.310"):
    def behave(args):
        write_run(runs, name, run_log(*entries, requested_by=by))
        return code, output
    return behave


def test_job_lifecycle_done(user, ai, runs, runner, inline):
    job = queue(user)
    write_run(runs, "old.json", run_log(entry()))  # 이전 기록은 결과에 넣지 않는다
    runner.behave = engine_writes(runs, "20261002-090000.json", entry(candidates=[candidate()]))
    jobs.tick()
    job.refresh_from_db()
    new = AnalysisRun.objects.get(run_file="runs/20261002-090000.json")
    assert (job.status, job.result, job.error) == ("DONE", {"analysisIds": [new.id]}, None)
    assert job.started_at and job.finished_at and job.started_at <= job.finished_at
    assert AnalysisRun.objects.count() == 2
    args, cwd, timeout = runner.calls[0]
    assert args == [sys.executable, "-m", "paper_engine", "analyze", "005930", "--by=alice", "--equity=10000000"]
    assert "--buy" not in args and cwd == jobs.ROOT and timeout == 20 * 60


def test_job_waits_while_another_runs_and_takes_oldest_first(user, ai, runs, runner, inline):
    running = queue(user, "000660", status=Job.RUNNING, started_at=timezone.now())
    first = queue(user, "005930", created_at=timezone.now() - timedelta(minutes=1))
    second = queue(user, "035420")
    jobs.tick()
    assert runner.calls == [] and Job.objects.get(id=first.id).status == "QUEUED"  # 한 번에 하나만
    Job.objects.filter(id=running.id).update(status=Job.DONE)
    runner.behave = engine_writes(runs, "a.json", entry())
    jobs.tick()
    assert [args[4] for args, _, _ in runner.calls] == ["005930"]
    assert Job.objects.get(id=first.id).status == "DONE" and Job.objects.get(id=second.id).status == "QUEUED"


@pytest.mark.parametrize("code, output, expected", [
    (1, f"Traceback ...\nkey={SECRET} Authorization: Bearer abc.def\n모델 응답 에러로 1개 종목의 분석을 중단했습니다.",
     "분석이 실패했습니다 (종료 코드 1)."),
    (None, "웹 조사 중...", "분석이 제한 시간(20분) 안에 끝나지 않았습니다."),
    (0, "", "분석은 끝났지만 실행 기록이 없습니다."),
])
def test_job_failures(user, ai, runs, runner, inline, code, output, expected):
    job = queue(user)
    runner.behave = lambda args: (code, "가" * 2000 + output)
    jobs.tick()
    job.refresh_from_db()
    assert job.status == "FAILED" and job.result is None and job.finished_at
    assert job.error.startswith(expected)
    tail = job.error[len(expected):].strip()
    assert len(tail) <= 500 and tail.endswith(output.splitlines()[-1] if output else "가")
    assert SECRET not in job.error and "abc.def" not in job.error


def test_bad_symbol_in_payload_never_reaches_engine(user, ai, runs, runner, inline):
    job = queue(user, "--buy")  # 관리자 화면에서 고친 작업이라도
    jobs.tick()
    job.refresh_from_db()
    assert job.status == "FAILED" and "종목코드" in job.error and runner.calls == []


def test_failed_run_with_record_is_still_indexed(user, ai, runs, runner, inline):
    job = queue(user)
    runner.behave = engine_writes(runs, "a.json", entry(), code=1, output="모델 응답 에러")
    jobs.tick()
    assert Job.objects.get(id=job.id).status == "FAILED"
    assert AnalysisRun.objects.filter(run_file="runs/a.json").exists()  # 목록에는 보인다


def test_records_by_others_are_not_job_results(user, ai, runs, runner, inline):
    job = queue(user)
    runner.behave = engine_writes(runs, "s3.json", entry(), by="strategy:3")  # 같은 시각에 전략이 남긴 기록
    jobs.tick()
    assert Job.objects.get(id=job.id).error.startswith("분석은 끝났지만 실행 기록이 없습니다.")


def test_stale_running_jobs_are_failed(user, ai, runs, runner, inline):
    stale = queue(user, "000660", status=Job.RUNNING, started_at=timezone.now() - timedelta(minutes=26))
    fresh = queue(user, "035420", status=Job.RUNNING, started_at=timezone.now() - timedelta(minutes=10))
    waiting = queue(user)
    jobs.tick()
    stale.refresh_from_db()
    assert stale.status == "FAILED" and "제한 시간" in stale.error and stale.finished_at
    assert Job.objects.get(id=fresh.id).status == "RUNNING" and runner.calls == []
    Job.objects.filter(id=fresh.id).update(started_at=timezone.now() - timedelta(minutes=30))
    runner.behave = engine_writes(runs, "a.json", entry())
    jobs.tick()  # 정리한 뒤 다음 작업을 잡는다
    assert Job.objects.get(id=waiting.id).status == "DONE"


def test_tick_never_raises(user, ai, runs, monkeypatch, caplog):
    def boom(*args):
        raise RuntimeError("DB 끊김")
    claim = jobs._claim
    monkeypatch.setattr(jobs, "_claim", boom)
    jobs.tick()  # 예외를 내지 않는다
    assert "분석 작업 확인 실패" in caplog.text

    monkeypatch.setattr(jobs, "_claim", claim)
    monkeypatch.setattr(jobs, "_start", boom)  # 스레드를 못 띄우면 작업을 실패로 남긴다
    job = queue(user)
    jobs.tick()
    job.refresh_from_db()
    assert job.status == "FAILED" and "작업을 시작하지 못했습니다" in job.error


def test_worker_errors_mark_job_failed(user, ai, runs, runner, monkeypatch):
    def boom(job_id):
        raise ValueError("이상한 기록")
    monkeypatch.setattr(jobs, "execute", boom)
    monkeypatch.setattr(jobs.connections, "close_all", lambda: None)  # 테스트 DB 연결은 닫지 않는다
    monkeypatch.setattr(jobs, "_start", jobs._work)
    job = queue(user)
    jobs.tick()
    job.refresh_from_db()
    assert job.status == "FAILED" and "작업 처리 중 오류" in job.error


@pytest.mark.django_db(transaction=True)
def test_tick_runs_job_in_background_thread(user, ai, runs, runner):
    job = queue(user)
    runner.behave = engine_writes(runs, "a.json", entry(candidates=[candidate()]))
    jobs.tick()
    jobs._worker.join(timeout=10)
    assert not jobs._worker.is_alive()
    job.refresh_from_db()
    assert job.status == "DONE" and job.result == {"analysisIds": [AnalysisRun.objects.get().id]}


def test_run_subprocess_returns_code_and_output(tmp_path):
    code, output = jobs.run_subprocess([sys.executable, "-c", "import sys; print('hi'); sys.exit(3)"], tmp_path, 30)
    assert (code, output.strip()) == (3, "hi")
    code, output = jobs.run_subprocess(
        [sys.executable, "-c", "import time; print('start', flush=True); time.sleep(30)"], tmp_path, 1)
    assert code is None and "start" in output
