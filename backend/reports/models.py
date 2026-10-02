"""AI 리포트의 Shared State와 구조화된 Trace (docs/DECISIONS.md 9-2, docs/API.md "AI 리포트").

두 표는 Orchestrator가 `reports.state`의 함수로만 바꾼다. 웹 API는 읽기와 신청(requested 행 만들기)만 한다.
"""
from django.conf import settings
from django.db import models
from django.utils import timezone


class Report(models.Model):
    """종목 리포트 신청 하나 = Shared State 하나."""
    REQUESTED, RUNNING, COMPLETED, FAILED = "requested", "running", "completed", "failed"
    STATUSES = [(s, s) for s in (REQUESTED, RUNNING, COMPLETED, FAILED)]
    ACTIVE, FINISHED = (REQUESTED, RUNNING), (COMPLETED, FAILED)
    MARKETS = [("KR", "KR"), ("US", "US")]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="reports")
    symbol = models.CharField(max_length=20)
    name = models.CharField(max_length=200)
    market = models.CharField(max_length=2, choices=MARKETS)
    status = models.CharField(max_length=10, choices=STATUSES, default=REQUESTED)
    current_step = models.CharField(max_length=64, null=True, blank=True)  # 실행 계획의 step id
    results = models.JSONField(default=dict, blank=True)                   # Worker id → 출력 계약을 통과한 결과
    errors = models.JSONField(default=dict, blank=True)                    # Worker id → 오류 메시지
    completed_agents = models.JSONField(default=list, blank=True)
    failed_agents = models.JSONField(default=list, blank=True)
    content = models.TextField(null=True, blank=True)                      # 리포트 본문 (Markdown)
    created_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "reports"
        indexes = [models.Index(fields=["created_at"]), models.Index(fields=["symbol", "created_at"]),
                   models.Index(fields=["status", "created_at"])]

    def __str__(self) -> str:
        return f"#{self.id} {self.name}({self.symbol}) {self.status}"


class TraceEvent(models.Model):
    """구조화된 Trace의 사건 하나. step은 리포트별 1부터 빈틈없이 늘어난다."""
    STARTED, COMPLETED, FAILED, BLOCKED, SKIPPED = "started", "completed", "failed", "blocked", "skipped"
    STATUSES = [(s, s) for s in (STARTED, COMPLETED, FAILED, BLOCKED, SKIPPED)]

    report = models.ForeignKey(Report, on_delete=models.CASCADE, related_name="trace_events")
    step = models.PositiveIntegerField()
    actor = models.CharField(max_length=64)        # Worker id · "join_guard" · "handoff_guard" · "orchestrator"
    action = models.CharField(max_length=64)       # agent_started · agent_completed · join_blocked · ...
    status = models.CharField(max_length=10, choices=STATUSES)
    provider = models.CharField(max_length=64, null=True, blank=True)
    model = models.CharField(max_length=128, null=True, blank=True)
    latency_ms = models.IntegerField(null=True, blank=True)
    details = models.JSONField(default=dict, blank=True)
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "report_trace_events"
        constraints = [models.UniqueConstraint(fields=["report", "step"], name="report_trace_step")]

    def __str__(self) -> str:
        return f"#{self.report_id}:{self.step} {self.actor} {self.action} {self.status}"
