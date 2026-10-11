"""알림 접점 (docs/DECISIONS.md 12-4). 다른 앱은 알림을 이 모듈의 notify로만 만든다.

    from notifications import service as notices
    notices.notify(user, "filled", "삼성전자 진입 체결", "71,000원 × 28주", link="/plans/3")

알림 하나 = 받는 사람별 웹 알림 행 + Discord 보낼 편지함 메시지 하나. Discord 전송은 엔진 루프의 dispatch.tick()이 한다.
Discord로 보낼 곳(Webhook·openclaw)이 없으면 편지함 메시지를 skipped로 남기고 콘솔에 출력한다.
편지함에 넣는 글(제목·본문·embed)의 멘션(<@…>·@everyone·@here)은 무력화하고, 우리가 붙이는 받는 사람 멘션 줄만 울린다.

알림 문장 (컨셉 계획 B6 — docs/API.md "알림 문장", docs/DECISIONS.md 14-7):
- 웹 알림의 제목·본문은 **받는 사람의 주린이모드**를 따른다. 켬(행이 없으면 켬)이면 쉬운 문장(title·body),
  끔이면 전문가 문장(expert_title·expert_body, 없으면 쉬운 문장). 주린이모드는 accounts.modes.beginner_modes로 한 번에 읽는다.
- Discord(팀 공용 채널 하나)는 받는 사람과 무관하게 쉬운 문장 + 숫자 한 줄(numbers)로 하나만 보내고 맨 앞에 HEADER를 붙인다.
- daily_move·thesis_check는 웹 알림만 (사용자별 묶음이 팀 채널에 쌓이지 않게).
"""
import os
import re
import sys
from dataclasses import dataclass
from functools import cache

from accounts import modes as investor_modes
from django.contrib.auth import get_user_model
from django.db import transaction
from paper_engine.config import ROOT, load_env
from paper_engine.notify import ConsoleNotifier

from config import engine

from .models import Notification, NotificationSetting, OutboxMessage

DEFAULT_PUBLIC_BASE_URL = "http://localhost:5173"
DEFAULT_LINK_LABEL = "웹에서 보기"
HEADER = "[모매매 · 모의투자]"  # Discord 글의 맨 앞: 서비스 이름(D-5 → 15-7 → 2026-10-07 바뀜 — DECISIONS 18장) + 실제 매매로 읽히지 않게
WEB_ONLY_KINDS = frozenset({"daily_move", "thesis_check"})  # Discord로 보내지 않는 kind
TITLE_MAX_LEN = 200
NO_WEBHOOK = "Discord 설정(DISCORD_WEBHOOK_URL·OPENCLAW_TARGET)이 없어 Discord로 보내지 않음"
_MENTION = re.compile(r"@(?=everyone|here|[!&]?\d)")
ZERO_WIDTH_SPACE = "\u200b"
# Discord embed 길이 제한 (https://discord.com/developers/docs/resources/message#embed-object-embed-limits)
EMBED_TITLE, EMBED_DESCRIPTION, EMBED_FIELDS, EMBED_FIELD_NAME, EMBED_FIELD_VALUE = 256, 4096, 25, 256, 1024
EMBED_FOOTER, EMBED_AUTHOR, EMBED_TOTAL = 2048, 256, 6000


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
    """서버에 DISCORD_WEBHOOK_URL이 있는지 (주소는 비밀 값이라 있는지만 알린다).

    2026-10-08 사용자 결정: Discord 알림을 끈다 (docs/DECISIONS.md 24장 — paper_engine.notify.make_notifier도 콘솔로만).
    화면(My Page 알림 설정)은 이 값이 false면 Discord 묶음을 접고 "지금은 웹 알림으로만 와요"를 보인다.
    """
    # return bool(engine.engine_config().discord_webhook_url)
    return False


def discord_configured() -> bool:
    """Discord로 보낼 곳이 있는지 (Webhook 또는 openclaw). 없으면 엔진 알림은 콘솔로만 간다."""
    return not isinstance(engine.notifier(), ConsoleNotifier)


def settings_of(user) -> NotificationSetting:
    """알림 설정. 없으면 기본값으로 만든다."""
    setting, _ = NotificationSetting.objects.get_or_create(user=user)
    return setting


