"""주린이모드 쉬운 판 PDF (docs/DECISIONS.md 20장): 문장 함수(웹 TS 테스트의 사례를 그대로 옮겼다), 짝 TS 파일과 문장 표가 같은지,
쉬운 판 HTML(넣는 것·빼는 것·의견별 계획), PDF API의 ?view=와 주린이모드, 두 판의 파일 이름·캐시·예전 판 정리.
실제 Chrome·증권사는 부르지 않는다 (가짜 render·가짜 완성 일봉).
"""
import copy
import html as htmllib
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from accounts.models import InvestorProfile
from paper_engine.wording import forbidden_phrases
from trading import market

from config import engine
from reports.output import easy_text as ez
from reports.output import pdf, text
from reports.models import Report

from ..conftest import make_report
from .test_pdf import RESULTS, candle_rows, event, fake_render, no_live_candles, text_of

KST = ez.KST
NOW = datetime(2026, 10, 4, 9, 30, tzinfo=timezone.utc)   # 만든 날 2026-10-04 18:30 (KST)
FRONT = Path(__file__).resolve().parents[4] / "frontend" / "src"


def plain(markup: str) -> str:
    """사람이 읽는 글자 (태그·스타일을 지우고 &#x27; 같은 문자 참조를 되돌리고 빈칸을 하나로)."""
    return " ".join(htmllib.unescape(text_of(markup)).split())


def section(markup: str, title: str) -> str:
    """제목(h2)이 title인 칸의 글자. 없으면 ""."""
    start = markup.find(f"<h2>{title}</h2>")
    if start < 0:
        return ""
    return plain(markup[start:markup.index("</section>", start)])


# --- 가짜 Trace 사건 (TS 테스트의 TraceEvent와 같은 모양) ---

def ev(step, actor, action, details=None, at=None):
    return SimpleNamespace(step=step, actor=actor, action=action, details=details or {}, model=None,
                           at=at or datetime(2026, 10, 5, 1, 0, step, tzinfo=timezone.utc))


def scenario(rows) -> list:
    """웹 예시 재생(frontend/src/lib/reportExamples.ts SCENARIOS)의 사건 목록. at은 2026-10-02 10:00(KST) + ms."""
    base = datetime(2026, 10, 2, 10, 0, tzinfo=KST)
    return [ev(i, actor, action, details, base + timedelta(milliseconds=ms))
            for i, (actor, action, ms, details) in enumerate(rows, 1)]


# ③ 모델 실패 → 대체 모델로 복구 → 검토 RETRY 1회 → 다시 작성 → 완료
RECOVERY = scenario([
    ("orchestrator", "workflow_started", 0, {"chaos": True, "source": "user"}),
    ("market_agent", "agent_started", 40, {"attempt": 1}),
    ("fundamental_agent", "agent_started", 45, {"attempt": 1}),
    ("news_agent", "agent_started", 50, {"attempt": 1}),
    ("news_agent", "agent_failed", 1250, {"errorType": "timeout", "attempt": 1, "injected": True, "final": False}),
    ("news_agent", "agent_retry", 1260, {"attempt": 2, "reason": "timeout"}),
    ("fundamental_agent", "agent_completed", 2185, {"attempts": 1, "recovered": False}),
    ("news_agent", "agent_failed", 2470, {"errorType": "timeout", "attempt": 2, "injected": True, "final": False}),
    ("news_agent", "agent_failover", 2480, {"from": "llama3.2", "to": "gpt-4.1-mini", "reason": "timeout"}),
    ("market_agent", "agent_completed", 3520, {"attempts": 1, "recovered": False}),
    ("news_agent", "agent_completed", 4390, {"attempts": 3, "recovered": True}),
    ("join_guard", "join_completed", 4400, {"step": "compose"}),
    ("report_agent", "agent_started", 4430, {"attempt": 1}),
    ("report_agent", "agent_completed", 9550, {"attempts": 1}),
    ("review_agent", "agent_started", 9570, {"attempt": 1}),
    ("review_agent", "agent_completed", 11400, {"attempts": 1, "verdict": "RETRY", "score": 62}),
    ("orchestrator", "review_retry", 11410, {"round": 1, "target": "report_agent"}),
    ("report_agent", "agent_started", 11440, {"attempt": 2}),
    ("report_agent", "agent_completed", 15900, {"attempts": 1}),
    ("review_agent", "agent_started", 15920, {"attempt": 2}),
    ("review_agent", "agent_completed", 17600, {"attempts": 1, "verdict": "PASS", "score": 84}),
    ("orchestrator", "workflow_completed", 17610, {"reason": "completed", "costUsd": 0.043}),
])
# ① 정상 흐름: 선택 Worker(뉴스)가 final 표시 없이 실패 → 그 자료 없이 진행
NORMAL = scenario([
    ("orchestrator", "workflow_started", 0, {}),
    ("market_agent", "agent_started", 40, {}),
    ("fundamental_agent", "agent_started", 45, {}),
    ("news_agent", "agent_started", 50, {}),
    ("fundamental_agent", "agent_completed", 2185, {}),
    ("news_agent", "agent_failed", 3060, {"error": "출력 계약 검증 실패: sentiment 필드 없음", "required": False}),
    ("market_agent", "agent_completed", 3520, {}),
    ("join_guard", "join_completed", 3530, {}),
    ("report_agent", "agent_started", 3560, {}),
    ("report_agent", "agent_completed", 8680, {}),
    ("review_agent", "agent_started", 8700, {}),
    ("review_agent", "agent_completed", 10530, {}),
    ("orchestrator", "workflow_completed", 10540, {}),
])


# --- 문장 함수 (frontend/src/test/report-easy.test.tsx "lib/reports 쉬운 보기 함수", lib/format.test.ts와 같은 사례) ---

def test_recovery_sentences():
    """다른 AI로 바꿈 · 같은 AI로 다시 · 끝내 못 함 (final 표시가 없으면 포기)."""
    assert ez.recovery_sentences(RECOVERY) == ["뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요"]
    assert ez.recovery_sentences(NORMAL) == ["뉴스를 읽는 AI가 끝내 답하지 못해 그 자료 없이 진행했어요"]
    retried = [
        ev(1, "market_agent", "agent_started"),
        ev(2, "market_agent", "agent_failed", {"errorType": "timeout", "final": False}),
        ev(3, "market_agent", "agent_retry"),
        ev(4, "market_agent", "agent_completed"),
        ev(5, "join_guard", "join_completed"),
    ]
    assert ez.recovery_sentences(retried) == ["시세를 보는 AI가 늦어 한 번 더 시도해 끝냈어요"]
    assert ez.recovery_sentences([ev(1, "market_agent", "agent_started"), ev(2, "market_agent", "agent_completed")]) == []
    # 늦은 것이 아니면 "제대로 답하지 못해", 모르는 담당자(Guard·Orchestrator)는 빼고, 마지막 실행(마지막 agent_started부터)만 본다
    bad = [ev(1, "review_agent", "agent_started"), ev(2, "review_agent", "agent_failed", {"errorType": "bad_output",
                                                                                         "final": False}),
           ev(3, "review_agent", "agent_completed"), ev(4, "handoff_guard", "agent_failed", {"final": True})]
    assert ez.recovery_sentences(bad) == ["검토 AI가 제대로 답하지 못해 한 번 더 시도해 끝냈어요"]
    rerun = [*bad[:3], ev(4, "review_agent", "agent_started"), ev(5, "review_agent", "agent_completed")]
    assert ez.recovery_sentences(rerun) == []
    gave_up = [ev(1, "news_agent", "agent_started"), ev(2, "news_agent", "agent_failed", {"errorType": "timeout"})]
    assert ez.recovery_sentences(gave_up) == ["뉴스를 읽는 AI가 끝내 답하지 못해 그 자료 없이 진행했어요"]


