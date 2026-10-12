"""주린이모드 쉬운 PDF의 문장 표와 문장 함수 (docs/DECISIONS.md 20장). Claude 파일.

웹 쉬운 보기(리포트 상세)와 같은 문장을 쓴다. 표마다 머리 주석에 짝 TS 파일을 적는다 — 문장을 바꾸면 두 쪽을 같이 고친다
(reports/tests/output/test_pdf_easy.py가 TS 파일을 읽어 같은지 본다). 함수도 짝 TS 함수를 그대로 옮겼다 (정규식·반올림·빈 값 규칙까지).
숫자·금액·시나리오·풀이는 이 코드가 만든다. LLM이 쓴 문장은 plainSummary·oneLiner·reasons·risks와 조사 요약뿐이다.
권유 표현을 쓰지 않는다 (paper_engine.wording.forbidden_phrases — 테스트가 고정 문장 전부를 검사한다).
"PDF 전용"이라고 적은 문장은 화면에 없는 문장이다 (종이라 눌러 볼 수 없거나, 계좌마다 다른 값을 넣지 않아서 새로 썼다).

JS 정규식의 `\\d`는 ASCII 숫자만이라 여기서는 `[0-9]`로 쓰고, JS의 입력 끝 `$`는 `\\Z`로 쓴다 (Python `$`는 끝 줄바꿈 앞도 맞는다).
"""
import math
import re
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal

from autotrade.recommend.sources import _holding_days
from paper_engine.data.ticks import kr_tick, round_price

from ..payloads import KST

WEEKDAYS = "월화수목금토일"
LIST_MAX = 3          # 쉬운 요약·근거·위험 줄 수 (lib/reports.ts draftOf)
CITATIONS_MAX = 10    # 인용 수 (draftOf)
RESEARCH_ROWS = 5     # 최근 공시·뉴스 제목 수 (researchOf)
NO_VALUE = "-"        # 화면 빈 값 (lib/format.ts — 자세한 PDF의 "–"와 다르다)

# --- AI 의견 한 줄 (↔ frontend/src/lib/plainText.ts OPINION_TEXT.line). 배지 글자는 reports/output/text.py OPINION_LABEL(= OPINION_TEXT.label)
OPINION_LINE = {
    "buy": "오를 근거가 더 많다고 봤어요",
    "hold": "아직 판단하기 이르다고 봤어요",
    "avoid": "위험이 더 크다고 봤어요",
}
# (↔ components/reports/easy/EasyReport.tsx Conclusion·PlainSummary·ChartSection)
NO_OPINION = "AI 의견을 읽지 못했어요."
NO_SUMMARY = "쉬운 요약이 아직 없어요."
CHART_TEXT = {
    "title": "가격 흐름",
    "target": "목표 가격",
    "entry": "사는 가격",
    "stop": "손절 가격",
    "empty": "가격 자료가 없어요.",
    "lines": "가로선은 AI가 제안한 사는 가격·목표 가격·손절 가격이에요.",
}
# PDF 전용: 범례 기준 줄. 화면처럼 "장마감 기준" 시각을 적는다 — 시세 AI의 asOf(조사 자료 요약의 시세 칸과 같은 글자, 예 "10월 2일(금)
# 15:30 장마감 기준")가 차트 마지막 봉과 같은 날일 때. 아니면(asOf가 없거나 읽지 못함, 리포트 뒤에 만든 PDF라 봉이 더 있음) 마지막 봉 날짜의 종가
CHART_BASIS = "일봉 · 최근 {n}일 · {basis}"
CHART_DAY_BASIS = "{day} 종가 기준"

# --- 신뢰 패널 (↔ components/reports/easy/TrustPanel.tsx. AI_REVIEW_NOTE ↔ lib/plainText.ts)
AI_REVIEW_NOTE = "AI 검토는 사실을 보증하지 않아요"
TRUST_TEXT = {
    "reviewed": "검토 AI가 근거와 대조해 통과",
    "not_reviewed": "검토 기록이 없어요",
    "citations": "인용 {n}개",
    "rewrites": "검토 AI가 근거가 약한 부분을 고쳐 쓰게 했고, 다시 검토해 통과했어요",
    "recovery_reviewed": " — 검토는 똑같이 거쳤어요",
}
# 자료 기준 시각 (↔ lib/reports.ts dataTimeText)
DATA_TIME = "{month}월 {day}일({weekday}) {hour}:{minute} 자료"
DATA_TIME_UNKNOWN = "자료 시각 모름"

