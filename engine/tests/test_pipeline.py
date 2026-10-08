import dataclasses
from datetime import date

import pytest

from paper_engine.agents import approver, critic, proposer
from paper_engine.config import Config, parse_analysts
from paper_engine.judge.risk import AccountContext
from paper_engine.judge.scenario import SWING_MAX_DAYS, SWING_MIN_DAYS
from paper_engine.llm import LlmError, LlmTimeout
from paper_engine.notify import format_candidate
from paper_engine.pipeline import ModelResponseError, analyze

TODAY = date(2026, 9, 29)
ACCOUNT = AccountContext(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.0)
# 의결권: mid-a 0.4, mid-b 0.4, small 0.2
CFG = Config("id", "secret", None, analysts=parse_analysts("mid-a:medium,mid-b:medium,small:small"),
             researchers=("web-a", "web-b"), approver="boss")


def candles(*lows):
    return [{"date": f"2026-09-{20 + i}", "open": 100_000.0, "high": 101_000.0, "low": low, "close": 100_000.0,
             "volume": 1_000.0} for i, low in enumerate(lows)]


def snapshot():
    # 코드 손절가: 최근 저점 97,000 − ATR 4,000 × 0.5 = 95,000 (현재가 − ATR 1~2배 = 92,000~96,000 안)
    return {"symbol": "005930", "name": "삼성전자", "market": "KOSPI", "currency": "KRW",
            "lastPrice": 100_000.0, "indicators": {"rsi14": 54.21, "atr14": 4_000.0},
            "recentCandles": candles(98_000.0, 97_000.0, 99_000.0), "warnings": [], "news": []}


def raw_scenario(**kw):
    base = {"horizon": "SWING", "entryPrice": 100_000, "targetPrice": 115_000, "stopPrice": 95_000,
            "probability": 0.6, "score": 80, "holdingDays": 10, "invalidation": "20일선 이탈",
            "rationale": [{"claim": "RSI 중립", "evidence": [{"field": "indicators.rsi14", "value": 54.21}]}]}
    return {**base, **kw}


def review(score, probability):
    return {"score": score, "probability": probability, "weaknesses": ["약점"], "comment": "요약"}


class FakeLlm:
    """proposals[model]은 시나리오 목록, reviews[model]은 점수·확률(모든 시나리오에 똑같이 준다)."""

    cost = 0.0

    def __init__(self, proposals, reviews, approval=None, research=None):
        self.proposals, self.reviews = proposals, reviews
        self.approval, self.research = approval, research or {}
        self.calls = []  # (역할, 모델, user)

    def research_json(self, model, system, user, timeout=None):
        self.calls.append(("research", model, user))
        return self._value(self.research.get(model, ({"findings": []}, [])))

    def complete_json(self, model, system, user, timeout=None):
        if system == proposer.SYSTEM:
            self.calls.append(("propose", model, user))
            return {"scenarios": self._value(self.proposals.get(model, []))}
        if system == critic.SYSTEM:
            self.calls.append(("review", model, user))
            r = self._value(self.reviews[model])
            ids = [part.split('"')[0] for part in user.split('"id": "')[1:]]
            return {"reviews": [{"id": sid, **r} for sid in ids]}
        assert system == approver.SYSTEM
        self.calls.append(("approve", model, user))
        return self._value(self.approval)

    @staticmethod
    def _value(v):
        if isinstance(v, Exception):
            raise v
        return v

    def count(self, role):
        return sum(1 for r, _, _ in self.calls if r == role)


APPROVE = {"decision": "APPROVE", "reason": "근거가 데이터와 맞음", "concerns": ["실적 발표 임박"]}
REJECT = {"decision": "REJECT", "reason": "저항선 부담", "concerns": []}


def run(llm, cfg=CFG, **kw):
    return analyze(llm, cfg, snapshot(), ACCOUNT, TODAY, **kw)


