"""시연용 규칙 추천(AI 아님)을 하나 만든다 (docs/API.md "POST /api/recommendations/demo"와 같은 규칙).

    python manage.py demo_recommend [--symbol 005930] [--user 아이디]

--user가 없으면 신청자 없이 만들고 팀 전체에 알린다 (하루 한도를 보지 않는다).
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from rest_framework.exceptions import APIException

from autotrade.recommend import demo


class Command(BaseCommand):
    help = "시연용 규칙 추천(AI 아님)을 하나 만든다"

    def add_arguments(self, parser):
        parser.add_argument("--symbol", help="종목코드 (없으면 시연 종목 목록에서 고른다)")
        parser.add_argument("--user", help="신청자 아이디 (없으면 팀 전체에 알린다)")

    def handle(self, *args, symbol=None, user=None, **options):
        who = None
        if user:
            who = get_user_model().objects.filter(username=user).first()
            if who is None:
                raise CommandError(f"사용자 '{user}'이(가) 없습니다.")
        try:
            rec = demo.recommend(who, symbol)
        except APIException as e:
            raise CommandError(str(e.detail)) from None
        self.stdout.write(f"시연 추천 #{rec.id} {rec.name} ({rec.symbol}): 진입 {rec.entry_price:,g} · "
                          f"목표 {rec.target_price:,g} · 손절 {rec.stop_price:,g} · 손익비 {rec.reward_risk:.2f}")
