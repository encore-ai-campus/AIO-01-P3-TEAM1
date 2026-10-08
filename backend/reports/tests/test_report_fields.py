"""리포트 새 열과 응답 필드 (docs/tasks/04-autohealing.md T4-1, docs/tasks/00-공통.md 3절):
user null 허용(자동 리포트)·source·team·chaos·cost_usd·pdf_path → ReportSummary의 source·team·requestedBy·chaosEnabled·
costUsd·hasPdf, ReportDetail의 chaos·recovery."""
import json

import pytest
from django.db import connection
from django.utils import timezone

from config import engine
from reports.models import Report

from .conftest import make_report

pytestmark = pytest.mark.django_db

NO_RECOVERY = {"failures": 0, "recovered": 0, "unrecovered": 0, "injected": 0, "recoveryMs": None, "models": {}}
CHAOS = {"enabled": True, "probability": 0.5, "errorTypes": ["timeout"], "workers": None, "scope": "primary",
         "seed": 123456}


def listed(api) -> dict:
    """목록의 첫 리포트 (최신순)."""
    return api.get("/api/reports").json()["results"][0]


def test_new_report_defaults(api, stocks):
    body = api.post("/api/reports", {"symbol": "005930"}, content_type="application/json").json()
    assert (body["source"], body["chaosEnabled"], body["costUsd"], body["hasPdf"]) == ("user", False, 0, False)
    assert body["chaos"] is None and body["recovery"] == NO_RECOVERY
    report = Report.objects.get()
    assert (report.source, report.team, report.chaos, report.cost_usd, report.pdf_path) == (
        "user", "stock_report", None, 0, None)
    assert body["team"] == "stock_report"


def test_auto_report_without_user(api, user):
    report = make_report(None, source=Report.AUTO)
    make_report(user)  # 사람이 신청한 리포트와 같이 목록에 나와도 깨지지 않는다
    results = api.get("/api/reports").json()["results"]
    assert [(r["source"], r["requestedBy"]) for r in results] == [("user", "앨리스"), ("auto", "자동")]
    body = api.get(f"/api/reports/{report.id}").json()
    assert (body["source"], body["requestedBy"]) == ("auto", "자동")


def test_auto_report_with_user_is_still_auto(api, user):
    make_report(user, source=Report.AUTO)
    assert listed(api)["requestedBy"] == "자동"


def test_mine_leaves_out_auto_reports(api, user):
    make_report(None, source=Report.AUTO)
    mine = make_report(user)
    assert [r["id"] for r in api.get("/api/reports?mine=1").json()["results"]] == [mine.id]


@pytest.mark.parametrize("chaos, enabled", [(None, False), ({"enabled": False}, False), ({"enabled": "yes"}, False),
                                            (["enabled"], False), (CHAOS, True)])
def test_chaos_enabled(api, user, chaos, enabled):
    report = make_report(user, chaos=chaos)
    assert listed(api)["chaosEnabled"] is enabled
    assert api.get(f"/api/reports/{report.id}").json()["chaos"] == chaos


def test_cost(api, user):
    make_report(user, cost_usd=0.4321)
    assert listed(api)["costUsd"] == 0.4321


def test_has_pdf_only_when_file_exists(api, user, tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "ROOT", tmp_path)
    report = make_report(user, status=Report.COMPLETED, pdf_path="reports/1.v3.pdf")
    assert listed(api)["hasPdf"] is False  # 열은 있지만 파일이 없다
    (tmp_path / "reports").mkdir()
    (tmp_path / "reports" / "1.v3.pdf").write_bytes(b"%PDF-1.4")
    assert listed(api)["hasPdf"] is True
    Report.objects.filter(pk=report.pk).update(pdf_path="reports")  # 폴더는 파일이 아니다
    assert listed(api)["hasPdf"] is False


def test_db_defaults_for_old_code(user):
    """새 열을 모르는 옛 코드가 INSERT해도 DB가 source·team·cost_usd를 채운다 (공유 개발 DB)."""
    now = timezone.now()
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO reports (user_id, symbol, name, market, status, results, errors, completed_agents, failed_agents,"
            " created_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            [user.id, "005930", "삼성전자", "KR", "requested", json.dumps({}), json.dumps({}), json.dumps([]),
             json.dumps([]), now])
    report = Report.objects.get()
    assert (report.source, report.team, report.cost_usd, report.chaos, report.pdf_path) == (
        "user", "stock_report", 0, None, None)