def required(*names):
    return dataclasses.replace(CFG, required_models=names)


def test_full_flow_selected():
    llm = FakeLlm({"mid-a": [raw_scenario()]},
                  {"mid-b": review(70, 0.5), "small": review(40, 0.3)}, APPROVE)
    result = run(llm)
    (c,) = result.candidates
    assert (c.id, c.proposer) == ("S1", "mid-a")
    assert [q.analyst for q in c.critiques] == ["mid-b", "small"]
    assert c.score == pytest.approx(0.4 * 80 + 0.4 * 70 + 0.2 * 40)  # 68
    assert c.consensus_probability == pytest.approx(0.4 * 0.6 + 0.4 * 0.5 + 0.2 * 0.3)
    assert c.participation == pytest.approx(1.0)
    assert c.passed and c.selected and c.approval.approver == "boss"
    text = format_candidate(c, "삼성전자")
    assert "[승인] S1 삼성전자" in text and "최종 컨펌 (boss): 승인" in text
    assert "남은 위험: 실적 발표 임박" in text
    assert result.errors == []


def test_call_counts_are_per_model_not_per_scenario():
    # 검증자마다 시나리오 2개를 받아도 검증 호출은 모델당 1번이다.
    # 제안은 모델당 MAX_SCENARIOS(1)개까지만 받고 나머지는 버린다.
    proposals = {m: [raw_scenario(score=50), raw_scenario(score=50, targetPrice=120_000)]
                 for m in ("mid-a", "mid-b", "small")}
    llm = FakeLlm(proposals, {m: review(50, 0.4) for m in proposals}, APPROVE)
    result = run(llm)
    assert len(result.candidates) == 3
    assert all(c.raw["targetPrice"] == 115_000 for c in result.candidates)
    assert (llm.count("research"), llm.count("propose"), llm.count("review")) == (2, 3, 3)
    assert all(u.split("검토할 시나리오:")[1].count('"id": "') == 2
               for r, _, u in llm.calls if r == "review")
    assert llm.count("approve") == 0  # 통과한 시나리오가 없으면 최종 컨펌을 부르지 않는다
    assert all(len(c.critiques) == 2 for c in result.candidates)
    assert [(x["stage"], x["calls"]) for x in result.stages] == [
        ("웹 조사", 2), ("시나리오 제안", 3), ("검증", 3)]


def test_context_is_shared_and_blind():
    llm = FakeLlm({"mid-a": [raw_scenario()]},
                  {"mid-b": review(70, 0.5), "small": review(70, 0.5)}, APPROVE,
                  research={"web-a": ({"findings": [{"claim": "수주 공시", "date": "2026-09-01"}]}, [])})
    result = run(llm)
    users = {role: [u for r, _, u in llm.calls if r == role] for role in ("propose", "review", "approve")}
    context = users["propose"][0]
    assert "수주 공시" in context  # 웹 조사 결과가 공유 컨텍스트에 들어 있다
    assert all(u == context for u in users["propose"])
    assert all(u.startswith(context) for u in users["review"] + users["approve"])
    # 검증자는 제안자와 제안자의 자기 평가 점수를 모른다
    for u in users["review"]:
        task = u[len(context):]
        assert "mid-a" not in task and '"score"' not in task
    assert result.research_log["researchers"] == {"R1": "web-a", "R2": "web-b"}


def test_critic_does_not_review_own_scenario():
    llm = FakeLlm({"mid-a": [raw_scenario()], "mid-b": [raw_scenario(targetPrice=116_000)]},
                  {m: review(70, 0.5) for m in ("mid-a", "mid-b", "small")}, APPROVE)
    result = run(llm)
    for c in result.candidates:
        assert c.proposer not in [q.analyst for q in c.critiques]
        assert len(c.critiques) == 2


