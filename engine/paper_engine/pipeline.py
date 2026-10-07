"""한 종목의 분석 파이프라인.

웹 조사 → 시나리오 제안 → 사실 검증(코드) → 검증 → 판정(코드) → 최종 컨펌
손절가는 코드가 정한다 (judge/stops.py): 제안 전에 종목 데이터의 stopRule에 넣어 모든 에이전트가 같이 보고,
제안된 시나리오의 stopPrice는 그 값으로 덮어쓴다.
"""
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date

from .agents import approver, critic, proposer, researcher
from .agents.context import build_context
from .config import Config
from .judge.fact_check import fact_check
from .judge.reach import Reach, check_reach, unavailable
from .judge.risk import AccountContext
from .judge.scenario import Scenario
from .judge.stops import RULE as STOP_RULE
from .judge.stops import swing_stop
from .judge.verdict import Approval, Candidate, Critique, judge
from .llm import LlmError, LlmTimeout

MAX_PARALLEL = 12  # 동시에 보내는 AI 요청 수


class ModelResponseError(Exception):
    """핵심 모델(REQUIRED_MODELS)이 제한 시간 안에 응답하지 못해 분석을 중단함."""


@dataclass
class AnalysisResult:
    symbol: str
    candidates: list[Candidate]
    errors: list[str] = field(default_factory=list)  # AI 호출 실패 등
    research_log: dict | None = None
    stages: list[dict] = field(default_factory=list)  # 단계별 소요 시간과 AI 비용
    excluded: list[str] = field(default_factory=list)  # 시간 초과로 이후 단계와 의결에서 뺀 모델


def _call(fn, *args):
    try:
        return fn(*args)
    except LlmError as e:
        return e


def _reach(s: Scenario, snapshot: dict) -> Reach:
    """목표가 도달 가능성 점검 (표시용). 어떤 오류도 분석을 멈추지 않고 '점검 못 함'으로 남긴다."""
    try:
        atr = (snapshot.get("indicators") or {}).get("atr14")
        return check_reach(s.entry_price, s.target_price, s.holding_days,
                           None if atr is None else float(atr))
    except Exception as e:
        return unavailable(str(e))


def stop_rule(snapshot: dict) -> dict:
    """종목 데이터 → stopRule (코드가 정한 손절가와 정하는 법). 자료가 모자라면 price는 None."""
    try:
        atr = (snapshot.get("indicators") or {}).get("atr14")
        lows = [float(c["low"]) for c in snapshot.get("recentCandles") or []]
        price = swing_stop(float(snapshot["lastPrice"]), lows, None if atr is None else float(atr),
                           snapshot["currency"])
    except (KeyError, TypeError, ValueError):
        price = None
    return {"price": price, "basis": "lastPrice", "rule": STOP_RULE}


def apply_stop(raw: dict, stop: float | None) -> list[str]:
    """제안된 시나리오의 stopPrice를 코드가 정한 손절가로 바꾼다. 쓸 수 없으면 사유를 돌려준다."""
    if stop is None:
        return ["손절가를 정할 자료(완성 일봉·ATR14)가 모자람"]
    raw["stopPrice"] = stop
    try:
        entry = float(raw["entryPrice"])
    except (KeyError, TypeError, ValueError):
        return []  # 형식 오류는 시나리오를 만들 때 잡는다
    if entry <= stop:
        return [f"진입가 {entry:g}가 코드가 정한 손절가 {stop:g} 이하"]
    return []


