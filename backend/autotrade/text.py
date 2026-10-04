"""알림·사건 메시지에 쓰는 숫자 표기 (천 단위 쉼표). 엔진 executor의 표기와 같다."""
from datetime import datetime

from paper_engine.agents.executor import money, qty_text, signed_money
from trading.store import KST

__all__ = ["money", "qty_text", "signed_money", "pct", "when"]


def pct(rate: float) -> str:
    """+12.3% / -4.5%."""
    return f"{rate * 100:+.1f}%"


def when(at: datetime) -> str:
    """10-07 15:30 (KST)."""
    return f"{at.astimezone(KST):%m-%d %H:%M}"
