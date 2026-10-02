"""팀 채널 알림. .env에 OPENCLAW_TARGET이 있으면 openclaw로 팀 Discord 채널에, 없으면 콘솔로 보낸다.

알림 전용이다: 매수 추천, 모의 체결·청산, 전략 실행 결과, 일일 리포트 PDF, 오류.
명령과 컨펌은 받지 않는다 (사용자 조작은 웹 화면에서 한다).
"""
import subprocess
import sys
from pathlib import Path
from typing import Protocol

from .judge.risk import RiskAssessment
from .judge.scenario import Scenario
from .judge.verdict import PASS_SCORE, Candidate

HORIZON_LABEL = {"SWING": "스윙", "LONG_TERM": "장기"}
DIRECTION_LABEL = {"POSITIVE": "호재", "NEGATIVE": "악재", "NEUTRAL": "중립"}
DISCORD_MAX_LEN = 2000  # Discord 메시지 하나의 최대 길이
OPENCLAW_TIMEOUT_SEC = 60


class Notifier(Protocol):
    def send(self, text: str) -> None:
        """팀 채널에 알린다."""

    def log(self, text: str) -> None:
        """콘솔(로그)에만 남긴다. 팀에 알릴 필요가 없는 상세 내용에 쓴다."""

    def send_file(self, path: Path, caption: str = "") -> None:
        """파일을 첨부해 보낸다 (분석 리포트, 일일 리포트)."""


class ConsoleNotifier:
    """개발용. 모두 콘솔에 출력한다."""

    def send(self, text: str) -> None:
        print(text, flush=True)

    def log(self, text: str) -> None:
        print(text, flush=True)

    def send_file(self, path: Path, caption: str = "") -> None:
        print(f"{caption}\n첨부: {path}".strip(), flush=True)


class OpenclawNotifier:
    """`openclaw message send --channel discord --target <OPENCLAW_TARGET>`로 팀 채널에 보낸다.

    같은 내용을 콘솔에도 출력한다 (로그용). 전송이 실패해도 예외를 내지 않는다 (알림 실패로 모의 체결이 멈추면 안 된다).
    """

    def __init__(self, target: str, bin_: str = "openclaw", run=subprocess.run):
        self._target = target  # channel:<ID>
        self._bin = bin_
        self._run = run

    def send(self, text: str) -> None:
        print(text, flush=True)
        try:
            for chunk in split_message(text):
                self._call(["--message", chunk])
        except OpenclawError as e:
            print(f"[openclaw 전송 실패] {e}", file=sys.stderr, flush=True)

    def log(self, text: str) -> None:
        print(text, flush=True)

    def send_file(self, path: Path, caption: str = "") -> None:
        print(f"{caption}\n첨부: {path}".strip(), flush=True)
        args = ["--media", str(path)]
        if caption:
            args += ["--message", caption[:DISCORD_MAX_LEN]]
        try:
            self._call(args)
        except OpenclawError as e:
            # 파일은 디스크에 남아 있다. 어디에 있는지는 알린다.
            print(f"[openclaw 파일 전송 실패] {e}", file=sys.stderr, flush=True)
            self.send(f"{caption}\n(파일 전송 실패. 위치: {path})".strip())

    def _call(self, args: list[str]) -> None:
        try:
            res = self._run([self._bin, "message", "send", "--channel", "discord", "--target", self._target,
                             *args, "--json"], capture_output=True, text=True, timeout=OPENCLAW_TIMEOUT_SEC)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise OpenclawError(f"openclaw 실행 실패: {e}") from None
        if res.returncode != 0:
            raise OpenclawError(f"openclaw 종료 코드 {res.returncode}: {(res.stderr or res.stdout).strip()[:300]}")


class OpenclawError(Exception):
    pass


def make_notifier(target: str | None, bin_: str = "openclaw") -> Notifier:
    """OPENCLAW_TARGET이 있으면 팀 채널, 없으면 콘솔."""
    return OpenclawNotifier(target, bin_) if target else ConsoleNotifier()


def split_message(text: str, limit: int = DISCORD_MAX_LEN) -> list[str]:
    """Discord 길이 제한에 맞게 줄 단위로 나눈다. 한 줄이 너무 길면 그 줄을 자른다."""
    chunks, current = [], ""
    for line in text.strip("\n").split("\n"):
        while len(line) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:limit])
            line = line[limit:]
        if current and len(current) + 1 + len(line) > limit:
            chunks.append(current)
            current = line
        else:
            current = f"{current}\n{line}" if current else line
    if current.strip():
        chunks.append(current)
    return chunks


