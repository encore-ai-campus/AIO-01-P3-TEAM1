"""알림 접점 (docs/DECISIONS.md 12-4). 다른 앱은 알림을 이 모듈의 notify로만 만든다.

    from notifications import service as notices
    notices.notify(user, "filled", "삼성전자 진입 체결", "71,000원 × 28주", link="/plans/3")

알림 하나 = 받는 사람별 웹 알림 행 + Discord 보낼 편지함 메시지 하나. Discord 전송은 엔진 루프의 dispatch.tick()이 한다.
Webhook이 없으면 편지함 메시지를 skipped로 남기고 콘솔에 출력한다 (Discord로는 보내지 않는다).
"""
import os
import sys
from functools import cache

from django.contrib.auth import get_user_model
from django.db import transaction
from paper_engine.config import ROOT, load_env

from config import engine

from .models import Notification, NotificationSetting, OutboxMessage

DEFAULT_PUBLIC_BASE_URL = "http://localhost:5173"
DEFAULT_LINK_LABEL = "웹에서 보기"
TITLE_MAX_LEN = 200
NO_WEBHOOK = "DISCORD_WEBHOOK_URL이 없어 Discord로 보내지 않음"


@cache
def _dotenv() -> dict:
    return load_env(ROOT / ".env")


def _env(key: str) -> str:
    """환경 변수 → 저장소 .env 순으로 읽는다 (analysis.quota와 같은 방식)."""
    return (os.environ.get(key) or _dotenv().get(key) or "").strip()


def public_url(path: str | None) -> str:
    """웹 경로 → Discord 메시지에 넣을 절대 주소 (PUBLIC_BASE_URL + 경로). 이미 절대 주소면 그대로."""
    base = (_env("PUBLIC_BASE_URL") or DEFAULT_PUBLIC_BASE_URL).rstrip("/")
    if not path:
        return base
    if path.startswith(("http://", "https://")):
        return path
    return f"{base}/{path.lstrip('/')}"


def webhook_configured() -> bool:
    """서버에 DISCORD_WEBHOOK_URL이 있는지 (주소는 비밀 값이라 있는지만 알린다)."""
    return bool(engine.engine_config().discord_webhook_url)


def settings_of(user) -> NotificationSetting:
    """알림 설정. 없으면 기본값으로 만든다."""
    setting, _ = NotificationSetting.objects.get_or_create(user=user)
    return setting


def notify(users, kind: str, title: str, body: str, *, link: str | None = None, discord: bool = True,
           discord_link: str | None = None, link_label: str | None = None, embed: dict | None = None) -> list:
    """알림을 만든다. 만든 웹 알림(Notification) 목록을 돌려준다. 예외를 밖으로 내지 않는다 (알림 실패가 매매를 막지 않게).

    users: User 하나, User 목록, 또는 None(= 활성 사용자 전체. Discord에는 멘션 없이 한 번만).
    kind: docs/API.md NotificationKind. title·body: 사람이 읽는 말 (비밀 값·로그인 아이디를 넣지 않는다).
    link: 웹 경로 ("/plans/3"). 웹 알림과 Discord 메시지에 쓴다.
    discord: False면 웹 알림만. discord_link: Discord 메시지에만 쓸 경로 (예: 서명된 활성화 링크). 없으면 link.
    link_label: Discord 메시지의 링크 앞 글 ("계획 활성화"). embed: Discord embed 하나 (title·description·url·color·fields).
    """
    try:
        recipients = _recipients(users)
    except Exception as e:
        _warn(f"알림 받는 사람을 정하지 못함 ({kind} {title}): {type(e).__name__}: {e}")
        return []
    created = []
    try:
        with transaction.atomic():  # 바깥 트랜잭션 안에서 불려도 실패가 그 트랜잭션을 깨지 않게 (savepoint)
            created = Notification.objects.bulk_create(
                Notification(user=user, kind=kind, title=title[:TITLE_MAX_LEN], body=body, link=link)
                for user in recipients)
    except Exception as e:
        _warn(f"웹 알림 만들기 실패 ({kind} {title}): {type(e).__name__}: {e}")
    if discord and recipients:
        try:
            with transaction.atomic():
                _enqueue(recipients, users is None, kind, title, body, discord_link or link, link_label, embed)
        except Exception as e:
            _warn(f"Discord 보낼 편지함 넣기 실패 ({kind} {title}): {type(e).__name__}: {e}")
    return created


def _recipients(users) -> list:
    User = get_user_model()
    if users is None:
        return list(User.objects.filter(is_active=True).order_by("id"))
    items = [users] if isinstance(users, User) else list(users)
    return list({user.pk: user for user in items}.values())  # 같은 사람에게 두 번 만들지 않는다


def _enqueue(recipients: list, broadcast: bool, kind: str, title: str, body: str, path: str | None,
             link_label: str | None, embed: dict | None) -> OutboxMessage | None:
    """Discord 메시지 하나를 편지함에 넣는다. 받는 사람이 모두 Discord를 껐으면 넣지 않는다."""
    settings = {s.user_id: s for s in NotificationSetting.objects.filter(user__in=[u.pk for u in recipients])}
    enabled = [u for u in recipients if u.pk not in settings or settings[u.pk].discord_enabled]
    if not enabled:
        return None
    mentions = [] if broadcast else [f"<@{settings[u.pk].discord_user_id}>" for u in enabled
                                     if u.pk in settings and settings[u.pk].discord_user_id]
    lines = [" ".join(mentions)] if mentions else []
    lines.append(f"**{title}**")
    if body:
        lines.append(body)
    if path:
        lines.append(f"▶ {link_label or DEFAULT_LINK_LABEL}: {public_url(path)}")
    content = "\n".join(lines)
    if webhook_configured():
        return OutboxMessage.objects.create(kind=kind, content=content, embed=embed)
    print(f"[Discord 알림 (Webhook 없음, 보내지 않음)]\n{content}", flush=True)
    return OutboxMessage.objects.create(kind=kind, content=content, embed=embed, status=OutboxMessage.SKIPPED,
                                        last_error=NO_WEBHOOK)


def _warn(text: str) -> None:
    print(f"[알림 실패] {text}", file=sys.stderr, flush=True)
