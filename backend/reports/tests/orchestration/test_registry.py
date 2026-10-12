"""YAML Registry → ExecutionPlan과 계획 검증. 잘못된 계획은 tmp YAML로 만든다."""
import copy

import pytest
import yaml

from reports.orchestration import registry
from reports.orchestration.registry import PlanError, build_plan

CONTRACTS = {"market_agent": "MarketResult", "fundamental_agent": "FundamentalResult", "news_agent": "NewsResult",
             "report_agent": "ReportDraft", "review_agent": "ReviewResult", "risk_agent": "RiskResult"}
WORKERS = {"workers": {
    wid: {"title": f"{wid} 제목", "goal": f"{wid} 목표", "provider": None, "model": None,
          "fallbacks": [], "output_contract": contract}
    for wid, contract in CONTRACTS.items()}}
TEAM = {"teams": {"t": {
    "title": "시험 팀", "failure_policy": "required_optional",
    "steps": [
        {"id": "research", "title": "조사", "mode": "parallel",
         "workers": ["market_agent", "fundamental_agent", "news_agent"],
         "required": ["market_agent", "fundamental_agent"], "optional": ["news_agent"], "timeout": 60},
        {"id": "compose", "title": "작성", "mode": "sequential", "workers": ["report_agent"],
         "depends_on": ["research"], "join": True},
        {"id": "review", "title": "검토", "mode": "sequential", "workers": ["review_agent"],
         "depends_on": ["compose"], "retry": {"target": "report_agent", "max_rounds": 2}},
    ],
    "handoffs": [{"from": "review_agent", "to": "risk_agent", "responsibility": "넘긴다", "max_hops": 2}],
}}}


def write(tmp_path, workers=None, teams=None):
    wf, tf = tmp_path / "workers.yaml", tmp_path / "teams.yaml"
    wf.write_text(yaml.safe_dump(WORKERS if workers is None else workers, allow_unicode=True), encoding="utf-8")
    tf.write_text(yaml.safe_dump(TEAM if teams is None else teams, allow_unicode=True), encoding="utf-8")
    return wf, tf


def team_with(change):
    """TEAM 복사본의 팀 't'를 change(team)로 고친다."""
    teams = copy.deepcopy(TEAM)
    change(teams["teams"]["t"])
    return teams


def test_default_registry_plan_shape():
    plan = registry.execution_plan()
    assert set(plan) == {"team", "title", "failurePolicy", "steps", "workers", "handoffs", "implemented"}
    assert (plan["team"], plan["title"], plan["failurePolicy"], plan["implemented"]) == (
        "stock_report", "종목 리포트", "required_optional", registry.AGENTS_IMPLEMENTED)
    assert [(s["id"], s["mode"], s["dependsOn"], s["join"], s["timeoutSec"], s["retry"]) for s in plan["steps"]] == [
        ("parallel_research", "parallel", [], False, 180, None),
        ("compose", "sequential", ["parallel_research"], True, 180, None),
        ("review", "sequential", ["compose"], False, 180, {"target": "report_agent", "maxRounds": 2})]
    research = plan["steps"][0]
    assert set(research) == {"id", "title", "mode", "workers", "required", "optional", "dependsOn", "join", "timeoutSec", "retry"}
    assert research["title"] == "조사"
    assert research["workers"] == ["market_agent", "fundamental_agent", "news_agent"]
    assert (research["required"], research["optional"]) == (["market_agent", "fundamental_agent"], ["news_agent"])
    assert plan["steps"][1]["required"] == ["report_agent"]  # required를 안 적으면 optional이 아닌 Worker 전부
    assert [w["id"] for w in plan["workers"]] == ["market_agent", "fundamental_agent", "news_agent", "report_agent",
                                                  "review_agent", "risk_agent"]
    market = plan["workers"][0]
    assert set(market) == {"id", "title", "goal", "provider", "model", "fallbacks", "outputContract"}
    assert (market["title"], market["provider"], market["model"], market["fallbacks"], market["outputContract"]) == (
        "시세·차트 Agent", "devpass", "gemini-3.8-flash", ["gpt-5.6-luna"], "MarketResult")
    assert all(w["provider"] == "devpass" and w["model"] for w in plan["workers"])
    assert all(w["goal"] for w in plan["workers"])
    assert plan["handoffs"] == [{"from": "review_agent", "to": "risk_agent",
                                 "responsibility": "투자 유의 종목이거나 고위험 신호가 있으면 리스크 점검 책임을 넘긴다",
                                 "maxHops": 1}]
    assert registry.step_ids() == ["parallel_research", "compose", "review"]