def test_low_score_fails_without_calling_approver():
    llm = FakeLlm({"small": [raw_scenario(score=95)]},
                  {"mid-a": review(40, 0.6), "mid-b": review(60, 0.6)}, APPROVE)
    (c,) = run(llm).candidates
    assert c.score == pytest.approx(0.2 * 95 + 0.4 * 40 + 0.4 * 60)  # 59
    assert not c.passed and c.approval is None
    assert llm.count("approve") == 0
    assert "기준 60점보다 낮음" in format_candidate(c)


def test_approver_rejects():
    llm = FakeLlm({"mid-a": [raw_scenario()]},
                  {"mid-b": review(70, 0.5), "small": review(70, 0.5)}, REJECT)
    (c,) = run(llm).candidates
    assert c.passed and not c.selected
    assert "[거부]" in format_candidate(c) and "저항선 부담" in format_candidate(c)


@pytest.mark.parametrize("approval", [LlmError("HTTP 500"), {"decision": "MAYBE"}, {}])
def test_approver_failure_means_not_approved(approval):
    llm = FakeLlm({"mid-a": [raw_scenario()]},
                  {"mid-b": review(70, 0.5), "small": review(70, 0.5)}, approval)
    (c,) = run(llm).candidates
    assert c.passed and not c.selected and not c.approval.approved


def test_failed_critic_without_timeout_counts_as_absent():
    # 시간 초과가 아닌 실패는 모델을 제외하지 않는다. 참여하지 않은 것으로만 센다.
    llm = FakeLlm({"mid-a": [raw_scenario()]},
                  {"mid-b": review(70, 0.5), "small": LlmError("HTTP 500")}, APPROVE)
    result = run(llm)
    (c,) = result.candidates
    assert result.excluded == []
    assert c.participation == pytest.approx(0.8)
    assert c.score == pytest.approx((0.4 * 80 + 0.4 * 70) / 0.8)  # 75
    assert c.selected


def test_quorum_not_met():
    llm = FakeLlm({"small": [raw_scenario(score=90)]},
                  {"mid-a": LlmError("HTTP 500"), "mid-b": review(90, 0.6)}, APPROVE)
    (c,) = run(llm).candidates
    assert c.participation == pytest.approx(0.6)  # 기준과 같으면 통과
    assert c.passed

    llm = FakeLlm({"small": [raw_scenario(score=90)]},
                  {"mid-a": LlmError("HTTP 500"), "mid-b": LlmError("HTTP 500")}, APPROVE)
    (c,) = run(llm).candidates
    assert c.participation == pytest.approx(0.2) and c.score == 90
    assert not c.passed and llm.count("approve") == 0
    assert "참여 의결권" in format_candidate(c)


# --- 시간 초과 ---

TIMEOUT = LlmTimeout("90초 안에 응답 없음")


def test_timed_out_critic_is_excluded_from_voting():
    llm = FakeLlm({"mid-a": [raw_scenario()]},
                  {"mid-b": review(70, 0.5), "small": TIMEOUT}, APPROVE)
    result = run(llm)
    (c,) = result.candidates
    assert result.excluded == ["small"]
    # 남은 두 모델이 의결권을 0.5씩 나눠 갖는다
    assert c.participation == pytest.approx(1.0)
    assert c.score == pytest.approx(0.5 * 80 + 0.5 * 70)
    assert c.consensus_probability == pytest.approx(0.55)
    assert c.selected
    assert "small: 시간 초과로 이후 단계와 의결에서 제외함" in result.errors


def test_model_timed_out_in_proposal_is_skipped_in_review():
    llm = FakeLlm({"mid-a": [raw_scenario()], "small": TIMEOUT},
                  {"mid-b": review(70, 0.5), "small": review(0, 0.0)}, APPROVE)
    result = run(llm)
    (c,) = result.candidates
    assert result.excluded == ["small"]
    assert [m for r, m, _ in llm.calls if r == "review"] == ["mid-b"]  # small은 부르지 않는다
    assert c.score == pytest.approx(75)


