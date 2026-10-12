"""오늘의 자동 리포트를 지금 한 번 시작한다 (엔진 루프의 "자동 리포트" 단계와 같은 일. reports/autoreport/auto.py, docs/tasks/01-인프라.md T1-6).

    python manage.py auto_report [--market KR] [--top 3] [--force] [--wait]

규칙 선별(그날 파일이 있으면 그것) → 선정 팀 실행 신청(단계 A)까지 한다. AUTO_REPORT 값과 상관없이 돈다.
--force가 없으면 루프와 같은 조건(AUTO_REPORT_AT 이후, 국내 거래일, 오늘 건너뜀 표시 없음)을 지킨다. --force면 조건을 무시한다.
그날 선정을 이미 시작했으면 새로 하지 않고 지금 상태를 보여 준다.
--wait가 없으면 다음은 엔진 루프(run_engine)가 이어서 한다 — 선정 팀 실행은 runner가, 그 뒤 단계(선정 Guard → 종목 리포트)는
루프의 "자동 리포트" 단계가 (진행 중인 선정은 AUTO_REPORT 값과 상관없이, KR·US 모두 이어 간다). --wait면 엔진 루프 없이 이 명령이 선정 팀 → 선정 Guard → 종목 리포트 → 발송까지
그 자리에서 돌린다 (손익비 기준을 넘는 추천이 없어 다시 시도한 리포트까지 — 시연용. LLM을 부르고 몇 분 걸린다). 엔진 루프가 이미 실행 중인 리포트는 끝날 때까지 기다린다.
선별은 증권사 조회를 100번 넘게 한다.
"""
import importlib
import time

from django.core.management.base import BaseCommand, CommandError
from trading import service

from config import engine
from reports.autoreport import auto, conf
from reports.models import Report

POLL_SEC = 2.0          # --wait: 엔진 루프가 실행 중인 리포트를 다시 보는 간격
WAIT_LIMIT_SEC = 1800   # --wait: 리포트 하나를 기다리는 최대 시간


def run_report(report: Report) -> None:
    """리포트 하나를 이 프로세스에서 실행한다 (Orchestrator. 예외를 밖으로 내지 않는다)."""
    importlib.import_module("reports.orchestration.orchestrator").run_report(report)


class Command(BaseCommand):
    help = "오늘의 자동 리포트(규칙 선별 → AI 선정 → 선정 Guard → 종목 리포트)를 지금 한 번 시작한다"

    def add_arguments(self, parser):
        parser.add_argument("--market", default=auto.MARKET, choices=["KR", "US"], help="시장 (기본 KR)")
        parser.add_argument("--top", type=int, help="리포트할 종목 수 1~5 (기본 AUTO_REPORT_TOP)")
        parser.add_argument("--force", action="store_true", help="시각·거래일·건너뜀 표시 조건을 무시하고 지금 실행")
        parser.add_argument("--wait", action="store_true", help="엔진 루프 없이 선정·리포트·발송까지 이 자리에서 끝낸다")

    def handle(self, *args, market="KR", top=None, force=False, wait=False, **options):
        now = service.now()
        day = now.astimezone(auto.KST).date()
        top = conf.clamp_top(top or conf.auto_report_top())
        if not force:
            if now.astimezone(auto.KST).time() < conf.auto_report_at():
                raise CommandError(f"아직 {conf.auto_report_at():%H:%M}(KST) 전입니다. 지금 하려면 --force.")
            if auto.skipped(market, day):
                raise CommandError(f"오늘({day}) {market} 자동 리포트는 건너뛰었습니다. 다시 하려면 --force.")
            if not auto.trading_day(market, now):
                raise CommandError(f"오늘({day})은 {market} 정규장이 없습니다. 그래도 하려면 --force.")
        if auto.load(market, day) is None and engine.broker_client() is None:
            raise CommandError("증권사 조회 키가 없어 선별할 수 없습니다.")
        if auto.start(market, top, now, self.stdout.write) is None:
            raise CommandError("선별하지 못했습니다 (오늘은 건너뜀 표시를 남겼습니다).")
        if wait:
            self.finish_day(market, day, top, now)
        self.summary(auto.load(market, day) or {})

    def finish_day(self, market: str, day, top: int, now) -> None:
        """--wait: 선정 팀 실행 → 선정 Guard·종목 리포트 신청 → 종목 리포트 실행·발송을 차례로.
        마지막 리포트가 끝나며 다시 시도(auto._retry)가 리포트를 더 신청하면 그것도 돌린다."""
        current = (auto.load(market, day) or {}).get("selection") or {}
        if current.get("status") == auto.RUNNING:
            if current.get("reportId"):
                self.run_or_wait(current["reportId"])
            auto.advance(market, day, self.stdout.write, top=top, now=now)
        done: set[int] = set()
        while todo := [i for i in (auto.load(market, day) or {}).get("reportIds") or [] if i not in done]:
            for report_id in todo:
                self.run_or_wait(report_id)
                done.add(report_id)

    def run_or_wait(self, report_id: int) -> None:
        """requested면 이 자리에서 실행하고 발송한다 (runner처럼 after_finish). 엔진 루프가 실행 중이면 끝날 때까지 기다린다."""
        report = Report.objects.filter(pk=report_id).first()
        if report is None:
            return
        if report.status == Report.REQUESTED:
            self.stdout.write(f"리포트 #{report.id} {report.name} 실행 중...")
            run_report(report)
            auto.after_finish(report)
        deadline = time.monotonic() + WAIT_LIMIT_SEC
        report.refresh_from_db()
        while report.status not in Report.FINISHED and time.monotonic() < deadline:
            time.sleep(POLL_SEC)
            report.refresh_from_db()
        self.stdout.write(f"리포트 #{report.id} {report.name}: {report.status}")

    def summary(self, result: dict) -> None:
        current = result.get("selection") or {}
        picks = ", ".join(f"{p.get('name') or p.get('symbol')}({p.get('symbol')})" for p in result.get("picks") or [])
        how = {auto.AI: "AI 선정", auto.RULE: f"규칙 선정(사유 {result.get('fallbackReason')})"}.get(
            result.get("selectedBy"), "선정 중")
        self.stdout.write(f"선정 실행 #{current.get('reportId')} {current.get('status')} · {how} · 종목: {picks or '없음'} · "
                          f"리포트 {result.get('reportIds') or []} · 추천 {result.get('recommendationIds') or []}")
