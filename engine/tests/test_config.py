import pytest

from paper_engine.config import ModelSpec, parse_analysts, parse_limit, vote_weights

TEXT = "big:large, mid-a:medium,mid-b:medium, small-a:small,small-b:small,"


def test_parse_analysts():
    specs = parse_analysts(TEXT)
    assert specs[0] == ModelSpec("big", "large")
    assert [s.id for s in specs] == ["big", "mid-a", "mid-b", "small-a", "small-b"]


def test_weights_follow_size_and_sum_to_one():
    w = vote_weights(parse_analysts(TEXT))
    assert w == {"big": 0.4, "mid-a": 0.2, "mid-b": 0.2, "small-a": 0.1, "small-b": 0.1}
    assert sum(w.values()) == pytest.approx(1)


@pytest.mark.parametrize("text", [
    "a:huge,b:small",   # 없는 크기
    "a:large",          # 모델 1개
    "a:large,a:small",  # 중복
    "a,b:small",        # 크기 누락
])
def test_parse_analysts_rejects_bad_input(text):
    with pytest.raises(ValueError):
        parse_analysts(text)


def test_parse_limit():
    assert parse_limit(None, 2_000_000) == 2_000_000 and parse_limit("", 2_000_000) == 2_000_000
    assert parse_limit("3,000,000", 2_000_000) == 3_000_000 and parse_limit("1_500_000", None) == 1_500_000
    assert parse_limit("off", 2_000_000) is None and parse_limit("0", 2_000_000) is None
    with pytest.raises(ValueError):
        parse_limit("-1", None)
    with pytest.raises(ValueError):
        parse_limit("200만원", None)


KEYS = ("KIWOOM_APPKEY", "KIWOOM_SECRETKEY", "KIWOOM_BASE_URL", "KIWOOM_TOKEN_CACHE", "MARKETS", "PAPER_CAPITAL_KRW",
        "PAPER_COMMISSION_KR", "PAPER_COMMISSION_US", "MAX_TOTAL_INVEST_KRW", "OPENCLAW_TARGET", "OPENCLAW_BIN",
        "BROKER", "CLIENT_ID", "CLIENT_SECRET", "POSTGRES_HOST")


@pytest.fixture
def env(monkeypatch):
    from paper_engine import config
    monkeypatch.setattr(config, "REPO_ROOT", config.REPO_ROOT / "no-such-dir")  # 저장소 .env를 읽지 않는다
    for key in KEYS:
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


def test_load_config_defaults_and_kiwoom_keys(env):
    from paper_engine.config import ROOT, ConfigError, load_config
    with pytest.raises(ConfigError, match="KIWOOM_APPKEY, KIWOOM_SECRETKEY"):
        load_config()
    cfg = load_config(require_broker=False)
    assert cfg.kiwoom_appkey is None and cfg.markets == ("KR",) and cfg.paper_capital_krw == 10_000_000
    assert cfg.commission == {"KR": 0.00015, "US": 0.00015} and cfg.max_total_invest_krw is None
    assert cfg.kiwoom_base_url == "https://api.kiwoom.com" and cfg.token_cache == ROOT / ".cache" / "kiwoom_token.json"
    assert cfg.openclaw_target is None and cfg.openclaw_bin == "openclaw"
    for removed in ("client_id", "client_secret", "live_trading", "openclaw_user_id", "openclaw_state_dir"):
        assert not hasattr(cfg, removed)


def test_load_config_reads_paper_settings(env):
    from paper_engine.config import load_config
    for key, value in (("KIWOOM_APPKEY", "app"), ("KIWOOM_SECRETKEY", "secret"), ("MARKETS", "kr, US"),
                       ("PAPER_CAPITAL_KRW", "5000000"), ("PAPER_COMMISSION_US", "0.0007"),
                       ("MAX_TOTAL_INVEST_KRW", "3,000,000"), ("OPENCLAW_TARGET", "channel:42"),
                       ("KIWOOM_BASE_URL", "https://mockapi.kiwoom.com")):
        env.setenv(key, value)
    cfg = load_config()
    assert (cfg.kiwoom_appkey, cfg.kiwoom_secretkey, cfg.markets) == ("app", "secret", ("KR", "US"))
    assert cfg.paper_capital_krw == 5_000_000 and cfg.commission == {"KR": 0.00015, "US": 0.0007}
    assert cfg.max_total_invest_krw == 3_000_000 and cfg.openclaw_target == "channel:42"
    assert cfg.kiwoom_base_url == "https://mockapi.kiwoom.com"


@pytest.mark.parametrize("key,value", [("MARKETS", "KR,JP"), ("PAPER_COMMISSION_KR", "0.5")])
def test_load_config_rejects_bad_paper_settings(env, key, value):
    from paper_engine.config import load_config
    env.setenv(key, value)
    with pytest.raises(ValueError):
        load_config(require_broker=False)


def test_paper_root_moves_run_data(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path
    import paper_engine
    code = "from paper_engine import config, __main__ as m; print(config.ROOT); print(m.DB_PATH)"
    env = dict(os.environ, PAPER_ROOT=str(tmp_path), PYTHONPATH=str(Path(paper_engine.__file__).parents[1]))
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, check=True)
    root, db = out.stdout.split()
    assert Path(root) == tmp_path.resolve() and Path(db) == tmp_path.resolve() / "data" / "trading.db"
