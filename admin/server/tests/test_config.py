"""환경 변수 설정."""
from pathlib import Path

import pytest

from paper_admin.config import ConfigError, load

BASE = {"ADMIN_SECRET_KEY": "k" * 32, "ADMIN_DATABASE_URL": "sqlite:///x.db"}


def test_defaults():
    s = load(BASE)
    assert s.data_dir == Path("./data") and s.deploys_path == Path("./data/deploys.jsonl")
    assert (s.service_url, s.health_interval_sec, s.engine_stale_sec, s.cookie_secure, s.api_url) == (
        "", 30, 120, False, "http://api:8100")


def test_overrides():
    s = load({**BASE, "ADMIN_DATA_DIR": "/data", "ADMIN_DEPLOYS_FILE": "/records/deploys.jsonl",
              "ADMIN_SERVICE_URL": "http://svc/", "ADMIN_COOKIE_SECURE": "on", "ADMIN_HEALTH_INTERVAL_SEC": "10"})
    assert s.deploys_path == Path("/records/deploys.jsonl") and s.audit_path == Path("/data/audit.jsonl")
    assert s.service_url == "http://svc" and s.cookie_secure is True and s.health_interval_sec == 10


@pytest.mark.parametrize("env", [{**BASE, "ADMIN_SECRET_KEY": "k" * 31}, {**BASE, "ADMIN_SECRET_KEY": ""},
                                 {**BASE, "ADMIN_DATABASE_URL": "mysql://x"}, {**BASE, "ADMIN_ENGINE_STALE_SEC": "x"}])
def test_refuses_bad_config(env):
    with pytest.raises(ConfigError):
        load(env)