def _money(value: float, currency: str) -> str:
    return f"{value:,.0f}원" if currency == "KRW" else f"${value:,.2f}"


def _size(r: RiskAssessment, currency: str) -> str:
    """수량과 매수 금액. 소수점 방식이면 금액이 기준이고 수량은 예상값이다."""
    if r.fractional:
        return f"매수 금액 {_money(r.amount, currency)} (소수점, 약 {r.quantity:.4f}주)"
    return f"수량 {r.quantity}주 · 매수 금액 {_money(r.amount, currency)}"


def format_report(s: Scenario, r: RiskAssessment, name: str = "", label: str | None = None) -> str:
    c = s.currency
    up = s.target_price / s.entry_price - 1
    down = 1 - s.stop_price / s.entry_price
    label = label or ("통과" if r.approved else "탈락")
    lines = [
        f"[{label}] {name or s.symbol} ({s.symbol}) "
        f"{HORIZON_LABEL[s.horizon]} 매수",
        f"진입 {_money(s.entry_price, c)} / 목표 {_money(s.target_price, c)} (+{up:.1%}) "
        f"/ 손절 {_money(s.stop_price, c)} (-{down:.1%})",
        f"예상 보유 {s.holding_days}일 · 목표 도달 확률 {s.probability:.0%} (AI 추정) "
        f"· 손익비 {r.reward_risk:.2f}",
        f"{_size(r, c)} (제약: {r.limited_by})",
        f"예상 수익 {_money(r.expected_profit, c)} · 최대 손실 {_money(r.max_loss, c)} "
        f"· 기대값 {_money(r.expected_value, c)} ({r.expected_return:+.2%})",
    ]
    if s.rationale:
        lines.append("근거:")
        lines += [f"  - {x}" for x in s.rationale]
    if s.invalidation:
        lines.append(f"무효화 조건: {s.invalidation}")
    if s.analyst:
        lines.append(f"제안: {s.analyst}")
    return "\n".join(lines)


def format_candidate(c: Candidate, name: str = "") -> str:
    """교차검증과 최종 컨펌 결과까지 포함한 시나리오 카드."""
    if not c.scenario:
        return (f"[탈락] {c.id} {name} · {c.proposer} 제안 · 사실·조건 검증 실패\n"
                + "\n".join(f"  - {e}" for e in c.fact_errors))
    if c.selected:
        label = "승인"
    elif c.passed:
        label = "거부"  # 판정은 통과했지만 최종 컨펌에서 거부
    else:
        label = "탈락"
    lines = [format_report(c.final, c.assessment, f"{c.id} {name}".strip(), label)]
    if c.reach:
        lines.append(c.reach.note)  # 표시용. 판정에는 쓰지 않는다
    if c.reject_reasons:
        lines.append("탈락 사유: " + "; ".join(c.reject_reasons))
    scores = [f"{c.proposer}(제안) {c.proposer_score:.0f}"]
    scores += [f"{q.analyst} {q.score:.0f}" for q in c.critiques]
    probs = [f"{c.proposer}(제안) {c.scenario.probability:.0%}"]
    probs += [f"{q.analyst} {q.probability:.0%}" for q in c.critiques]
    lines.append(f"교차검증 점수 {c.score:.0f}점 (기준 {PASS_SCORE:.0f}점, 참여 의결권 "
                 f"{c.participation:.0%}): {' / '.join(scores)}")
    lines.append(f"확률 추정: {' / '.join(probs)} → 가중 평균 {c.consensus_probability:.0%}")
    for q in c.critiques:
        lines.append(f"  [{q.analyst} {q.score:.0f}점] {q.comment}")
        lines += [f"    - {w}" for w in q.weaknesses]
    if c.approval:
        a = c.approval
        lines.append(f"최종 컨펌 ({a.approver}): {'승인' if a.approved else '거부'} · {a.reason}")
        lines += [f"  - 남은 위험: {x}" for x in a.concerns]
    return "\n".join(lines)


MAX_SUMMARY_ITEMS = 3  # 추천 카드에 넣는 근거·약점 수
MAX_ITEM_LEN = 140


