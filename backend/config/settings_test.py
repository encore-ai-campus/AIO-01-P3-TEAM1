"""테스트 설정 (pytest-django). 비밀 키가 없어도 돌게 테스트용 값을 넣고 기본 설정을 그대로 쓴다."""
import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-insecure-secret-key")

from .settings import *  # noqa: E402,F401,F403