# --- AI 담당자(Worker)의 쉬운 이름 — "Agent" 대신 (↔ lib/reports.ts WORKER_EASY_NAME, workerEasyName)
WORKER_EASY_NAME = {
    "market_agent": "시세를 보는 AI",
    "fundamental_agent": "재무제표를 읽는 AI",
    "news_agent": "뉴스를 읽는 AI",
    "report_agent": "리포트를 쓰는 AI",
    "review_agent": "검토 AI",
    "risk_agent": "위험을 점검하는 AI",
    # 매매 종목 선정 팀 (stock_selection)
    "news_screen_agent": "후보 뉴스를 보는 AI",
    "filing_screen_agent": "후보 공시를 보는 AI",
    "flow_agent": "수급을 보는 AI",
    "selector_agent": "종목을 고르는 AI",
    "selection_review_agent": "선정을 검토하는 AI",
}
WORKER_FALLBACK = "AI 담당자"

# --- 자동 복구 문장 (↔ lib/reports.ts recoverySentences)
RECOVERY_TEXT = {
    "switched": "{name}가 {why} 다른 AI가 이어받았어요",
    "retried": "{name}가 {why} 한 번 더 시도해 끝냈어요",
    "gave_up": "{name}가 끝내 답하지 못해 그 자료 없이 진행했어요",
    "late": "늦어",
    "bad": "제대로 답하지 못해",
}

# --- 매매 계획 (↔ components/plan/PlanCard.tsx STATE_TEXT와 Ready의 쉬운 줄). 계좌마다 다른 수량·금액은 넣지 않는다
PLAN_TITLE = "매매 계획"
PLAN_TEXT = {
    "watch": "AI는 지금은 지켜보자는 의견이에요. 실행할 계획이 없어요.",
    "negative": "AI는 위험이 더 크다고 봤어요. 실행할 계획을 만들지 않았어요.",
    "no_plan": "AI가 낸 가격 계획이 맞지 않아(손절 가격이 사는 가격보다 높음 등) 실행 계획을 만들지 않았어요.",
}
PLAN_READY = "사는 가격 {entry} · 목표 가격 {target} · 손절 가격 {stop}. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요."
# PDF 전용: 종이에는 버튼이 없다 — 사람이 웹에서 직접 눌러야 시작된다는 것을 말로 (DECISIONS 12장 "사람이 최종 결정").
# 버튼 이름은 쉬운 보기의 글자 그대로: 매매 계획 카드의 "실행 준비"(components/plan/PlanCard.tsx) → 실행 확인의 "모의 자동매매 시작"
# (pages/RecommendationPage.tsx). 파일은 한 번 만들어 다시 쓰므로 기한을 날짜로 적지 않고 만료된다는 것만 말한다
PLAN_BUTTONS = {"prepare": "실행 준비", "start": "모의 자동매매 시작"}
PLAN_ACTIVATE = ("이 계획은 웹의 매매 계획 카드에서 '실행 준비'를 거쳐 직접 '모의 자동매매 시작'을 눌러야 시작돼요. "
                 "누르지 않으면 실행되지 않고, 기한이 지나면 만료돼요.")

# --- 근거와 위험 · 이 의견이 틀리는 경우 (↔ components/reports/easy/ReasonsRisks.tsx)
REASONS_TEXT = {
    "title": "근거와 위험",
    "reasons": "AI가 든 근거",
    "risks": "위험",
    "wrong": "이 의견이 틀리는 경우",
    "no_reasons": "근거가 없어요.",
    "no_risks": "따로 적은 위험이 없어요.",
    "source": "출처: {source}",
    "citations": "이 리포트가 인용한 자료 {n}개: {items}",
}
WHEN_WRONG_STOP = "가격이 손절 가격({price}) 아래로 내려가면 이 의견을 다시 봐야 해요"
WHEN_WRONG_FALLBACK = "AI가 근거로 든 내용(실적·공시·수급)이 바뀌면 의견도 달라질 수 있어요"

