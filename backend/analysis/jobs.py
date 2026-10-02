"""분석 작업 실행. run_engine 루프(trading)가 매번 tick()을 부른다 (docs/DECISIONS.md 8-2, 8-4).

웹이 만든 QUEUED 작업을 한 번에 하나씩 RUNNING으로 잡아, 백그라운드 스레드에서 엔진 CLI를 하위 프로세스로 돌린다:
`python -m paper_engine analyze <종목> --by=<아이디> --equity=<초기 자금>` (--buy 없음: 엔진 계좌에 매수하지 않는다).
끝나면 실행 기록을 색인해 만들어진 AnalysisRun 번호를 result.analysisIds에 넣는다.
"""
import logging
import os
import re
import signal
import subprocess
import sys
import threading
from datetime import timedelta
from pathlib import Path

from django.db import connections
from django.utils import timezone
from paper_engine.config import ROOT

from config import engine

from . import index
from .models import AnalysisRun, Job

TIMEOUT_SEC = 20 * 60
STALE_AFTER = timedelta(minutes=25)  # 이보다 오래 RUNNING이면 프로세스가 죽은 것으로 보고 FAILED로 정리한다
OUTPUT_TAIL = 500
# 국내 6자리 영숫자 코드, 미국 티커 1~6자 (대문자·점·하이픈). 하위 프로세스 인자로 넘기기 전에도 다시 확인한다
SYMBOL = re.compile(r"[0-9A-Z]{6}|[A-Z][A-Z.\-]{0,5}")

log = logging.getLogger(__name__)
_worker: threading.Thread | None = None  # 지금 이 프로세스에서 도는 작업 스레드 (테스트가 기다릴 때 쓴다)
_proc: subprocess.Popen | None = None   # 지금 도는 분석 하위 프로세스 (shutdown이 끝낸다)
RESTARTED = "엔진이 다시 시작돼 분석이 중단되었습니다. 다시 요청하세요."
STOPPED = "엔진을 끄면서 분석이 중단되었습니다. 다시 요청하세요."


def tick() -> None:
    """대기 중인 분석 작업이 있으면 처리를 시작한다. 막지 않고(오래 걸리는 일은 스레드), 예외를 내지 않는다."""
    try:
        _fail_stale()
        job = _claim()
    except Exception:
        log.exception("분석 작업 확인 실패")
        return
    if job is None:
        return
    try:
        _start(job.id)
    except Exception as e:
        log.exception("분석 작업 #%s 시작 실패", job.id)
        _finish_safely(job.id, error=f"작업을 시작하지 못했습니다 ({type(e).__name__}).")


def recover() -> int:
    """엔진 루프(run_engine)를 시작할 때 부른다. 이전 실행이 남긴 RUNNING 작업을 FAILED로 정리하고 그 수를 돌려준다.

    작업 스레드는 엔진 프로세스와 같이 죽으므로, 새로 시작한 시점의 RUNNING은 모두 주인 없는 작업이다
    (엔진 루프는 하나만 돈다는 전제). 정리하지 않으면 25분 동안 팀 전체의 분석 큐가 멈춘다.
    """
    return _fail_running(RESTARTED)


def shutdown() -> None:
    """엔진 루프를 끝낼 때 부른다. 돌고 있는 분석 하위 프로세스(그룹)를 끝내고 작업을 FAILED로 남긴다."""
    proc = _proc
    if proc is not None and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            proc.terminate()
    _fail_running(STOPPED)


def _fail_running(error: str) -> int:
    try:
        return Job.objects.filter(status=Job.RUNNING).update(status=Job.FAILED, finished_at=timezone.now(), error=error)
    except Exception:
        log.exception("실행 중이던 분석 작업 정리 실패")
        return 0


def _fail_stale() -> None:
    cutoff = timezone.now() - STALE_AFTER
    Job.objects.filter(status=Job.RUNNING, started_at__lt=cutoff).update(
        status=Job.FAILED, finished_at=timezone.now(),
        error="제한 시간 안에 끝나지 않았습니다 (엔진이 중간에 멈춘 것으로 보입니다).")


def _claim() -> Job | None:
    """실행 중인 작업이 없으면 가장 오래된 QUEUED를 RUNNING으로 바꿔 돌려준다.

    QUEUED인 행만 바꾸는 UPDATE 한 번으로 잡으므로 두 프로세스가 같은 작업을 잡지 않는다.
    """
    if Job.objects.filter(status=Job.RUNNING).exists():
        return None
    job = Job.objects.filter(status=Job.QUEUED).order_by("created_at", "id").first()
    if job is None:
        return None
    now = timezone.now()
    if not Job.objects.filter(id=job.id, status=Job.QUEUED).update(status=Job.RUNNING, started_at=now):
        return None  # 다른 프로세스가 먼저 잡았다
    job.status, job.started_at = Job.RUNNING, now
    return job


