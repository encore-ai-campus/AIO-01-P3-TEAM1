"""복구 셈법이 기준 사례(recovery_cases.json)와 같은 숫자를 내는지."""
import json
from pathlib import Path

import pytest

from paper_admin import recovery

CASES = json.loads((Path(__file__).parents[2] / "recovery_cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_reference_cases(case):
    found = recovery.incidents(case["events"])
    assert recovery.summary(found) == case["expected"]["summary"]
    assert [i.as_dict() for i in found] == case["expected"]["incidents"]


def test_period_stats_mean_and_groups():
    by_name = {c["name"]: c for c in CASES}
    mixed = recovery.incidents(by_name["두 Worker가 섞이고 같은 Worker가 다시 실행됨 (검토 RETRY), 목록 순서가 step과 다름"]["events"])
    gave_up = recovery.incidents(by_name["포기 (복구 안 됨)와 처음부터 포기 (장애로 세지 않음)"]["events"])
    reports = [{"id": 1, "symbol": "A"}, {"id": 2, "symbol": "B"}, {"id": 3, "symbol": "C"}]
    stats = recovery.stats(reports, {1: mixed, 2: gave_up, 3: []}, first="2026-10-02", last="2026-10-08", days=7)
    assert stats["reports"] == 3 and stats["reportsWithFailures"] == 2
    assert (stats["failures"], stats["recovered"], stats["unrecovered"], stats["injected"]) == (4, 3, 1, 1)
    assert stats["autoRecoveryRate"] == 75.0
    assert stats["meanRecoveryMs"] == round((2000 + 5000 + 2250) / 3)
    assert stats["byErrorType"][0] == {"errorType": "bad_output", "failures": 2, "recovered": 1}
    assert stats["recent"][0]["reportId"] == 1 and stats["recent"][0]["worker"] == "report_agent"
    assert stats["byWorker"][0] == {"worker": "market_agent", "failures": 2, "recovered": 1}


def test_empty_period():
    stats = recovery.stats([], {}, first="2026-10-02", last="2026-10-08", days=7)
    assert stats["autoRecoveryRate"] is None and stats["meanRecoveryMs"] is None and stats["recent"] == []
