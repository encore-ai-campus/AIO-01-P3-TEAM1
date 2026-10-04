"""Discord 활성화 링크의 서명 (docs/API.md "Discord 활성화 링크"). token = 추천 id + 만료(validUntil)를 서버가 서명한 값."""
from django.core import signing

from .models import Recommendation

SALT = "autotrade.activate"


def activation_token(rec: Recommendation) -> str:
    return signing.dumps({"r": rec.id}, salt=SALT)


def check_token(rec: Recommendation, token: str) -> bool:
    """추천 id가 맞고, 만든 때부터 validUntil까지 안이면 True."""
    max_age = max((rec.valid_until - rec.created_at).total_seconds(), 0)
    try:
        data = signing.loads(token, salt=SALT, max_age=max_age)
    except (signing.BadSignature, TypeError, ValueError):  # 만료(SignatureExpired)도 BadSignature다
        return False
    return isinstance(data, dict) and data.get("r") == rec.id