def test_trust_of_and_lines():
    """검토 통과·고쳐 쓴 횟수·인용 수·자료 시각(시세 AI가 끝낸 시각) — TS trustOf, 그리고 패널의 줄 (TrustPanel)."""
    results = {
        "report_agent": {"verdict": "buy", "citations": ["A", "B"], "plainSummary": ["가"], "reasons": [], "risks": [],
                         "targets": {}},
        "review_agent": {"verdict": "PASS", "score": 84},
    }
    t = ez.trust_of(results, RECOVERY)
    assert {k: t[k] for k in ("reviewed", "rewrites", "citations")} == {"reviewed": True, "rewrites": 1, "citations": 2}
    assert t["dataAt"] == RECOVERY[9].at and t["recovery"] == ["뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요"]
    # 결과에 검토가 없으면 Trace의 마지막 검토 판정
    assert ez.trust_of({}, RECOVERY)["reviewed"] is True
    assert ez.trust_of({"review_agent": {"verdict": "RETRY"}}, [])["reviewed"] is False
    assert ez.data_time_text("2026-10-05T16:30:00Z") == "10월 6일(화) 01:30 자료"  # UTC → 한국 시간
    assert ez.data_time_text(None) == "자료 시각 모름" and ez.data_time_text("어제") == "자료 시각 모름"
    assert ez.trust_lines(results, RECOVERY) == [
        "검토 AI가 근거와 대조해 통과 · 인용 2개 · 10월 2일(금) 10:00 자료",
        "검토 AI가 근거가 약한 부분을 고쳐 쓰게 했고, 다시 검토해 통과했어요",
        "뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요 — 검토는 똑같이 거쳤어요",
    ]
    # 검토 기록이 없으면 고쳐 쓴 줄도 "검토는 똑같이 거쳤어요"도 없다
    assert ez.trust_lines({}, NORMAL) == ["검토 기록이 없어요 · 인용 0개 · 10월 2일(금) 10:00 자료",
                                          "뉴스를 읽는 AI가 끝내 답하지 못해 그 자료 없이 진행했어요"]


def test_draft_of_reads_only_well_formed_values():
    d = ez.draft_of({"report_agent": {"verdict": "sell", "oneLiner": " 한 줄 ", "plainSummary": ["가", 3, "", "나", "다", "라"],
                                      "targets": {"entry": "1", "stop": 9}}})
    assert d["verdict"] is None and d["oneLiner"] == "한 줄" and d["plainSummary"] == ["가", "나", "다"]
    assert d["reasons"] == [] and d["targets"] == {"entry": None, "target": None, "stop": 9.0, "holdingDays": None}
    assert ez.draft_of({}) is None and ez.draft_of({"report_agent": "x"}) is None


def test_split_source_and_when_wrong_of():
    assert ez.split_source("매출이 늘었다 (출처: DART 반기보고서)") == ("매출이 늘었다", "DART 반기보고서")
    assert ez.split_source("거래대금 증가 [근거: KRX 일봉]") == ("거래대금 증가", "KRX 일봉")
    assert ez.split_source("출처 없음") == ("출처 없음", None)
    assert ez.when_wrong_of(["환율", "70,000원 아래로 내려가면 다시 봐야 한다", "업황"]) == (
        "70,000원 아래로 내려가면 다시 봐야 한다", ["환율", "업황"])
    assert ez.when_wrong_of(["환율"]) == (None, ["환율"])
    # 긍정적이 아닌 의견에는 손절 가격이 없어 '손절'이 든 위험은 옮기지 않는다 (다른 조건 문장은 옮긴다)
    risks = ["손절 가격 아래로 내려가면 다시 봐야 한다", "실적이 나빠지면 의견을 다시 봐야 해요"]
    assert ez.when_wrong_of(risks, "hold") == (risks[1], [risks[0]])
    assert ez.when_wrong_of(risks, "buy") == (risks[0], [risks[1]])
    assert ez.when_wrong_of(risks, None) == (risks[1], [risks[0]])   # 의견을 읽지 못함 = 긍정적이 아님


def test_price_only_risk():
    """손절 가격(70,000원)만 말하는 문장(코드의 손절 문장과 같은 뜻)과 다른 조건이 붙은 문장."""
    def only(line, stop=70_000):
        return ez.price_only_risk(line, stop, "KRW")
    assert only("손절 가격 아래로 내려가면 다시 봐야 한다") is True
    assert only("70,000원 아래로 내려가면 다시 봐야 해요") is True
    assert only("주가가 70,100원 아래로 내려가면 다시 봐야 해요") is True   # 호가 한 칸 차이(반올림)는 같은 가격
    assert only("70,000원 아래로 내려가거나 실적 발표가 나쁘면 다시 봐야 해요") is False
    assert only("업황 지표가 나빠지면 다시 봐야 해요") is False
    # 글자 '원'이나 손절 가격과 다른 금액만으로는 '가격만 말하는 문장'이 아니다
    assert only("원/달러 환율이 1,450원을 넘으면 광고 매출 환산이 줄어 의견을 다시 판단해야 해요") is False
    assert only("원자재 가격이 오르면 이 의견을 다시 봐야 해요") is False
    assert only("회원 수가 줄면 다시 봐야 해요") is False
    assert only("연구원 이탈이 이어지면 다시 봐야 해요") is False
    assert only("주가가 75,000원 아래로 내려가면 다시 봐야 해요") is False   # 손절 가격과 다른 가격 = 다른 조건
    assert only("손절 매물이 늘면 다시 봐야 해요") is False
    assert ez.price_only_risk("$110.00 아래로 내려가면 다시 봐야 해요", 110, "USD") is True
    assert only("주가가 ７０,０００원 아래로 내려가면 다시 봐야 해요") is False   # JS \d처럼 ASCII 숫자만 금액으로 읽는다


def test_without_price_clause():
    """앞의 손절 가격 조건 떼기 (손절 문장이 이미 그 가격을 말할 때)."""
    def strip(line, stop=70_000):
        return ez.without_price_clause(line, stop, "KRW")
    assert strip("70,000원 아래로 내려가거나 실적 발표가 나쁘면 다시 봐야 해요") == "실적 발표가 나쁘면 다시 봐야 해요"
    assert strip("주가가 70,000원 밑으로 떨어지거나, 업황이 바뀌면 다시 봐야 해요") == "업황이 바뀌면 다시 봐야 해요"
    assert strip("주가가 손절가(70,000원) 아래로 내려가거나 업황이 바뀌면 다시 봐야 해요") == "업황이 바뀌면 다시 봐야 해요"
    assert ez.without_price_clause("$110.00 아래로 내려가거나 가이던스가 낮아지면 다시 봐야 해요", 110, "USD") == \
        "가이던스가 낮아지면 다시 봐야 해요"
    assert strip("업황 지표가 나빠지면 다시 봐야 해요") == "업황 지표가 나빠지면 다시 봐야 해요"
    # 손절 가격이 아닌 금액 조건(매출·다른 가격)이나 앞에 붙은 다른 조건은 떼지 않는다
    for line in (
        "광고 매출이 분기 1조원 아래로 떨어지거나 금리가 오르면 의견을 다시 봐야 해요",
        "영업이익이 1,000억원 아래로 내려가거나 수주가 줄면 의견을 다시 봐야 해요",
        "75,000원 아래로 내려가거나 실적 발표가 나쁘면 다시 봐야 해요",
        "실적이 나쁘면 70,000원 아래로 내려가거나 금리가 오르면 다시 봐야 해요",
        "70,000원 아래로 내려가거나 x",   # 남는 말이 4자 미만
    ):
        assert strip(line) == line


