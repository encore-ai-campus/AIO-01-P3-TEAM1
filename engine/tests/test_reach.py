import dataclasses
from datetime import date

import pytest

from paper_engine.agents import approver, critic, proposer
from paper_engine.config import Config, parse_analysts
from paper_engine.info import _analysis_view
from paper_engine.judge.reach import HARD_RATIO, Reach, check_reach
from paper_engine.judge.risk import AccountContext, assess
from paper_engine.judge.scenario import Scenario
from paper_engine.judge.verdict import Approval, Candidate
from paper_engine.notify import format_candidate
from paper_engine.pipeline import analyze

ACCOUNT = AccountContext(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.0)


# --- 순수 함수 ---

def test_normal():
    # 목표 거리 15,000 / 예상 변동폭 5,000 × √9 = 15,000 → 1배
    r = check_reach(100_000, 115_000, 9, 5_000)
    assert r.ratio == pytest.approx(1.0) and r.expected_move == pytest.approx(15_000)
    assert not r.hard
    assert r.note == "목표 도달 점검: 목표 +15.0% / 9일 예상 변동폭 15.0% (ATR×√일수) = 1.00배"


def test_hard():
    r = check_reach(100_000, 115_000, 4, 2_500)  # 15,000 / 5,000 = 3배
    assert r.ratio == pytest.approx(3.0) and r.hard
    assert r.note == ("주의 목표 도달 어려움: 목표 +15.0% / 4일 예상 변동폭 5.0% (ATR×√일수) "
                      f"= 3.00배 (기준 {HARD_RATIO}배)")


def test_threshold_boundary():
    # 기준과 같으면 표시하지 않고, 넘으면 표시한다
    at = check_reach(100.0, 130.0, 4, 10.0)  # 30 / 20 = 1.5
    assert at.ratio == pytest.approx(HARD_RATIO) and not at.hard
    above = check_reach(100.0, 130.1, 4, 10.0)
    assert above.hard and above.note.startswith("주의")


@pytest.mark.parametrize("atr", [None, 0, 0.0, -1.0, float("nan")])
def test_missing_atr(atr):
    r = check_reach(100_000, 115_000, 10, atr)
    assert r == Reach(None, None, False, "목표 도달 점검 못 함: ATR 없음")


def test_one_day_holding():
    r = check_reach(200.0, 206.0, 1, 4.0)  # √1 = 1 → 6 / 4
    assert r.expected_move == pytest.approx(4.0) and r.ratio == pytest.approx(1.5)
    assert "1일 예상 변동폭 2.0%" in r.note


# --- 판정과 표시 ---

def candidate(reach=None, approved=True, **kw):
    base = dict(symbol="005930", currency="KRW", horizon="SWING", entry_price=100_050,
                target_price=115_080, stop_price=95_030, probability=0.5, holding_days=10)
    s = Scenario(**{**base, **kw})
    return Candidate(id="S1", proposer="m", raw={}, scenario=s, final=s, proposer_score=80,
                     score=70, participation=1.0, consensus_probability=0.5,
                     assessment=assess(s, ACCOUNT),
                     approval=Approval(approved, "사유", [], "boss"), reach=reach)


def test_hard_reach_does_not_change_verdict():
    plain = candidate()
    hard = candidate(check_reach(100_050, 115_080, 10, 100))
    assert hard.reach.hard
    assert (hard.passed, hard.selected, hard.reject_reasons) == (
        plain.passed, plain.selected, plain.reject_reasons) == (True, True, [])
    low = dataclasses.replace(hard, score=50)
    assert low.reject_reasons == ["교차검증 점수 50점이 기준 60점보다 낮음"]


def test_format_candidate_shows_note():
    reach = check_reach(100_050, 115_080, 10, 1_000)
    lines = format_candidate(candidate(reach), "삼성전자").split("\n")
    assert reach.note in lines
    assert lines.index(reach.note) < next(i for i, x in enumerate(lines) if x.startswith("교차검증 점수"))
    assert "ATR×√일수" not in format_candidate(candidate())  # 이전 기록처럼 없으면 줄도 없다


def test_info_view_reads_reach():
    reach = check_reach(100_050, 115_080, 10, 1_000)
    entry = {"snapshot": {"symbol": "005930"},
             "candidates": [dataclasses.asdict(candidate(reach)), {"id": "S2"}]}
    view = _analysis_view(entry, "runs/x.json", {})
    assert view["candidates"][0]["reach"] == dataclasses.asdict(reach)
    assert view["candidates"][1]["reach"] is None


# --- 파이프라인 ---

