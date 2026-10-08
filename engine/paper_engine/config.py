"""설정 로딩. 값은 환경변수가 우선이고, 없으면 저장소 루트의 .env에서 읽는다. 키 설명은 docs/DECISIONS.md 2장.

실행 데이터(data/, runs/, .cache/)는 ROOT 아래에 둔다. ROOT는 PAPER_ROOT(환경변수 또는 .env)가 있으면 그 경로,
없으면 저장소 루트다 (컨테이너에서는 볼륨 경로).
"""
import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
KIWOOM_BASE_URL = "https://api.kiwoom.com"
# 증권사(BROKER) → 조회에 필요한 키. 운영은 kiwoom, toss는 로컬 개발 환경(DJANGO_DEBUG=on) 전용이다.
# 예외: 키움 키를 받기 전 운영 임시로 ALLOW_TOSS_BROKER=on (docs/DECISIONS.md 3-1·23장)
BROKER_KEYS = {"kiwoom": ("KIWOOM_APPKEY", "KIWOOM_SECRETKEY"), "toss": ("CLIENT_ID", "CLIENT_SECRET")}
SUPPORTED_MARKETS = ("KR", "US")
TRUTHY = ("on", "true", "1", "yes")
DEFAULT_COMMISSION = {"KR": 0.00015, "US": 0.00015}


def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip().upper()] = value.strip().strip('"').strip("'")
    return env


def _root() -> Path:
    value = os.environ.get("PAPER_ROOT") or load_env(REPO_ROOT / ".env").get("PAPER_ROOT")
    return Path(value).expanduser().resolve() if value else REPO_ROOT


ROOT = _root()


# 모델 크기별 의결권 비중. 모델 목록과 각 모델의 크기는 .env에서 정한다.
SIZE_WEIGHTS = {"large": 4, "medium": 2, "small": 1}


@dataclass(frozen=True)
class ModelSpec:
    id: str
    size: str


def parse_analysts(text: str) -> tuple[ModelSpec, ...]:
    """'모델ID:크기'를 쉼표로 이은 문자열을 읽는다."""
    specs = []
    for item in _split(text):
        model_id, _, size = item.partition(":")
        if size not in SIZE_WEIGHTS:
            raise ValueError(f"ANALYSTS의 '{item}': 크기는 {', '.join(SIZE_WEIGHTS)} 중 하나여야 합니다.")
        specs.append(ModelSpec(model_id, size))
    ids = [s.id for s in specs]
    if len(specs) < 2:
        raise ValueError("ANALYSTS에는 모델이 2개 이상 있어야 교차검증을 할 수 있습니다.")
    if len(set(ids)) != len(ids):
        raise ValueError("ANALYSTS에 같은 모델이 두 번 들어 있습니다.")
    return tuple(specs)


def _split(text: str) -> list[str]:
    return [x.strip() for x in text.split(",") if x.strip()]


def vote_weights(specs: tuple[ModelSpec, ...]) -> dict[str, float]:
    """모델별 의결권. 합이 1이 되게 나눈다."""
    total = sum(SIZE_WEIGHTS[s.size] for s in specs)
    return {s.id: SIZE_WEIGHTS[s.size] / total for s in specs}


@dataclass(frozen=True)
class Config:
    kiwoom_appkey: str | None
    kiwoom_secretkey: str | None
    token_cache: Path | None  # 키움 토큰 캐시
    llm_api_key: str | None = None
    analysts: tuple[ModelSpec, ...] = ()
    researchers: tuple[str, ...] = ()
    approver: str | None = None
    required_models: tuple[str, ...] = ()  # 시간 초과되면 분석을 중단할 핵심 모델
    dart_api_key: str | None = None
    data_gokr_api_key: str | None = None  # data.go.kr: 기업 재무정보(연간 실적 추이)와 특일 정보(국내 공휴일)
    sec_contact_email: str | None = None
    kiwoom_base_url: str = KIWOOM_BASE_URL
    markets: tuple[str, ...] = ("KR",)  # 운영할 시장. serve 루프·시장 기록·일일 리포트는 이 시장만 돈다
    paper_capital_krw: float = 10_000_000  # 모의 계좌 초기 자금 (계좌를 처음 만들 때만 쓴다)
    commission: dict = field(default_factory=lambda: dict(DEFAULT_COMMISSION))  # 시장별 모의 수수료율
    max_total_invest_krw: float | None = None  # 자동 관리 포지션 총 금액 한도 (원). None이면 두지 않는다
    discord_webhook_url: str | None = field(default=None, repr=False)  # 팀 Discord 채널 Webhook (비밀 값). 있으면 먼저 쓴다
    openclaw_target: str | None = None  # 팀 채널 알림 대상 (channel:<ID>). Webhook도 이것도 없으면 콘솔
    openclaw_bin: str = "openclaw"
    redis_url: str | None = None  # 예약 주문·전략·생존 신호. 없으면 예약과 전략이 꺼진다
    backup_dir: Path | None = None  # 없으면 data/backups
    chrome_bin: str | None = None  # 리포트 PDF를 만들 Chrome. 없으면 PATH에서 찾는다
    broker: str = "kiwoom"  # 조회에 쓸 증권사 (BROKER_KEYS). toss는 로컬 개발 환경 전용
    toss_client_id: str | None = None
    toss_client_secret: str | None = None
    toss_token_cache: Path | None = None

    @property
    def weights(self) -> dict[str, float]:
        return vote_weights(self.analysts)

    @property
    def broker_ready(self) -> bool:
        """고른 증권사의 조회 키가 다 있는지."""
        if self.broker == "toss":
            return bool(self.toss_client_id and self.toss_client_secret)
        return bool(self.kiwoom_appkey and self.kiwoom_secretkey)