def test_when_wrong_box():
    """ReasonsRisks: 손절 문장(코드) + AI 문장(가격 조건을 뗀 것, 가격만 말하면 숨김). 둘 다 없으면 기본 문장."""
    draft = {"risks": ["환율", "70,000원 아래로 내려가거나 실적 발표가 나쁘면 다시 봐야 해요 (출처: 리포트)"],
             "targets": {"entry": 75_000.0, "target": 80_000.0, "stop": 70_000.0, "holdingDays": 5.0}}
    assert ez.when_wrong(draft, "buy", "KRW") == (
        ["가격이 손절 가격(70,000원) 아래로 내려가면 이 의견을 다시 봐야 해요", "실적 발표가 나쁘면 다시 봐야 해요"], ["환율"])
    only_price = {**draft, "risks": ["70,000원 아래로 내려가면 다시 봐야 해요"]}
    assert ez.when_wrong(only_price, "buy", "KRW") == (["가격이 손절 가격(70,000원) 아래로 내려가면 이 의견을 다시 봐야 해요"], [])
    assert ez.when_wrong(only_price, "hold", "KRW") == (["70,000원 아래로 내려가면 다시 봐야 해요"], [])
    assert ez.when_wrong({**draft, "risks": ["환율"]}, "avoid", "KRW") == ([ez.WHEN_WRONG_FALLBACK], ["환율"])


def test_formats():
    """lib/format.ts와 같은 모양, 0%는 부호 없이, 빈 값은 "-". 반올림은 화면 함수마다 다르다 (절반은 모두 0에서 먼 쪽):
    formatRate는 toFixed(2진수 값 그대로 — 1.005는 실제로 1.00499…라 "1.00"), formatNumber·달러 formatPrice는 Intl.NumberFormat
    (가장 짧은 10진 표기 — 12.35 → "12.4"), 원화 formatPrice는 Math.round. 기대값은 node(Intl·toFixed)로 확인한 값이다."""
    assert ez.format_rate(0.0123) == "+1.23%" and ez.format_rate(-0.005) == "-0.50%"
    assert ez.format_rate(0) == "0.00%" and ez.format_rate(-0.00001) == "0.00%" and ez.format_rate(None) == "-"
    assert ez.format_rate(0.01005) == "+1.00%"   # toFixed (Intl이면 "1.01")
    assert ez.format_price(123.45, "USD") == "$123.45" and ez.format_price(1234.5, "USD") == "$1,234.50"
    assert ez.format_price(162.005, "USD") == "$162.01" and ez.format_price(0.145, "USD") == "$0.15"   # Intl
    assert ez.format_price(-162.005, "USD") == "-$162.01"
    assert ez.format_price(71000, "KRW") == "71,000원" and ez.format_price(1234567.6) == "1,234,568원"
    assert ez.format_price(0.5) == "1원" and ez.format_price(None) == "-" and ez.format_price(float("nan")) == "-"
    assert ez.format_number(12.0, 1) == "12" and ez.format_number(61.25, 1) == "61.3" and ez.format_number(2.45, 1) == "2.5"
    assert ez.format_number(1234.56, 1) == "1,234.6" and ez.format_number(-3.04, 1) == "-3" and ez.format_number(True) == "-"
    # 지표(RSI·변동성·PER·PBR·ROE)는 코드가 소수 2자리로 내고 화면은 1자리로 보인다 — 둘째 자리 5가 흔하다 (Intl: 짧은 표기를 반올림)
    assert [ez.format_number(v, 1) for v in (55.15, 2.05, 12.35, 1.15, 8.45)] == ["55.2", "2.1", "12.4", "1.2", "8.5"]
    assert ez.format_number(-12.35, 1) == "-12.4" and ez.format_number(2.5) == "3" and ez.format_number(1.005, 2) == "1.01"
    assert ez.metric(9.0, "%") == "9%" and ez.metric(None, "배") == "-"
    assert ez.day_label("2026-09-18") == "9월 18일(금)" and ez.day_label("어제") == "어제"


def test_prices_plan_and_scenario():
    """호가 단위 내림·보유 기간(추천과 같은 값) → 순서 검사 → 계획 문장·세 가지 경우 (1주 기준 비율)."""
    rounded = ez.tick_prices({"entry": 72_345.0, "target": 77_777.0, "stop": 69_123.0, "holdingDays": 10.0}, "KRW")
    assert rounded == {"entry": 72_300.0, "target": 77_700.0, "stop": 69_100.0, "holdingDays": 10}
    assert ez.tick_prices({"entry": 180.129, "target": 0.0, "stop": None}, "USD") == {"entry": 180.12, "target": 0.0,
                                                                                     "stop": None, "holdingDays": 10}
    assert ez.tick_prices({"entry": 0.12345}, "USD")["entry"] == 0.1234   # 1달러 미만은 0.0001 단위 (엔진 round_price)
    # 보유 기간: 추천(autotrade.recommend.sources._holding_days)과 같은 규칙 — 없으면 10거래일, 정수로 내리고 1~20으로 자른다
    from autotrade.recommend.sources import DEFAULT_HOLDING_DAYS
    from reports.guardrails.contracts import MAX_HOLDING_DAYS, MIN_HOLDING_DAYS
    days = {v: ez.tick_prices({"holdingDays": v}, "KRW")["holdingDays"] for v in (None, 7.5, 0.0, 25.0, 3.0)}
    assert days == {None: DEFAULT_HOLDING_DAYS, 7.5: 7, 0.0: MIN_HOLDING_DAYS, 25.0: MAX_HOLDING_DAYS, 3.0: 3}
    assert DEFAULT_HOLDING_DAYS == 10
    assert ez.plan_lines("buy", rounded, "KRW") == [
        "사는 가격 72,300원 · 목표 가격 77,700원 · 손절 가격 69,100원. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요.",
        ez.PLAN_ACTIVATE]
    assert ez.plan_lines("hold", rounded, "KRW") == [ez.PLAN_TEXT["watch"]]
    assert ez.plan_lines("avoid", rounded, "KRW") == [ez.PLAN_TEXT["negative"]]
    assert ez.plan_lines("buy", {**rounded, "stop": 80_000.0}, "KRW") == [ez.PLAN_TEXT["no_plan"]]
    assert ez.plan_lines(None, rounded, "KRW") == [ez.PLAN_TEXT["no_plan"]]   # 화면 planCardState와 같다
    t = {"entry": 10_000.0, "target": 11_000.0, "stop": 9_600.0, "holdingDays": 7.0}
    assert ez.scenario_of(t) == {"gain": "+10.00%", "loss": "-4.00%", "time": "7거래일 뒤"}
    assert ez.scenario_of({**t, "holdingDays": None})["time"] == "기간 끝"
    assert ez.scenario_of({**t, "holdingDays": 0.0})["time"] == "기간 끝"
    # PDF는 추천과 같은 값(tick_prices)으로 그린다 — 리포트에 보유 기간이 없으면 추천처럼 10거래일 (화면은 추천의 holdingDays)
    assert ez.scenario_of(ez.tick_prices({**t, "holdingDays": None}, "KRW"))["time"] == "10거래일 뒤"
    assert ez.scenario_of({**t, "stop": 10_500.0}) is None and ez.scenario_of({**t, "target": None}) is None


# --- 짝 TS 파일과 같은 문장 (파일이 없으면 건너뛰지 않고 실패한다) ---

def ts(path: str) -> str:
    file = FRONT / path
    assert file.is_file(), f"짝 TS 파일이 없습니다: {file}"
    return file.read_text(encoding="utf-8")


