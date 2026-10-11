"""복구 셈법 기준 사례 (admin/recovery_cases.json, admin/API.md 3장): 서비스의 셈(reports.autohealing.stats)과 관리자 백엔드의 셈이 같은 숫자를 낸다.

관리자 백엔드(admin/server)는 Django가 아니어서 같은 셈법을 옮겨 구현했다. 두 쪽 테스트가 같은 파일을 읽는다.
"""
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from reports.autohealing import stats

CASES = json.loads((Path(__file__).resolve().parents[4] / "admin" / "recovery_cases.json").read_text(encoding="utf-8"))["cases"]


def _event(raw: dict) -> SimpleNamespace:
    return SimpleNamespace(step=raw["step"], actor=raw["actor"], action=raw["action"], status=raw["status"],
                           model=raw.get("model"), details=raw.get("details") or {}, at=datetime.fromisoformat(raw["at"]))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_stats_match_cases(case):
    events = [_event(e) for e in case["events"]]
    summary = stats.report_recovery(events)
    want = case["expected"]["summary"]
    assert {k: summary[k] for k in want} == want
    found = [{"worker": i["worker"], "errorType": i["errorType"], "injected": i["injected"], "recovered": i["recovered"],
              "recoveryMs": i["recoveryMs"], "at": i["at"]} for i in stats.incidents(events)]
    assert found == [{**i, "at": datetime.fromisoformat(i["at"])} for i in case["expected"]["incidents"]]
