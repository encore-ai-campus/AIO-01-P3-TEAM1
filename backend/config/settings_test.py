"""테스트 설정 (pytest-django). 비밀 키가 없어도 돌게 테스트용 값을 넣고 기본 설정을 그대로 쓴다."""
import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-insecure-secret-key")

from .settings import *  # noqa: E402,F401,F403

# 테스트는 SQLite 메모리 DB에서 돈다. 개발자 .env가 PostgreSQL(팀이 같이 보는 개발 DB)을 가리켜도 그 서버를 건드리지 않는다.
# 운영과 같은 PostgreSQL로 검사할 때만(CI) TEST_WITH_POSTGRES=1을 주면 .env·환경 변수의 POSTGRES_* 설정을 그대로 쓴다.
if os.environ.get("TEST_WITH_POSTGRES", "").lower() not in ("1", "on", "true", "yes"):
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}

# 테스트에서 계정을 많이 만든다. 느린 기본 해시(PBKDF2) 대신 빠른 해시를 쓴다.
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# 테스트는 로그인을 많이 한다. 시도 제한에 걸리지 않게 넉넉히 둔다 (제한 자체는 따로 검사한다).
REST_FRAMEWORK = {**REST_FRAMEWORK, "DEFAULT_THROTTLE_RATES": {"login": "10000/min"}}  # noqa: F405
