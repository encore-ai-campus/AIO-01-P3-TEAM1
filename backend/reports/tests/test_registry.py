"""YAML Registry → ExecutionPlan과 계획 검증. 잘못된 계획은 tmp YAML로 만든다."""
import copy

import pytest
import yaml

from reports import registry
from reports.registry import PlanError, build_plan

WORKERS = {"workers": {
    wid: {"title": f"{wid} 제목", "goal": f"{wid} 목표", "provider": None, "model": None, "output_contract": f"{wid}Result"}
    for wid in ("a", "b", "c", "d", "e")}}
TEAM = {"teams": {"t": {
    "title": "시험 팀", "failure_policy": "required_optional",
    "steps": [
        {"id": "s1", "title": "조사", "mode": "parallel", "workers": ["a", "b", "c"], "required": ["a", "b"],
         "optional": ["c"], "timeout": 60},
        {"id": "s2", "title": "작성", "mode": "sequential", "workers": ["d"], "depends_on": ["s1"], "join": True,
         "retry": {"target": "a", "max_rounds": 2}},
    ],
    "handoffs": [{"from": "d", "to": "e", "responsibility": "넘긴다", "max_hops": 2}],
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
        "stock_report", "종목 리포트", "required_optional", False)
    assert [(s["id"], s["mode"], s["dependsOn"], s["join"], s["timeoutSec"], s["retry"]) for s in plan["steps"]] == [
        ("parallel_research", "parallel", [], False, 60, None),
        ("compose", "sequential", ["parallel_research"], True, 90, None),
        ("review", "sequential", ["compose"], False, 60, {"target": "report_agent", "maxRounds": 2})]
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
        "시세·차트 Agent", None, None, [], "MarketResult")
    assert all(w["goal"] for w in plan["workers"])
    assert plan["handoffs"] == [{"from": "review_agent", "to": "risk_agent",
                                 "responsibility": "투자 유의 종목이거나 고위험 신호가 있으면 리스크 점검 책임을 넘긴다",
                                 "maxHops": 1}]
    assert registry.step_ids() == ["parallel_research", "compose", "review"]


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
    assert [s["id"] for s in plan["steps"]] == ["s1", "s2"]
    assert [w["id"] for w in plan["workers"]] == ["a", "b", "c", "d", "e"]
    assert plan["steps"][1]["timeoutSec"] is None
    assert plan["steps"][1]["retry"] == {"target": "a", "maxRounds": 2}
    assert plan["handoffs"][0]["maxHops"] == 2


def dup_step(t):
    t["steps"].append({**t["steps"][1], "id": "s1"})


def self_cycle(t):
    t["steps"][0]["depends_on"] = ["s1"]


def two_cycle(t):
    t["steps"][0]["depends_on"] = ["s2"]


@pytest.mark.parametrize("change, message", [
    (dup_step, "step id가 겹칩니다: s1"),
    (lambda t: t["steps"][1].update(depends_on=["nope"]), "step 's2': 없는 앞 단계: nope"),
    (self_cycle, "순환"),
    (two_cycle, "순환"),
    (lambda t: t["steps"][1].update(workers=["d", "zz"]), "step 's2': 정의에 없는 Worker: zz"),
    (lambda t: t["steps"][0].update(required=["a", "d"]), "required에 workers에 없는 Worker: d"),
    (lambda t: t["steps"][0].update(optional=["c", "e"]), "optional에 workers에 없는 Worker: e"),
    (lambda t: t["steps"][0].update(required=["a", "c"]), "required와 optional에 함께 있는 Worker: c"),
    (lambda t: t.update(failure_policy="retry_forever"), "모르는 failure_policy: retry_forever"),
    (lambda t: t["steps"][0].update(mode="random"), "step 's1': 모르는 mode: random"),
    (lambda t: t["handoffs"][0].update(to="ghost"), "정의에 없는 Worker: ghost"),
    (lambda t: t["handoffs"][0].update({"from": "ghost"}), "정의에 없는 Worker: ghost"),
    (lambda t: t["handoffs"][0].update(max_hops=0), "max_hops는 1 이상의 정수"),
    (lambda t: t["steps"][1].update(dependson=["s1"]), "모르는 항목: dependson"),
    (lambda t: t["steps"][0].update(workers=[]), "workers가 비어 있습니다"),
    (lambda t: t["steps"][0].update(timeout=-1), "timeout"),
    (lambda t: t["steps"][0].update(join=True), "join은 앞 단계"),
    (lambda t: t["steps"][1].update(retry="again"), "retry는 객체"),
    (lambda t: t["steps"][1].update(retry={"target": "a", "max_round": 2}), "모르는 항목: max_round"),
    (lambda t: t["steps"][1].update(retry={"target": "ghost", "max_rounds": 2}), "정의되지 않은 Worker"),
    (lambda t: t["steps"][1].update(retry={"target": "d", "max_rounds": 2}), "depends_on 단계의 Worker"),
    (lambda t: t["steps"][1].update(retry={"target": "a", "max_rounds": 0}), "1 이상의 정수"),
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
    del broken["workers"]["a"]["output_contract"]
    with pytest.raises(PlanError, match="Worker 'a'의 output_contract 값이 없습니다"):
        build_plan("t", *write(tmp_path, workers=broken))


@pytest.mark.parametrize("change, message", [
    (lambda worker: worker.update(fallbacks="backup"), "이름 목록"),
    (lambda worker: worker.update(fallbacks=["backup", "backup"]), "겹치는 이름"),
    (lambda worker: worker.update(model="primary", fallbacks=["primary"]), "주 모델이 들어갈 수 없습니다"),
])
def test_invalid_worker_fallbacks(tmp_path, change, message):
    workers = copy.deepcopy(WORKERS)
    change(workers["workers"]["a"])
    with pytest.raises(PlanError, match=message):
        build_plan("t", *write(tmp_path, workers=workers))


def test_worker_fallbacks_are_exposed_in_order(tmp_path):
    workers = copy.deepcopy(WORKERS)
    workers["workers"]["a"].update(model="primary", fallbacks=["backup-1", "backup-2"])
    plan = build_plan("t", *write(tmp_path, workers=workers))
    assert plan["workers"][0]["fallbacks"] == ["backup-1", "backup-2"]
