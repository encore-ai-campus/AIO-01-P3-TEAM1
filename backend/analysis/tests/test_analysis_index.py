import os

import pytest

from analysis import index
from analysis.models import AnalysisRun, RunFile

from .conftest import candidate, entry, error_entry, fact_failed, run_log, write_run

pytestmark = pytest.mark.django_db


def test_buy_verdict_picks_best_selected_scenario(runs):
    log = run_log(entry(candidates=[candidate("S1", score=90.0, approved=False),   # 점수는 높지만 승인 안 됨
                                    candidate("S2", "claude", score=70.0),
                                    candidate("S3", "gemini", score=80.0, target=120_000),
                                    candidate("S4", score=40.0)]))                   # 점수 미달
    write_run(runs, "20261002-090000.json", log)
    assert index.refresh() == 1
    run = AnalysisRun.objects.get()
    assert (run.run_file, run.symbol, run.name, run.market, run.currency) == (
        "runs/20261002-090000.json", "005930", "삼성전자", "KR", "KRW")
    assert run.verdict == "BUY" and run.scenario_count == 4
    assert run.analyzed_at.isoformat() == "2026-10-02T00:00:00+00:00"
    assert (run.price_at_analysis, run.requested_by, run.cost_usd) == (100_000, "alice", 0.31)
    assert run.best == {
        "proposer": "gemini", "selected": True, "passed": True, "score": 80.0, "probability": 0.5,
        "entryPrice": 100_000, "targetPrice": 120_000, "stopPrice": 95_000, "holdingDays": 10,
        "rationale": ["20일선 위에서 거래량이 늘었다", "외국인 순매수 5일 연속"],
        "invalidation": "종가가 20일선 아래로 내려가면 무효", "rejectReasons": []}


def test_pass_verdict_picks_best_overall_and_handles_fact_failures(runs):
    log = run_log(entry(candidates=[candidate("S1", score=40.0), fact_failed(), candidate("S2", score=55.0)]))
    write_run(runs, "a.json", log)
    index.refresh()
    run = AnalysisRun.objects.get()
    assert run.verdict == "PASS" and run.scenario_count == 3
    assert run.best["score"] == 55.0 and run.best["passed"] is False and run.best["selected"] is False
    assert run.best["rejectReasons"] == ["교차검증 점수 55점이 기준 60점보다 낮음"]
    failed = index.scenarios_of(log["results"][0])[1]
    assert failed == {
        "proposer": "deepseek", "selected": False, "passed": False, "score": None, "probability": None,
        "entryPrice": 130_000, "targetPrice": 150_000, "stopPrice": 120_000, "holdingDays": 7,
        "rationale": ["근거 없는 주장"], "invalidation": "없음",
        "rejectReasons": ["entryPrice가 현재가에서 5% 넘게 벗어남"]}


def test_symbols_without_candidates_or_with_model_error(runs):
    log = run_log(entry(symbol="AAPL", name="애플", currency="USD", last=230.5),
                  error_entry(), strategy={"id": 3, "name": "기본 국내 선별"}, requested_by="cli")
    write_run(runs, "20261002-070000-s3.json", log)
    assert index.refresh() == 2
    hynix, apple = AnalysisRun.objects.order_by("symbol")  # 숫자가 먼저
    assert (apple.market, apple.currency, apple.verdict, apple.best, apple.scenario_count) == ("US", "USD", "PASS",
                                                                                             None, 0)
    assert (hynix.verdict, hynix.best, hynix.cost_usd, hynix.price_at_analysis) == ("PASS", None, 0.05, 200_000)
    assert apple.requested_by == hynix.requested_by == "strategy:3"


def test_refresh_is_idempotent_and_reads_only_new_files(runs, monkeypatch):
    write_run(runs, "a.json", run_log(entry()))
    assert index.refresh() == 1
    assert index.refresh() == 0
    reads = []
    original = index.parse
    monkeypatch.setattr(index, "parse", lambda *a: reads.append(a[1]) or original(*a))
    write_run(runs, "b.json", run_log(entry(symbol="000660", name="SK하이닉스")))
    assert index.refresh() == 1
    assert reads == ["runs/b.json"]  # 이미 색인한 a.json은 다시 읽지 않는다
    assert AnalysisRun.objects.count() == 2


def test_broken_files_are_skipped_and_retried_when_changed(runs):
    (runs / "broken.json").write_text('{"startedAt": "2026-10-02T09:00:00+09:00", "results": [')  # 쓰는 중
    (runs / "list.json").write_text("[1, 2]")
    (runs / "notes.txt").write_text("not a run")
    write_run(runs, "ok.json", run_log(entry()))
    assert index.refresh() == 1
    assert set(RunFile.objects.values_list("name", "ok")) == {("broken.json", False), ("list.json", False),
                                                             ("ok.json", True)}
    assert index.refresh() == 0
    write_run(runs, "broken.json", run_log(entry(symbol="000660", name="SK하이닉스")))
    os.utime(runs / "broken.json", ns=(1, 1))  # 크기·수정 시각이 바뀌면 다시 읽는다
    assert index.refresh() == 1
    assert RunFile.objects.get(name="broken.json").ok


def test_missing_runs_dir_and_odd_entries(runs):
    runs.rmdir()
    assert index.refresh() == 0
    runs.mkdir()
    log = run_log(entry(), {"snapshot": {}}, "not a dict", entry(), started="not a time")  # 같은 종목 두 번은 하나만
    write_run(runs, "a.json", log)
    assert index.refresh() == 1
    assert AnalysisRun.objects.get().analyzed_at is not None  # 시각을 못 읽으면 파일 수정 시각


def test_run_path_stays_inside_runs_dir(runs, tmp_path):
    (tmp_path / "secret.json").write_text("{}")
    (runs / "link.json").symlink_to(tmp_path / "secret.json")
    assert index.run_path("runs/a.json") == (runs / "a.json").resolve()
    for bad in ("runs/../secret.json", "../secret.json", "/etc/passwd", "runs/a.txt", "other/a.json",
                "runs/sub/a.json", "runs/link.json"):
        assert index.run_path(bad) is None, bad
    assert index.refresh() == 0  # RUNS_DIR 밖을 가리키는 링크는 색인하지 않는다
