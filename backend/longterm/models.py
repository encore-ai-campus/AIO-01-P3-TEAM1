"""장기투자: 오늘의 내 종목 뉴스 · 산 이유와 펀더멘털 점검 (docs/API.md "장기투자", docs/DECISIONS.md 14-3).

숫자와 판정은 결정론적 코드가 만든다 (등락 분해·근거 목록·펀더멘털 판정). LLM은 오늘의 내 종목 뉴스의 설명 문장에만 쓴다.
JSON 필드는 읽고 쓰기만 한다 (PostgreSQL 전용 조회를 쓰지 않는다 — 로컬 SQLite, 운영 PostgreSQL).
"""
from django.conf import settings
from django.db import models
from django.utils import timezone


class DailyMoveNote(models.Model):
    """종목 하나의 하루 기록 (docs/API.md DailyMove). 종목·날짜당 하나, 팀 공용 — 여러 사람이 가져도, 엔진이 다시 떠도 한 번.

    업종 등락(sectorChangeRate)은 v1에서 늘 null이라 열을 두지 않는다.
    """
    TEMPLATE, LLM = "template", "llm"
    METHODS = [(m, m) for m in (TEMPLATE, LLM)]

    symbol = models.CharField(max_length=20)
    name = models.CharField(max_length=200)
    market = models.CharField(max_length=2, default="KR")  # v1은 국내 종목만
    day = models.DateField()  # 거래일 (KST)
    as_of = models.DateTimeField()  # 그날 정규장 종료 시각 (장마감 기준)
    close = models.FloatField()  # 그날 종가
    prev_close = models.FloatField()  # 전 거래일 종가
    change_rate = models.FloatField()  # close / prev_close - 1
    proxy_symbol = models.CharField(max_length=20)  # 시장 대용 ETF: 코스피 069500 · 코스닥 229200
    proxy_name = models.CharField(max_length=100)  # "KODEX 200" · "KODEX 코스닥150"
    proxy_change_rate = models.FloatField(null=True, blank=True)  # 받지 못하면 None
    excess_change_rate = models.FloatField(null=True, blank=True)  # change_rate - proxy_change_rate (β=1, 원인이 아니다)
    volatility20 = models.FloatField(null=True, blank=True)  # 최근 20거래일 일간 등락률의 표준편차
    flows = models.JSONField(null=True, blank=True)  # {"foreign", "institution", "individual"}: 순매수 수량 ÷ 거래량
    headline = models.CharField(max_length=200)  # 한 줄 제목 (코드가 60자로 자른다)
    summary = models.JSONField(default=list, blank=True)  # 설명 문장 1~3개
    drivers = models.JSONField(default=list, blank=True)  # 설명이 기댄 근거 id (evidence[].id). 템플릿이면 []
    uncertain = models.BooleanField(default=False)  # 근거가 약함 (뉴스 제목뿐 등)
    method = models.CharField(max_length=8, choices=METHODS, default=TEMPLATE)
    evidence = models.JSONField(default=list, blank=True)  # DailyMoveEvidence[] (id, kind, text, source, at, url, reliability)
    missing = models.JSONField(default=list, blank=True)  # 비운 칸과 이유 한 줄씩
    llm_model = models.CharField(max_length=100, null=True, blank=True)  # method llm일 때 쓴 모델 (화면에 내지 않는다)
    cost_usd = models.FloatField(null=True, blank=True)  # LLM 비용 (전용 클라이언트의 호출 전후 차이). 템플릿이면 None
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "daily_move_notes"
        constraints = [models.UniqueConstraint(fields=["symbol", "day"], name="daily_move_notes_symbol_day")]
        indexes = [models.Index(fields=["day"])]

    def __str__(self) -> str:
        return f"{self.day} {self.name}({self.symbol}) {self.change_rate:+.2%}"


class InvestmentThesis(models.Model):
    """산 이유 (docs/API.md Thesis). 사용자·종목당 하나. 장기 보유를 고를 때 "왜 샀나요?"로 받는다.

    baseline은 처음 저장할 때의 지표 값 {FundamentalKey: 값} (FundamentalsRow.value와 같은 단위). 자료가 없으면 {}이고 다음 점검에서 채운다.
    active는 이 종목을 장기 보유(style long, 체결 대기·보유 중) 중인지 — 서버가 정한다 (끝나면 False, 점검·알림을 멈춘다).
    """
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="investment_theses")
    symbol = models.CharField(max_length=20)
    name = models.CharField(max_length=200)
    market = models.CharField(max_length=2)  # KR | US
    reasons = models.JSONField(default=list, blank=True)  # 산 이유 1~3개 (각 1~100자)
    axes = models.JSONField(default=list, blank=True)  # 점검 축 growth | profitability | balance_sheet (비면 셋 다)
    baseline = models.JSONField(default=dict, blank=True)
    baseline_period = models.CharField(max_length=100, null=True, blank=True)  # 기준선 보고서 ("2026 반기보고서")
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "investment_theses"
        constraints = [models.UniqueConstraint(fields=["user", "symbol"], name="investment_theses_user_symbol")]
        indexes = [models.Index(fields=["active", "symbol"])]

    def __str__(self) -> str:
        return f"{self.user} {self.name}({self.symbol})"


class ThesisCheck(models.Model):
    """산 이유 점검 한 번 (docs/API.md ThesisCheck). 산 이유를 지우면 같이 지운다.

    rows는 FundamentalsRow[] 9개(기준선 비교 포함), new_bad는 이번에 새로 bad가 된 지표 키. caption은 고정 문구라 저장하지 않는다.
    """
    FILING, WEEKLY = "filing", "weekly"
    TRIGGERS = [(t, t) for t in (FILING, WEEKLY)]

    thesis = models.ForeignKey(InvestmentThesis, on_delete=models.CASCADE, related_name="checks")
    checked_at = models.DateTimeField(default=timezone.now)
    trigger = models.CharField(max_length=8, choices=TRIGGERS)  # filing: 그날 새 정기공시 · weekly: 매주 월요일 전체
    period = models.CharField(max_length=100, null=True, blank=True)  # 점검에 쓴 보고서 이름. 자료가 없으면 None
    received_at = models.DateField(null=True, blank=True)  # 그 보고서 접수일
    overall = models.CharField(max_length=8)  # solid | caution | review | na
    previous_overall = models.CharField(max_length=8, null=True, blank=True)  # 직전 점검의 종합 (첫 점검이면 None)
    rows = models.JSONField(default=list, blank=True)
    new_bad = models.JSONField(default=list, blank=True)
    notified = models.BooleanField(default=False)  # 이 점검으로 thesis_check 알림을 보냈는지
    # 판정에만 쓰는 값 (화면에 내지 않는다): 보고서·매출 성장률·같은 누적 기간의 순이익과 영업현금흐름.
    # 다음 점검(다른 보고서 기간)의 "2개 보고서 연속" 조건이 읽는다 (fundamentals_check.evaluate의 facts)
    facts = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "thesis_checks"
        indexes = [models.Index(fields=["thesis", "checked_at"])]

    def __str__(self) -> str:
        return f"#{self.thesis_id} {self.checked_at:%Y-%m-%d} {self.overall}"
