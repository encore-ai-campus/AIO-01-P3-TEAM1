"""팀원 계정을 무작위 아이디·비밀번호로 만들고 파일(0600)에 적는다 (docs/DECISIONS.md 8-1).

    python manage.py create_team_accounts [--count 5] [--out PATH] [--reset-passwords]

다시 실행해도 안전하다: 파일에 있고 DB에도 있는 계정은 그대로 두고, 모자란 수만 새로 만들어 파일에 더한다.
파일에 있는데 DB에 없는 계정은 파일의 아이디·비밀번호로 다시 만든다. `--reset-passwords`는 파일의 계정 비밀번호를
새로 만들어 DB와 파일을 같이 바꾼다. 비밀번호는 파일에만 적고 표준 출력에는 찍지 않는다.
"""
import os
import secrets
import string
import tempfile
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model, password_validation
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from accounts.models import Profile

AMBIGUOUS = set("0Oo1lIi")  # 손으로 옮겨 적을 때 헷갈리는 글자
LOWER = "".join(c for c in string.ascii_lowercase if c not in AMBIGUOUS)
UPPER = "".join(c for c in string.ascii_uppercase if c not in AMBIGUOUS)
DIGITS = "".join(c for c in string.digits if c not in AMBIGUOUS)
USERNAME_PREFIX, USERNAME_LENGTH, PASSWORD_LENGTH = "tm-", 5, 12
TRIES = 100
FILE_NAME = "team_accounts.txt"


def new_username(taken: set[str]) -> str:
    """`tm-` + 소문자·숫자 5자. 파일·DB의 아이디, 다른 사람의 닉네임과 겹치지 않게 (대소문자 무시)."""
    user_model = get_user_model()
    for _ in range(TRIES):
        username = USERNAME_PREFIX + "".join(secrets.choice(LOWER + DIGITS) for _ in range(USERNAME_LENGTH))
        if (username in taken
                or user_model.objects.filter(**{f"{user_model.USERNAME_FIELD}__iexact": username}).exists()
                or Profile.objects.filter(nickname__iexact=username).exists()):
            continue
        return username
    raise CommandError("겹치지 않는 아이디를 만들지 못했습니다.")


def new_password(user) -> str:
    """영문 대소문자·숫자 12자 (세 종류가 모두 들어감). Django 비밀번호 검증(AUTH_PASSWORD_VALIDATORS)을 통과해야 한다."""
    alphabet = LOWER + UPPER + DIGITS
    for _ in range(TRIES):
        password = "".join(secrets.choice(alphabet) for _ in range(PASSWORD_LENGTH))
        if not all(set(password) & set(group) for group in (LOWER, UPPER, DIGITS)):
            continue
        try:
            password_validation.validate_password(password, user)
        except ValidationError:
            continue
        return password
    raise CommandError("비밀번호 검증을 통과하는 비밀번호를 만들지 못했습니다 (AUTH_PASSWORD_VALIDATORS 확인).")


def read_accounts(path: Path) -> list[tuple[str, str]]:
    """파일의 (아이디, 비밀번호) 목록. 파일이 없으면 []. `#` 줄과 빈 줄은 건너뛴다."""
    if not path.exists():
        return []
    accounts, seen = [], set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = [part.strip() for part in line.split("\t")]
        if len(parts) != 2 or not all(parts):
            # 줄 내용은 비밀번호가 섞여 있을 수 있어 찍지 않는다
            raise CommandError(f"{path} {number}번째 줄이 '아이디<TAB>비밀번호' 형식이 아닙니다.")
        username, password = parts
        if username in seen:
            raise CommandError(f"{path} {number}번째 줄: 아이디 {username}이(가) 두 번 나옵니다.")
        seen.add(username)
        accounts.append((username, password))
    return accounts


def write_accounts(path: Path, accounts: list[tuple[str, str]]) -> None:
    """권한 0600으로 임시 파일에 쓰고 바꿔 끼운다 (쓰다 실패해도 기존 파일이 남는다)."""
    lines = [
        f"# 팀 계정 (python manage.py create_team_accounts). 생성 시각 {timezone.localtime().isoformat(timespec='seconds')}",
        "# 비밀번호가 들어 있다. 이 파일은 git에 넣지 않는다 (.gitignore). 팀원에게는 각자 자기 줄만 따로 전한다.",
        "# 형식: 아이디<TAB>비밀번호",
        *(f"{username}\t{password}" for username, password in accounts),
    ]
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)  # mkstemp는 0600으로 만든다
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            os.fchmod(file.fileno(), 0o600)
            file.write("\n".join(lines) + "\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class Command(BaseCommand):
    help = "팀원 계정을 무작위 아이디·비밀번호로 만들고 파일(0600)에 적는다. 다시 실행해도 안전하다."

    def add_arguments(self, parser):
        parser.add_argument("--count", type=int, default=5, help="파일에 있어야 할 계정 수 (기본 5). 모자란 수만 만든다.")
        parser.add_argument("--out", default=None, help=f"계정 파일 (기본: 저장소 루트의 {FILE_NAME})")
        parser.add_argument("--reset-passwords", action="store_true", help="파일의 계정 비밀번호를 새로 만들어 DB와 파일을 같이 바꾼다")

    def handle(self, *args, count: int, out: str | None, reset_passwords: bool, **options):
        if count < 0:
            raise CommandError("--count는 0 이상이어야 합니다.")
        path = Path(out).expanduser() if out else Path(settings.BASE_DIR).parent / FILE_NAME
        if path.is_dir() or not path.parent.is_dir():
            raise CommandError(f"계정 파일을 쓸 수 없는 경로입니다: {path}")

        user_model = get_user_model()
        accounts = read_accounts(path)
        created = recreated = reset = kept = 0
        with transaction.atomic():  # 파일 쓰기가 실패하면 DB 변경도 되돌린다
            result = []
            for username, password in accounts:
                user = user_model.objects.filter(**{user_model.USERNAME_FIELD: username}).first()
                if reset_passwords:
                    password = new_password(user or user_model(**{user_model.USERNAME_FIELD: username}))
                    reset += 1
                if user is None:
                    user_model.objects.create_user(**{user_model.USERNAME_FIELD: username}, password=password)
                    recreated += 1
                elif reset_passwords:
                    user.set_password(password)
                    user.save(update_fields=["password"])
                else:
                    kept += 1
                result.append((username, password))

            taken = {username.lower() for username, _ in result}
            for _ in range(count - len(result)):
                username = new_username(taken)
                taken.add(username)
                password = new_password(user_model(**{user_model.USERNAME_FIELD: username}))
                user_model.objects.create_user(**{user_model.USERNAME_FIELD: username}, password=password)
                result.append((username, password))
                created += 1

            if created or reset:
                write_accounts(path, result)
            elif path.exists():
                os.chmod(path, 0o600)

        self.stdout.write(f"팀 계정 {len(result)}개: 새로 만듦 {created}, 다시 만듦 {recreated}, "
                          f"비밀번호 바꿈 {reset}, 그대로 {kept}")
        self.stdout.write(f"계정 파일: {path} ({'갱신' if created or reset else '변경 없음'}, 권한 0600)")