def test_selection_team_plan_shape():
    plan = registry.execution_plan(registry.SELECTION_TEAM)
    assert (plan["team"], plan["title"], plan["failurePolicy"], plan["handoffs"]) == (
        "stock_selection", "매매 종목 선정", "required_optional", [])
    assert [(s["id"], s["mode"], s["dependsOn"], s["join"], s["timeoutSec"], s["retry"]) for s in plan["steps"]] == [
        ("candidate_research", "parallel", [], False, 180, None),
        ("select", "sequential", ["candidate_research"], True, 180, None),
        ("select_review", "sequential", ["select"], False, 180, {"target": "selector_agent", "maxRounds": 2})]
    research = plan["steps"][0]
    assert (research["required"], research["optional"]) == (
        ["news_screen_agent", "filing_screen_agent"], ["flow_agent"])
    assert {w["id"]: w["outputContract"] for w in plan["workers"]} == {
        "news_screen_agent": "CandidateNewsResult", "filing_screen_agent": "FilingCheckResult",
        "flow_agent": "FlowResult", "selector_agent": "SelectionDraft", "selection_review_agent": "ReviewResult"}
    assert registry.step_ids("stock_selection") == ["candidate_research", "select", "select_review"]
    assert "selector_agent" in registry.worker_ids("stock_selection")
    assert "selector_agent" not in registry.worker_ids()


@pytest.mark.parametrize("team", registry.TEAMS)
def test_yaml_fallbacks_are_the_model_healing_picks(team):
    """화면에 보이는 대체 모델(YAML fallbacks)은 호출기가 실제로 고르는 대체 모델 하나다 (차단이 없을 때 — 00-공통 4·7절).
    healing.FALLBACK_POOL이나 주 모델을 바꾸면 YAML fallbacks도 같이 고친다."""
    from reports.autohealing import healing

    healing.breaker.reset()
    for worker in registry.execution_plan(team)["workers"]:
        picked = healing.fallback_for(worker["model"], 0.0, {worker["model"]})
        assert worker["fallbacks"] == [picked], worker["id"]


def test_plan_is_cached_and_copied(monkeypatch):
    registry.execution_plan()
    calls = []
    monkeypatch.setattr(registry, "build_plan", lambda *a, **k: calls.append(1))
    plan = registry.execution_plan()  # 처음 읽은 결과를 쓴다
    assert calls == []
    plan["steps"].clear()
    assert len(registry.execution_plan()["steps"]) == 3  # 받은 쪽이 고쳐도 캐시는 그대로
    monkeypatch.setattr(registry, "AGENTS_IMPLEMENTED", True)
    assert registry.execution_plan()["implemented"] is True


def test_tmp_plan_orders_steps_and_lists_used_workers(tmp_path):
    teams = team_with(lambda t: t["steps"].reverse())  # 뒤 단계를 먼저 적어도 실행 순서로 낸다
    plan = build_plan("t", *write(tmp_path, teams=teams))
    assert [s["id"] for s in plan["steps"]] == ["research", "compose", "review"]
    assert [w["id"] for w in plan["workers"]] == [
        "market_agent", "fundamental_agent", "news_agent", "report_agent", "review_agent", "risk_agent"]
    assert plan["steps"][1]["timeoutSec"] is None
    assert plan["steps"][2]["retry"] == {"target": "report_agent", "maxRounds": 2}
    assert plan["handoffs"][0]["maxHops"] == 2


def dup_step(t):
    t["steps"].append({**t["steps"][1], "id": "research"})


def self_cycle(t):
    t["steps"][0]["depends_on"] = ["research"]


def two_cycle(t):
    t["steps"][0]["depends_on"] = ["compose"]