def jsx(src: str) -> str:
    """JSX를 화면에 보이는 글자 모양으로: 줄바꿈 들여쓰기를 지우고 {" "}는 빈칸, <Term k="X" />는 X, <Term k="X">Y</Term>는 Y."""
    src = re.sub(r"\s*\n\s*", "", src).replace('{" "}', " ")
    src = re.sub(r'<Term k="([^"]+)"\s*/>', r"\1", src)
    return re.sub(r'<Term k="[^"]+">([^<]*)</Term>', r"\1", src)


def pattern(template: str) -> str:
    """Python 문장 틀("{n}개")을 TS 글자("${x}개"·JSX "{x}개")에 맞출 정규식으로. 문장 전체가 맞아야 한다 —
    앞뒤가 따옴표·백틱·태그·중괄호여서 TS 문장이 더 길거나 짧아져도 찾아낸다."""
    body = r"\$?\{[^{}]+\}".join(re.escape(part) for part in re.split(r"\{[a-z_]+\}", template))
    return rf"(?<=[\"'`>{{}}]){body}(?=[\"'`<{{}}])"


def assert_in(templates, src: str, where: str) -> None:
    missing = [t for t in templates if not re.search(pattern(t), src)]
    assert missing == [], f"{where}에 없는 문장: {missing}"


def visible(src: str) -> set[str]:
    """JSX에서 화면에 보이는 글자 덩어리 (jsx()로 편 뒤 태그 사이 '>…<'의 글자). aria-label·label 같은 속성 값은 들지 않는다."""
    return {part.strip() for part in re.findall(r">([^<>]*)<", jsx(src)) if part.strip()}


def assert_visible(headings, src: str, where: str) -> None:
    """제목은 화면에 보이는 글자로 있어야 한다 — 같은 글자의 aria-label이 남아 있어도 보이는 제목을 바꾸면 실패한다."""
    shown = visible(src)
    missing = [h for h in headings if h not in shown]
    assert missing == [], f"{where}에 보이는 글자로 없는 제목: {missing}"


def block(src: str, start: str) -> str:
    """src에서 start부터 처음 나오는 '};'까지 (TS 객체 하나)."""
    i = src.index(start)
    return src[i:src.index("};", i)]


def test_tables_match_plain_text_ts():
    src = ts("lib/plainText.ts")
    lines = dict(re.findall(r'(buy|hold|avoid): \{[^}]*?line: "([^"]+)"', src))
    labels = dict(re.findall(r'(buy|hold|avoid): \{[^}]*?label: "([^"]+)"', src))
    assert lines == ez.OPINION_LINE and labels == text.OPINION_LABEL
    assert re.search(r'export const AI_REVIEW_NOTE = "([^"]+)"', src)[1] == ez.AI_REVIEW_NOTE
    assert re.search(r'export const DISCLAIMER = "([^"]+)"', src)[1] == pdf.DISCLAIMER


def test_tables_match_reports_ts():
    src = ts("lib/reports.ts")
    names = dict(re.findall(r'(\w+): "([^"]+)"', block(src, "export const WORKER_EASY_NAME")))
    assert names == ez.WORKER_EASY_NAME and '?? "AI 담당자"' in src and ez.WORKER_FALLBACK == "AI 담당자"
    assert_in(ez.RECOVERY_TEXT.values(), src, "reports.ts recoverySentences")
    assert_in([ez.DATA_TIME, ez.DATA_TIME_UNKNOWN], src, "reports.ts dataTimeText")


def test_tables_match_glossary_ts():
    found = dict(re.findall(r'entry\(\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"', ts("lib/glossary.ts")))
    assert {k: found.get(k) for k in ez.GLOSSARY} == ez.GLOSSARY


def test_tables_match_components():
    plan_src = ts("components/plan/PlanCard.tsx")
    plan = jsx(plan_src)
    states = dict(re.findall(r'(\w+): "([^"]+)"', block(plan, "const STATE_TEXT")))
    assert {k: states.get(k) for k in ez.PLAN_TEXT} == ez.PLAN_TEXT
    assert_in([ez.PLAN_READY, ez.PLAN_TITLE], plan, "PlanCard.tsx")
    scenario_src = ts("components/reports/easy/ScenarioBoxes.tsx")
    assert_in(ez.SCENARIO_TEXT.values(), jsx(scenario_src), "ScenarioBoxes.tsx")
    reasons_src = ts("components/reports/easy/ReasonsRisks.tsx")
    assert_in([*ez.REASONS_TEXT.values(), ez.WHEN_WRONG_STOP, ez.WHEN_WRONG_FALLBACK], jsx(reasons_src), "ReasonsRisks.tsx")
    research_src = ts("components/reports/easy/ResearchCards.tsx")
    assert_in(ez.RESEARCH_TEXT.values(), jsx(research_src), "ResearchCards.tsx")
    assert_in(ez.TRUST_TEXT.values(), jsx(ts("components/reports/easy/TrustPanel.tsx")), "TrustPanel.tsx")
    easy_src = ts("components/reports/easy/EasyReport.tsx")
    assert_in([*ez.CHART_TEXT.values(), ez.NO_OPINION, ez.NO_SUMMARY, *ez.MARKET_NAME.values()], jsx(easy_src),
              "EasyReport.tsx")
    # 쪽의 칸 제목은 화면에 보이는 글자와 같아야 한다 (aria-label에 같은 글자가 있어 위 검사만으로는 바뀐 제목을 놓친다)
    assert_visible([ez.PLAN_TITLE], plan_src, "PlanCard.tsx")
    sc = ez.SCENARIO_TEXT
    assert_visible([sc["title"], sc["gain_title"], sc["loss_title"], sc["time_title"]], scenario_src, "ScenarioBoxes.tsx")
    rr = ez.REASONS_TEXT
    assert_visible([rr["title"], rr["reasons"], rr["risks"], rr["wrong"]], reasons_src, "ReasonsRisks.tsx")
    rs = ez.RESEARCH_TEXT
    assert_visible([rs["title"], rs["market"], rs["fundamental"], rs["news"], rs["filings"]], research_src,
                   "ResearchCards.tsx")
    assert_visible([ez.CHART_TEXT["title"]], easy_src, "EasyReport.tsx")


def test_plan_activate_names_the_easy_buttons():
    """PDF의 실행 안내는 쉬운 보기에 실제로 있는 버튼 이름을 쓴다: 매매 계획 카드 "실행 준비" → 실행 확인 "모의 자동매매 시작"."""
    prepare, start = ez.PLAN_BUTTONS["prepare"], ez.PLAN_BUTTONS["start"]
    assert f"'{prepare}'" in ez.PLAN_ACTIVATE and f"'{start}'" in ez.PLAN_ACTIVATE and ez.PLAN_TITLE in ez.PLAN_ACTIVATE
    card = ts("components/plan/PlanCard.tsx")
    ready = card[card.index("function Ready("):card.index("function Blocked(")]   # 매매 계획 카드의 실행 가능 칸 (미니 줄 말고)
    assert_visible([prepare], ready, "PlanCard.tsx Ready")
    page = ts("pages/RecommendationPage.tsx")
    assert re.search(r'easy \? "' + re.escape(start) + '"', page), "RecommendationPage.tsx 쉬운 보기 버튼 이름"
    assert "계획 활성화" not in ez.PLAN_ACTIVATE   # 전문가 보기의 이름 (쉬운 보기에는 없다)


def fixed_sentences() -> list[str]:
    """easy_text.py의 고정 문장 전부 (표의 값 포함, 정규식·빈 값 기호 제외)."""
    out = []
    for name, value in vars(ez).items():
        if not name.isupper() or name in ("STOP_WORD", "NO_VALUE", "WEEKDAYS"):
            continue
        if isinstance(value, str):
            out.append(value)
        elif isinstance(value, dict):
            out += [v for v in value.values() if isinstance(v, str)]
    return out