def parse_limit(text: str | None, default: float | None) -> float | None:
    """금액 한도. 비어 있으면 기본값, 0이나 off면 한도 없음. 쉼표와 밑줄은 무시한다."""
    text = (text or "").strip().lower().replace(",", "").replace("_", "")
    if not text:
        return default
    if text in ("off", "none", "0"):
        return None
    value = float(text)
    if value < 0:
        raise ValueError(f"한도는 0 이상이어야 합니다: {text}")
    return value


class ConfigError(RuntimeError):
    """필수 설정이 없거나 잘못됨. CLI는 이 메시지만 보여 주고 끝낸다."""


def parse_markets(text: str | None) -> tuple[str, ...]:
    """'KR' 또는 'KR,US'. 비어 있으면 KR."""
    markets = tuple(dict.fromkeys(m.upper() for m in _split(text or "KR")))
    unknown = [m for m in markets if m not in SUPPORTED_MARKETS]
    if unknown or not markets:
        raise ValueError(f"MARKETS는 {', '.join(SUPPORTED_MARKETS)} 중에서 고릅니다: {text}")
    return markets


def _rate(text: str | None) -> float:
    value = float(text) if text not in (None, "") else DEFAULT_COMMISSION["KR"]
    if not 0 <= value < 0.01:
        raise ValueError(f"수수료율은 0 이상 0.01 미만의 소수 비율입니다: {text}")
    return value


def _env() -> dict:
    env = load_env(REPO_ROOT / ".env")
    env.update({k.upper(): v for k, v in os.environ.items()})
    return env


def _is_on(value: str | None) -> bool:
    return (value or "").lower() in TRUTHY


def parse_broker(env: dict) -> str:
    """BROKER. 비어 있으면 kiwoom. toss는 로컬 개발 환경에서만 고를 수 있다.

    개발 환경은 DJANGO_DEBUG가 켜져 있는지로 가린다 (운영은 DJANGO_DEBUG=off다). 로컬에서도 PostgreSQL을 쓸 수 있어서
    DB 종류로는 가리지 않는다. 예외로 ALLOW_TOSS_BROKER가 켜져 있으면 DEBUG가 꺼져 있어도 받는다 — 키움 키를 받기 전
    운영 임시용이다 (토스 때문에 운영 DEBUG를 켜 두지 않으려고. docs/DECISIONS.md 3-1·23장).
    """
    broker = (env.get("BROKER") or "kiwoom").lower()
    if broker not in BROKER_KEYS:
        raise ConfigError(f"BROKER는 {', '.join(BROKER_KEYS)} 중에서 고릅니다: {broker}")
    if broker == "toss" and not (_is_on(env.get("DJANGO_DEBUG")) or _is_on(env.get("ALLOW_TOSS_BROKER"))):
        raise ConfigError("BROKER=toss는 로컬 개발 환경 전용입니다 (DJANGO_DEBUG=on이거나 ALLOW_TOSS_BROKER=on일 때만). "
                          "운영은 키움만 씁니다.")
    return broker


def load_config(require_broker: bool = True) -> Config:
    """require_broker가 False면 증권사 키가 없어도 된다 (조회 없이 기록만 보는 명령: account, orders, halt 등)."""
    env = _env()
    broker = parse_broker(env)
    missing = [k for k in BROKER_KEYS[broker] if not env.get(k)]
    if require_broker and missing:
        raise ConfigError(f".env 또는 환경변수에 {', '.join(missing)} 값이 없습니다.")
    return Config(
        broker=broker,
        toss_client_id=env.get("CLIENT_ID") or None,
        toss_client_secret=env.get("CLIENT_SECRET") or None,
        toss_token_cache=ROOT / ".cache" / "toss_token.json",
        kiwoom_appkey=env.get("KIWOOM_APPKEY") or None,
        kiwoom_secretkey=env.get("KIWOOM_SECRETKEY") or None,
        token_cache=Path(env.get("KIWOOM_TOKEN_CACHE") or ROOT / ".cache" / "kiwoom_token.json"),
        kiwoom_base_url=env.get("KIWOOM_BASE_URL") or KIWOOM_BASE_URL,
        llm_api_key=env.get("DEVPASS_APIKEY"),
        analysts=parse_analysts(env["ANALYSTS"]) if env.get("ANALYSTS") else (),
        researchers=tuple(_split(env.get("RESEARCHERS", ""))),
        approver=env.get("APPROVER") or None,
        required_models=tuple(_split(env.get("REQUIRED_MODELS", ""))),
        dart_api_key=env.get("DART_API_KEY"),
        data_gokr_api_key=env.get("DATA_GOKR_API") or None,
        sec_contact_email=env.get("SEC_CONTACT_EMAIL"),
        markets=parse_markets(env.get("MARKETS")),
        paper_capital_krw=float(env.get("PAPER_CAPITAL_KRW") or 10_000_000),
        commission={"KR": _rate(env.get("PAPER_COMMISSION_KR")), "US": _rate(env.get("PAPER_COMMISSION_US"))},
        max_total_invest_krw=parse_limit(env.get("MAX_TOTAL_INVEST_KRW"), None),
        discord_webhook_url=env.get("DISCORD_WEBHOOK_URL") or None,
        openclaw_target=env.get("OPENCLAW_TARGET") or None,
        openclaw_bin=env.get("OPENCLAW_BIN") or "openclaw",
        redis_url=env.get("REDIS_URL") or None,
        backup_dir=Path(env["BACKUP_DIR"]).expanduser() if env.get("BACKUP_DIR") else None,
        chrome_bin=env.get("CHROME_BIN") or None,
    )
