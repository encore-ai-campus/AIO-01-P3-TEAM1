"""AI 리포트 Worker 등록소."""

from .base import Worker
from .fundamental import WORKER as FUNDAMENTAL_WORKER
from .market import WORKER as MARKET_WORKER
from .news import WORKER as NEWS_WORKER
from .report import WORKER as REPORT_WORKER
from .review import WORKER as REVIEW_WORKER
from .risk import WORKER as RISK_WORKER

WORKERS: dict[str, Worker] = {
    worker.id: worker
    for worker in (
        MARKET_WORKER, FUNDAMENTAL_WORKER, NEWS_WORKER,
        REPORT_WORKER, REVIEW_WORKER, RISK_WORKER,
    )
}
