"""알림 접점 (docs/DECISIONS.md 12-4). 다른 앱은 알림을 이 모듈의 notify로만 만든다.

    from notifications import service as notices
    notices.notify(user, "filled", "삼성전자 진입 체결", "71,000원 × 28주", link="/plans/3")

뼈대: 서명과 약속만 있다. 구현은 notifications 작업이 채운다 (웹 알림 행 + Discord 보낼 편지함).
"""


def notify(users, kind: str, title: str, body: str, *, link: str | None = None, discord: bool = True,
           discord_link: str | None = None, link_label: str | None = None, embed: dict | None = None) -> list:
    """알림을 만든다. 만든 웹 알림(Notification) 목록을 돌려준다. 예외를 밖으로 내지 않는다 (알림 실패가 매매를 막지 않게).

    users: User 하나, User 목록, 또는 None(= 활성 사용자 전체. Discord에는 멘션 없이 한 번만).
    kind: docs/API.md NotificationKind. title·body: 사람이 읽는 말 (비밀 값·로그인 아이디를 넣지 않는다).
    link: 웹 경로 ("/plans/3"). 웹 알림과 Discord 메시지에 쓴다.
    discord: False면 웹 알림만. discord_link: Discord 메시지에만 쓸 경로 (예: 서명된 활성화 링크). 없으면 link.
    link_label: Discord 메시지의 링크 앞 글 ("계획 활성화"). embed: Discord embed 하나 (title·description·url·color·fields).
    """
    return []