# --- 세 가지 경우 (↔ components/reports/easy/ScenarioBoxes.tsx). PDF는 1주 기준 비율만 (계좌 금액은 웹 매매 계획 카드)
SCENARIO_TEXT = {
    "title": "세 가지 경우",
    "basis": "1주 기준 비율 · 수수료·세금 빼기 전",
    "gain_title": "목표 가격에 닿으면",
    "gain_note": "모의 계좌에서 팔아요",
    "loss_title": "손절 가격에 닿으면",
    "loss_note": "손실이 더 커지지 않게 팔아요. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요",
    "time_title": "기간 안에 둘 다 안 닿으면",
    "time_days": "{n}거래일 뒤",
    "time_no_days": "기간 끝",
    "time_note": "보유 기간이 끝나는 날 가격에 팔아요. 이익일 수도, 손실일 수도 있어요",
}
# PDF 전용: 화면의 "계좌 금액 대신 비율로 보여요" 대신 (PDF는 누가 받아도 같은 파일이라 계좌 금액을 넣지 않는다)
SCENARIO_ACCOUNT_NOTE = "내 모의 계좌로 계산한 금액은 웹의 매매 계획 카드에서 볼 수 있어요."

# --- 조사 자료 요약 (↔ components/reports/easy/ResearchCards.tsx)
RESEARCH_TEXT = {
    "title": "조사 자료 요약",
    "market": "시세",
    "fundamental": "재무·공시",
    "news": "뉴스",
    "close": "종가",
    "live": "장중 가격",  # 리포트를 장 중에 만들었을 때 (MarketResult.priceBasis live — docs/API.md "리포트 시세")
    "no_basis": "시세 기준 시각: 자료 없음",
    "rsi": "RSI",
    "volatility": "하루 변동성",
    "per": "PER",
    "pbr": "PBR",
    "roe": "ROE",
    "filings": "최근 공시",
    "news_source": "뉴스 제목: Google 뉴스 검색 결과(각 언론사)",
}

# --- 용어 풀이 (↔ lib/glossary.ts GLOSSARY의 short — 쉬운 PDF에 나오는 용어만). PDF는 눌러 볼 수 없어 쪽 끝에 모아 싣는다
GLOSSARY = {
    "손절": "정해 둔 가격까지 내려가면 손실이 더 커지기 전에 파는 것이에요. 가격이 갑자기 크게 떨어지면 정한 가격보다 더 낮게 팔릴 수도 있어요.",
    "목표 가격": "여기에 닿으면 팔기로 정해 둔 가격이에요. 닿는다는 보장은 없어요.",
    "보유 기간": "산 뒤 최대 며칠(거래일) 가지고 있을지 정한 기간이에요. 그때까지 목표·손절에 닿지 않으면 그날 가격에 팔아요.",
    "종가": "그날 정규장이 끝날 때의 마지막 가격이에요.",
    "장마감 기준": "계좌 평가·랭킹은 직전 정규장 종가로 보여 장중에는 숫자가 바뀌지 않아요. 종목 시세는 실시간으로 몇 초마다 새로 받고, "
                "리포트는 장 중에 만들면 그때 가격을 써요. 모의 체결은 주문 시점 가격으로 해요.",
    "RSI": "최근 오른 폭과 내린 폭을 비교한 0~100 사이 지표예요. 70 위면 짧은 기간에 많이 올랐고, 30 아래면 많이 내렸다는 뜻으로 읽어요.",
    "변동성": "가격이 얼마나 크게 오르내리는지예요. 크면 같은 기간에도 이익과 손실이 모두 커질 수 있어요.",
    "PER": "주가가 1주당 1년 순이익의 몇 배인지예요. 높으면 이익에 비해 비싸게, 낮으면 싸게 거래된다는 뜻이고 같은 업종끼리 비교해요.",
    "PBR": "주가가 1주당 순자산(가진 것에서 빚을 뺀 것)의 몇 배인지예요. 1보다 낮으면 장부상 순자산보다 싸게 거래된다는 뜻이에요.",
    "ROE": "자기자본이익률. 회사가 주주의 돈(자본)으로 1년에 얼마를 벌었는지 비율로 나타내요. 높을수록 자본으로 이익을 많이 냈다는 뜻이에요.",
    "공시": "회사가 법에 따라 실적·중요한 결정 등을 알리는 것이에요. 금융감독원 전자공시(DART)에서 볼 수 있어요.",
}
GLOSSARY_TITLE = "용어 풀이"  # PDF 전용

# --- 위험 점검 AI의 메모 (PDF 전용 — 컨셉 6장 "결론 위 노란 상자". 화면에는 아직 없다)
RISK_TEXT = {"title": "위험을 점검한 AI의 메모", "level": "위험 정도: {level}"}

# --- 쉬운 꼬리말 (PDF 전용 — 자세한 판의 모델·비용 대신 "어떻게 만들었나요")
FOOTER_TEXT = {
    "title": "어떻게 만들었나요",
    "how": "AI 여러 개가 시세·재무·뉴스를 나눠 조사하고, 리포트를 쓴 뒤 검토 AI가 근거와 대조했어요.",
    "made": "만든 날 {at} · {service}",
}