def _start(job_id: int) -> None:
    global _worker
    _worker = threading.Thread(target=_work, args=(job_id,), name=f"analysis-job-{job_id}", daemon=True)
    _worker.start()


def _work(job_id: int) -> None:
    try:
        execute(job_id)
    except Exception as e:
        log.exception("분석 작업 #%s 처리 실패", job_id)
        _finish_safely(job_id, error=f"작업 처리 중 오류가 났습니다 ({type(e).__name__}).")
    finally:
        connections.close_all()  # 이 스레드의 DB 연결


def execute(job_id: int) -> None:
    """RUNNING으로 잡은 작업 하나를 끝까지 처리한다 (작업 스레드 안에서 부른다)."""
    job = Job.objects.select_related("user").get(id=job_id)
    if job.type != Job.ANALYZE:
        _finish(job_id, error=f"알 수 없는 작업 종류: {job.type}")
        return
    symbol, username = str(job.payload.get("symbol") or ""), job.user.username
    if not SYMBOL.fullmatch(symbol):
        _finish(job_id, error=f"종목코드 형식이 올바르지 않습니다: {symbol[:20]}")
        return
    cfg = engine.engine_config()
    before = index.run_file_names()
    args = [sys.executable, "-m", "paper_engine", "analyze", symbol, f"--by={username}",
            f"--equity={_number(cfg.paper_capital_krw)}"]
    code, output = run_subprocess(args, ROOT, TIMEOUT_SEC)
    index.refresh()  # 실패했어도 기록이 남았으면 목록에 보이게 한다
    new_files = [index.run_file_of(name) for name in index.run_file_names() - before]
    ids = list(AnalysisRun.objects.filter(run_file__in=new_files, requested_by=username)
               .order_by("id").values_list("id", flat=True))
    tail = _tail(output, cfg)
    if code is None:
        _finish(job_id, error=f"분석이 제한 시간({TIMEOUT_SEC // 60}분) 안에 끝나지 않았습니다." + _suffix(tail))
    elif code != 0:
        _finish(job_id, error=f"분석이 실패했습니다 (종료 코드 {code})." + _suffix(tail))
    elif not ids:
        _finish(job_id, error="분석은 끝났지만 실행 기록이 없습니다." + _suffix(tail))
    else:
        _finish(job_id, result={"analysisIds": ids})


def run_subprocess(args: list[str], cwd: Path, timeout: float) -> tuple[int | None, str]:
    """하위 프로세스를 돌려 (종료 코드, 출력)을 돌려준다. 시간 초과면 프로세스 그룹을 끝내고 종료 코드 None.

    테스트는 이 함수를 가짜로 바꿔 실제 분석(AI 비용)을 돌리지 않는다.
    """
    global _proc
    proc = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, start_new_session=True)
    _proc = proc
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # 리포트를 만드는 Chrome 같은 손자 프로세스까지
        except OSError:
            proc.kill()
        try:
            out, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:  # 출력 파이프를 쥔 프로세스가 남았다
            out = b""
        return None, out.decode("utf-8", "replace")
    finally:
        _proc = None


def _number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def _tail(output: str, cfg) -> str:
    """출력 끝부분 (500자 이내). 비밀 값은 가린다."""
    secrets = [cfg.llm_api_key, cfg.kiwoom_appkey, cfg.kiwoom_secretkey, cfg.toss_client_id, cfg.toss_client_secret,
               cfg.dart_api_key, cfg.data_gokr_api_key]
    for secret in secrets:
        if secret and len(secret) >= 4:
            output = output.replace(secret, "***")
    output = re.sub(r"(?i)(authorization[\"']?\s*[:=]\s*[\"']?(?:bearer\s+)?|bearer\s+)[^\s\"',]+", r"\1***", output)
    return output.strip()[-OUTPUT_TAIL:]


def _suffix(tail: str) -> str:
    return f"\n{tail}" if tail else ""


def _finish(job_id: int, result: dict | None = None, error: str | None = None) -> None:
    status = Job.FAILED if error else Job.DONE
    Job.objects.filter(id=job_id, status=Job.RUNNING).update(
        status=status, result=result, error=error, finished_at=timezone.now())


def _finish_safely(job_id: int, error: str) -> None:
    try:
        _finish(job_id, error=error)
    except Exception:
        log.exception("분석 작업 #%s 상태 기록 실패", job_id)
