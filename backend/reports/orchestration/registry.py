"""YAML Registry → 실행 계획 (docs/API.md "AI 리포트"의 ExecutionPlan, docs/DECISIONS.md 9-2·9-3).

worker_definitions.yaml(Worker 이름·목표·Provider·주·대체 모델·출력 계약)과
team_definitions.yaml(단계·병렬·필수/선택·Timeout·Retry·Handoff)을 읽어 계획을 검증하고 API 형식(camelCase) dict로 만든다.
정의하지 않은 키도 오타로 보고 거부한다. 실행 정책(병렬 실행, Join, 부분 실패, Retry·Handoff 판단)은 여기서 하지 않는다.
검증은 서버 시작이 아니라 처음 읽을 때 하고 결과를 캐시한다 (YAML을 고치면 서버를 다시 띄운다).
"""
import copy
from functools import cache
from numbers import Real
from pathlib import Path

import yaml

from ..guardrails import contracts

HERE = Path(__file__).resolve().parent
WORKERS_FILE, TEAMS_FILE = HERE / "worker_definitions.yaml", HERE / "team_definitions.yaml"
TEAM = "stock_report"                # 팀원이 신청하는 종목 리포트 (기본 팀)
SELECTION_TEAM = "stock_selection"   # 하루 한 번 자동 리포트할 종목을 고르는 선정 팀 (docs/design/AI_AGENT_WORKFLOW.md)
TEAMS = (TEAM, SELECTION_TEAM)
# Agent·Orchestrator를 붙이면 True로 바꾼다 (화면이 SSE를 연다. DECISIONS 9-4)
AGENTS_IMPLEMENTED = True
REVIEW_CONTRACT = "ReviewResult"     # retry(검토 반복)를 둘 수 있는 단계의 Worker 출력 계약

FAILURE_POLICIES = ("fail_fast", "best_effort", "required_optional")
MODES = ("parallel", "sequential")
WORKER_KEYS = {"title", "goal", "provider", "model", "fallbacks", "output_contract"}
STEP_KEYS = {"id", "title", "mode", "workers", "required", "optional", "depends_on", "join", "timeout", "retry"}
TEAM_KEYS = {"title", "failure_policy", "steps", "handoffs"}
HANDOFF_KEYS = {"from", "to", "responsibility", "max_hops"}
RETRY_KEYS = {"target", "max_rounds"}
MAX_RETRY_ROUNDS = 3


class PlanError(ValueError):
    """실행 계획이 잘못됨. 메시지에 사유가 있다."""


def execution_plan(team: str = TEAM) -> dict:
    """팀의 ExecutionPlan (기본은 종목 리포트). 캐시한 계획을 고쳐도 안 바뀌게 복사본을 준다. 모르는 팀이면 PlanError."""
    plan = copy.deepcopy(_cached_plan(team))
    plan["implemented"] = AGENTS_IMPLEMENTED
    return plan


def step_ids(team: str = TEAM) -> list[str]:
    return [step["id"] for step in _cached_plan(team)["steps"]]


def worker_ids(team: str = TEAM) -> list[str]:
    return [worker["id"] for worker in _cached_plan(team)["workers"]]


def _cached_plan(team: str = TEAM) -> dict:
    if team not in TEAMS:
        raise PlanError(f"모르는 팀: {team}")
    return _plan_of(team)


@cache
def _plan_of(team: str) -> dict:
    return build_plan(team)