@dataclass(frozen=True)
class Notice:
    """알림 문장 한 벌 (B6): 쉬운 문장(주린이모드 켬·Discord) + 전문가 문장(끔) + Discord 숫자 한 줄.

    문장은 부르는 앱이 모아 둔다 (autotrade/text.py, reports/output/text.py). send는 이 모듈의 notify를 부른다.
    """
    title: str
    body: str
    expert_title: str | None = None
    expert_body: str | None = None
    numbers: str | None = None  # Discord에만 붙이는 숫자 한 줄 (예: "체결 70,600원 × 3주 · 목표 77,000원 · 손절 67,700원")

    def send(self, users, kind: str, **options) -> list:
        return notify(users, kind, self.title, self.body, expert_title=self.expert_title,
                      expert_body=self.expert_body, numbers=self.numbers, **options)


def notify(users, kind: str, title: str, body: str, *, link: str | None = None, discord: bool = True,
           discord_link: str | None = None, link_label: str | None = None, embed: dict | None = None,
           expert_title: str | None = None, expert_body: str | None = None, numbers: str | None = None) -> list:
    """알림을 만든다. 만든 웹 알림(Notification) 목록을 돌려준다. 예외를 밖으로 내지 않는다 (알림 실패가 매매를 막지 않게).

    users: User 하나, User 목록, 또는 None(= 활성 사용자 전체. Discord에는 멘션 없이 한 번만).
    kind: docs/API.md NotificationKind. title·body: 쉬운 문장 (비밀 값·로그인 아이디·장중 가격 숫자를 넣지 않는다).
    expert_title·expert_body: 주린이모드를 끈 사람의 웹 알림 문장 (없으면 쉬운 문장). numbers: Discord에 붙일 숫자 한 줄.
    link: 웹 경로 ("/plans/3"). 웹 알림과 Discord 메시지에 쓴다.
    discord: False면 웹 알림만 (WEB_ONLY_KINDS는 늘 웹만). discord_link: Discord 메시지에만 쓸 경로 (예: 서명된 활성화 링크).
    link_label: Discord 메시지의 링크 앞 글 ("계획 활성화"). embed: Discord embed 하나 (title·description·url·color·fields).
    """
    try:
        with transaction.atomic():  # 바깥 트랜잭션 안에서 불려도 실패가 그 트랜잭션을 깨지 않게 (savepoint)
            recipients = _recipients(users)
    except Exception as e:
        _warn(f"알림 받는 사람을 정하지 못함 ({kind} {title}): {type(e).__name__}: {e}")
        return []
    modes = _beginner_modes(recipients) if expert_title is not None or expert_body is not None else {}
    created = []
    try:
        with transaction.atomic():
            created = Notification.objects.bulk_create(
                _row(user, kind, link, *_wording(modes.get(user.pk, True), title, body, expert_title, expert_body))
                for user in recipients)
    except Exception as e:
        _warn(f"웹 알림 만들기 실패 ({kind} {title}): {type(e).__name__}: {e}")
    if discord and kind not in WEB_ONLY_KINDS and recipients:
        try:
            with transaction.atomic():
                _enqueue(recipients, users is None, kind, title, body, discord_link or link, link_label, embed,
                         numbers)
        except Exception as e:
            _warn(f"Discord 보낼 편지함 넣기 실패 ({kind} {title}): {type(e).__name__}: {e}")
    return created


def _wording(easy: bool, title: str, body: str, expert_title: str | None, expert_body: str | None) -> tuple[str, str]:
    """받는 사람의 웹 알림 (제목, 본문): 주린이모드 켬이면 쉬운 문장, 끔이면 전문가 문장 (없는 쪽은 쉬운 문장)."""
    if easy:
        return title, body
    return (title if expert_title is None else expert_title), (body if expert_body is None else expert_body)


def _row(user, kind: str, link: str | None, title: str, body: str) -> Notification:
    return Notification(user=user, kind=kind, title=title[:TITLE_MAX_LEN], body=body, link=link)


def _beginner_modes(recipients: list) -> dict[int, bool]:
    """받는 사람별 주린이모드 {user id: 켬?} (accounts.modes.beginner_modes — 한 번의 쿼리, 행이 없으면 켬).

    읽지 못하면 {} (모두 켬 — 쉬운 문장). 바깥 트랜잭션을 깨지 않게 savepoint 안에서 읽는다.
    """
    try:
        with transaction.atomic():
            return dict(investor_modes.beginner_modes([user.pk for user in recipients]))
    except Exception as e:
        _warn(f"주린이모드를 읽지 못해 쉬운 문장으로 보냄: {type(e).__name__}: {e}")
        return {}


