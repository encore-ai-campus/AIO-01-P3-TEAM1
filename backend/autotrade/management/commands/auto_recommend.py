"""매일 자동 추천(시연)을 지금 한 번 돌린다 (엔진 루프의 "자동 추천" 단계와 같은 일. autotrade/recommend/auto.py).

    python manage.py auto_recommend [--market KR] [--top 3] [--force]

AUTO_RECOMMEND 값과 상관없이 돈다. --force가 없으면 루프와 같은 조건(거래일, AUTO_RECOMMEND_AT 이후, 오늘 아직 안 함)을 지킨다.
--force면 조건을 무시하고 지금 실행한다 (시연·시험용. 그날 선별 파일이 있으면 그것을 쓴다).
선별은 증권사 조회를 100번 넘게 한다.
"""
from django.core.management.base import BaseCommand, CommandError
from trading import service

from autotrade.recommend import auto
from autotrade import conf
from config import engine


class Command(BaseCommand):
    help = "선별 상위 종목으로 시연 추천(AI 아님)을 만든다 (매일 자동 추천을 지금 한 번)"

    def add_arguments(self, parser):
        parser.add_argument("--market", default=auto.MARKET, choices=["KR", "US"], help="시장 (기본 KR)")
        parser.add_argument("--top", type=int, help="추천할 선별 상위 종목 수 (기본 AUTO_RECOMMEND_TOP)")
        parser.add_argument("--force", action="store_true", help="시각·거래일·하루 한 번 조건을 무시하고 지금 실행")

    def handle(self, *args, market="KR", top=None, force=False, **options):
        if engine.broker_client() is None:
            raise CommandError("증권사 조회 키가 없어 선별할 수 없습니다.")
        now = service.now()
        top = max(top or conf.auto_recommend_top(), 1)
        day = now.astimezone(auto.KST).date()
        if not force:
            if now.astimezone(auto.KST).time() < conf.auto_recommend_at():
                raise CommandError(f"아직 {conf.auto_recommend_at():%H:%M}(KST) 전입니다. 지금 하려면 --force.")
            if auto.done(market, day):
                raise CommandError(f"오늘({day}) {market} 자동 추천을 이미 했습니다. 다시 하려면 --force.")
            if not auto.trading_day(market, now):
                raise CommandError(f"오늘({day})은 {market} 정규장이 없습니다. 그래도 하려면 --force.")
        made = auto.run(market, top, now, self.stdout.write)
        self.stdout.write(f"시연 추천 {made}개를 만들었습니다.")