def analyze(llm, cfg: Config, snapshot: dict, account: AccountContext, today: date,
            web: bool = True, fractional: bool = False) -> AnalysisResult:
    """snapshot에 webResearch를 채워 넣고, 그 데이터를 모든 에이전트가 공유한다.

    fractional이면 미국 종목에서 1주를 못 살 때 소수점 방식으로 수량을 계산한다 (judge/risk.py).
    """
    fractional = fractional and snapshot["currency"] == "USD"
    result = AnalysisResult(snapshot["symbol"], [])
    analysts = [m.id for m in cfg.analysts]

    def timed_out(name: str, stage_name: str) -> None:
        """시간 초과는 한 번만 나도 그 모델을 이후 단계와 의결에서 뺀다. 핵심 모델이면 분석을 중단한다."""
        if name in cfg.required_models:
            raise ModelResponseError(f"{name}이(가) {stage_name} 단계에서 제한 시간 안에 응답하지 않음")
        if name not in result.excluded:
            result.excluded.append(name)

    def active() -> list[str]:
        return [m for m in analysts if m not in result.excluded]
    mark = [time.monotonic(), llm.cost]

    def stage(name: str, calls: int) -> None:
        now, cost = time.monotonic(), llm.cost
        result.stages.append({"stage": name, "calls": calls, "seconds": round(now - mark[0], 1),
                              "costUsd": round(cost - mark[1], 4)})
        mark[:] = [now, cost]

    with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        # 1. 웹 조사
        if web and cfg.researchers:
            snapshot["webResearch"], result.research_log = researcher.run_research(
                llm, list(cfg.researchers), snapshot, today)
            result.errors += result.research_log["errors"]
            for name in result.research_log["timedOut"]:
                timed_out(name, "웹 조사")
            stage("웹 조사", len(cfg.researchers))
        snapshot["stopRule"] = stop_rule(snapshot)
        context = build_context(snapshot)

        # 2. 시나리오 제안 (독립)
        proposers = active()
        outcomes = list(pool.map(lambda m: _call(proposer.propose, llm, m, context), proposers))
        for name, outcome in zip(proposers, outcomes):
            if isinstance(outcome, Exception):
                result.errors.append(f"{name} 시나리오 제안 실패: {outcome}")
                if isinstance(outcome, LlmTimeout):
                    timed_out(name, "시나리오 제안")
                continue
            for raw in outcome:
                result.candidates.append(
                    Candidate(id=f"S{len(result.candidates) + 1}", proposer=name, raw=raw))

        stage("시나리오 제안", len(proposers))

        # 3. 사실 검증 (코드). 손절가는 여기서 코드 값으로 바꾼다 (검증 AI도 바뀐 값을 본다)
        for c in result.candidates:
            c.fact_errors = fact_check(snapshot, c.raw) + apply_stop(c.raw, snapshot["stopRule"]["price"])
            if c.fact_errors:
                continue
            try:
                c.proposer_score = min(max(float(c.raw["score"]), 0.0), 100.0)
                c.scenario = Scenario.from_dict({
                    **c.raw, "symbol": snapshot["symbol"], "currency": snapshot["currency"],
                    "analyst": c.proposer,
                    "rationale": [str(r.get("claim", "")) for r in c.raw.get("rationale") or []],
                })
            except (ValueError, KeyError, TypeError) as e:
                c.fact_errors.append(f"시나리오 형식 오류: {e}")
                continue
            c.reach = _reach(c.scenario, snapshot)
        valid = [c for c in result.candidates if c.scenario]

        # 4. 검증: 모델마다 한 번의 호출로 자기 제안을 뺀 전체를 채점한다
        jobs = {name: {c.id: c.raw for c in valid if c.proposer != name} for name in active()}
        jobs = {name: scenarios for name, scenarios in jobs.items() if scenarios}
        notes = {c.id: c.reach.note for c in valid if c.reach}
        outcomes = list(pool.map(lambda m: _call(critic.review, llm, m, context, jobs[m], notes), jobs))
        by_id = {c.id: c for c in valid}
        for name, outcome in zip(jobs, outcomes):
            if isinstance(outcome, Exception):
                result.errors.append(f"{name} 검증 실패: {outcome}")
                if isinstance(outcome, LlmTimeout):
                    timed_out(name, "검증")
                continue
            missing = set(jobs[name]) - set(outcome)
            if missing:
                result.errors.append(f"{name} 검증 누락: {', '.join(sorted(missing))}")
            for sid, r in outcome.items():
                by_id[sid].critiques.append(Critique(analyst=name, **r))

        stage("검증", len(jobs))

        # 5. 판정 (코드): 제외된 모델을 뺀 나머지끼리 의결권을 다시 나눈다
        weights = {name: w for name, w in cfg.weights.items() if name in active()}
        total = sum(weights.values())
        weights = {name: w / total for name, w in weights.items()}
        for c in valid:
            judge(c, weights, account, fractional)

        # 6. 최종 컨펌: 판정을 통과한 시나리오만
        passed = [c for c in valid if c.passed]
        if passed and not cfg.approver:
            result.errors.append("APPROVER가 설정되지 않아 최종 컨펌을 하지 못함")
        elif passed:
            approvals = list(pool.map(
                lambda c: _call(approver.approve, llm, cfg.approver, context, c), passed))
            for c, approval in zip(passed, approvals):
                if isinstance(approval, LlmTimeout):
                    timed_out(cfg.approver, "최종 컨펌")
                    approval = Approval(False, f"최종 컨펌 응답을 받지 못함: {approval}", [],
                                        cfg.approver)
                c.approval = approval
            stage("최종 컨펌", len(passed))

    for name in result.excluded:
        result.errors.append(f"{name}: 시간 초과로 이후 단계와 의결에서 제외함")
    result.candidates.sort(key=lambda c: (c.selected, c.passed, c.score), reverse=True)
    return result