CFG = Config("id", "secret", None, analysts=parse_analysts("mid-a:medium,mid-b:medium,small:small"),
             approver="boss")


def snapshot(atr14):
    indicators = {"rsi14": 54.21}
    if atr14 is not ...:
        indicators["atr14"] = atr14
    candles = [{"date": "2026-09-26", "open": 100_000.0, "high": 101_000.0, "low": 97_000.0,
                "close": 100_000.0, "volume": 1_000.0}]
    return {"symbol": "005930", "name": "삼성전자", "market": "KOSPI", "currency": "KRW",
            "lastPrice": 100_000.0, "indicators": indicators, "recentCandles": candles, "warnings": [], "news": []}


def raw_scenario():
    return {"horizon": "SWING", "entryPrice": 100_000, "targetPrice": 115_000, "stopPrice": 95_000,
            "probability": 0.6, "score": 80, "holdingDays": 10, "invalidation": "20일선 이탈",
            "rationale": [{"claim": "RSI 중립", "evidence": [{"field": "indicators.rsi14", "value": 54.21}]}]}


class FakeLlm:
    """mid-a만 시나리오 하나를 내고, 나머지는 70점 0.5로 채점하고, 승인자는 승인한다."""

    cost = 0.0

    def complete_json(self, model, system, user, timeout=None):
        if system == proposer.SYSTEM:
            return {"scenarios": [raw_scenario()] if model == "mid-a" else []}
        if system == critic.SYSTEM:
            ids = [part.split('"')[0] for part in user.split('"id": "')[1:]]
            return {"reviews": [{"id": sid, "score": 70, "probability": 0.5, "weaknesses": [],
                                 "comment": "요약"} for sid in ids]}
        assert system == approver.SYSTEM
        return {"decision": "APPROVE", "reason": "근거가 데이터와 맞음", "concerns": []}


def run(atr14):
    return analyze(FakeLlm(), CFG, snapshot(atr14), ACCOUNT, date(2026, 9, 29), web=False)


@pytest.mark.parametrize("atr14,hard", [(6_000.0, False), (1_000.0, True)])
def test_pipeline_fills_reach(atr14, hard):
    (c,) = run(atr14).candidates
    assert c.reach == check_reach(100_000, 115_000, 10, atr14)
    assert c.reach.hard is hard
    assert c.selected  # 도달 어려움 표시가 판정을 바꾸지 않는다
    assert c.reach.note in format_candidate(c)


@pytest.mark.parametrize("atr14", [..., None, "잘못된 값"])
def test_pipeline_without_atr_cannot_set_stop(atr14):
    # ATR이 없으면 코드가 손절가를 정할 수 없어 시나리오를 거른다 (judge/stops.py). 분석은 오류 없이 끝난다
    result = run(atr14)
    (c,) = result.candidates
    assert not c.selected and c.scenario is None and c.reach is None and result.errors == []
    assert c.fact_errors == ["손절가를 정할 자료(완성 일봉·ATR14)가 모자람"]


# --- 검증자와 승인자에게 점검 결과 전달 ---

def test_reach_note_is_passed_to_critic_and_approver():
    from paper_engine.agents import approver, critic

    seen = {}

    class Llm:
        def complete_json(self, model, system, user, timeout=90):
            seen[system[:12]] = user
            if system is critic.SYSTEM:
                return {"reviews": [{"id": "S1", "score": 70, "probability": 0.5}]}
            return {"decision": "REJECT", "reason": "r"}

    raw = {"horizon": "SWING", "entryPrice": 100, "targetPrice": 130, "stopPrice": 95,
           "probability": 0.5, "holdingDays": 4, "rationale": [], "invalidation": ""}
    critic.review(Llm(), "m", "ctx", {"S1": raw}, {"S1": "주의 목표 도달 어려움: x"})
    assert '"reachCheck": "주의 목표 도달 어려움: x"' in seen[critic.SYSTEM[:12]]
    critic.review(Llm(), "m", "ctx", {"S1": raw})
    assert "reachCheck" not in seen[critic.SYSTEM[:12]]
    assert "reachCheck" in critic.SYSTEM and "reachCheck" in approver.SYSTEM


def test_proposer_keeps_swing_when_model_mixes_horizons():
    from paper_engine.agents import proposer

    class Llm:
        def complete_json(self, model, system, user, timeout=90):
            return {"scenarios": [{"horizon": "LONG_TERM", "n": 1}, "bad", {"horizon": "SWING", "n": 2}]}

    assert proposer.propose(Llm(), "m", "ctx") == [{"horizon": "SWING", "n": 2}]