def _recipients(users) -> list:
    User = get_user_model()
    if users is None:
        return list(User.objects.filter(is_active=True).order_by("id"))
    items = [users] if isinstance(users, User) else list(users)
    return list({user.pk: user for user in items}.values())  # 같은 사람에게 두 번 만들지 않는다


def _enqueue(recipients: list, broadcast: bool, kind: str, title: str, body: str, path: str | None,
             link_label: str | None, embed: dict | None, numbers: str | None = None) -> OutboxMessage | None:
    """Discord 메시지 하나를 편지함에 넣는다. 받는 사람이 모두 Discord를 껐으면 넣지 않는다.

    글: "[모매매 · 모의투자] **제목**" → 받는 사람 멘션 줄 → 쉬운 본문 → 숫자 한 줄 → 링크 줄.
    """
    settings = {s.user_id: s for s in NotificationSetting.objects.filter(user__in=[u.pk for u in recipients])}
    enabled = [u for u in recipients if u.pk not in settings or settings[u.pk].discord_enabled]
    if not enabled:
        return None
    mentions = [] if broadcast else [f"<@{settings[u.pk].discord_user_id}>" for u in enabled
                                     if u.pk in settings and settings[u.pk].discord_user_id]
    lines = [f"{HEADER} **{defuse(title)}**"]
    if mentions:
        lines.append(" ".join(mentions))
    if body:
        lines.append(defuse(body))
    if numbers:
        lines.append(defuse(numbers))
    if path:
        lines.append(f"▶ {link_label or DEFAULT_LINK_LABEL}: {public_url(path)}")
    content = "\n".join(lines)
    embed = fit_embed(_defuse_all(embed)) if embed else embed
    if discord_configured():
        return OutboxMessage.objects.create(kind=kind, content=content, embed=embed)
    print(f"[Discord 알림 (Discord 설정 없음, 보내지 않음)]\n{content}", flush=True)
    return OutboxMessage.objects.create(kind=kind, content=content, embed=embed, status=OutboxMessage.SKIPPED,
                                        last_error=NO_WEBHOOK)


def defuse(text: str) -> str:
    """글 속 멘션(<@ID>·<@!ID>·<@&역할>·@everyone·@here)이 울리지 않게 @ 뒤에 폭 없는 공백을 넣는다."""
    return _MENTION.sub("@" + ZERO_WIDTH_SPACE, text)


def _defuse_all(value):
    if isinstance(value, str):
        return defuse(value)
    if isinstance(value, dict):
        return {k: _defuse_all(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_defuse_all(v) for v in value]
    return value


def _cut(text, limit: int) -> str:
    text = str(text)
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _embed_len(embed: dict) -> int:
    """Discord가 합 6,000자로 세는 글자 수 (제목·설명·필드 이름과 값·footer·author)."""
    texts = [embed.get("title"), embed.get("description")]
    texts += [part for f in embed.get("fields") or [] for part in (f["name"], f["value"])]
    for key, field in (("footer", "text"), ("author", "name")):
        if isinstance(embed.get(key), dict):
            texts.append(embed[key].get(field))
    return sum(len(text) for text in texts if text)


def fit_embed(embed: dict) -> dict:
    """Discord embed 길이 제한에 맞게 자른다 (넘으면 Discord가 400으로 거절한다).

    합이 넘으면 설명을 줄이고, 그래도 넘으면 뒤 필드부터 뺀다.
    """
    e = dict(embed)
    for key, limit in (("title", EMBED_TITLE), ("description", EMBED_DESCRIPTION)):
        if e.get(key) is not None:
            e[key] = _cut(e[key], limit)
    for key, field, limit in (("footer", "text", EMBED_FOOTER), ("author", "name", EMBED_AUTHOR)):
        if isinstance(e.get(key), dict) and e[key].get(field) is not None:
            e[key] = dict(e[key], **{field: _cut(e[key][field], limit)})
    if isinstance(e.get("fields"), list):
        e["fields"] = [dict(f, name=_cut(f.get("name", ""), EMBED_FIELD_NAME),
                            value=_cut(f.get("value", ""), EMBED_FIELD_VALUE))
                       for f in e["fields"] if isinstance(f, dict)][:EMBED_FIELDS]
    over = _embed_len(e) - EMBED_TOTAL
    if over > 0 and e.get("description"):
        e["description"] = _cut(e["description"], max(len(e["description"]) - over, 1))
    while _embed_len(e) > EMBED_TOTAL and e.get("fields"):
        e["fields"] = e["fields"][:-1]
    return e


def _warn(text: str) -> None:
    print(f"[알림 실패] {text}", file=sys.stderr, flush=True)
