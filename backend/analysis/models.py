"""AI 분석 색인과 작업 (docs/DECISIONS.md 6장, 8-4)."""
from django.conf import settings
from django.db import models
from django.utils import timezone


class AnalysisRun(models.Model):
    """엔진 실행 기록(runs/*.json)의 색인. 실행 기록의 results 항목 하나(종목 하나) = 행 하나."""
    BUY, PASS = "BUY", "PASS"
    VERDICTS = [(BUY, BUY), (PASS, PASS)]

    run_file = models.CharField(max_length=255)          # "runs/<파일 이름>.json" (엔진 trades.run_file과 같은 형식)
    symbol = models.CharField(max_length=20)
    name = models.CharField(max_length=200)
    market = models.CharField(max_length=2)              # KR | US
    currency = models.CharField(max_length=3)            # KRW | USD
    analyzed_at = models.DateTimeField()                 # 실행 기록의 startedAt
    verdict = models.CharField(max_length=4, choices=VERDICTS)
    price_at_analysis = models.FloatField(null=True, blank=True)
    best = models.JSONField(null=True, blank=True)       # 대표 시나리오 (docs/API.md Scenario 형식)
    scenario_count = models.IntegerField(default=0)
    requested_by = models.CharField(max_length=200, null=True, blank=True)  # 아이디 · "strategy:<번호>" · "cli"
    cost_usd = models.FloatField(null=True, blank=True)

    class Meta:
        db_table = "analysis_runs"
        constraints = [models.UniqueConstraint(fields=["run_file", "symbol"], name="analysis_run_file_symbol")]
        indexes = [models.Index(fields=["analyzed_at"]), models.Index(fields=["symbol", "analyzed_at"])]

    def __str__(self) -> str:
        return f"{self.name}({self.symbol}) {self.verdict} {self.run_file}"


class RunFile(models.Model):
    """색인한 실행 기록 파일. 다 읽은 파일(ok)은 다시 읽지 않고, 깨진 파일은 크기·수정 시각이 바뀌면 다시 읽어 본다."""
    name = models.CharField(max_length=255, unique=True)  # RUNS_DIR 안의 파일 이름
    size = models.BigIntegerField()
    mtime_ns = models.BigIntegerField()
    ok = models.BooleanField()
    indexed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "analysis_run_files"

    def __str__(self) -> str:
        return f"{self.name} ({'ok' if self.ok else '깨짐'})"


class Job(models.Model):
    """오래 걸리는 웹 요청 (지금은 AI 분석). 웹이 QUEUED로 만들고 run_engine 루프의 analysis.jobs.tick()이 처리한다."""
    ANALYZE = "analyze"
    QUEUED, RUNNING, DONE, FAILED = "QUEUED", "RUNNING", "DONE", "FAILED"
    TYPES = [(ANALYZE, ANALYZE)]
    STATUSES = [(s, s) for s in (QUEUED, RUNNING, DONE, FAILED)]

    type = models.CharField(max_length=20, choices=TYPES, default=ANALYZE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="analysis_jobs")
    payload = models.JSONField(default=dict)             # analyze: {"symbol": "005930"}
    status = models.CharField(max_length=10, choices=STATUSES, default=QUEUED)
    result = models.JSONField(null=True, blank=True)     # analyze가 DONE이면 {"analysisIds": [...]}
    error = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "jobs"
        indexes = [models.Index(fields=["status", "created_at"]), models.Index(fields=["user", "created_at"])]

    def __str__(self) -> str:
        return f"#{self.id} {self.type} {self.payload} {self.status}"