@pytest.mark.parametrize("change, message", [
    (dup_step, "step id가 겹칩니다: research"),
    (lambda t: t["steps"][1].update(depends_on=["nope"]), "step 'compose': 없는 앞 단계: nope"),
    (self_cycle, "순환"),
    (two_cycle, "순환"),
    (lambda t: t["steps"][1].update(workers=["report_agent", "zz"]), "step 'compose': 정의에 없는 Worker: zz"),
    (lambda t: t["steps"][0].update(required=["market_agent", "report_agent"]),
     "required에 workers에 없는 Worker: report_agent"),
    (lambda t: t["steps"][0].update(optional=["news_agent", "risk_agent"]),
     "optional에 workers에 없는 Worker: risk_agent"),
    (lambda t: t["steps"][0].update(required=["market_agent", "news_agent"]),
     "required와 optional에 함께 있는 Worker: news_agent"),
    (lambda t: t.update(failure_policy="retry_forever"), "모르는 failure_policy: retry_forever"),
    (lambda t: t["steps"][0].update(mode="random"), "step 'research': 모르는 mode: random"),
    (lambda t: t["handoffs"][0].update(to="ghost"), "정의에 없는 Worker: ghost"),
    (lambda t: t["handoffs"][0].update({"from": "ghost"}), "정의에 없는 Worker: ghost"),
    (lambda t: t["handoffs"][0].update(max_hops=0), "max_hops는 1 이상의 정수"),
    (lambda t: t["steps"][1].update(dependson=["s1"]), "모르는 항목: dependson"),
    (lambda t: t["steps"][0].update(workers=[]), "workers가 비어 있습니다"),
    (lambda t: t["steps"][0].update(timeout=-1), "timeout"),
    (lambda t: t["steps"][0].update(join=True), "join은 앞 단계"),
    (lambda t: t["steps"][2].update(retry="again"), "retry는 객체"),
    (lambda t: t["steps"][2].update(retry={"target": "report_agent", "max_round": 2}),
     "모르는 항목: max_round"),
    (lambda t: t["steps"][2].update(retry={"target": "ghost", "max_rounds": 2}),
     "depends_on 단계의 Worker"),
    (lambda t: t["steps"][2].update(retry={"target": "market_agent", "max_rounds": 2}),
     "depends_on 단계의 Worker"),
    (lambda t: t["steps"][2].update(retry={"target": "report_agent", "max_rounds": 0}), "1 이상의 정수"),
    (lambda t: t["steps"][2].update(retry={"target": "report_agent", "max_rounds": 4}), "3 이하여야"),
    (lambda t: t.update(steps=[]), "steps가 비어 있습니다"),
])
def test_invalid_plans(tmp_path, change, message):
    with pytest.raises(PlanError, match=message):
        build_plan("t", *write(tmp_path, teams=team_with(change)))


def test_invalid_files(tmp_path):
    wf, tf = write(tmp_path)
    with pytest.raises(PlanError, match="팀 'x' 정의가 없습니다"):
        build_plan("x", wf, tf)
    with pytest.raises(PlanError, match="파일을 읽을 수 없습니다"):
        build_plan("t", tmp_path / "없음.yaml", tf)
    tf.write_text("teams: [unclosed", encoding="utf-8")
    with pytest.raises(PlanError, match="YAML 형식 오류"):
        build_plan("t", wf, tf)
    broken = copy.deepcopy(WORKERS)
    del broken["workers"]["market_agent"]["output_contract"]
    with pytest.raises(PlanError, match="Worker 'market_agent'의 output_contract 값이 없습니다"):
        build_plan("t", *write(tmp_path, workers=broken))


@pytest.mark.parametrize("change, message", [
    (lambda worker: worker.update(fallbacks="backup"), "이름 목록"),
    (lambda worker: worker.update(fallbacks=["backup", "backup"]), "겹치는 이름"),
    (lambda worker: worker.update(model="primary", fallbacks=["primary"]), "주 모델이 들어갈 수 없습니다"),
])
def test_invalid_worker_fallbacks(tmp_path, change, message):
    workers = copy.deepcopy(WORKERS)
    change(workers["workers"]["market_agent"])
    with pytest.raises(PlanError, match=message):
        build_plan("t", *write(tmp_path, workers=workers))


