"""판정. 에이전트들의 점수와 확률을 의결권으로 가중 평균하고, 리스크 엔진과 함께 통과 여부를 정한다."""
from dataclasses import dataclass, field, replace

from .reach import Reach
from .risk import AccountContext, RiskAssessment, assess
from .scenario import Scenario

PASS_SCORE = 60.0  # 가중 평균 점수가 이 값 이상이어야 통과
QUORUM = 0.6  # 평가에 참여한 모델의 의결권 합이 이 비율 이상이어야 판정이 유효


@dataclass
class Critique:
    analyst: str
    score: float  # 0~100
    probability: float
    weaknesses: list[str]
    comment: str


@dataclass
class Approval:
    approved: bool
    reason: str
    concerns: list[str]
    approver: str


@dataclass
class Candidate:
    id: str  # S1, S2... 한 종목 분석 안에서의 번호
    proposer: str
    raw: dict
    scenario: Scenario | None = None
    fact_errors: list[str] = field(default_factory=list)
    proposer_score: float | None = None  # 제안자의 자기 평가 (0~100)
    critiques: list[Critique] = field(default_factory=list)
    consensus_probability: float | None = None
    score: float = 0.0  # 의결권 가중 평균 점수 (0~100)
    participation: float = 0.0  # 평가에 참여한 모델의 의결권 합 (전체 1.0)
    assessment: RiskAssessment | None = None
    final: Scenario | None = None  # 합의 확률을 반영한 시나리오
    approval: Approval | None = None  # 판정을 통과한 경우에만 받는다
    reach: Reach | None = None  # 목표가 도달 가능성 점검. 표시용이며 판정에 쓰지 않는다

    @property
    def passed(self) -> bool:
        """교차검증 점수와 리스크 엔진을 모두 통과했는지."""
        return not self.reject_reasons

    @property
    def selected(self) -> bool:
        """판정을 통과하고 최종 컨펌까지 받았는지."""
        return bool(self.passed and self.approval and self.approval.approved)

    @property
    def reject_reasons(self) -> list[str]:
        if not self.scenario:
            return list(self.fact_errors)
        reasons = list(self.assessment.reasons)
        if self.participation < QUORUM:
            reasons.append(f"평가 참여 의결권 {self.participation:.0%}가 기준 {QUORUM:.0%}보다 낮음")
        elif self.score < PASS_SCORE:
            reasons.append(f"교차검증 점수 {self.score:.0f}점이 기준 {PASS_SCORE:.0f}점보다 낮음")
        return reasons


def judge(c: Candidate, weights: dict[str, float], account: AccountContext,
          fractional: bool = False) -> None:
    """점수와 확률을 의결권으로 가중 평균하고 리스크 엔진을 돌린다.

    weights에 없는 모델(시간 초과로 제외된 모델)의 점수는 쓰지 않는다. 제안자가 제외됐으면
    제안자의 자기 평가도 뺀다. 평가에 참여한 의결권이 QUORUM에 못 미치면 통과시키지 않는다.
    """
    voters = [(c.proposer, c.proposer_score, c.scenario.probability)]
    voters += [(q.analyst, q.score, q.probability) for q in c.critiques]
    voters = [v for v in voters if v[0] in weights]
    total = sum(weights[name] for name, _, _ in voters)
    c.participation = total / sum(weights.values()) if weights else 0.0
    if total:
        c.score = sum(weights[n] * s for n, s, _ in voters) / total
        c.consensus_probability = sum(weights[n] * p for n, _, p in voters) / total
    else:
        c.score, c.consensus_probability = 0.0, c.scenario.probability
    c.final = replace(c.scenario, probability=c.consensus_probability)
    c.assessment = assess(c.final, account, fractional)
