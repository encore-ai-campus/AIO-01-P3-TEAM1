"""복구 셈법 기준 사례 (이 폴더의 recovery_cases.json, 관리 서버 저장소 SHS5029/paper_admin의 API.md 3장): 서비스의 셈(reports.stats)과 관리자 백엔드의 셈이 같은 숫자를 낸다.

관리자 백엔드는 Django가 아니어서 같은 셈법을 옮겨 구현했다. 관리 서버 저장소에 같은 파일(recovery_cases.json)이 있고,
그 저장소의 CI가 두 파일이 같은지 본다 — 셈법을 바꾸면 두 저장소를 같이 고친다.
"""
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from reports import stats

CASES = json.loads((Path(__file__).resolve().parent / "recovery_cases.json").read_text(encoding="utf-8"))["cases"]


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
