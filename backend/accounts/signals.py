"""사용자를 만들면 프로필을 자동으로 만든다 (관리자 화면·createsuperuser·create_team_accounts 모두)."""
from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver

from accounts.models import profile_of


@receiver(post_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="accounts_create_profile")
def create_profile(sender, instance, created, raw=False, **kwargs):
    if created and not raw:  # raw: loaddata는 프로필도 데이터에 들어 있다
        profile_of(instance)
