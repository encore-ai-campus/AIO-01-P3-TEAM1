import pytest


@pytest.fixture(autouse=True)
def fast_password_hasher(settings):
    """테스트에서는 빠른 해시를 쓴다 (기본 PBKDF2는 계정 하나에 수백 ms)."""
    settings.PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