def test_proposer_timed_out_later_loses_its_own_vote():
    # small이 시나리오를 낸 뒤 검증 단계에서 시간 초과. 시나리오는 남기고 자기 평가만 뺀다.
    llm = FakeLlm({"small": [raw_scenario(score=100, probability=0.9)], "mid-a": [raw_scenario()]},
                  {"mid-a": review(70, 0.5), "mid-b": review(60, 0.4), "small": TIMEOUT}, APPROVE)
    result = run(llm)
    by_proposer = {c.proposer: c for c in result.candidates}
    c = by_proposer["small"]
    assert c.score == pytest.approx(65) and c.consensus_probability == pytest.approx(0.45)
    assert c.participation == pytest.approx(1.0)
    assert [q.analyst for q in by_proposer["mid-a"].critiques] == ["mid-b"]


def test_researcher_timeout_excludes_model_from_later_stages():
    cfg = dataclasses.replace(CFG, researchers=("small", "web-b"))
    llm = FakeLlm({"mid-a": [raw_scenario()], "small": [raw_scenario()]},
                  {m: review(70, 0.5) for m in ("mid-a", "mid-b", "small")}, APPROVE,
                  research={"small": TIMEOUT})
    result = run(llm, cfg)
    assert result.excluded == ["small"]
    assert "small" not in [m for r, m, _ in llm.calls if r in ("propose", "review")]
    assert [c.proposer for c in result.candidates] == ["mid-a"]


@pytest.mark.parametrize("stage,llm", [
    ("웹 조사", FakeLlm({}, {}, APPROVE, research={"web-a": TIMEOUT})),
    ("시나리오 제안", FakeLlm({"mid-a": TIMEOUT}, {}, APPROVE)),
    ("검증", FakeLlm({"mid-b": [raw_scenario()]}, {"mid-a": TIMEOUT, "small": review(70, 0.5)},
                   APPROVE)),
    ("최종 컨펌", FakeLlm({"mid-a": [raw_scenario()]},
                      {"mid-b": review(70, 0.5), "small": review(70, 0.5)}, TIMEOUT)),
])
def test_required_model_timeout_aborts_analysis(stage, llm):
    with pytest.raises(ModelResponseError, match=stage):
        run(llm, required("web-a", "mid-a", "boss"))


def test_required_model_other_failure_does_not_abort():
    llm = FakeLlm({"mid-a": LlmError("HTTP 500"), "mid-b": [raw_scenario()]},
                  {"mid-a": review(70, 0.5), "small": review(70, 0.5)}, APPROVE)
    result = run(llm, required("mid-a"))
    assert result.excluded == [] and len(result.candidates) == 1


def test_optional_approver_timeout_means_not_approved():
    llm = FakeLlm({"mid-a": [raw_scenario()]},
                  {"mid-b": review(70, 0.5), "small": review(70, 0.5)}, TIMEOUT)
    (c,) = run(llm).candidates
    assert c.passed and not c.selected and "응답을 받지 못함" in c.approval.reason


def test_fact_check_failure_skips_review():
    bad = raw_scenario(rationale=[{"claim": "x", "evidence": [{"field": "indicators.rsi14", "value": 20}]}])
    llm = FakeLlm({"mid-a": [bad]}, {}, APPROVE)
    (c,) = run(llm).candidates
    assert c.fact_errors and c.scenario is None and not c.passed
    assert llm.count("review") == 0
    assert "사실·조건 검증 실패" in format_candidate(c)