def test_fixed_sentences_have_no_forbidden_phrases():
    sentences = fixed_sentences()
    assert len(sentences) > 80 and ez.PLAN_ACTIVATE in sentences and ez.GLOSSARY["RSI"] in sentences
    for line in sentences:
        assert forbidden_phrases(line, causal=True) == [], line
    assert "모의" in ez.PLAN_ACTIVATE and "모의" in ez.SCENARIO_TEXT["gain_note"]   # 매매를 말하는 쉬운 문장 (14-7 B6)


# --- 쉬운 판 HTML ---

@pytest.fixture
def candles(monkeypatch):
    """완성 일봉 80개 (2026-07-01 ~ 2026-09-18)."""
    monkeypatch.setattr(market, "completed_candles", lambda symbol: candle_rows())
    monkeypatch.setattr(market, "candles", no_live_candles)


EASY_RESULTS = copy.deepcopy(RESULTS)
EASY_RESULTS["report_agent"].update({
    "reasons": ["수급 개선 (출처: KRX 일봉)", "실적 바닥 통과 [근거: DART 분기보고서]", "거래대금 증가"],
    "risks": ["환율 변동", "69,000원 아래로 내려가거나 실적 발표가 나쁘면 다시 봐야 해요", "외국인 매도"],
    "citations": ["DART 분기보고서", "KRX 일봉", "연합뉴스"],
})
EASY_RESULTS["fundamental_agent"]["recentFilings"] = [{"date": "2026-09-30", "title": "분기보고서", "impact": "neutral"},
                                                      {"title": "주요사항보고서"}, {"date": "2026-09-01"}]
EASY_RESULTS["news_agent"] = {"sentiment": "positive", "summary": "신제품 기사가 많아요",
                              "headlines": [{"date": "2026-10-01", "title": "신제품 발표", "source": "연합뉴스"},
                                            {"title": "공장 증설", "source": None}], "evidence": []}


def easy_report(user, results=None, symbol="005930"):
    """쉬운 판 예시: 시세 AI가 18:00(KST)에 끝냄, 뉴스 AI가 늦어 다른 모델로 복구, 검토 RETRY 한 번 뒤 통과."""
    report = make_report(user, symbol, status=Report.COMPLETED, results=EASY_RESULTS if results is None else results,
                         finished_at=datetime(2026, 10, 4, 9, 5, tzinfo=timezone.utc))
    rows = [
        ("orchestrator", "workflow_started", "started", 0, {}),
        ("market_agent", "agent_started", "started", 0, {"attempt": 1}),
        ("market_agent", "agent_completed", "completed", 0, {"model": "model-m", "provider": "demo"}),
        ("news_agent", "agent_started", "started", 1, {"attempt": 1}),
        ("news_agent", "agent_failed", "failed", 2, {"model": "model-a", "errorType": "timeout", "attempt": 1,
                                                     "injected": True, "final": False}),
        ("news_agent", "agent_failover", "started", 3, {"from": "model-a", "to": "model-b"}),
        ("news_agent", "agent_completed", "completed", 4, {"model": "model-b", "provider": "demo", "recovered": True,
                                                           "costUsd": 0.01}),
        ("report_agent", "agent_started", "started", 5, {"attempt": 1}),
        ("report_agent", "agent_completed", "completed", 6, {"model": "model-c", "provider": "demo"}),
        ("review_agent", "agent_started", "started", 6, {"attempt": 1}),
        ("review_agent", "agent_completed", "completed", 7, {"model": "model-r", "verdict": "RETRY", "score": 60}),
        ("orchestrator", "review_retry", "started", 8, {"round": 1, "target": "report_agent"}),
        ("report_agent", "agent_started", "started", 9, {"attempt": 2}),
        ("report_agent", "agent_completed", "completed", 10, {"model": "model-c", "provider": "demo"}),
        ("review_agent", "agent_started", "started", 10, {"attempt": 2}),
        ("review_agent", "agent_completed", "completed", 11, {"model": "model-r", "verdict": "PASS", "score": 88}),
        ("orchestrator", "workflow_completed", "completed", 12, {"costUsd": 0.0345}),
    ]
    trace = [event(report, step, actor, action, status, sec, **details)
             for step, (actor, action, status, sec, details) in enumerate(rows, 1)]
    return report, trace


def build(user, results=None, symbol="005930") -> str:
    report, trace = easy_report(user, results, symbol)
    return pdf.build_report_html(report, list(reversed(trace)), NOW, easy=True)   # 순서가 섞여 와도 step 순서로 읽는다


def test_easy_html_has_every_section_in_order(user, candles):
    markup = build(user)
    words = plain(markup)
    assert "@page { size: A4; margin: 12mm }" in markup and '"Noto Sans CJK KR", "Apple SD Gothic Neo"' in markup
    assert "<title>삼성전자 AI 리포트 · 모매매</title>" in markup and '<header class="brand">' in markup
    assert "삼성전자 005930 · 국내 · 2026년 10월 4일 리포트" in words
    titles = ["위험을 점검한 AI의 메모", "AI 의견: 긍정적", "쉬운 요약", "매매 계획", "근거와 위험", "세 가지 경우", "가격 흐름",
              "조사 자료 요약", "용어 풀이", "어떻게 만들었나요"]
    at = [words.index(t) for t in titles]
    assert at == sorted(at), titles
    # 위험 점검 메모 (결론 위 노란 상자)
    assert "위험을 점검한 AI의 메모 위험 정도: 보통 변동성 확대 구간 단기 과열 주의" in words
    # 결론 + 신뢰 패널
    assert '<span class="op buy">AI 의견: 긍정적</span>' in markup
    assert "오를 근거가 더 많다고 봤어요 단기 반등 구간, 분할 접근" in words
    assert ("검토 AI가 근거와 대조해 통과 · 인용 3개 · 10월 4일(일) 18:00 자료 "
            "검토 AI가 근거가 약한 부분을 고쳐 쓰게 했고, 다시 검토해 통과했어요 "
            "뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요 — 검토는 똑같이 거쳤어요 AI 검토는 사실을 보증하지 않아요") in words
    # 쉬운 요약 1~3 + 면책
    assert ("쉬운 요약 1 거래가 늘며 값이 오르는 흐름이에요 2 실적이 나아지고 있다는 공시가 있었어요 "
            f"3 환율이 바뀌면 손실이 더 클 수도 있어요 {pdf.DISCLAIMER}") in words
    # 매매 계획 (계좌 값 없이)
    assert section(markup, "매매 계획") == (
        "매매 계획 사는 가격 72,000원 · 목표 가격 77,000원 · 손절 가격 69,000원. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요. "
        f"{ez.PLAN_ACTIVATE}")
    # 근거와 위험 · 이 의견이 틀리는 경우 · 인용
    assert section(markup, "근거와 위험") == (
        "근거와 위험 AI가 든 근거 수급 개선 출처: KRX 일봉 실적 바닥 통과 출처: DART 분기보고서 거래대금 증가 "
        "위험 환율 변동 외국인 매도 이 의견이 틀리는 경우 가격이 손절 가격(69,000원) 아래로 내려가면 이 의견을 다시 봐야 해요 "
        "실적 발표가 나쁘면 다시 봐야 해요 이 리포트가 인용한 자료 3개: DART 분기보고서 · KRX 일봉 · 연합뉴스")
    # 세 가지 경우 (1주 기준 비율)
    assert section(markup, "세 가지 경우") == (
        "세 가지 경우 1주 기준 비율 · 수수료·세금 빼기 전 목표 가격에 닿으면 +6.94% 모의 계좌에서 팔아요 "
        "손절 가격에 닿으면 -4.17% 손실이 더 커지지 않게 팔아요. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요 "
        "기간 안에 둘 다 안 닿으면 10거래일 뒤 보유 기간이 끝나는 날 가격에 팔아요. 이익일 수도, 손실일 수도 있어요 "
        f"{ez.SCENARIO_ACCOUNT_NOTE}")
    # 가격 흐름: 완성 일봉, 이동평균 없음, 쉬운 이름의 가로선 셋, 범례·기준 줄
    chart = markup.split('<svg class="chart"')[1].split("</svg>")[0]
    assert "<polyline" not in chart and chart.count('stroke-dasharray="5 3"') == 3 and chart.count("<rect") > 60
    assert "목표 가격 77,000" in chart and "사는 가격 72,000" in chart and "손절 가격 69,000" in chart and "진입" not in chart
    assert section(markup, "가격 흐름").endswith(
        "목표 가격 77,000원 사는 가격 72,000원 손절 가격 69,000원 일봉 · 최근 60일 · 9월 18일(금) 종가 기준 "
        "가로선은 AI가 제안한 사는 가격·목표 가격·손절 가격이에요.")
    # 조사 자료 요약
    assert section(markup, "조사 자료 요약") == (
        "조사 자료 요약 시세 종가 72,000원 10월 2일(금) 15:30 장마감 기준 상승 추세 RSI 61.3 하루 변동성 2.4% "
        "재무·공시 양호 PER 12.5배 PBR 1.1배 ROE 9% 최근 공시 분기보고서 · 2026-09-30 주요사항보고서 "
        "뉴스 신제품 기사가 많아요 신제품 발표 — 연합뉴스 · 2026-10-01 공장 증설 뉴스 제목: Google 뉴스 검색 결과(각 언론사)")
    # 용어 풀이: 이 쪽에 나온 용어, 화면 사전 문장 그대로
    assert re.findall(r"<dt>([^<]+)</dt>", markup.split("<h2>용어 풀이</h2>")[1]) == [
        "손절", "목표 가격", "보유 기간", "장마감 기준", "종가", "RSI", "변동성", "PER", "PBR", "ROE", "공시"]
    assert ez.GLOSSARY["손절"] in words and ez.GLOSSARY["공시"] in words
    # 쉬운 꼬리말
    assert '<div class="foot">' in markup and words.endswith(
        f"어떻게 만들었나요 {ez.FOOTER_TEXT['how']} 뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요 "
        f"만든 날 2026-10-04 18:30 · 모매매 {pdf.DISCLAIMER}")
    assert markup.count(pdf.DISCLAIMER) == 2 and markup.count("투자 권유가 아닙니다") == 2