def test_worker_fallbacks_are_exposed_in_order(tmp_path):
    workers = copy.deepcopy(WORKERS)
    workers["workers"]["market_agent"].update(model="primary", fallbacks=["backup-1", "backup-2"])
    plan = build_plan("t", *write(tmp_path, workers=workers))
    assert plan["workers"][0]["fallbacks"] == ["backup-1", "backup-2"]


@pytest.mark.parametrize("fallbacks, message", [
    (None, "이름 목록"),
    (["backup"], "주 모델 model도 필요"),
    (["   "], "이름 목록"),
])
def test_worker_fallbacks_reject_null_missing_primary_and_blank_name(tmp_path, fallbacks, message):
    workers = copy.deepcopy(WORKERS)
    workers["workers"]["market_agent"]["fallbacks"] = fallbacks
    with pytest.raises(PlanError, match=message):
        build_plan("t", *write(tmp_path, workers=workers))


def test_worker_fallbacks_are_trimmed_before_duplicate_and_primary_checks(tmp_path):
    workers = copy.deepcopy(WORKERS)
    workers["workers"]["market_agent"].update(model="primary", fallbacks=[" backup ", "backup"])
    with pytest.raises(PlanError, match="겹치는 이름"):
        build_plan("t", *write(tmp_path, workers=workers))

    workers["workers"]["market_agent"]["fallbacks"] = [" primary "]
    with pytest.raises(PlanError, match="주 모델이 들어갈 수 없습니다"):
        build_plan("t", *write(tmp_path, workers=workers))


@pytest.mark.parametrize("max_rounds", [True, "2", 2.0, None])
def test_retry_max_rounds_must_be_an_integer(tmp_path, max_rounds):
    teams = team_with(lambda t: t["steps"][2].update(
        retry={"target": "report_agent", "max_rounds": max_rounds}))
    with pytest.raises(PlanError, match="1 이상의 정수"):
        build_plan("t", *write(tmp_path, teams=teams))


def test_retry_null_is_exposed_as_null(tmp_path):
    teams = team_with(lambda t: t["steps"][2].update(retry=None))
    assert build_plan("t", *write(tmp_path, teams=teams))["steps"][2]["retry"] is None


def test_retry_max_rounds_accepts_agreed_upper_bound(tmp_path):
    teams = team_with(lambda t: t["steps"][2].update(
        retry={"target": "report_agent", "max_rounds": 3}))
    assert build_plan("t", *write(tmp_path, teams=teams))["steps"][2]["retry"]["maxRounds"] == 3


def test_retry_is_only_allowed_on_sequential_review_stage(tmp_path):
    def change(team):
        team["steps"][2].pop("retry")
        team["steps"][1]["retry"] = {"target": "market_agent", "max_rounds": 2}

    with pytest.raises(PlanError, match="검토 Worker\\(ReviewResult\\) 하나만 있는 순차 단계"):
        build_plan("t", *write(tmp_path, teams=team_with(change)))


def test_retry_target_must_be_in_exactly_one_step(tmp_path):
    teams = team_with(lambda t: t["steps"][0]["workers"].append("report_agent"))
    with pytest.raises(PlanError, match="계획의 한 단계에만"):
        build_plan("t", *write(tmp_path, teams=teams))


def test_one_retry_target_cannot_be_used_by_multiple_review_steps(tmp_path):
    def change(team):
        team["steps"].append({
            "id": "second_review", "title": "재검토", "mode": "sequential", "workers": ["review_agent"],
            "depends_on": ["compose"], "retry": {"target": "report_agent", "max_rounds": 2},
        })

    with pytest.raises(PlanError, match="한 단계에서만 재시도"):
        build_plan("t", *write(tmp_path, teams=team_with(change)))


def test_output_contract_must_be_known(tmp_path):
    workers = copy.deepcopy(WORKERS)
    workers["workers"]["market_agent"]["output_contract"] = "MarketResults"
    with pytest.raises(PlanError, match="모르는 output_contract: MarketResults"):
        build_plan("t", *write(tmp_path, workers=workers))


def test_unknown_team_is_rejected():
    with pytest.raises(PlanError, match="모르는 팀"):
        registry.execution_plan("day_plan")