def test_non_swing_proposals_are_rejected_before_review():
    # 장기 시나리오와 보유 기간이 범위 밖인 스윙 시나리오는 사실 검증에서 탈락하고 채점받지 않는다
    llm = FakeLlm({"mid-a": [raw_scenario(horizon="LONG_TERM", holdingDays=150, targetPrice=123_000)],
                   "mid-b": [raw_scenario(holdingDays=100)],
                   "small": [raw_scenario()]},
                  {m: review(70, 0.5) for m in ("mid-a", "mid-b", "small")}, APPROVE)
    result = run(llm)
    by_proposer = {c.proposer: c for c in result.candidates}
    long_term, too_long = by_proposer["mid-a"], by_proposer["mid-b"]
    assert long_term.fact_errors[0] == "매매하지 않는 투자 기간: LONG_TERM (허용 SWING)"
    assert too_long.fact_errors == ["보유 기간 100거래일이 허용 범위를 벗어남 (허용 3~20거래일)"]
    for c in (long_term, too_long):
        assert c.scenario is None and not c.passed and c.critiques == [] and c.score == 0
        assert c.reject_reasons == c.fact_errors
    # 검증자에게는 통과한 스윙 시나리오(S3)만 간다
    reviewed = [u.split("검토할 시나리오:")[1] for r, _, u in llm.calls if r == "review"]
    assert len(reviewed) == 2 and all('"id": "S3"' in u and '"id": "S1"' not in u
                                      and '"id": "S2"' not in u for u in reviewed)
    assert by_proposer["small"].selected


def test_prompts_are_swing_only():
    days = f"{SWING_MIN_DAYS}~{SWING_MAX_DAYS}거래일"
    assert f"holdingDays는 {days}" in proposer.SYSTEM
    assert "LONG_TERM" not in proposer.SYSTEM and proposer.MAX_SCENARIOS == 1
    for system in (proposer.SYSTEM, critic.SYSTEM, approver.SYSTEM):
        assert days in system
        assert "손익비" not in system  # 리스크 엔진의 최소 손익비는 알려주지 않는다


@pytest.mark.parametrize("change", [{"targetPrice": 99_000}, {"score": None}, {"horizon": "WEEKLY"}])
def test_invalid_scenario_shape_is_rejected(change):
    llm = FakeLlm({"mid-a": [raw_scenario(**change)]}, {}, APPROVE)
    (c,) = run(llm).candidates
    assert c.scenario is None and c.fact_errors


def test_code_stop_replaces_proposed_stop():
    llm = FakeLlm({"mid-a": [raw_scenario(stopPrice=50_000)]},
                  {"mid-b": review(70, 0.5), "small": review(40, 0.3)}, APPROVE)
    (c,) = run(llm).candidates
    assert c.scenario.stop_price == 95_000 and c.raw["stopPrice"] == 95_000
    # 제안 AI는 손절가를 미리 받고, 검증 AI는 바뀐 손절가를 본다
    propose_context = next(u for r, _, u in llm.calls if r == "propose")
    assert '"stopRule": {"price": 95000.0, "basis": "lastPrice"' in propose_context
    assert all('"stopPrice": 95000' in u for r, _, u in llm.calls if r == "review")


def test_entry_at_or_below_code_stop_is_rejected():
    # 저점 99,500 − 1,000 = 98,500 → 현재가 − ATR 2,000 = 98,000으로 맞춤. 진입가 97,000은 손절가 아래
    near = {**snapshot(), "indicators": {"rsi14": 54.21, "atr14": 2_000.0}, "recentCandles": candles(99_500.0)}
    llm = FakeLlm({"mid-a": [raw_scenario(entryPrice=97_000)]}, {}, APPROVE)
    (c,) = analyze(llm, CFG, near, ACCOUNT, TODAY).candidates
    assert c.fact_errors == ["진입가 97000가 코드가 정한 손절가 98000 이하"]


@pytest.mark.parametrize("change", [{"indicators": {"rsi14": 54.21}}, {"recentCandles": []}])
def test_no_stop_without_candles_or_atr(change):
    llm = FakeLlm({"mid-a": [raw_scenario()]}, {}, APPROVE)
    (c,) = analyze(llm, CFG, {**snapshot(), **change}, ACCOUNT, TODAY).candidates
    assert c.scenario is None and c.fact_errors == ["손절가를 정할 자료(완성 일봉·ATR14)가 모자람"]
    assert llm.count("review") == 0