def test_easy_html_leaves_out_expert_and_personal_values(user, candles):
    """검토 점수·신뢰도·확률·모델 이름·제공자·비용·오류 코드·"Agent"·신청자(아이디·닉네임)·비밀 값은 싣지 않는다."""
    markup = build(user)
    words = plain(markup)
    for word in ("검토 점수", "88점", "60점", "신뢰도", "74%", "확률", "55%", "비용", "장애", "KST"):
        assert word not in words, word
    for raw in ("Agent", "model-", "demo", "timeout", "errorType", "injected", "$", "alice", "앨리스"):
        assert raw not in markup, raw
    assert not re.search(r"(?i)secret|token|password|api[_-]?key|authorization|bearer|sk-[a-z0-9]{8}", markup)
    assert forbidden_phrases(words) == []


@pytest.mark.parametrize("verdict, plan_text", [("hold", ez.PLAN_TEXT["watch"]), ("avoid", ez.PLAN_TEXT["negative"])])
def test_easy_hold_and_avoid_have_no_plan_or_price_lines(user, candles, verdict, plan_text):
    results = copy.deepcopy(EASY_RESULTS)
    results["report_agent"].update({"verdict": verdict, "risks": ["손절 가격 아래로 내려가면 다시 봐야 한다",
                                                                  "실적이 나빠지면 의견을 다시 봐야 해요"]})
    markup = build(user, results)
    words = plain(markup)
    assert f"{text.OPINION_LABEL[verdict]} {ez.OPINION_LINE[verdict]}" in words
    assert section(markup, "매매 계획") == f"매매 계획 {plan_text}" and ez.PLAN_ACTIVATE not in words
    assert "세 가지 경우" not in words and "+6.94%" not in words
    chart = markup.split('<svg class="chart"')[1].split("</svg>")[0]
    assert "stroke-dasharray" not in chart and "가로선은" not in words and '<ul class="lines">' not in markup
    # 손절 가격이 없는 의견: '손절'이 든 위험은 위험 목록에 남고, 틀리는 경우는 다른 조건 문장
    assert ("위험 손절 가격 아래로 내려가면 다시 봐야 한다 이 의견이 틀리는 경우 실적이 나빠지면 의견을 다시 봐야 해요 "
            "이 리포트가") in words
    terms = re.findall(r"<dt>([^<]+)</dt>", markup.split("<h2>용어 풀이</h2>")[1])
    assert terms[:2] == ["장마감 기준", "종가"] and "손절" not in terms and "보유 기간" not in terms


def test_easy_buy_with_wrong_prices_has_no_plan(user, candles):
    """가격 순서가 틀리면(손절 > 사는 가격) 계획·세 가지 경우·가로선 없이 '가격 계획이 맞지 않아' 문장. 호가로 내린 뒤에 본다."""
    results = copy.deepcopy(EASY_RESULTS)
    results["report_agent"]["targets"] = {"entry": 72000, "target": 77000, "stop": 73000, "holdingDays": 10}
    results["report_agent"]["risks"] = ["70,000원 아래로 내려가면 다시 봐야 해요"]
    markup = build(user, results)
    words = plain(markup)
    assert section(markup, "매매 계획") == f"매매 계획 {ez.PLAN_TEXT['no_plan']}"
    assert "세 가지 경우" not in words and "stroke-dasharray" not in markup and "손절 가격(" not in words
    assert "이 의견이 틀리는 경우 70,000원 아래로 내려가면 다시 봐야 해요" in words   # 손절 문장이 없으면 AI 문장 그대로
    # 호가 단위로 내리면 같은 가격이 되는 계획 (69,080 → 69,000 · 69,020 → 69,000)도 맞지 않는다
    results["report_agent"]["targets"] = {"entry": 69080, "target": 77000, "stop": 69020, "holdingDays": 10}
    assert section(build(user, results), "매매 계획") == f"매매 계획 {ez.PLAN_TEXT['no_plan']}"


def test_easy_prices_are_rounded_to_tick_like_the_recommendation(user, candles):
    results = copy.deepcopy(EASY_RESULTS)
    results["report_agent"]["targets"] = {"entry": 72345, "target": 77777, "stop": 69123, "holdingDays": 7.5}
    markup = build(user, results)
    words = plain(markup)
    assert "사는 가격 72,300원 · 목표 가격 77,700원 · 손절 가격 69,100원." in words
    assert "+7.47% " in words and "-4.43% " in words and "7거래일 뒤" in words   # 보유 기간도 추천처럼 정수로 내린다
    assert "가격이 손절 가격(69,100원) 아래로" in words and "목표 가격 77,700원 사는 가격 72,300원 손절 가격 69,100원" in words


def test_easy_risk_box_only_with_risk_result(user, candles):
    results = copy.deepcopy(EASY_RESULTS)
    del results["risk_agent"]
    assert "위험을 점검한 AI의 메모" not in build(user, results)
    results["risk_agent"] = {"level": "모름", "warnings": [], "summary": " "}   # 보일 것이 없으면 상자도 없다
    assert "riskbox" not in build(user, results).split("</style>")[1]
    results["risk_agent"] = {"level": "high", "warnings": ["투자경고 종목입니다"], "summary": None}
    assert "위험을 점검한 AI의 메모 위험 정도: 높음 투자경고 종목입니다 AI 의견" in plain(build(user, results))