def build_plan(team: str = TEAM, workers_file: Path = WORKERS_FILE, teams_file: Path = TEAMS_FILE) -> dict:
    """YAML 두 파일을 읽어 검증하고 ExecutionPlan을 만든다 (캐시 없음). 잘못되면 PlanError."""
    definitions = {wid: _worker(wid, spec) for wid, spec in _section(workers_file, "workers").items()}
    spec = _section(teams_file, "teams").get(team)
    if not isinstance(spec, dict):
        raise PlanError(f"{teams_file.name}에 팀 '{team}' 정의가 없습니다.")
    _known_keys(spec, TEAM_KEYS, f"팀 '{team}'")
    title = _text(spec.get("title"), f"팀 '{team}'의 title")
    policy = spec.get("failure_policy")
    if policy not in FAILURE_POLICIES:
        raise PlanError(f"팀 '{team}': 모르는 failure_policy: {policy}")

    raw_steps = spec.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise PlanError(f"팀 '{team}': steps가 비어 있습니다.")
    steps, seen = [], set()
    for raw in raw_steps:
        step = _step(raw, definitions)
        if step["id"] in seen:
            raise PlanError(f"step id가 겹칩니다: {step['id']}")
        seen.add(step["id"])
        steps.append(step)
    for step in steps:
        missing = [dep for dep in step["dependsOn"] if dep not in seen]
        if missing:
            raise PlanError(f"step '{step['id']}': 없는 앞 단계: {', '.join(missing)}")
    steps_by_id = {step["id"]: step for step in steps}
    worker_steps: dict[str, list[str]] = {}
    for step in steps:
        for worker in step["workers"]:
            worker_steps.setdefault(worker, []).append(step["id"])
    retry_targets: set[str] = set()
    for step in steps:
        retry = step["retry"]
        if retry is None:
            continue
        dependency_workers = {
            worker
            for dependency in step["dependsOn"]
            for worker in steps_by_id[dependency]["workers"]
        }
        if retry["target"] not in dependency_workers:
            raise PlanError(
                f"step '{step['id']}': retry target은 depends_on 단계의 Worker여야 합니다: {retry['target']}"
            )
        target_steps = worker_steps.get(retry["target"], [])
        if len(target_steps) != 1:
            raise PlanError(
                f"step '{step['id']}': retry target Worker는 계획의 한 단계에만 있어야 합니다: "
                f"{retry['target']} ({', '.join(target_steps)})"
            )
        if retry["target"] in retry_targets:
            raise PlanError(f"retry target은 한 단계에서만 재시도할 수 있습니다: {retry['target']}")
        retry_targets.add(retry["target"])
    steps = _ordered(steps)

    raw_handoffs = spec.get("handoffs") or []
    if not isinstance(raw_handoffs, list):
        raise PlanError(f"팀 '{team}': handoffs는 목록이어야 합니다.")
    handoffs = [_handoff(raw, definitions) for raw in raw_handoffs]

    used = [wid for step in steps for wid in step["workers"]]
    used += [wid for handoff in handoffs for wid in (handoff["from"], handoff["to"])]
    return {
        "team": team, "title": title, "failurePolicy": policy, "steps": steps,
        "workers": [definitions[wid] for wid in dict.fromkeys(used)],  # 처음 나온 순서, 중복 없이
        "handoffs": handoffs, "implemented": AGENTS_IMPLEMENTED,
    }


def _section(path: Path, key: str) -> dict:
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except OSError as e:
        raise PlanError(f"{Path(path).name} 파일을 읽을 수 없습니다: {e}") from None
    except yaml.YAMLError as e:
        raise PlanError(f"{Path(path).name}: YAML 형식 오류: {e}") from None
    section = data.get(key) if isinstance(data, dict) else None
    if not isinstance(section, dict) or not section:
        raise PlanError(f"{Path(path).name}에 '{key}' 항목이 없습니다.")
    return section


def _worker(wid, spec) -> dict:
    where = f"Worker '{wid}'"
    if not isinstance(wid, str) or not isinstance(spec, dict):
        raise PlanError(f"{where}의 정의가 올바르지 않습니다.")
    _known_keys(spec, WORKER_KEYS, where)
    model = _optional_text(spec.get("model"), f"{where}의 model")
    fallbacks = _names(spec.get("fallbacks", []), f"{where}의 fallbacks")
    if fallbacks and model is None:
        raise PlanError(f"{where}: fallbacks가 있으면 주 모델 model도 필요합니다.")
    if model is not None and model in fallbacks:
        raise PlanError(f"{where}: fallbacks에 주 모델이 들어갈 수 없습니다: {model}")
    return {
        "id": wid, "title": _text(spec.get("title"), f"{where}의 title"), "goal": _text(spec.get("goal"), f"{where}의 goal"),
        "provider": _optional_text(spec.get("provider"), f"{where}의 provider"),
        "model": model, "fallbacks": fallbacks,
        "outputContract": _contract(spec.get("output_contract"), where),
    }


def _contract(value, where: str) -> str:
    name = _text(value, f"{where}의 output_contract")
    if name not in contracts.NAMES:  # 오타면 호출기가 bad_output으로 재시도·대체 모델까지 가므로 여기서 막는다
        raise PlanError(f"{where}: 모르는 output_contract: {name}")
    return name