def _short(text: str, limit: int = MAX_ITEM_LEN) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def format_recommendation(c: Candidate, name: str = "") -> str:
    """매수 추천 카드 (팀 채널용). 조건과 AI 추론 과정(제안 → 검증 → 최종 컨펌)을 간추린다.

    전체 평가 자료는 리포트(report.py)에 있다. 요약은 이미 있는 값을 줄여 쓰고 AI를 다시 부르지 않는다.
    """
    s, r, cur = c.final, c.assessment, c.final.currency
    up = s.target_price / s.entry_price - 1
    down = 1 - s.stop_price / s.entry_price
    lines = [
        f"[매수 추천] {name or s.symbol} ({s.symbol}) · {HORIZON_LABEL[s.horizon]} {s.holding_days}거래일",
        f"진입 {_money(s.entry_price, cur)} / 목표 {_money(s.target_price, cur)} (+{up:.1%}) "
        f"/ 손절 {_money(s.stop_price, cur)} (-{down:.1%})",
        f"{_size(r, cur)} · 예상 수익 {_money(r.expected_profit, cur)} "
        f"· 최대 손실 {_money(r.max_loss, cur)}",
        f"점수 {c.score:.0f}점 (기준 {PASS_SCORE:.0f}) · 목표 도달 확률 {c.consensus_probability:.0%} (AI 추정) "
        f"· 손익비 {r.reward_risk:.2f}",
    ]
    if r.fractional:
        lines.append("소수점 방식: 1주를 못 사서 금액 ÷ 진입가만큼 소수점 수량으로 모의 매수")
    if c.reach:
        lines.append(c.reach.note)
    lines.append("AI 추론 요약")
    lines.append(f"① 제안 ({c.proposer}, 자기 평가 {c.proposer_score:.0f}점)")
    lines += [f"  - {_short(x)}" for x in s.rationale[:MAX_SUMMARY_ITEMS]]
    if c.critiques:
        scores = [q.score for q in c.critiques]
        lines.append(f"② 검증 ({len(c.critiques)}개 모델, {min(scores):.0f}~{max(scores):.0f}점)")
        # 점수를 낮게 준 검증자의 지적부터, 검증자마다 가장 중요한 약점 하나씩
        weak = [(q.analyst, q.weaknesses[0]) for q in sorted(c.critiques, key=lambda q: q.score)
                if q.weaknesses]
        lines += [f"  - 약점 ({who}): {_short(w)}" for who, w in weak[:MAX_SUMMARY_ITEMS]]
        best = max(c.critiques, key=lambda q: q.score)
        if best.comment:
            lines.append(f"  - 총평 ({best.analyst}): {_short(best.comment)}")
    if c.approval:
        lines.append(f"③ 최종 컨펌 ({c.approval.approver}): 승인 · {_short(c.approval.reason, 240)}")
        lines += [f"  - 남은 위험: {_short(x)}" for x in c.approval.concerns[:MAX_SUMMARY_ITEMS]]
    if s.invalidation:
        lines.append(f"무효화 조건: {_short(s.invalidation, 200)}")
    return "\n".join(lines)


def format_research(research: dict, log: dict) -> str:
    """웹 조사 결과 요약. 조사자별로 찾은 내용을 보여준다."""
    lines = ["웹 조사 (검증되지 않은 외부 정보)"]
    for r in research["researchers"]:
        lines.append(f"  [{r['id']} {log['researchers'][r['id']]}] {len(r['findings'])}건")
        for f in r["findings"]:
            source = f["sourceTitle"] or f["sourceUrl"] or "출처 없음"
            if f["sourceVerified"] is False:
                source += ", 출처 확인 안 됨"
            lines.append(f"    - ({DIRECTION_LABEL[f['direction']]}, {f['date'] or '날짜 없음'}) "
                         f"{f['claim']} [{source}]")
        for e in r["upcomingEvents"]:
            lines.append(f"    - (예정 {e['date']}) {e['event']}")
    return "\n".join(lines)


def format_plan(plan, name: str) -> str:
    c = plan.currency
    size = (f"{_money(plan.entry_amount, c)}어치, 약 {plan.quantity:.4f}주 (소수점)" if plan.fractional
            else f"{plan.quantity:g}주")
    return (f"주문 계획: {name} ({plan.symbol}) {size}\n"
            f"  진입 지정가 {_money(float(plan.entry_price), c)} · 매수 금액 {_money(plan.amount, c)} "
            "(오늘 정규장 끝까지 유효, 안 되면 취소)\n"
            f"  체결 후 목표 {_money(float(plan.target_price), c)} / 손절 {_money(float(plan.stop_trigger), c)} "
            "(엔진이 2회 연속 확인하면 모의 매도)\n"
            f"  보유 기한 {plan.expire_date} (지나면 다음 정규장에서 청산)")