# 머리 (PDF 전용 — 화면 머리의 "{신청자} 님이 만듦"은 넣지 않는다, pdf.py 머리말)
MARKET_NAME = {"KR": "국내", "US": "미국"}
HEAD_DATE = "{year}년 {month}월 {day}일 리포트"


# --- 값 읽기 (lib/reports.ts의 isObj·finite·text·texts) ---

def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def finite(value) -> float | None:
    """유한한 숫자만 (bool·문자열·NaN·무한대는 None) — TS finite."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def clean(value) -> str | None:
    """앞뒤 공백을 지운 문자열. 문자열이 아니거나 비었으면 None — TS text."""
    return value.strip() if isinstance(value, str) and value.strip() else None


def texts(value, limit: int) -> list[str]:
    """문자열 목록 (앞뒤 공백을 지우고 빈 값을 뺀 뒤 limit개) — TS texts."""
    if not isinstance(value, list):
        return []
    return [x for x in (clean(v) for v in value) if x is not None][:limit]


def draft_of(results) -> dict | None:
    """report_agent 결과(ReportDraft)를 모양이 틀린 값은 비우고 읽는다. 결과가 dict가 아니면 None — TS draftOf."""
    d = _dict(results).get("report_agent")
    if not isinstance(d, dict):
        return None
    t = _dict(d.get("targets"))
    return {
        "verdict": d.get("verdict") if d.get("verdict") in OPINION_LINE else None,
        "oneLiner": clean(d.get("oneLiner")),
        "plainSummary": texts(d.get("plainSummary"), LIST_MAX),
        "reasons": texts(d.get("reasons"), LIST_MAX),
        "risks": texts(d.get("risks"), LIST_MAX),
        "citations": texts(d.get("citations"), CITATIONS_MAX),
        "targets": {k: finite(t.get(k)) for k in ("entry", "target", "stop", "holdingDays")},
    }


def valid_targets(t: dict) -> bool:
    """사는·목표·손절 가격이 0 < 손절 < 사는 가격 < 목표 순서인지 (추천으로 이어지는 조건) — TS validTargets."""
    entry, target, stop = t.get("entry"), t.get("target"), t.get("stop")
    return entry is not None and target is not None and stop is not None and 0 < stop < entry < target


def tick_prices(t: dict, currency: str) -> dict:
    """리포트 제안값을 추천(autotrade.recommend.sources.create)이 저장하는 값으로 — 웹 매매 계획 카드·세 가지 경우와 같은 숫자.

    가격은 호가 단위로 내린다 (0 이하·없는 값은 그대로). 보유 기간은 추천과 같은 규칙(sources._holding_days): 없거나 잘못된 값이면
    기본 10거래일, 정수로 내리고 1~20으로 자른다. 화면 lib/reports.ts floorTargets가 같은 가격 내림을 한다 (추천이 아직 없을 때).
    """
    out = dict(t)
    for key in ("entry", "target", "stop"):
        value = t.get(key)
        if value is not None and value > 0:
            out[key] = float(round_price(value, currency))
    out["holdingDays"] = _holding_days(t.get("holdingDays"))
    return out


def worker_easy_name(worker_id: str) -> str:
    return WORKER_EASY_NAME.get(worker_id, WORKER_FALLBACK)


# --- 숫자 형식 (lib/format.ts) ---

def _half_up_exact(value: float, digits: int) -> Decimal:
    """2진수 값 그대로 반올림 (절반은 0에서 먼 쪽) — JS Number.prototype.toFixed와 같다 (12.35는 실제로 12.3499…라 "12.3").
    format_rate가 쓴다 (화면 formatRate가 toFixed). Python 기본 반올림(round)은 짝수 쪽이라 쓰지 않는다."""
    return Decimal(value).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)


def _half_up_shortest(value: float, digits: int) -> Decimal:
    """가장 짧은 10진 표기(repr — JS가 숫자를 글자로 쓰는 모양)를 반올림 (절반은 0에서 먼 쪽) — Intl.NumberFormat과 같다
    (12.35 → "12.4", 162.005 → "162.01"). format_number·달러 format_price가 쓴다 (화면 formatNumber·formatPrice가 Intl)."""
    return Decimal(repr(float(value))).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)


def format_number(value, digits: int = 0) -> str:
    """천 단위 쉼표, 소수는 최대 digits자리 (뒤 0은 지운다: 12.0 → "12") — TS formatNumber (Intl 반올림: 12.35 → "12.4")."""
    v = finite(value)
    if v is None:
        return NO_VALUE
    q = abs(_half_up_shortest(v, digits))
    body = f"{q:,.{digits}f}".rstrip("0").rstrip(".") if digits and q != q.to_integral_value() else f"{int(q):,}"
    return f"-{body}" if math.copysign(1.0, v) < 0 else body


def format_price(value, currency: str = "KRW") -> str:
    """종목 통화의 가격: 원화 "71,000원"(Math.round — 2진수 값 그대로 절반은 위로), 달러 "$123.45"(Intl 반올림 — $162.005 → "$162.01")
    — TS formatPrice."""
    v = finite(value)
    if v is None:
        return NO_VALUE
    if currency == "USD":
        return f"{'-' if v < 0 else ''}${_half_up_shortest(abs(v), 2):,.2f}"
    whole = math.floor(v)
    if v - whole >= 0.5:  # JS Math.round (절반은 위로)
        whole += 1
    return f"{whole:,}원"


def format_rate(value, digits: int = 2) -> str:
    """소수 비율 → 부호가 붙은 백분율 ("+1.23%", "-0.50%"). 반올림해 0이면 부호 없이 "0.00%" — TS formatRate (toFixed 반올림)."""
    v = finite(value)
    if v is None:
        return NO_VALUE
    pct = v * 100
    fixed = _half_up_exact(abs(pct), digits)
    if fixed == 0:
        return f"{0:.{digits}f}%"
    return f"{'+' if pct > 0 else '-'}{fixed}%"


def plain_number(value: float) -> str:
    """JS 숫자를 글자로 바꾼 모양 (10.0 → "10", 7.5 → "7.5")."""
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def day_label(day) -> str:
    """"YYYY-MM-DD" → "10월 6일(화)". 형식이 틀리면 그대로 — TS formatDayLabel."""
    m = re.match(r"([0-9]{4})-([0-9]{2})-([0-9]{2})", str(day or ""))
    if not m:
        return str(day or NO_VALUE)
    try:
        weekday = WEEKDAYS[date(int(m[1]), int(m[2]), int(m[3])).weekday()]
    except ValueError:
        return str(day)
    return f"{int(m[2])}월 {int(m[3])}일({weekday})"


def data_time_text(at) -> str:
    """자료 기준 시각 → "10월 5일(월) 14:02 자료" (한국 시간). 읽지 못하면 "자료 시각 모름" — TS dataTimeText.

    at은 datetime이나 ISO 문자열. 시간대가 없으면 한국 시간으로 본다 (화면은 한국 시간 브라우저에서 읽는다).
    """
    if isinstance(at, str):
        try:
            at = datetime.fromisoformat(at.strip())
        except ValueError:
            return DATA_TIME_UNKNOWN
    if not isinstance(at, datetime):
        return DATA_TIME_UNKNOWN
    local = (at if at.tzinfo else at.replace(tzinfo=KST)).astimezone(KST)
    return DATA_TIME.format(month=local.month, day=local.day, weekday=WEEKDAYS[local.weekday()],
                            hour=f"{local:%H}", minute=f"{local:%M}")


# --- 자동 복구 문장 (lib/recovery.ts attemptHistory, lib/reports.ts recoverySentences) ---

ERROR_TYPES = ("timeout", "server_error", "bad_output", "unknown")


def _call_failure(e) -> bool:
    """LLM 호출 한 번의 실패 (재시도·전환으로 이어진다): agent_failed이고 final이 정확히 false — TS isCallFailure."""
    return e.action == "agent_failed" and _dict(e.details).get("final") is False


def _give_up(e) -> bool:
    """포기: agent_failed이고 final이 false가 아님 (표시가 없어도 포기로 본다) — TS isGiveUp."""
    return e.action == "agent_failed" and _dict(e.details).get("final") is not False


def attempt_history(trace, worker_id: str) -> dict:
    """한 Worker의 마지막 실행(마지막 agent_started부터)의 시도 이력 {"outcomes", "recovered", "gaveUp"} — TS attemptHistory."""
    mine = [e for e in trace if e.actor == worker_id]
    starts = [i for i, e in enumerate(mine) if e.action == "agent_started"]
    run = mine[starts[-1]:] if starts else mine
    outcomes: list[str] = []
    recovered = gave_up = False
    for e in run:
        if _call_failure(e):
            kind = _dict(e.details).get("errorType")
            outcomes.append(kind if kind in ERROR_TYPES else "unknown")
        elif e.action == "agent_completed":
            recovered = len(outcomes) > 0
            outcomes.append("ok")
        elif _give_up(e):
            gave_up = True
    return {"outcomes": outcomes, "recovered": recovered, "gaveUp": gave_up}


def recovery_sentences(trace) -> list[str]:
    """자동 복구를 쉬운 문장으로: 다른 AI가 이어받음 · 한 번 더 시도해 끝냄 · 끝내 못 해 그 자료 없이 진행 — TS recoverySentences.

    trace는 step 순서의 사건 목록. 담당자는 trace에 처음 나온 순서, WORKER_EASY_NAME에 있는 담당자만 (Orchestrator·Guard는 뺀다).
    final 표시가 없는 agent_failed는 포기로 본다 (화면과 같은 규칙 — 자세한 판의 셈법과 다르다).
    """
    out = []
    for actor in dict.fromkeys(e.actor for e in trace):
        if actor not in WORKER_EASY_NAME:
            continue
        h = attempt_history(trace, actor)
        name = worker_easy_name(actor)
        why = RECOVERY_TEXT["late"] if "timeout" in h["outcomes"] else RECOVERY_TEXT["bad"]
        switched = any(e.actor == actor and e.action == "agent_failover" for e in trace)
        if h["recovered"]:
            out.append(RECOVERY_TEXT["switched" if switched else "retried"].format(name=name, why=why))
        elif h["gaveUp"]:
            out.append(RECOVERY_TEXT["gave_up"].format(name=name))
    return out


# --- 신뢰 패널 (lib/reports.ts trustOf, TrustPanel.tsx) ---

def _last_completed(trace, actor: str):
    return next((e for e in reversed(trace) if e.actor == actor and e.action == "agent_completed"), None)


def trust_of(results, trace) -> dict:
    """{"reviewed", "rewrites", "citations", "dataAt", "recovery"} — TS trustOf (점수는 쉬운 판에 싣지 않아 뺐다).

    reviewed: review_agent 결과의 verdict가 PASS (없으면 Trace의 마지막 검토 판정). rewrites: 검토 RETRY → 다시 쓴 횟수.
    dataAt: 시세 AI가 자료를 받은 시각 (market_agent의 마지막 agent_completed.at).
    """
    review = _dict(results).get("review_agent")
    review_event = _last_completed(trace, "review_agent")
    verdict = clean(_dict(review).get("verdict")) or clean(_dict(getattr(review_event, "details", None)).get("verdict"))
    draft = draft_of(results)
    market_event = _last_completed(trace, "market_agent")
    return {
        "reviewed": verdict == "PASS",
        "rewrites": sum(1 for e in trace if e.action == "review_retry"),
        "citations": len(draft["citations"]) if draft else 0,
        "dataAt": market_event.at if market_event is not None else None,
        "recovery": recovery_sentences(trace),
    }


def trust_lines(results, trace) -> list[str]:
    """신뢰 패널의 줄 (AI_REVIEW_NOTE 앞까지): 첫 줄(검토 · 인용 · 자료 시각), 고쳐 쓴 줄(검토 통과일 때만), 복구 문장들 — TrustPanel.tsx."""
    t = trust_of(results, trace)
    first = " · ".join((TRUST_TEXT["reviewed"] if t["reviewed"] else TRUST_TEXT["not_reviewed"],
                        TRUST_TEXT["citations"].format(n=t["citations"]), data_time_text(t["dataAt"])))
    lines = [first]
    if t["rewrites"] > 0 and t["reviewed"]:
        lines.append(TRUST_TEXT["rewrites"])
    suffix = TRUST_TEXT["recovery_reviewed"] if t["reviewed"] else ""
    lines.extend(f"{line}{suffix}" for line in t["recovery"])
    return lines


# --- 근거·위험·이 의견이 틀리는 경우 (lib/reports.ts splitSource·whenWrongOf·priceOnlyRisk·withoutPriceClause, ReasonsRisks.tsx) ---

SOURCE_TAIL = re.compile(r"\s*[(\[（]\s*(?:출처|근거)\s*[:：]\s*([^)\]）]+?)\s*[)\]）]\s*\Z")
WRONG_HINT = re.compile(r"다시 (?:봐야|판단)|틀리|아래로|손절")
STOP_WORD = r"손절\s*(?:가격|선|라인|가(?!능))"
_UNSET = object()


def split_source(line: str) -> tuple[str, str | None]:
    """"… (출처: DART 반기보고서)"처럼 끝에 붙은 출처를 떼어 (글, 출처). 없으면 (line, None) — TS splitSource."""
    m = SOURCE_TAIL.search(line)
    return (line[:m.start()].strip(), m[1].strip()) if m else (line, None)


def when_wrong_of(risks: list[str], opinion=_UNSET) -> tuple[str | None, list[str]]:
    """위험 중 '틀리는 경우' 형식에 맞는 하나와 나머지 — TS whenWrongOf.

    opinion을 주었는데 긍정적(buy)이 아니면 '손절'이 든 위험은 옮기지 않는다 (그 의견에는 손절 가격이 없다). 주지 않으면 가리지 않는다.
    """
    no_stop = opinion is not _UNSET and opinion != "buy"
    risk = next((x for x in risks if WRONG_HINT.search(x) and not (no_stop and "손절" in x)), None)
    return risk, [x for x in risks if x != risk]


def tick_of(price: float, currency: str) -> float:
    """호가 단위 (국내는 가격대별, 미국은 1센트) — TS tickOf (국내 표는 엔진 ticks.kr_tick과 같다)."""
    return 0.01 if currency == "USD" else kr_tick(price)


def _price_source(currency: str) -> str:
    """문장 속 가격 한 개 (그 통화만): 국내 "66,000원"·"66000 원"·"66,000원선", 미국 "$110.00". 숫자가 첫 묶음 — TS priceSource."""
    return r"\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)" if currency == "USD" else r"([0-9][0-9,]*(?:\.[0-9]+)?)\s*원선?"


def _is_stop_price(raw: str, stop: float, currency: str) -> bool:
    """금액이 손절 가격과 같은지 (반올림해 적을 수 있어 호가 두 칸까지) — TS isStopPrice."""
    try:
        n = float(raw.replace(",", ""))
    except ValueError:
        return False
    return math.isfinite(n) and abs(n - stop) <= 2 * tick_of(stop, currency) + 1e-9


def _mentions_stop(line: str, stop: float, currency: str) -> bool:
    """손절 가격이라고 부르거나 손절 가격과 같은 금액이 있다 — TS mentionsStop."""
    if re.search(STOP_WORD, line):
        return True
    return any(_is_stop_price(m[1], stop, currency) for m in re.finditer(_price_source(currency), line))


def price_only_risk(line: str, stop: float, currency: str) -> bool:
    """손절 가격만 말하는 문장인지 (코드가 만든 손절 문장과 같은 뜻이라 숨긴다). 다른 조건이 붙으면 아니다 — TS priceOnlyRisk."""
    return _mentions_stop(line, stop, currency) and not re.search(r"거나|또는|나오면|발표", line)


def without_price_clause(line: str, stop: float, currency: str) -> str:
    """'66,000원 아래로 내려가거나 …'처럼 앞에 붙은 손절 가격 조건을 떼고 다른 조건만 — TS withoutPriceClause.

    그 금액이 손절 가격(호가 두 칸 안)이거나 '손절 가격'이라고 부를 때만 뗀다. 앞에 다른 조건이 있거나 남는 말이 4자 미만이면 그대로.
    """
    clause = re.compile(rf"^([^.]*?)(?:{_price_source(currency)}|{STOP_WORD})\)?\s*(?:아래|밑)으?로\s*(?:내려가|떨어지)거나,?\s*")
    m = clause.search(line)
    if not m or re.search(r"거나|또는|면\s|고\s|며\s", m[1]):
        return line
    if m[2] is not None and not _is_stop_price(m[2], stop, currency):
        return line
    rest = line[m.end():].strip()
    return rest if len(rest) >= 4 else line


def when_wrong(draft: dict, opinion, currency: str) -> tuple[list[str], list[str]]:
    """'이 의견이 틀리는 경우' 상자의 줄과 위험 목록에 남는 위험 — ReasonsRisks.tsx.

    의견이 긍정적이고 가격이 맞으면 손절 문장을 코드가 만들고, AI 문장이 그 손절 가격만 말하면 숨기고, 앞에 그 가격 조건이 붙어 있으면 뗀다.
    손절 문장도 AI 문장도 없으면 WHEN_WRONG_FALLBACK. draft는 draft_of 모양 (targets는 화면에 보일 값).
    """
    risk, others = when_wrong_of(draft["risks"], opinion)
    targets = draft["targets"]
    stop_line = targets["stop"] if opinion == "buy" and valid_targets(targets) else None
    risk_text = None if risk is None else split_source(risk)[0]
    wrong = risk_text if risk_text is not None and not (
        stop_line is not None and price_only_risk(risk_text, stop_line, currency)) else None
    lines = []
    if stop_line is not None:
        lines.append(WHEN_WRONG_STOP.format(price=format_price(stop_line, currency)))
    if wrong:
        lines.append(without_price_clause(wrong, stop_line, currency) if stop_line is not None else wrong)
    if stop_line is None and not wrong:
        lines.append(WHEN_WRONG_FALLBACK)
    return lines, others


# --- 매매 계획 · 세 가지 경우 ---

def plan_lines(opinion, targets: dict, currency: str) -> list[str]:
    """매매 계획 카드의 문장 (리포트 자료만 — 계좌 수량·금액·기한·준비 중 상태는 없다). PlanCard.tsx의 상태와 같은 판단:
    지켜보기 · 부정적 · 긍정적인데 가격이 맞지 않음(의견을 읽지 못해도 같은 문장) · 긍정적이고 가격이 맞음(가격 한 줄 + 활성화 안내)."""
    if opinion == "hold":
        return [PLAN_TEXT["watch"]]
    if opinion == "avoid":
        return [PLAN_TEXT["negative"]]
    if opinion == "buy" and valid_targets(targets):
        return [PLAN_READY.format(entry=format_price(targets["entry"], currency),
                                  target=format_price(targets["target"], currency),
                                  stop=format_price(targets["stop"], currency)), PLAN_ACTIVATE]
    return [PLAN_TEXT["no_plan"]]


def scenario_of(targets: dict) -> dict | None:
    """세 가지 경우 (1주 기준 비율, 비용 전). 가격 순서가 틀리면 None — TS scenarioOf의 share 기준.

    {"gain": "+6.94%", "loss": "-4.17%", "time": "10거래일 뒤" | "기간 끝"}
    """
    if not valid_targets(targets):
        return None
    entry, days = targets["entry"], targets.get("holdingDays")
    return {
        "gain": format_rate(targets["target"] / entry - 1),
        "loss": format_rate(targets["stop"] / entry - 1),
        "time": SCENARIO_TEXT["time_days"].format(n=plain_number(days)) if days else SCENARIO_TEXT["time_no_days"],
    }


# --- 조사 자료 (lib/reports.ts researchOf) ---

def _rows(value) -> list[dict]:
    return [x for x in value if isinstance(x, dict)] if isinstance(value, list) else []


def research_of(results) -> dict:
    """조사 AI 세 곳의 결과 {"market", "fundamental", "news"} (없으면 None) — TS researchOf에서 쉬운 보기가 쓰는 값만.
    market.basis: "live"(장 중에 만든 리포트의 장중 가격) 또는 "close"(priceBasis가 없거나 다른 값 — 예전 결과)."""
    r = _dict(results)
    m, f, n = r.get("market_agent"), r.get("fundamental_agent"), r.get("news_agent")
    metrics = _dict(f.get("metrics")) if isinstance(f, dict) else {}
    return {
        "market": {"summary": clean(m.get("summary")), "price": finite(m.get("price")), "asOf": clean(m.get("asOf")),
                   "basis": "live" if m.get("priceBasis") == "live" else "close",
                   "rsi": finite(m.get("rsi")), "volatilityPct": finite(m.get("volatilityPct"))}
        if isinstance(m, dict) else None,
        "fundamental": {
            "summary": clean(f.get("summary")), "per": finite(metrics.get("per")), "pbr": finite(metrics.get("pbr")),
            "roe": finite(metrics.get("roe")),
            "filings": [x for x in ({"date": clean(row.get("date")), "title": clean(row.get("title")) or ""}
                                    for row in _rows(f.get("recentFilings"))) if x["title"]][:RESEARCH_ROWS],
        } if isinstance(f, dict) else None,
        "news": {
            "summary": clean(n.get("summary")),
            "headlines": [x for x in ({"date": clean(row.get("date")), "title": clean(row.get("title")) or "",
                                       "source": clean(row.get("source"))} for row in _rows(n.get("headlines")))
                          if x["title"]][:RESEARCH_ROWS],
        } if isinstance(n, dict) else None,
    }


def metric(value, unit: str = "", digits: int = 1) -> str:
    """지표 칸 값: 소수 digits자리까지 + 단위, 없으면 "-" — ResearchCards.tsx num."""
    return NO_VALUE if finite(value) is None else f"{format_number(value, digits)}{unit}"
