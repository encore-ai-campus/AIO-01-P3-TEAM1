"""매매 종목 선정 (reports/autoreport/selection.py): 선정 Guard 규칙 하나하나와 선정 팀의 공용 입력(team_inputs). 증권사를 부르지 않는다."""
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from config import engine
from reports.autoreport import auto, selection
from reports.agents.base import WorkerError
from reports.models import Report

KST = ZoneInfo("Asia/Seoul")
CANDIDATES = [  # 점수 순 (코드가 매긴 값)
    {"symbol": "005930", "name": "삼성전자", "score": 80.0, "rsi": 55.0},
    {"symbol": "005380", "name": "현대차", "score": 70.0, "rsi": 48.0},
    {"symbol": "035420", "name": "NAVER", "score": 65.0, "rsi": 61.0},
    {"symbol": "000660", "name": "SK하이닉스", "score": 50.0, "rsi": 66.0},
    {"symbol": "042700", "name": "한미반도체", "score": 45.0, "rsi": 70.0},
]


def ai(*symbols):
    return [{"symbol": s, "rank": i, "reason": f"{s} 이유", "evidence": []} for i, s in enumerate(symbols, 1)]


def news(**themes):
    return {"summary": "뉴스", "items": [{"symbol": s, "sentiment": "neutral", "materials": [], "concerns": [],
                                         "theme": t, "evidence": []} for s, t in themes.items()]}


def filings(**severity):
    return {"summary": "공시", "items": [{"symbol": s, "severity": v, "signals": ["유상증자"] if v == "high" else [],
                                         "evidence": []} for s, v in severity.items()]}


class Warnings:
    """가짜 투자유의 조회: symbol → 이름 목록 또는 예외. 부른 종목을 기록한다."""

    def __init__(self, found=None):
        self.found, self.calls = found or {}, []

    def __call__(self, symbol):
        self.calls.append(symbol)
        value = self.found.get(symbol, [])
        if isinstance(value, Exception):
            raise value
        return value


def symbols(rows):
    return [row["symbol"] for row in rows]


def test_ai_order_kept_with_code_numbers():
    out = selection.guard(CANDIDATES, ai("035420", "005380", "000660"), {}, Warnings(), top=3)
    assert symbols(out["picks"]) == ["035420", "005380", "000660"]
    first = out["picks"][0]
    assert first["score"] == 65.0 and first["rsi"] == 61.0 and first["name"] == "NAVER"   # 숫자는 후보 표(코드) 값
    assert (first["aiRank"], first["aiReason"], first["theme"], first["filledByRule"]) == (1, "035420 이유", None, False)
    assert out["filtered"] == []


def test_outside_candidates_is_filtered_and_rule_fills():
    out = selection.guard(CANDIDATES, ai("999999", "005380"), {}, Warnings(), top=3)
    assert out["filtered"] == [{"symbol": "999999", "name": None, "reason": "규칙 후보 표에 없는 종목", "stage": "candidates"}]
    assert symbols(out["picks"]) == ["005380", "005930", "035420"]
    assert [p["filledByRule"] for p in out["picks"]] == [False, True, True]
    assert out["picks"][1]["aiRank"] is None and out["picks"][1]["aiReason"] is None


def test_investment_warning_is_filtered():
    warnings = Warnings({"005380": ["투자경고", "단기과열"]})
    out = selection.guard(CANDIDATES, ai("005380", "005930"), {}, warnings, top=2)
    assert out["filtered"] == [{"symbol": "005380", "name": "현대차", "reason": "투자유의: 투자경고, 단기과열",
                                "stage": "warnings"}]
    assert symbols(out["picks"]) == ["005930", "035420"]
    assert warnings.calls == ["005380", "005930", "035420"]   # 이미 본 종목은 규칙으로 채울 때 다시 보지 않는다


def test_warnings_lookup_error_fails_closed():
    out = selection.guard(CANDIDATES, ai("005930"), {}, Warnings({"005930": RuntimeError("조회 실패")}), top=1)
    assert out["filtered"] == [{"symbol": "005930", "name": "삼성전자", "reason": "투자유의 확인 실패", "stage": "warnings"}]
    assert symbols(out["picks"]) == ["005380"]