def test_easy_empty_report_still_renders(user, monkeypatch):
    def down(symbol):
        raise RuntimeError("시세 조회 불가")
    monkeypatch.setattr(market, "completed_candles", down)
    monkeypatch.setattr(market, "candles", no_live_candles)
    markup = pdf.build_report_html(make_report(user, status=Report.COMPLETED), [], NOW, easy=True)
    words = plain(markup)
    assert '<svg class="logo"' in markup and '<svg class="chart"' not in markup
    assert (f"{ez.NO_OPINION} 검토 기록이 없어요 · 인용 0개 · 자료 시각 모름 {ez.AI_REVIEW_NOTE} "
            f"쉬운 요약 {ez.NO_SUMMARY} {pdf.DISCLAIMER} 매매 계획 {ez.PLAN_TEXT['no_plan']} "
            f"가격 흐름 {ez.CHART_TEXT['empty']} 어떻게 만들었나요") in words
    for missing in ("근거와 위험", "세 가지 경우", "조사 자료 요약", "용어 풀이", "위험을 점검한"):
        assert missing not in words, missing
    assert markup.count(pdf.DISCLAIMER) == 2 and forbidden_phrases(words) == []


def glossary_terms(markup: str) -> list[str]:
    return re.findall(r"<dt>([^<]+)</dt>", markup.split("<h2>용어 풀이</h2>")[1])


def test_easy_research_without_close_basis_hides_price(user, candles):
    """시세 기준 시각(asOf)을 읽지 못하면 가격 없이 '자료 없음' (자세한 판 _market_basis·화면과 같다). 빈 지표는 "-".
    용어 풀이는 쪽에 나온 글자만: 시세 칸에 '장마감 기준'이 없고, 차트 범례의 "… 종가 기준"이 있어 '종가'만."""
    results = {"market_agent": {"price": 72000, "asOf": "어제", "rsi": None},
               "fundamental_agent": {"metrics": {"per": 12.5}}}
    markup = build(user, results)
    assert section(markup, "조사 자료 요약") == ("조사 자료 요약 시세 시세 기준 시각: 자료 없음 RSI - 하루 변동성 - "
                                            "재무·공시 PER 12.5배 PBR - ROE -")
    assert "장마감 기준" not in plain(markup.split("<h2>용어 풀이</h2>")[0])
    assert glossary_terms(markup) == ["종가", "PER", "공시"]   # 값이 있는 지표만


@pytest.mark.parametrize("as_of, shown", [
    ("2026-10-02T15:30:00", "10월 2일(금) 15:30 장마감 기준"),   # 시간대 없음 = 한국 시간 (화면 new Date()·한국 브라우저)
    ("2026-10-02", "10월 2일(금) 09:00 장마감 기준"),            # 날짜만 = UTC 자정 (JS Date와 같다)
    ("2026-10-02T06:30:00Z", "10월 2일(금) 15:30 장마감 기준"),
])
def test_easy_research_reads_as_of_like_the_web(user, candles, as_of, shown):
    """시세 칸의 asOf는 화면(ResearchCards)처럼 읽는다 — 자세한 판은 그대로(시간대가 없으면 '자료 없음')."""
    results = {"market_agent": {"price": 72000, "asOf": as_of, "rsi": 55.15, "volatilityPct": 2.05},
               "fundamental_agent": {"metrics": {"per": 12.35, "pbr": 1.15, "roe": 8.45}}}
    assert section(build(user, results), "조사 자료 요약") == (
        f"조사 자료 요약 시세 종가 72,000원 {shown} RSI 55.2 하루 변동성 2.1% "
        "재무·공시 PER 12.4배 PBR 1.2배 ROE 8.5%")   # 지표 반올림은 화면 Intl과 같다
    report, trace = easy_report(user, results)
    expert = text_of(pdf.build_report_html(report, trace, NOW))
    assert ("시세 지표 기준 시각: 자료 없음" in expert) is (as_of != "2026-10-02T06:30:00Z")


def test_easy_chart_basis_and_glossary_follow_the_page(user, candles):
    """차트 범례: 시세 AI asOf가 마지막 봉과 같은 날이면 그 '장마감 기준' 시각, 아니면 마지막 봉의 '종가 기준'.
    용어 풀이의 '장마감 기준'·'종가'는 그 글자가 쪽에 있을 때만."""
    same_day = {"market_agent": {"price": None, "asOf": "2026-09-18T15:30:00+09:00"}}
    markup = build(user, same_day)
    assert section(markup, "가격 흐름").endswith("일봉 · 최근 60일 · 9월 18일(금) 15:30 장마감 기준")
    assert glossary_terms(markup) == ["장마감 기준"]   # 시세 칸에 가격(종가)이 없고 범례도 장마감 기준
    # asOf가 없으면(예전 결과) 범례는 마지막 봉의 종가 — 쪽에 '장마감 기준'이 없으니 풀이도 없다
    markup = build(user, {"market_agent": {"summary": "상승 추세"}})
    assert section(markup, "가격 흐름").endswith("일봉 · 최근 60일 · 9월 18일(금) 종가 기준")
    assert "장마감 기준" not in plain(markup.split("<h2>용어 풀이</h2>")[0]) and glossary_terms(markup) == ["종가"]
    # 리포트 뒤에 만든 PDF라 봉이 asOf보다 뒤까지 있으면 범례는 마지막 봉 (시세 칸은 asOf 그대로)
    markup = build(user, {"market_agent": {"price": 72000, "asOf": "2026-09-17T15:30:00+09:00"}})
    assert section(markup, "가격 흐름").endswith("9월 18일(금) 종가 기준")
    assert "종가 72,000원 9월 17일(목) 15:30 장마감 기준" in section(markup, "조사 자료 요약")
    assert glossary_terms(markup) == ["장마감 기준", "종가"]


def test_easy_live_price_card_and_chart(user, candles):
    """장 중에 만든 리포트(priceBasis live): 시세 칸은 "장중 가격 … · … 기준"(화면 ResearchCards와 같다), 차트 범례는 asOf가 마지막 봉과
    같은 날이어도 장마감 기준이 아니라 마지막 봉의 "… 종가 기준" (그 봉은 PDF를 만들 때 받은 봉이다). 용어 풀이는 차트의 '종가'만."""
    live = {"market_agent": {"price": 71500, "asOf": "2026-09-18T11:20:05+09:00", "priceBasis": "live", "rsi": 55.15}}
    markup = build(user, live)
    assert section(markup, "조사 자료 요약") == "조사 자료 요약 시세 장중 가격 71,500원 9월 18일(금) 11:20 기준 RSI 55.2 하루 변동성 -"
    assert section(markup, "가격 흐름").endswith("일봉 · 최근 60일 · 9월 18일(금) 종가 기준")
    assert "장마감 기준" not in plain(markup.split("<h2>용어 풀이</h2>")[0]) and glossary_terms(markup) == ["종가", "RSI"]
    # priceBasis가 없거나 모르는 값이면(예전 결과) 종가로 읽는다
    old = build(user, {"market_agent": {"price": 72000, "asOf": "2026-09-17T15:30:00+09:00", "priceBasis": "?"}})
    assert "종가 72,000원 9월 17일(목) 15:30 장마감 기준" in section(old, "조사 자료 요약")


def test_easy_scenario_uses_recommendation_holding_days(user, candles):
    """리포트에 보유 기간이 없으면(계약상 null 가능) 추천이 쓰는 기본 10거래일 (화면은 그 추천의 holdingDays를 보인다)."""
    results = copy.deepcopy(EASY_RESULTS)
    results["report_agent"]["targets"]["holdingDays"] = None
    assert "기간 안에 둘 다 안 닿으면 10거래일 뒤" in section(build(user, results), "세 가지 경우")


