"""엔진 루프 (docs/DECISIONS.md 8-2·12장·14장): 모의 체결·청산 확인, 예약 실행, 일별 자산 기록, 분석 작업,
추천 수집, 리포트 알림, 자동 추천(시연), 자동매매, 장기투자, 알림 발송 (이 순서).

    python manage.py run_engine [--once] [--interval 5]

한 단계의 오류는 콘솔에 한 줄로 남기고 다음 단계·다음 루프로 넘어간다. Ctrl+C로 끝난다.
증권사 조회 키가 없으면 체결·예약·자산 기록·자동 추천·자동매매·장기투자는 건너뛰고
분석 작업·추천 수집·리포트 알림·알림 발송만 돈다.
리포트 알림(끝난 리포트 → 신청자 알림, reports.alerts)은 추천 수집 다음이라 같은 바퀴에서 만든 추천을 보고 판단한다.
알림 발송은 늘 마지막이라 같은 바퀴에서 생긴 알림을 바로 보낸다.
"""
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from config import engine
from trading import service


class Command(BaseCommand):
    help = ("모의 체결·청산 확인, 예약 실행, 일별 자산 기록, 분석 작업, 추천 수집, 리포트 알림, 자동 추천, 자동매매, 장기투자, "
            "알림 발송을 반복한다")

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="한 번만 돌고 끝낸다")
        parser.add_argument("--interval", type=float, default=5.0, help="반복 간격 (초, 기본 5)")

    def handle(self, *args, once=False, interval=5.0, **options):
        from analysis import jobs  # analysis 앱 소유 (분석 작업 실행)

        if engine.broker_client() is None:
            self.log("증권사 조회 키가 없어 체결·예약·자산 기록·장기투자·자동 추천·자동매매를 건너뛰고 "
                     "분석 작업·추천 수집·알림 발송만 돈다 (리포트 알림 포함)")
        if not once:  # 상주 루프는 하나만 돈다. 이전 실행이 남긴 실행 중 표시를 정리해야 분석 큐가 멈추지 않는다
            recovered = jobs.recover()
            if recovered:
                self.log(f"이전 실행이 남긴 분석 작업 {recovered}개를 실패로 정리함")
        try:
            while True:
                if not once:  # 오래 도는 루프는 끊긴 DB 연결을 버리고 다시 붙는다 (한 번만 돌 때는 필요 없다)
                    close_old_connections()
                self.tick()
                if once:
                    break
                time.sleep(max(interval, 0.1))
        except KeyboardInterrupt:
            self.log("엔진 루프를 끝냄")
        finally:
            if not once:
                jobs.shutdown()  # 돌고 있는 분석 하위 프로세스를 끝낸다

    def tick(self) -> None:
        now = service.now()
        broker = engine.broker_client() is not None
        if broker:
            self.step("체결 확인", lambda: service.sync_accounts(now, self.log))
            self.step("예약 실행", lambda: service.run_reservations(now, self.log))
            self.step("일별 자산 기록", lambda: service.record_equity(now, self.log))
        self.step("분석 작업", _analysis_tick)
        self.step("추천 수집", lambda: _collect_recommendations(now, self.log))
        self.step("리포트 알림", lambda: _report_alerts(now, self.log))
        if broker:  # 선별·시세·주문이 필요하다
            self.step("자동 추천", lambda: _auto_recommend(now, self.log))
            self.step("자동매매", lambda: _autotrade_tick(now, self.log))
            self.step("장기투자", lambda: _longterm_tick(now, self.log))  # 일봉·수급 조회가 필요하다
        self.step("알림 발송", lambda: _dispatch_notifications(now, self.log))

    def step(self, label: str, run) -> None:
        try:
            run()
        except KeyboardInterrupt:
            raise
        except Exception as e:  # 한 단계의 오류가 루프를 죽이지 않게
            self.stderr.write(f"{service.now():%H:%M:%S} {label} 실패: {type(e).__name__}: {e}")

    def log(self, text: str) -> None:
        self.stdout.write(f"{service.now():%H:%M:%S} {text}")


def _analysis_tick() -> None:
    from analysis import jobs  # analysis 앱 소유 (분석 작업 실행)

    jobs.tick()


def _collect_recommendations(now, log) -> None:
    from autotrade import sources  # autotrade 앱 소유 (끝난 리포트·BUY 분석 → 추천, 기한 지난 추천 만료)

    sources.collect(now, log)


def _report_alerts(now, log) -> None:
    from reports import alerts  # 리포트 끝 알림 (B7, Claude 파일 — 팀의 runner·healing은 사용자 알림을 보내지 않는다)

    alerts.sweep_finished(now, log)


def _auto_recommend(now, log) -> None:
    from autotrade import auto  # autotrade 앱 소유 (매일 자동 추천, 시연. AUTO_RECOMMEND=demo일 때만)

    auto.tick(now, log)


def _autotrade_tick(now, log) -> None:
    from autotrade import executor  # autotrade 앱 소유 (진행 중 계획의 주문·체결 대기·보유 감시·청산)

    executor.tick(now, log)


def _longterm_tick(now, log) -> None:
    from longterm import jobs  # longterm 앱 소유 (오늘의 내 종목 뉴스·펀더멘털 점검. LONGTERM_JOBS=off면 쉰다)

    jobs.tick(now, log)


def _dispatch_notifications(now, log) -> None:
    from notifications import dispatch  # notifications 앱 소유 (Discord 보낼 편지함 발송)

    dispatch.tick(now, log)
