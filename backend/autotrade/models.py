"""AI 추천 · 매매 계획 · 계획 사건 (docs/DECISIONS.md 12-2, docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림").

추천은 팀 전체가 같이 보는 제안 하나, 계획은 팀원 한 명이 자기 모의 계좌에 활성화한 것이다 (가격·기간을 복사해 둔다).
PostgreSQL 전용 기능은 쓰지 않는다 (로컬 SQLite, 운영 PostgreSQL).
"""
from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

class Recommendation(models.Model):
    """AI(또는 시연 규칙)의 매수 제안 하나. 출처(리포트·분석)마다 하나만 만든다."""
    REPORT, ANALYSIS, DEMO = "report", "analysis", "demo"
    SOURCES = [(s, s) for s in (REPORT, ANALYSIS, DEMO)]
    OPEN, EXPIRED = "open", "expired"
    STATUSES = [(s, s) for s in (OPEN, EXPIRED)]
    DEADLINE, BELOW_STOP, ABOVE_TARGET = "deadline", "below_stop", "above_target"  # expired가 된 까닭 (expiredReason)
    EXPIRED_REASONS = [(s, s) for s in (DEADLINE, BELOW_STOP, ABOVE_TARGET)]

    source = models.CharField(max_length=10, choices=SOURCES)
    report = models.ForeignKey("reports.Report", on_delete=models.SET_NULL, null=True, blank=True,
                               related_name="recommendations")
    analysis = models.ForeignKey("analysis.AnalysisRun", on_delete=models.SET_NULL, null=True, blank=True,
                                 related_name="recommendations")
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
                                     related_name="recommendations")  # 신청한(시연이면 만든) 팀원. 자동이면 None
    symbol = models.CharField(max_length=20)
    name = models.CharField(max_length=200)
    market = models.CharField(max_length=2)  # KR | US
    currency = models.CharField(max_length=3)  # KRW | USD
    price_at_creation = models.FloatField(null=True, blank=True)
    entry_price = models.FloatField()
    target_price = models.FloatField()
    stop_price = models.FloatField()
    holding_days = models.IntegerField()  # 보유 거래일 (1~20)
    probability = models.FloatField()  # 손절 전에 목표가에 도달할 확률 (0~1)
    probability_assumed = models.BooleanField(default=False)  # 확률이 없어 0.5로 둠
    confidence = models.FloatField(null=True, blank=True)  # 0~100
    target_return = models.FloatField()
    stop_loss_rate = models.FloatField()
    reward_risk = models.FloatField()  # 비용 반영 (리스크 엔진과 같은 계산)
    expected_return = models.FloatField()
    summary = models.TextField()
    reasons = models.JSONField(default=list, blank=True)
    risks = models.JSONField(default=list, blank=True)
    risk_level = models.CharField(max_length=6, null=True, blank=True)  # low | medium | high
    status = models.CharField(max_length=8, choices=STATUSES, default=OPEN, db_index=True)
    expired_reason = models.CharField(max_length=12, choices=EXPIRED_REASONS, null=True, blank=True)  # None: open 또는 예전 행(기한)
    valid_until = models.DateTimeField()  # 활성화할 수 있는 기한이자 계획의 진입 기한
    created_at = models.DateTimeField(default=timezone.now)
    deleted_at = models.DateTimeField(null=True, blank=True)  # 만든 팀원이 지운 시각 (숨김 — API에서 빠진다, hide.py)

    class Meta:
        db_table = "recommendations"
        constraints = [
            models.UniqueConstraint(fields=["report"], condition=Q(report__isnull=False),
                                    name="recommendations_one_per_report"),
            models.UniqueConstraint(fields=["analysis"], condition=Q(analysis__isnull=False),
                                    name="recommendations_one_per_analysis"),
        ]
        indexes = [models.Index(fields=["status", "created_at"]), models.Index(fields=["symbol", "created_at"])]

    def __str__(self) -> str:
        return f"#{self.id} {self.source} {self.name}({self.symbol}) {self.status}"