def _step(raw, definitions: dict) -> dict:
    if not isinstance(raw, dict):
        raise PlanError(f"step 정의가 올바르지 않습니다: {raw!r}")
    sid = _text(raw.get("id"), "step의 id")
    where = f"step '{sid}'"
    _known_keys(raw, STEP_KEYS, where)
    mode = raw.get("mode")
    if mode not in MODES:
        raise PlanError(f"{where}: 모르는 mode: {mode}")
    workers = _names(raw.get("workers"), f"{where}의 workers")
    if not workers:
        raise PlanError(f"{where}: workers가 비어 있습니다.")
    unknown = [wid for wid in workers if wid not in definitions]
    if unknown:
        raise PlanError(f"{where}: 정의에 없는 Worker: {', '.join(unknown)}")
    optional = _names(raw.get("optional", []), f"{where}의 optional")
    required = (_names(raw["required"], f"{where}의 required") if "required" in raw
                else [wid for wid in workers if wid not in optional])
    for label, names in (("required", required), ("optional", optional)):
        outside = [wid for wid in names if wid not in workers]
        if outside:
            raise PlanError(f"{where}: {label}에 workers에 없는 Worker: {', '.join(outside)}")
    both = [wid for wid in required if wid in optional]
    if both:
        raise PlanError(f"{where}: required와 optional에 함께 있는 Worker: {', '.join(both)}")
    depends_on = _names(raw.get("depends_on", []), f"{where}의 depends_on")
    join = raw.get("join", False)
    if not isinstance(join, bool):
        raise PlanError(f"{where}: join은 true 또는 false여야 합니다.")
    if join and not depends_on:
        raise PlanError(f"{where}: join은 앞 단계(depends_on)가 있어야 합니다.")
    timeout = raw.get("timeout")
    if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, Real) or timeout <= 0):
        raise PlanError(f"{where}: timeout은 0보다 큰 초 단위 숫자여야 합니다.")
    retry = _retry(raw.get("retry"), where)
    if retry is not None and (mode != "sequential" or len(workers) != 1
                              or definitions[workers[0]]["outputContract"] != REVIEW_CONTRACT):
        raise PlanError(f"{where}: retry는 검토 Worker({REVIEW_CONTRACT}) 하나만 있는 순차 단계에서만 허용됩니다.")
    return {"id": sid, "title": _text(raw.get("title"), f"{where}의 title"), "mode": mode, "workers": workers,
            "required": required, "optional": optional, "dependsOn": depends_on, "join": join, "timeoutSec": timeout,
            "retry": retry}


def _retry(raw, where: str) -> dict | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise PlanError(f"{where}: retry는 객체여야 합니다.")
    _known_keys(raw, RETRY_KEYS, f"{where}의 retry")
    target = _text(raw.get("target"), f"{where}의 retry target")
    max_rounds = _positive_int(raw.get("max_rounds"), f"{where}: retry max_rounds", MAX_RETRY_ROUNDS)
    return {"target": target, "maxRounds": max_rounds}


def _ordered(steps: list[dict]) -> list[dict]:
    """앞 단계가 먼저 오는 실행 순서 (YAML 순서를 되도록 지킨다). 순환이 있으면 PlanError."""
    ordered, done, pending = [], set(), list(steps)
    while pending:
        ready = next((step for step in pending if set(step["dependsOn"]) <= done), None)
        if ready is None:
            raise PlanError(f"step 의존 관계에 순환이 있습니다: {', '.join(step['id'] for step in pending)}")
        ordered.append(ready)
        done.add(ready["id"])
        pending.remove(ready)
    return ordered


def _handoff(raw, definitions: dict) -> dict:
    if not isinstance(raw, dict):
        raise PlanError(f"handoff 정의가 올바르지 않습니다: {raw!r}")
    _known_keys(raw, HANDOFF_KEYS, "handoff")
    source, target = _text(raw.get("from"), "handoff의 from"), _text(raw.get("to"), "handoff의 to")
    where = f"handoff '{source} → {target}'"
    unknown = [wid for wid in (source, target) if wid not in definitions]
    if unknown:
        raise PlanError(f"{where}: 정의에 없는 Worker: {', '.join(unknown)}")
    if source == target:
        raise PlanError(f"{where}: 자기 자신에게 넘길 수 없습니다.")
    max_hops = _positive_int(raw.get("max_hops", 1), f"{where}: max_hops")
    return {"from": source, "to": target, "responsibility": _text(raw.get("responsibility"), f"{where}의 responsibility"),
            "maxHops": max_hops}


def _known_keys(spec: dict, allowed: set[str], where: str) -> None:
    """오타(예: dependson)를 조용히 무시하지 않게 모르는 항목을 막는다."""
    unknown = sorted(str(key) for key in spec if key not in allowed)
    if unknown:
        raise PlanError(f"{where}: 모르는 항목: {', '.join(unknown)}")


def _text(value, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PlanError(f"{label} 값이 없습니다.")
    return value.strip()


def _optional_text(value, label: str) -> str | None:
    return None if value is None else _text(value, label)


def _positive_int(value, label: str, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise PlanError(f"{label}는 1 이상의 정수여야 합니다.")
    if maximum is not None and value > maximum:
        raise PlanError(f"{label}는 {maximum} 이하여야 합니다.")
    return value


def _names(value, label: str) -> list[str]:
    if not isinstance(value, list):
        raise PlanError(f"{label}: 이름 목록이어야 합니다.")
    names = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise PlanError(f"{label}: 이름 목록이어야 합니다.")
        names.append(item.strip())
    if len(set(names)) != len(names):
        raise PlanError(f"{label}: 겹치는 이름이 있습니다.")
    return names
