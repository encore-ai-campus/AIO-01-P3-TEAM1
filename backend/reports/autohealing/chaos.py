"""장애 주입 (docs/tasks/00-공통.md 5절, 04-autohealing.md T4-6, docs/API.md `ChaosConfig`).

리포트를 신청할 때 `chaos`를 켜면 Worker의 LLM 호출 일부를 일부러 실패시킨다. 주입은 `healing`의 실제 호출 직전 한 곳에서만 하고,
그 뒤는 진짜 장애와 같은 복구 경로(재시도 → 대체 모델 → Circuit Breaker)를 탄다. 주입 여부는 Trace의 `injected`에만 남는다.

판정은 재현할 수 있다: 같은 seed·Worker·모델·시도 번호면 같은 결과다 (seed는 신청 때 서버가 정해 저장한다).
"""
import random
import secrets

from config.api import Rejected

from ..orchestration import registry

ERROR_TYPES = ("timeout", "server_error", "bad_output")   # 주입할 수 있는 실패 (unknown 제외)
SCOPES = ("primary", "all")    # primary: 주 모델 호출만 실패 (대체 모델로 복구되는 것을 보인다) · all: 대체 모델까지
DEFAULT_PROBABILITY = 0.5
SEED_BITS = 31
MAX_SEED = 2 ** 53   # 신청에서 받는 seed 상한 (브라우저 Number가 정확한 범위 — "같은 설정으로 다시 신청"이 같은 seed를 보내게)
KEYS = {"enabled", "probability", "errorTypes", "workers", "scope", "seed"}


def parse(body, team: str = registry.TEAM) -> dict | None:
    """요청의 `chaos`를 검사해 저장할 ChaosConfig로 만든다. 없거나 꺼져 있으면 None. 잘못되면 Rejected(400).

    `enabled`만 필수이고 나머지는 기본값: probability 0.5, errorTypes 셋 다, workers null(전부), scope "primary", seed는 서버가 정한다.
    """
    if body is None:
        return None
    if not isinstance(body, dict):
        raise Rejected("chaos는 객체여야 합니다.")
    unknown = set(body) - KEYS
    if unknown:
        raise Rejected(f"chaos에 모르는 항목이 있습니다: {', '.join(sorted(unknown))}")
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        raise Rejected("chaos.enabled는 true 또는 false입니다.")
    probability = _probability(body.get("probability", DEFAULT_PROBABILITY))
    error_types = _error_types(body.get("errorTypes", list(ERROR_TYPES)))
    workers = _workers(body.get("workers"), team)
    scope = body.get("scope", "primary")
    if scope not in SCOPES:
        raise Rejected(f"chaos.scope는 {' 또는 '.join(SCOPES)}입니다.")
    seed = body.get("seed")
    if seed is None:
        seed = secrets.randbits(SEED_BITS)
    elif isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < MAX_SEED:
        raise Rejected("chaos.seed는 0 이상 2^53 미만의 정수입니다.")
    if not enabled:  # 끈 설정은 저장하지 않는다 (null = 끄기). 그래도 형식은 위에서 검사했다
        return None
    return {"enabled": True, "probability": probability, "errorTypes": error_types, "workers": workers,
            "scope": scope, "seed": seed}


def is_on(chaos: dict | None) -> bool:
    """저장된 ChaosConfig가 장애 주입을 켰는지."""
    return isinstance(chaos, dict) and chaos.get("enabled") is True


def should_fail(chaos: dict | None, worker_id: str, model: str, is_primary: bool, attempt: int) -> str | None:
    """이 호출을 실패시킬지. 실패시키면 실패 종류(ERROR_TYPES 중 하나), 아니면 None.

    attempt는 그 Worker 실행에서의 전체 시도 번호 (Trace `agent_failed.details.attempt`와 같다).
    """
    if not is_on(chaos):
        return None
    workers = chaos.get("workers")
    if workers is not None and worker_id not in workers:
        return None
    if chaos.get("scope", "primary") == "primary" and not is_primary:
        return None
    rng = random.Random(f"{chaos.get('seed')}:{worker_id}:{model}:{attempt}")
    if rng.random() >= chaos.get("probability", DEFAULT_PROBABILITY):
        return None
    types = [t for t in chaos.get("errorTypes") or ERROR_TYPES if t in ERROR_TYPES] or list(ERROR_TYPES)
    return rng.choice(types)


def _probability(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
        raise Rejected("chaos.probability는 0~1 사이의 숫자입니다.")
    return float(value)


def _error_types(value) -> list[str]:
    if not isinstance(value, list) or not value or any(t not in ERROR_TYPES for t in value):
        raise Rejected(f"chaos.errorTypes는 {', '.join(ERROR_TYPES)} 중 하나 이상입니다.")
    return list(dict.fromkeys(value))


def _workers(value, team: str) -> list[str] | None:
    if value is None:
        return None
    known = registry.worker_ids(team)
    if not isinstance(value, list) or not value or any(not isinstance(w, str) or w not in known for w in value):
        raise Rejected(f"chaos.workers는 null이거나 이 Worker 중 하나 이상입니다: {', '.join(known)}")
    return list(dict.fromkeys(value))
