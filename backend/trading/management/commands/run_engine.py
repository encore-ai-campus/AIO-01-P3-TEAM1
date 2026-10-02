"""엔진 루프 (docs/DECISIONS.md 8-2): 모의 체결·청산 확인, 예약 실행, 일별 자산 기록, 분석 작업.

    python manage.py run_engine [--once] [--interval 5]

한 단계의 오류는 콘솔에 한 줄로 남기고 다음 단계·다음 루프로 넘어간다. Ctrl+C로 끝난다.
증권사 조회 키가 없으면 체결·예약·자산 기록은 건너뛰고 분석 작업만 돈다.
"""
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from config import engine
from trading import service


class Command(BaseCommand):
    help = "모의 체결·청산 확인, 예약 실행, 일별 자산 기록, 분석 작업을 반복한다"

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="한 번만 돌고 끝낸다")
        parser.add_argument("--interval", type=float, default=5.0, help="반복 간격 (초, 기본 5)")

    def handle(self, *args, once=False, interval=5.0, **options):
        from analysis import jobs  # analysis 앱 소유 (분석 작업 실행)

        if engine.broker_client() is None:
            self.log("증권사 조회 키가 없어 체결·예약·자산 기록을 건너뛰고 분석 작업만 돈다")
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
        if engine.broker_client() is not None:
            self.step("체결 확인", lambda: service.sync_accounts(now, self.log))
            self.step("예약 실행", lambda: service.run_reservations(now, self.log))
            self.step("일별 자산 기록", lambda: service.record_equity(now, self.log))
        self.step("분석 작업", _analysis_tick)

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
