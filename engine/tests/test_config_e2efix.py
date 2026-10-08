"""BROKER=toss 허용 조건: DJANGO_DEBUG 또는 ALLOW_TOSS_BROKER (docs/DECISIONS.md 3-1·23장, OPS-1)."""
import pytest

from paper_engine import config
from paper_engine.config import ConfigError, load_config

TRUE_VALUES = ["on", "ON", "true", "1", "yes"]
FALSE_VALUES = ["off", "false", "0", "no", ""]


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(config, "REPO_ROOT", config.REPO_ROOT / "no-such-dir")  # 저장소 .env를 읽지 않는다
    for key in ("BROKER", "DJANGO_DEBUG", "ALLOW_TOSS_BROKER", "KIWOOM_APPKEY", "KIWOOM_SECRETKEY", "POSTGRES_HOST"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BROKER", "toss")
    monkeypatch.setenv("CLIENT_ID", "id")
    monkeypatch.setenv("CLIENT_SECRET", "secret")
    return monkeypatch


def test_toss_allowed_when_debug_off_but_allow_toss_broker_on(env):
    """운영 임시: DJANGO_DEBUG=off여도 ALLOW_TOSS_BROKER=on이면 토스를 받는다 (키움 키를 받기 전까지)."""
    env.setenv("DJANGO_DEBUG", "off")
    env.setenv("ALLOW_TOSS_BROKER", "on")
    cfg = load_config()
    assert cfg.broker == "toss" and cfg.broker_ready


def test_toss_allowed_when_only_allow_toss_broker_is_set(env):
    env.setenv("ALLOW_TOSS_BROKER", "on")  # DJANGO_DEBUG 자체가 없어도 된다
    assert load_config(require_broker=False).broker == "toss"


@pytest.mark.parametrize("value", TRUE_VALUES)
def test_allow_toss_broker_accepts_the_same_true_values_as_debug(env, value):
    env.setenv("DJANGO_DEBUG", "off")
    env.setenv("ALLOW_TOSS_BROKER", value)
    assert load_config(require_broker=False).broker == "toss"


@pytest.mark.parametrize("value", TRUE_VALUES)
def test_debug_alone_still_allows_toss(env, value):
    env.setenv("DJANGO_DEBUG", value)
    assert load_config(require_broker=False).broker == "toss"


@pytest.mark.parametrize("debug", [None, "off", ""])
@pytest.mark.parametrize("allow", [None, "off", "false", "0", "no", ""])
def test_toss_refused_when_both_are_off(env, debug, allow):
    if debug is not None:
        env.setenv("DJANGO_DEBUG", debug)
    if allow is not None:
        env.setenv("ALLOW_TOSS_BROKER", allow)
    for require_broker in (True, False):
        with pytest.raises(ConfigError, match="ALLOW_TOSS_BROKER"):
            load_config(require_broker=require_broker)


def test_allow_toss_broker_does_not_change_the_default_broker(env):
    """ALLOW_TOSS_BROKER는 허용만 한다. BROKER를 주지 않으면 키움이다."""
    env.delenv("BROKER")
    env.setenv("ALLOW_TOSS_BROKER", "on")
    cfg = load_config(require_broker=False)
    assert cfg.broker == "kiwoom" and not cfg.broker_ready


def test_kiwoom_never_needs_the_toss_switches(env):
    env.setenv("BROKER", "kiwoom")
    env.setenv("DJANGO_DEBUG", "off")
    env.setenv("ALLOW_TOSS_BROKER", "off")
    assert load_config(require_broker=False).broker == "kiwoom"
