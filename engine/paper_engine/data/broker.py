"""증권사 조회 클라이언트를 설정(BROKER)에 따라 만든다 (docs/DECISIONS.md 3장).

운영은 키움(KiwoomClient)이다. 토스(TossClient)는 로컬 개발 환경(DJANGO_DEBUG=on)에서만 고를 수 있다 (config.load_config가 막는다).
두 클라이언트의 공개 메서드 이름·인자·반환 형식은 같다.
"""
from pathlib import Path

from .calendar import MarketCalendar
from .kiwoom import KiwoomClient
from .toss import TossClient

BrokerClient = KiwoomClient | TossClient


def make_client(cfg, cache_dir: Path) -> BrokerClient:
    """cfg.broker의 조회 클라이언트. cache_dir는 장 달력의 공휴일 캐시 위치 (키움만 쓴다)."""
    if cfg.broker == "toss":
        return TossClient(cfg.toss_client_id, cfg.toss_client_secret, cfg.toss_token_cache)
    return KiwoomClient(cfg.kiwoom_appkey, cfg.kiwoom_secretkey, cfg.token_cache,
                        MarketCalendar(cfg.data_gokr_api_key, cache_dir), cfg.kiwoom_base_url)