class TradePlan(models.Model):
    """팀원 한 명이 추천을 자기 모의 계좌에 활성화한 계획. 상태는 executor가 조건부 UPDATE로만 바꾼다."""
    ACTIVE, ENTRY_PENDING, HOLDING = "active", "entry_pending", "holding"
    CLOSED, CANCELLED, EXPIRED, FAILED = "closed", "cancelled", "expired", "failed"
    LIVE = (ACTIVE, ENTRY_PENDING, HOLDING)  # 진행 중
    STATUSES = [(s, s) for s in (ACTIVE, ENTRY_PENDING, HOLDING, CLOSED, CANCELLED, EXPIRED, FAILED)]
    VIAS = [("web", "web"), ("discord", "discord")]
    PERCENT, AMOUNT = "percent", "amount"  # 넣을 돈을 정한 방식 (docs/API.md TradePlan.budgetMode — 2026-10-11)
    BUDGET_MODES = [(s, s) for s in (PERCENT, AMOUNT)]

    recommendation = models.ForeignKey(Recommendation, on_delete=models.PROTECT, related_name="plans")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="trade_plans")
    symbol = models.CharField(max_length=20)
    name = models.CharField(max_length=200)
    market = models.CharField(max_length=2)
    currency = models.CharField(max_length=3)
    status = models.CharField(max_length=14, choices=STATUSES, default=ACTIVE, db_index=True)
    via = models.CharField(max_length=8, choices=VIAS, default="web")
    quantity = models.FloatField()
    # 사용자가 정한 금액 (원 — percent면 활성화 순간 매수 가능 금액 × % 를 원 단위로 내린 값). 2026-10-11 전 계획은 선택 예산 또는 None
    budget_krw = models.FloatField(null=True, blank=True)
    budget_mode = models.CharField(max_length=8, choices=BUDGET_MODES, null=True, blank=True)  # None: 2026-10-11 전 계획
    budget_percent = models.IntegerField(null=True, blank=True)  # percent면 1~100 (매수 가능 금액 기준), 아니면 None
    # 시연용 수동 시작 (DECISIONS 31장): 손익비·기대값 점검(plans/risk.MANUAL_SKIP_CODES)을 건너뛰고 활성화했는지. 재주문 점검도 같은 사유를
    # 건너뛴다. 활성화 때 한 번 쓰고 바꾸지 않는다. db_default: 이 열을 모르는 예전 코드(공유 개발 DB, 배포 중의 옛 컨테이너)가 행을 넣어도 되게
    manual_start = models.BooleanField(default=False, db_default=False)
    entry_price = models.FloatField()
    target_price = models.FloatField()
    stop_price = models.FloatField()
    holding_days = models.IntegerField()
    entry_deadline = models.DateTimeField()  # = 추천의 valid_until
    order = models.ForeignKey("trading.PaperOrder", on_delete=models.SET_NULL, null=True, blank=True,
                              related_name="trade_plans")  # 지금 연결된 모의 주문 (재주문하면 바뀐다)
    fill_price = models.FloatField(null=True, blank=True)
    filled_at = models.DateTimeField(null=True, blank=True)
    exit_price = models.FloatField(null=True, blank=True)
    exit_reason = models.CharField(max_length=8, null=True, blank=True)  # TARGET | STOP | EXPIRED | MANUAL
    closed_at = models.DateTimeField(null=True, blank=True)
    pnl_krw = models.FloatField(null=True, blank=True)
    failure_reason = models.TextField(null=True, blank=True)
    activated_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "trade_plans"
        constraints = [
            # 같은 종목에는 진행 중 계획 하나만 (부분 유일 인덱스, SQLite·PostgreSQL 모두 지원)
            models.UniqueConstraint(fields=["user", "symbol"], condition=Q(status__in=("active", "entry_pending",
                                                                                         "holding")),
                                    name="trade_plans_one_live_per_symbol"),
        ]
        indexes = [models.Index(fields=["user", "activated_at"])]

    def __str__(self) -> str:
        return f"#{self.id} {self.name}({self.symbol}) {self.status}"


class PlanEvent(models.Model):
    """계획의 사건 하나 (리포트 Trace처럼). step은 계획별 1부터 빈틈없이 늘어난다."""
    plan = models.ForeignKey(TradePlan, on_delete=models.CASCADE, related_name="events")
    step = models.PositiveIntegerField()
    kind = models.CharField(max_length=20)  # docs/API.md PlanEventKind
    message = models.TextField()
    details = models.JSONField(default=dict, blank=True)
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "trade_plan_events"
        constraints = [models.UniqueConstraint(fields=["plan", "step"], name="trade_plan_event_step")]

    def __str__(self) -> str:
        return f"#{self.plan_id}:{self.step} {self.kind}"
