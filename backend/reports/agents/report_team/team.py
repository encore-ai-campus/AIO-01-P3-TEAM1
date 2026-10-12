"""종목 리포트 팀(stock_report) Worker 등록: 조사 3개(시세·재무·뉴스) → 작성 → 검토 → (Handoff) 리스크 점검.

id와 출력 계약은 worker_definitions.yaml과 같아야 한다 (tests/agents/test_agents_report.py가 확인한다).
"""
from ..base import Worker
from .fundamental import FundamentalAgent
from .market import MarketAgent
from .news import NewsAgent
from .report import ReportAgent
from .review import ReviewAgent
from .risk import RiskAgent

WORKERS: dict[str, Worker] = {worker.id: worker for worker in (
    MarketAgent(), FundamentalAgent(), NewsAgent(), ReportAgent(), ReviewAgent(), RiskAgent())}
