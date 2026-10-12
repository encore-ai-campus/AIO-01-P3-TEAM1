"""환경 변수 설정 (admin/API.md, docs/plans/OPS_ADMIN_PLAN.md). ADMIN_SECRET_KEY가 32자 미만이면 시작하지 않는다."""
import os
from dataclasses import dataclass
from pathlib import Path

MIN_SECRET_LEN = 32


class ConfigError(RuntimeError):
    """설정이 틀려 시작할 수 없다."""


@dataclass(frozen=True)
class Settings:
    database_url: str
    secret_key: str
    data_dir: Path
    service_url: str = ""
    health_interval_sec: int = 30
    engine_stale_sec: int = 120
    cookie_secure: bool = False
    api_url: str = "http://api:8100"
    deploys_file: Path | None = None

    @property
    def deploys_path(self) -> Path:
        """ADMIN_DEPLOYS_FILE가 있으면 그것 (compose가 호스트의 기록 폴더를 따로 붙인다), 없으면 ADMIN_DATA_DIR/deploys.jsonl."""
        return self.deploys_file or self.data_dir / "deploys.jsonl"

    @property
    def audit_path(self) -> Path:
        return self.data_dir / "audit.jsonl"

    @property
    def tokens_path(self) -> Path:
        return self.data_dir / "mcp_tokens.json"


def _int(env: dict, key: str, default: int) -> int:
    raw = (env.get(key) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{key}는 정수여야 합니다") from None
    if value <= 0:
        raise ConfigError(f"{key}는 0보다 커야 합니다")
    return value


def _flag(env: dict, key: str) -> bool:
    return (env.get(key) or "").strip().lower() in ("on", "1", "true", "yes")


def data_dir(env: dict | None = None) -> Path:
    """ADMIN_DATA_DIR (기본 ./data). 토큰 CLI처럼 비밀 키 없이 쓰는 곳도 이것만 읽는다."""
    env = os.environ if env is None else env
    return Path((env.get("ADMIN_DATA_DIR") or "").strip() or "./data")


def load(env: dict | None = None) -> Settings:
    """환경 변수에서 읽는다. 틀리면 ConfigError."""
    env = os.environ if env is None else env
    secret = env.get("ADMIN_SECRET_KEY") or ""
    if len(secret) < MIN_SECRET_LEN:
        raise ConfigError(f"ADMIN_SECRET_KEY는 {MIN_SECRET_LEN}자 이상이어야 합니다")
    url = (env.get("ADMIN_DATABASE_URL") or "").strip()
    if not url.startswith(("postgresql://", "postgres://", "sqlite:///")):
        raise ConfigError("ADMIN_DATABASE_URL은 postgresql://... 또는 sqlite:///경로 여야 합니다")
    return Settings(
        database_url=url,
        secret_key=secret,
        data_dir=data_dir(env),
        service_url=(env.get("ADMIN_SERVICE_URL") or "").strip().rstrip("/"),
        health_interval_sec=_int(env, "ADMIN_HEALTH_INTERVAL_SEC", 30),
        engine_stale_sec=_int(env, "ADMIN_ENGINE_STALE_SEC", 120),
        cookie_secure=_flag(env, "ADMIN_COOKIE_SECURE"),
        api_url=((env.get("ADMIN_API_URL") or "").strip() or "http://api:8100").rstrip("/"),
        deploys_file=Path(env["ADMIN_DEPLOYS_FILE"].strip()) if (env.get("ADMIN_DEPLOYS_FILE") or "").strip() else None,
    )