def test_risk_engine_failure_blocks_approval():
    llm = FakeLlm({"mid-a": [raw_scenario(targetPrice=104_000)]},  # 손익비 미달
                  {"mid-b": review(90, 0.6), "small": review(90, 0.6)}, APPROVE)
    (c,) = run(llm).candidates
    assert c.score > 60 and not c.passed and llm.count("approve") == 0


def test_proposer_failure_and_no_scenarios():
    llm = FakeLlm({"mid-a": LlmError("HTTP 500")}, {}, APPROVE)
    result = run(llm)
    assert result.candidates == []
    assert result.errors == ["mid-a 시나리오 제안 실패: HTTP 500"]


def test_no_web():
    llm = FakeLlm({}, {}, APPROVE)
    result = run(llm, web=False)
    assert llm.count("research") == 0 and result.research_log is None
    assert '"webResearch"' not in llm.calls[0][2]  # 데이터에 웹 조사 항목이 없다


def test_review_ignores_unknown_and_malformed_items():
    class Llm:
        def complete_json(self, model, system, user, timeout=None):
            return {"reviews": [
                {"id": "S1", "score": 150, "probability": -1, "weaknesses": list("abcdefg"), "comment": 1},
                {"id": "S1", "score": 10, "probability": 0.1},  # 중복
                {"id": "S9", "score": 50, "probability": 0.5},  # 받지 않은 id
                {"id": "S2", "score": "높음", "probability": 0.5},  # 형식 오류
            ]}
    out = critic.review(Llm(), "m", "context", {"S1": raw_scenario(), "S2": raw_scenario()})
    assert list(out) == ["S1"]
    assert out["S1"]["score"] == 100 and out["S1"]["probability"] == 0
    assert len(out["S1"]["weaknesses"]) == 5 and out["S1"]["comment"] == "1"


class SnapshotClient:
    """build_snapshot이 부르는 조회만 흉내 낸다."""

    def __init__(self, info):
        self.info = info

    def stocks(self, symbols):
        return [self.info]

    def completed_daily_candles(self, symbol, market):
        return [{"timestamp": f"2026-09-{d:02d}T00:00:00+09:00", "openPrice": "100", "highPrice": "110",
                 "lowPrice": "90", "closePrice": "100", "volume": "1000"} for d in range(1, 30)]

    def prices(self, symbols):
        return [{"lastPrice": "100"}]

    def warnings(self, symbol):
        return []

    def investor_trading(self, symbol, days):
        return []


def test_snapshot_has_broker_reports_even_when_news_fails(monkeypatch):
    from paper_engine.data import snapshot as snap_mod

    def no_news(*a, **kw):
        raise OSError("RSS down")
    calls = []
    monkeypatch.setattr(snap_mod, "fetch_news", no_news)
    monkeypatch.setattr(snap_mod, "stock_reports", lambda *a: calls.append(a) or [{"broker": "미래에셋증권"}])
    kr = {"symbol": "047810", "name": "한국항공우주", "market": "KOSPI", "currency": "KRW", "securityType": "STOCK"}
    got = snap_mod.build_snapshot(SnapshotClient(kr), "047810")
    assert got["news"] == [] and "RSS down" in got["newsError"]
    assert got["brokerReports"] == [{"broker": "미래에셋증권"}]
    us = {"symbol": "KIM", "name": "킴코 리얼티", "englishName": "Kimco Realty", "market": "NYSE", "currency": "USD",
          "securityType": "FOREIGN_STOCK"}
    snap_mod.build_snapshot(SnapshotClient(us), "KIM")
    assert calls == [("한국항공우주", "047810", "KR"), ("Kimco Realty", "KIM", "US")]  # 미국은 영문 이름으로 찾는다
