"""AI 리포트 Worker 등록소. Orchestrator는 WORKERS(id → 인스턴스)만 본다.

종목 리포트 팀(stock_report)의 Worker는 report_team/team.py, 매매 종목 선정 팀(stock_selection)의 Worker는 selection_team/team.py가 등록한다.
"""
from .base import Worker
from .report_team.team import WORKERS as REPORT_WORKERS
from .selection_team.team import WORKERS as SELECTION_WORKERS

WORKERS: dict[str, Worker] = {**REPORT_WORKERS, **SELECTION_WORKERS}
