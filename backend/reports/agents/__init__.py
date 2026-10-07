"""AI 리포트 Worker 등록소."""

from .base import Worker

WORKERS: dict[str, Worker] = {}
