"""엔진(paper_engine) 접점. 웹과 관리 명령은 엔진 설정과 증권사 조회 클라이언트를 여기서만 얻는다 (docs/DECISIONS.md 8-2).

다른 모듈은 `from config import engine` 뒤 `engine.broker_client()`처럼 모듈을 거쳐 부른다
(`from config.engine import broker_client`로 이름을 가져가지 않는다). 그래야 테스트가
`monkeypatch.setattr(engine, "broker_client", lambda: fake)`로 가짜 클라이언트를 끼울 수 있다.
테스트에서는 루트 conftest.py가 증권사 키를 비우므로 가짜를 끼우지 않으면 broker_client()는 None이다.
"""
import threading

from paper_engine.config import ROOT, Config, load_config
from paper_engine.data.broker import BrokerClient, make_client
from paper_engine.notify import Notifier, make_notifier

DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / ".cache"
RUNS_DIR = ROOT / "runs"            # 엔진이 남기는 AI 분석 실행 기록 (JSON·PDF)
HALT_FILE = DATA_DIR / "HALT"       # 새 모의 매수 중단 스위치 (엔진 CLI의 halt/resume와 같은 파일)

_lock = threading.Lock()
_config: Config | None = None
_client: BrokerClient | None = None


def engine_config() -> Config:
    """엔진 설정 (.env + 환경 변수). 프로세스에서 한 번 읽는다."""
    global _config
    with _lock:
        if _config is None:
            _config = load_config(require_broker=False)
        return _config


def broker_client() -> BrokerClient | None:
    """증권사 조회 클라이언트. 프로세스에 하나만 둔다 (호출 간격 조절·토큰 공유). 조회 키가 없으면 None."""
    global _client
    cfg = engine_config()
    if not cfg.broker_ready:
        return None
    with _lock:
        if _client is None:
            _client = make_client(cfg, CACHE_DIR)
        return _client


def notifier() -> Notifier:
    """팀 채널 알림 (docs/DECISIONS.md 12-4): DISCORD_WEBHOOK_URL이 있으면 Webhook > OPENCLAW_TARGET이 있으면 openclaw > 콘솔.

    테스트는 `monkeypatch.setattr(engine, "notifier", lambda: fake)`로 가짜를 끼운다.
    """
    return make_notifier(engine_config())
