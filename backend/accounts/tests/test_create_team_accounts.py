"""python manage.py create_team_accounts: 무작위 계정 생성, 파일 0600, 다시 실행해도 안전.

비밀번호가 테스트 출력에 나오지 않게 비밀번호를 assert 식에 직접 넣지 않는다.
"""
import io
import re
import stat

import pytest
from django.contrib.auth import password_validation
from django.core.management import CommandError, call_command
from django.test import Client

from accounts.models import Profile

pytestmark = pytest.mark.django_db

LINE = re.compile(r"^tm-[a-hjkmnp-z2-9]{5}\t[a-hjkmnp-zA-HJ-NP-Z2-9]{12}$")


def run(path, *args) -> str:
    out = io.StringIO()
    call_command("create_team_accounts", "--out", str(path), *args, stdout=out)
    return out.getvalue()


def read(path) -> list[tuple[str, str]]:
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if not line.startswith("#")]
    return [tuple(line.split("\t")) for line in lines]


def can_login(username, password) -> bool:
    client = Client()
    response = client.post("/api/auth/login", {"username": username, "password": password},
                           content_type="application/json")
    return response.status_code == 200


def test_creates_five_accounts(tmp_path, django_user_model):
    path = tmp_path / "team_accounts.txt"
    output = run(path)

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    text = path.read_text(encoding="utf-8")
    header = [line for line in text.splitlines() if line.startswith("#")]
    assert header and text.startswith("#")
    assert "생성 시각" in header[0]
    assert any("git에 넣지 않는다" in line for line in header)
    body = [line for line in text.splitlines() if not line.startswith("#")]
    assert len(body) == 5
    assert all(LINE.match(line) for line in body), "줄 형식이 '아이디<TAB>비밀번호'가 아니다"

    accounts = read(path)
    assert len({username for username, _ in accounts}) == 5
    for username, password in accounts:
        user = django_user_model.objects.get(username=username)
        assert not user.is_staff and not user.is_superuser and user.is_active
        ok = user.check_password(password)
        assert ok, f"{username}: 파일의 비밀번호가 DB와 다르다"
        password_validation.validate_password(password, user)
        assert Profile.objects.get(user=user).nickname == username
        mixed = all(set(password) & set(group) for group in ("ABCDEFGHJKMNPQRSTUVWXYZ", "abcdefghjkmnpqrstuvwxyz",
                                                              "23456789"))
        assert mixed, f"{username}: 대문자·소문자·숫자가 모두 들어 있지 않다"
    username, password = accounts[0]
    ok = can_login(username, password)
    assert ok, "만든 계정으로 로그인하지 못했다"

    assert "5" in output and str(path) in output
    leaked = any(password in output for _, password in accounts)
    assert not leaked, "표준 출력에 비밀번호가 나왔다"


def test_rerun_is_idempotent(tmp_path, django_user_model):
    path = tmp_path / "team_accounts.txt"
    run(path)
    before = read(path)
    output = run(path)
    same = read(path) == before
    assert same, "다시 실행했더니 파일이 바뀌었다"
    assert django_user_model.objects.count() == 5
    for username, password in before:
        ok = django_user_model.objects.get(username=username).check_password(password)
        assert ok, f"{username}: 다시 실행했더니 비밀번호가 바뀌었다"
    assert "새로 만듦 0" in output


def test_rerun_adds_missing_count(tmp_path, django_user_model):
    path = tmp_path / "team_accounts.txt"
    run(path, "--count", "3")
    before = read(path)
    run(path, "--count", "5")
    after = read(path)
    kept = after[:3] == before
    assert kept, "기존 계정이 바뀌었다"
    assert len(after) == 5
    assert django_user_model.objects.count() == 5
    run(path, "--count", "2")  # 적게 줘도 지우지 않는다
    same = read(path) == after
    assert same, "--count를 적게 줬더니 파일이 바뀌었다"
    assert django_user_model.objects.count() == 5


def test_recreates_account_missing_in_db(tmp_path, django_user_model):
    # 사용자를 지우는 대신 DB에 없는 계정이 든 파일을 만든다 (삭제는 다른 앱 표로 연쇄되므로 이 테스트와 무관하게 둔다)
    path = tmp_path / "team_accounts.txt"
    text = "# 손으로 적은 파일\ntm-abcde\tAbcdefgh2345\ntm-fghjk\tXyzwvuts6789\n"
    path.write_text(text, encoding="utf-8")
    django_user_model.objects.create_user(username="tm-fghjk", password="Xyzwvuts6789")
    username, password = "tm-abcde", "Abcdefgh2345"
    output = run(path, "--count", "2")
    assert path.read_text(encoding="utf-8") == text
    assert django_user_model.objects.count() == 2
    ok = django_user_model.objects.get(username=username).check_password(password)
    assert ok, "파일의 비밀번호로 다시 만들지 않았다"
    assert Profile.objects.filter(user__username=username).exists()
    assert "다시 만듦 1" in output


def test_reset_passwords(tmp_path, django_user_model):
    path = tmp_path / "team_accounts.txt"
    run(path)
    before = dict(read(path))
    output = run(path, "--reset-passwords")
    after = dict(read(path))
    assert list(after) == list(before)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    for username in before:
        user = django_user_model.objects.get(username=username)
        changed = before[username] != after[username]
        old_ok, new_ok = user.check_password(before[username]), user.check_password(after[username])
        assert changed and not old_ok and new_ok, f"{username}: 비밀번호를 바꾸지 않았다"
    leaked = any(password in output for password in after.values())
    assert not leaked, "표준 출력에 비밀번호가 나왔다"


def test_fixes_file_permission(tmp_path):
    path = tmp_path / "team_accounts.txt"
    run(path)
    path.chmod(0o644)
    run(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_default_path_is_repo_root(tmp_path, settings, django_user_model):
    settings.BASE_DIR = tmp_path / "backend"
    out = io.StringIO()
    call_command("create_team_accounts", "--count", "1", stdout=out)
    assert len(read(tmp_path / "team_accounts.txt")) == 1


def test_bad_file_line(tmp_path, django_user_model):
    path = tmp_path / "team_accounts.txt"
    path.write_text("# 주석\ntm-abcde secret-without-tab\n", encoding="utf-8")
    with pytest.raises(CommandError) as error:
        run(path)
    assert "2번째 줄" in str(error.value) and "secret" not in str(error.value)
    assert django_user_model.objects.count() == 0


def test_duplicate_file_line(tmp_path):
    path = tmp_path / "team_accounts.txt"
    path.write_text("tm-abcde\tAbcdefgh2345\ntm-abcde\tAbcdefgh6789\n", encoding="utf-8")
    with pytest.raises(CommandError):
        run(path)


def test_negative_count(tmp_path):
    with pytest.raises(CommandError):
        run(tmp_path / "team_accounts.txt", "--count", "-1")


def test_missing_directory(tmp_path):
    with pytest.raises(CommandError):
        run(tmp_path / "nope" / "team_accounts.txt")