def test_easy_us_report(user, monkeypatch):
    monkeypatch.setattr(market, "completed_candles", lambda symbol: candle_rows(30, 180))
    monkeypatch.setattr(market, "candles", no_live_candles)
    results = copy.deepcopy(EASY_RESULTS)
    results["report_agent"]["targets"] = {"entry": 180.129, "target": 200.456, "stop": 170.999, "holdingDays": 5}
    results["report_agent"]["risks"] = ["$170.99 아래로 내려가면 다시 봐야 해요"]
    results["market_agent"].update({"price": 180.5, "asOf": "2026-10-02T16:00:00-04:00"})
    words = plain(build(user, results, "AAPL"))
    assert "AAPL · 미국 · 2026년 10월 4일 리포트" in words
    assert "사는 가격 $180.12 · 목표 가격 $200.45 · 손절 가격 $170.99." in words
    assert "이 의견이 틀리는 경우 가격이 손절 가격($170.99) 아래로 내려가면 이 의견을 다시 봐야 해요 이 리포트가" in words  # 가격만 → 숨김
    assert "종가 $180.50 10월 2일(금) 16:00(뉴욕) 장마감 기준" in words and "일봉 · 최근 30일 · 7월 30일(목) 종가 기준" in words


def test_easy_html_escapes_values(user, candles):
    evil = "<script>alert(1)</script>"
    results = {"market_agent": {"asOf": evil, "summary": evil},
               "news_agent": {"summary": evil, "headlines": [{"title": evil, "source": evil, "date": evil}]},
               "fundamental_agent": {"recentFilings": [{"title": evil, "date": evil}]},
               "report_agent": {"verdict": "buy", "oneLiner": evil, "plainSummary": [evil], "reasons": [evil],
                                "risks": [evil], "citations": [evil], "targets": {}},
               "risk_agent": {"level": "low", "warnings": [evil], "summary": evil}}
    report = make_report(user, status=Report.COMPLETED, results=results)
    report.name = evil
    report.save()
    markup = pdf.build_report_html(report, [event(report, 1, evil, "agent_completed", "completed")], NOW, easy=True)
    assert "<script>" not in markup and "&lt;script&gt;" in markup


# --- API: ?view=easy|expert, 주린이모드, 두 판의 파일 ---

@pytest.fixture
def files(monkeypatch, tmp_path):
    monkeypatch.setattr(engine, "ROOT", tmp_path)
    monkeypatch.setattr(engine, "engine_config", lambda: SimpleNamespace(chrome_bin=None))
    return tmp_path


@pytest.fixture
def renders(monkeypatch):
    calls = []
    monkeypatch.setattr(pdf, "render_pdf", fake_render(calls))
    return calls


def url(report_id, view=None):
    return f"/api/reports/{report_id}/pdf" + ("" if view is None else f"?view={view}")


def names(folder) -> list[str]:
    return sorted(p.name for p in folder.iterdir())


def test_file_stem_has_easy_variant():
    assert pdf._file_stem(7, 4, easy=True) == "7.v4.easy" and pdf._file_stem(7, 4) == "7.v4"
    assert pdf._file_stem(7, 1, easy=True) == "7.easy" and pdf.TEMPLATE_VERSION == 5


@pytest.mark.parametrize("view, easy", [("easy", True), ("expert", False), (" EASY ", True), ("Expert", False)])
def test_pdf_view_param_picks_variant(api, user, files, candles, renders, view, easy):
    report, _ = easy_report(user)
    response = api.get(url(report.id, view))
    assert response.status_code == 200 and b"".join(response.streaming_content) == b"%PDF-fake"
    name = f"{report.id}.v{pdf.TEMPLATE_VERSION}.easy.pdf" if easy else f"{report.id}.v{pdf.TEMPLATE_VERSION}.pdf"
    assert names(files / "reports") == [name]
    made = renders[0][0]
    assert ("어떻게 만들었나요" in made) is easy and ("만든 Agent · 자동 복구" in made) is not easy


@pytest.mark.parametrize("profile, easy", [(None, True), (True, True), (False, False)])
def test_pdf_without_view_follows_beginner_mode(api, user, files, candles, renders, profile, easy):
    """view가 없거나 비었으면 요청한 사람의 주린이모드 (프로필 행이 없으면 켬)."""
    if profile is not None:
        InvestorProfile.objects.create(user=user, beginner_mode=profile)
    report, _ = easy_report(user)
    for view in (None, ""):
        assert api.get(url(report.id, view)).status_code == 200
    assert names(files / "reports") == [f"{report.id}.v{pdf.TEMPLATE_VERSION}.easy.pdf" if easy else f"{report.id}.v{pdf.TEMPLATE_VERSION}.pdf"]
    assert len(renders) == 1   # 두 번째는 만든 파일을 쓴다


def test_pdf_bad_view_is_400_before_anything_else(api, user, files, renders):
    detail = {"detail": "view는 easy 또는 expert입니다."}
    running = make_report(user, status=Report.RUNNING)
    for path in (url(999, "simple"), url(running.id, "simple"), url(running.id, "easy,expert")):
        response = api.get(path)
        assert response.status_code == 400 and response.json() == detail, path
    assert api.get(url(999, "easy")).status_code == 404 and api.get(url(running.id, "easy")).status_code == 409
    assert renders == [] and not (files / "reports").exists()


def test_pdf_variants_are_cached_separately(api, user, files, candles, renders):
    report, _ = easy_report(user)
    for view in ("easy", "expert", "easy", "expert"):
        assert api.get(url(report.id, view)).status_code == 200
    assert len(renders) == 2 and names(files / "reports") == [f"{report.id}.v{pdf.TEMPLATE_VERSION}.easy.pdf", f"{report.id}.v{pdf.TEMPLATE_VERSION}.pdf"]


def test_pdf_older_template_cleanup_removes_both_variants(api, user, files, candles, renders):
    """새 판을 만들면 그 리포트의 예전 판 파일을 두 판(자세한·쉬운) 모두 지운다. 지금 판의 다른 판 파일·다른 리포트 파일은 그대로."""
    report, _ = easy_report(user)
    folder = files / "reports"
    folder.mkdir()
    old = [f"{report.id}.pdf", f"{report.id}.easy.pdf", f"{report.id}.v2.pdf", f"{report.id}.v2.easy.pdf",
           f"{report.id}.v3.easy.html", f"{report.id}.v3.html", f"{report.id}.v4.pdf"]
    keep = [f"{report.id}.v{pdf.TEMPLATE_VERSION}.pdf", f"{report.id + 1}.v3.easy.pdf"]
    for name in old + keep:
        (folder / name).write_bytes(b"%PDF-old")
    response = api.get(url(report.id, "easy"))
    assert response.status_code == 200 and b"".join(response.streaming_content) == b"%PDF-fake"
    assert names(folder) == sorted([f"{report.id}.v{pdf.TEMPLATE_VERSION}.easy.pdf", *keep])


def test_pdf_easy_without_chrome_serves_html(api, user, files, candles, monkeypatch):
    from paper_engine import report as engine_report

    monkeypatch.setattr(engine_report, "find_chrome", lambda configured=None: None)
    report, _ = easy_report(user)
    response = api.get(url(report.id, "easy"))
    assert response.status_code == 200 and response["Content-Type"].startswith("text/html")
    assert "어떻게 만들었나요" in b"".join(response.streaming_content).decode()
    assert names(files / "reports") == [f"{report.id}.v{pdf.TEMPLATE_VERSION}.easy.html"]