def test_high_risk_filing_is_filtered_low_is_kept():
    research = {"filing_screen_agent": filings(**{"005930": "high", "005380": "low"})}
    out = selection.guard(CANDIDATES, ai("005930", "005380"), research, Warnings(), top=2)
    assert out["filtered"] == [{"symbol": "005930", "name": "삼성전자", "reason": "고위험 공시: 유상증자", "stage": "filing"}]
    assert symbols(out["picks"]) == ["005380", "035420"]


def test_same_theme_at_most_two_compared_normalized():
    research = {"news_screen_agent": news(**{"000660": "반도체", "042700": " 반도체 ", "005930": "반도체",
                                             "035420": "AI  플랫폼", "005380": "ai 플랫폼"})}
    out = selection.guard(CANDIDATES, ai("000660", "042700", "005930", "035420", "005380"), research, Warnings(), top=4)
    assert out["filtered"] == [{"symbol": "005930", "name": "삼성전자", "reason": "같은 테마(반도체)가 이미 2개",
                                "stage": "theme"}]
    assert symbols(out["picks"]) == ["000660", "042700", "035420", "005380"]
    assert [p["theme"] for p in out["picks"]] == ["반도체", "반도체", "AI 플랫폼", "ai 플랫폼"]


def test_fallback_without_ai_uses_rule_order_and_still_checks_warnings():
    warnings = Warnings({"005930": ["투자주의"]})
    out = selection.guard(CANDIDATES, None, None, warnings, top=3)
    assert symbols(out["picks"]) == ["005380", "035420", "000660"]
    assert all(p["filledByRule"] and p["aiRank"] is None for p in out["picks"])
    assert out["filtered"][0]["stage"] == "warnings"


def test_research_missing_skips_filing_and_theme_checks():
    research = {"news_screen_agent": news(**{"005930": "반도체", "000660": "반도체", "042700": "반도체"})}
    out = selection.guard(CANDIDATES, ai("005930", "000660", "042700"), research, Warnings(), top=3)
    assert symbols(out["picks"]) == ["005930", "000660", "005380"]   # 공시 결과가 없어도 테마 검사는 한다
    out = selection.guard(CANDIDATES, ai("005930", "000660", "042700"), {}, Warnings(), top=3)
    assert symbols(out["picks"]) == ["005930", "000660", "042700"]


def test_too_few_candidates_returns_what_passes():
    out = selection.guard(CANDIDATES[:2], ai("005930"), {}, Warnings({"005380": ["투자경고"]}), top=3)
    assert symbols(out["picks"]) == ["005930"] and symbols(out["filtered"]) == ["005380"]


def test_candidates_of_falls_back_to_picks():
    assert selection.candidates_of({"picks": [{"symbol": "005930"}, {"name": "코드 없음"}]}) == [{"symbol": "005930"}]
    assert selection.candidates_of({"candidates": [], "picks": [{"symbol": "005930"}]}) == []
    assert selection.candidates_of(None) == []


# --- team_inputs ---

@pytest.fixture
def selection_run(db, monkeypatch, tmp_path):
    monkeypatch.setattr(engine, "RUNS_DIR", tmp_path / "runs")
    at = datetime(2026, 10, 5, 8, 0, tzinfo=KST)
    report = Report.objects.create(source=Report.AUTO, team=Report.STOCK_SELECTION, user=None, symbol="KR",
                                   name=auto.SELECTION_NAME, market="KR", created_at=at)
    auto.save({"market": "KR", "at": at.isoformat(), "picks": CANDIDATES[:3], "candidates": CANDIDATES,
               "selection": {"reportId": report.id, "status": "running"}, "reportIds": [], "recommendationIds": []})
    return report


def test_team_inputs_reads_candidates_of_the_day(selection_run):
    assert selection.team_inputs(selection_run) == {"market": "KR", "day": "2026-10-05", "candidates": CANDIDATES}


def test_team_inputs_rejects_other_run_or_missing_file(selection_run):
    other = Report.objects.create(source=Report.AUTO, team=Report.STOCK_SELECTION, symbol="KR",
                                  name=auto.SELECTION_NAME, market="KR", created_at=selection_run.created_at)
    with pytest.raises(WorkerError, match="후보 표"):
        selection.team_inputs(other)
    selection_run.created_at = datetime(2026, 10, 6, 8, 0, tzinfo=KST)   # 그날 파일이 없음
    with pytest.raises(WorkerError, match="후보 표"):
        selection.team_inputs(selection_run)
