"""AI 리포트 A4 PDF (docs/tasks/05-프론트.md T5-11~T5-14, docs/plans/TEAM_DEV_PLAN.md 6-3, docs/DECISIONS.md 14-7 "PDF").

`build_report_html`이 종목 리포트 한 쪽(길어도 두 쪽)을, `build_screening_html`이 선별 요약 표지를 HTML 문자열로 만든다.
가격 차트·점수 막대는 SVG·CSS를 문자열로 직접 만든다 (외부 라이브러리 없음). PDF 변환은 엔진의 `render_pdf`(Chrome headless).
Agent가 아직 결과를 다 못 채웠어도(`Report.results`가 비어 있어도) 있는 만큼만 그리고 없는 칸은 "자료 없음"으로 둔다.

서비스 이름은 "모매매"(2026-10-07 바뀜 — docs/DECISIONS.md 18장, 로고 모양은 15-7). 쪽 머리에 로고(8~10mm)와 이름,
오른쪽에 작은 글씨 "AI 리포트 · 모의투자 연습용"을 두고 가는 선을 긋는다 (면책 문장·날짜는 본문·꼬리말에 있어 머리에 다시 넣지 않는다).
맨 위에 쉬운 요약 상자(`results.report_agent.plainSummary`, B1)와 통일 면책 문장을 두고, 꼬리말도 같은 면책 문장이다.
가격은 장마감 기준이다: 차트는 완성 일봉(`trading.market.completed_candles` — 장중 미완성 봉 없음)으로 그리고
범례에 "YYYY-MM-DD 종가 기준"을, 시세 지표 아래에 `market_agent`의 종가·`asOf`("… 장마감 기준")를 적는다.
리포트를 장 중에 만들었으면(`priceBasis: "live"`, 2026-10-08 — docs/API.md "리포트 시세") 시세 지표 기준 줄은 "장중 가격 … · … 기준"이다.

주린이모드 쉬운 판(`build_easy_report_html`, docs/DECISIONS.md 20장)은 웹 쉬운 보기와 같은 문장(easy_text.py)으로
결론·신뢰 패널·쉬운 요약·매매 계획·근거와 위험·세 가지 경우·가격 흐름·조사 자료·용어 풀이를 싣는다. 검토 점수·확률·신뢰도·모델·비용은 싣지 않는다.

만든 파일은 `PAPER_ROOT/reports/<id>.v<TEMPLATE_VERSION>.pdf`(Chrome이 없으면 `.html`)로 두고 다시 쓴다 (쉬운 판은 `<id>.v<판>.easy.pdf`).
양식을 바꾸면 TEMPLATE_VERSION을 올린다 — 이름이 달라져 예전 양식 파일(판 번호 없는 `<id>.pdf` = 1판 포함)을 쓰지 않고 새로 만들며,
그때 두 판(자세한·쉬운)의 예전 파일을 지운다.

리포트 신청자의 로그인 아이디는 넣지 않는다 (아이디는 로그인 정보다). 비밀 값도 넣지 않는다.
"""
import logging
import math
import os
import re
import uuid
from collections import Counter
from datetime import UTC, datetime
from html import escape
from pathlib import Path

from django.utils import timezone
from paper_engine.report import render_pdf
from trading import market

from config import engine

from . import easy_text as ez
from ..guardrails.contracts import ONE_LINER_MAX
from ..models import Report, TraceEvent
from ..payloads import KST, conclusion
from .text import OPINION_LABEL, selection_fallback_sentence

log = logging.getLogger(__name__)

SERVICE_NAME = "모매매"  # 화면 frontend/src/lib/plainText.ts SERVICE_NAME과 같다
BRAND_NOTE = "AI 리포트 · 모의투자 연습용"  # 쪽 머리 오른쪽 작은 글씨
DISCLAIMER = "이 리포트는 AI가 만든 참고 자료이며 투자 권유가 아닙니다. 모든 매매는 모의 계좌에서만 이뤄집니다."  # 통일 면책 문장
# 양식 판. 양식을 바꾸면 올린다 (예전 판 파일은 다음 요청 때 새로 만든다).
# 2: 2026-10 쉬운 요약·장마감 기준. 3: 2026-10-05 서비스 이름 종이배·로고 머리. 4: 2026-10-07 서비스 이름 모매매.
# 5: 2026-10-08 로고 ㅁ 블록 셋 (docs/DECISIONS.md 27장)
TEMPLATE_VERSION = 5
NO_DATA = "자료 없음"
NO_VALUE = "–"
CHART_DAYS = 60            # 차트에 그리는 최근 일봉 수
MA_WINDOW = 20             # 이동평균 기간
LIST_ITEMS = 3             # 근거·리스크 줄 수
MAX_DROP_REASONS = 8       # 탈락·제외 사유 요약에 보이는 종류 수
MAX_FAIL_LINES = 6         # 꼬리의 복구 내용 줄 수

VERDICT_LABEL = {"buy": "긍정적", "hold": "지켜보기", "avoid": "부정적"}  # AI 의견 배지 (화면 lib/plainText.ts OPINION_TEXT와 같은 말)
SUMMARY_ITEMS = 3          # 쉬운 요약 줄 수 (ReportDraft.plainSummary 상한)
WEEKDAYS = "월화수목금토일"
RISK_LABEL = {"low": "낮음", "medium": "보통", "high": "높음"}
STATUS_LABEL = {"requested": "대기", "running": "진행 중", "completed": "완성", "failed": "실패"}
AGENT_LABEL = {"market_agent": "시세", "fundamental_agent": "재무", "news_agent": "뉴스",
               "report_agent": "작성", "review_agent": "검토", "risk_agent": "리스크"}
RISE, FALL, ACCENT = "#d2342f", "#2a62d2", "#e08a00"   # 상승 빨강·하락 파랑 (국내 관례), 이동평균 주황

# 로고: brand 타일 + 흰 ㅁ 블록 셋의 오르는 계단 (frontend/src/components/brand/BrandMark.tsx의 32px 이상 판 — 속이 빈 ㅁ).
# 도형 값은 frontend/src/lib/brandShapes.ts(MU_PATH·ICON_BLOCKS·ICON_BLOCK_SCALE)와 같다 — 바꾸면 둘 다 고친다.
# 늘이기·그림자·그라데이션을 더하지 않고, 블록 색을 바꾸지 않는다 (docs/DECISIONS.md 27장).
MU_PATH = "M0 0H104V88L0 96Z M32 28V60L72 57V28Z"
ICON_BLOCKS = ((4.5, 18), (12.5, 13), (20.5, 8))
ICON_BLOCK_SCALE = 0.0673
LOGO_SVG = ('<svg class="logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
            '<rect width="32" height="32" rx="8" fill="#3182F6"/><g fill="#FFFFFF" fill-rule="evenodd">'
            + "".join(f'<path transform="translate({x} {y}) scale({ICON_BLOCK_SCALE})" d="{MU_PATH}"/>' for x, y in ICON_BLOCKS)
            + "</g></svg>")

CSS = """
@page { size: A4; margin: 12mm }
.brand { display: flex; align-items: center; justify-content: space-between; gap: 4mm; padding-bottom: 2mm;
         margin-bottom: 4mm; border-bottom: 1px solid #333; }
.brand .mark { display: flex; align-items: center; gap: 2.25mm; font-size: 14pt; font-weight: 800;
               letter-spacing: -0.02em; color: #191f28; }
.brand .logo { width: 9mm; height: 9mm; flex: none; }
.brand .note { color: #555; font-size: 8pt; text-align: right; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
body { font-family: "Noto Sans CJK KR", "Apple SD Gothic Neo", sans-serif; font-size: 9.5pt; line-height: 1.45;
       color: #1a1a1a; margin: 0; }
h1 { font-size: 17pt; margin: 0 0 1mm; }
h2 { font-size: 10.5pt; margin: 4mm 0 1.5mm; padding-bottom: .8mm; border-bottom: 1.5px solid #333; break-after: avoid; }
p { margin: 1mm 0; }
.meta { color: #555; font-size: 9pt; }
.badge { display: inline-block; padding: .3mm 2.4mm; border-radius: 2mm; font-weight: 700; color: #fff; background: #777; }
.badge.buy { background: #d2342f; } .badge.hold { background: #777; } .badge.avoid { background: #2a62d2; }
.one { font-size: 11.5pt; font-weight: 700; margin: 2mm 0 0; }
.chart { width: 100%; height: auto; display: block; }
.empty { color: #888; padding: 3mm 0; }
.legend { color: #555; font-size: 8pt; margin: 0; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2mm; }
.card { border: 1px solid #ccc; border-radius: 2mm; padding: 1.5mm 2.5mm; }
.card .k { color: #666; font-size: 8pt; } .card .v { font-size: 13pt; font-weight: 700; }
.bar { display: grid; grid-template-columns: 30mm 1fr 16mm; align-items: center; gap: 2mm; margin: 1mm 0; }
.bar .track { height: 3.2mm; background: #eee; border-radius: 1.6mm; overflow: hidden; }
.bar .fill { height: 100%; background: #3b6fd4; }
.bar .val { text-align: right; font-weight: 700; }
ul { margin: 0; padding-left: 5mm; } li { margin: .6mm 0; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }
.warn { color: #b4491f; }
table { border-collapse: collapse; width: 100%; margin: 1mm 0 2mm; }
th, td { border: 1px solid #ccc; padding: .8mm 1.8mm; text-align: left; vertical-align: top; }
th { background: #f3f3f3; width: 24mm; }
td.n { text-align: right; }
.foot { margin-top: 4mm; color: #555; font-size: 8.5pt; border-top: 1px solid #ccc; padding-top: 1.5mm; }
.easy { border: 1.5px solid #3b6fd4; border-radius: 2mm; background: #f4f7fd; padding: 1.5mm 3mm 2mm; margin: 3mm 0 0; }
.easy h2 { border: 0; margin: 0 0 1mm; padding: 0; }
.notice { color: #555; font-size: 8.5pt; margin-top: 1.5mm; }
.small { font-size: 8pt; color: #777; }
svg text { font-family: "Noto Sans CJK KR", "Apple SD Gothic Neo", sans-serif; }
"""


def _e(value) -> str:
    return escape("" if value is None else str(value))


def _num(value) -> float | None:
    """결과 JSON의 숫자. bool·문자열·NaN·무한대는 없는 값으로 본다."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _texts(value, limit: int) -> list[str]:
    return [str(x) for x in value[:limit] if isinstance(x, (str, int, float)) and str(x).strip()] \
        if isinstance(value, list) else []


def _fmt(value: float | None, digits: int = 1, suffix: str = "", signed: bool = False) -> str:
    if value is None:
        return NO_VALUE
    return f"{value:+,.{digits}f}{suffix}" if signed else f"{value:,.{digits}f}{suffix}"


def _price(value: float | None, mkt: str) -> str:
    if value is None:
        return NO_VALUE
    return f"{value:,.0f}" if mkt == "KR" else f"{value:,.2f}"


def _brand_head() -> str:
    """쪽 머리: 왼쪽 로고 9mm + 이름(800, 사이는 로고의 1/4), 오른쪽 작은 글씨, 아래 가는 선."""
    return (f'<header class="brand"><span class="mark">{LOGO_SVG}<span>{SERVICE_NAME}</span></span>'
            f'<span class="note">{BRAND_NOTE}</span></header>')


def _page(title: str, body: str, css: str = "") -> str:
    """A4 한 문서. css는 공통 CSS 뒤에 더하는 판별 스타일 (쉬운 판 EASY_CSS — 자세한 판·표지는 더하지 않는다)."""
    return (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{_e(title)} · {SERVICE_NAME}</title>'
            f"<style>{CSS}{css}</style></head><body>{_brand_head()}{body}</body></html>")


def _as_of(value, mkt: str) -> str | None:
    """장마감 기준 시각 ISO → "10월 2일(금) 15:30 장마감 기준" (미국은 뉴욕 시각 "16:00(뉴욕)"). 읽지 못하면 None."""
    try:
        at = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if at.tzinfo is None:
        return None
    at = at.astimezone(market.MARKET_TZ.get(mkt, KST))
    return (f"{at.month}월 {at.day}일({WEEKDAYS[at.weekday()]}) {at:%H:%M}{'(뉴욕)' if mkt == 'US' else ''} "
            f"장마감 기준")


def _live_at(at: datetime, mkt: str) -> str:
    """장 중에 받은 가격의 시각 → "10월 8일(목) 15:23 기준" (그 시장 현지 시각, 미국은 "15:23(뉴욕)")."""
    at = at.astimezone(market.MARKET_TZ.get(mkt, KST))
    return f"{at.month}월 {at.day}일({WEEKDAYS[at.weekday()]}) {at:%H:%M}{'(뉴욕)' if mkt == 'US' else ''} 기준"


# --- 가격 차트 (SVG 문자열) ---

def _load_candles(symbol: str) -> list[dict]:
    """완성 일봉(과거 → 최신, 장마감 기준 — 장중에도 오늘 미완성 봉이 없다). 조회가 안 되면 빈 목록 (차트 자리에 "시세 자료 없음")."""
    try:
        rows = market.completed_candles(symbol)
    except Exception as e:  # 시세를 못 받아도 PDF는 나가야 한다 (차트만 비운다)
        log.warning("리포트 PDF 차트용 일봉 조회 실패: %s %s", symbol, type(e).__name__)
        return []
    out = []
    for c in rows or []:
        try:
            out.append({"date": str(c["timestamp"])[:10], "open": float(c["openPrice"]), "high": float(c["highPrice"]),
                        "low": float(c["lowPrice"]), "close": float(c["closePrice"])})
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _moving_average(closes: list[float], window: int) -> list[float | None]:
    return [sum(closes[i - window + 1:i + 1]) / window if i >= window - 1 else None for i in range(len(closes))]


LINE_NAMES = ("진입", "목표", "손절")  # 자세한 판의 가로선 이름 (쉬운 판은 사는 가격·목표 가격·손절 가격)


def _chart_svg(candles: list[dict], targets: dict, mkt: str, *, average: bool = True,
               names: tuple[str, str, str] = LINE_NAMES, right: int = 66, height: int = 250) -> str:
    """최근 일봉 캔들 + 20일 이동평균 + 제안 진입·목표·손절 가로선. 일봉이 2개 미만이면 안내 문구.

    쉬운 판은 이동평균을 빼고(average=False) 가로선 이름을 쉬운 말로(names — 진입·목표·손절 순서), 이름이 길어 오른쪽 칸(right)을
    넓히고 조금 낮게(height) 그린다. 기본값은 자세한 판 그대로다 (같은 입력이면 같은 SVG).
    """
    if len(candles) < 2:
        return '<p class="empty">시세 자료 없음</p>'
    ma_all = _moving_average([c["close"] for c in candles], MA_WINDOW) if average else [None] * len(candles)
    shown, ma = candles[-CHART_DAYS:], ma_all[-CHART_DAYS:]
    lines = [(names[0], _num(targets.get("entry")), "#555"), (names[1], _num(targets.get("target")), RISE),
             (names[2], _num(targets.get("stop")), FALL)]
    lines = [x for x in lines if x[1] is not None and x[1] > 0]
    values = [c["high"] for c in shown] + [c["low"] for c in shown] + [v for _, v, _ in lines] + \
        [m for m in ma if m is not None]
    lo, hi = min(values), max(values)
    pad = (hi - lo) * 0.06 or hi * 0.02 or 1.0
    lo, hi = lo - pad, hi + pad
    width, left, top, bottom = 720, 58, 8, 20
    plot_w, plot_h = width - left - right, height - top - bottom
    step = plot_w / len(shown)

    def x(i: int) -> float:
        return left + step * (i + 0.5)

    def y(v: float) -> float:
        return top + plot_h * (hi - v) / (hi - lo)

    parts = [f'<svg class="chart" viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg" role="img" '
             f'aria-label="최근 일봉 차트">', f'<rect x="0" y="0" width="{width}" height="{height}" fill="#fff"/>']
    for k in range(5):  # 가로 눈금
        v = lo + (hi - lo) * k / 4
        parts.append(f'<line x1="{left}" y1="{y(v):.1f}" x2="{left + plot_w}" y2="{y(v):.1f}" stroke="#e6e6e6"/>'
                     f'<text x="{left - 4}" y="{y(v) + 3:.1f}" font-size="9" fill="#666" text-anchor="end">'
                     f'{_e(_price(v, mkt))}</text>')
    body_w = max(2.0, step * 0.62)
    for i, c in enumerate(shown):
        color = RISE if c["close"] >= c["open"] else FALL
        top_y, bot_y = y(max(c["open"], c["close"])), y(min(c["open"], c["close"]))
        parts.append(f'<line x1="{x(i):.1f}" y1="{y(c["high"]):.1f}" x2="{x(i):.1f}" y2="{y(c["low"]):.1f}" '
                     f'stroke="{color}" stroke-width="1"/>'
                     f'<rect x="{x(i) - body_w / 2:.1f}" y="{top_y:.1f}" width="{body_w:.1f}" '
                     f'height="{max(1.0, bot_y - top_y):.1f}" fill="{color}"/>')
    points = " ".join(f"{x(i):.1f},{y(m):.1f}" for i, m in enumerate(ma) if m is not None)
    if points:
        parts.append(f'<polyline points="{points}" fill="none" stroke="{ACCENT}" stroke-width="1.6"/>')
    for label, value, color in lines:
        parts.append(f'<line x1="{left}" y1="{y(value):.1f}" x2="{left + plot_w}" y2="{y(value):.1f}" stroke="{color}" '
                     f'stroke-width="1.3" stroke-dasharray="5 3"/>'
                     f'<text x="{left + plot_w + 4}" y="{y(value) + 3:.1f}" font-size="9.5" font-weight="700" '
                     f'fill="{color}">{_e(label)} {_e(_price(value, mkt))}</text>')
    parts.append(f'<text x="{left}" y="{height - 5}" font-size="9" fill="#666">{_e(shown[0]["date"])}</text>'
                 f'<text x="{left + plot_w}" y="{height - 5}" font-size="9" fill="#666" text-anchor="end">'
                 f'{_e(shown[-1]["date"])}</text></svg>')
    return "".join(parts)


# --- 종목 리포트 ---

def _bar(label: str, ratio: float, text: str) -> str:
    width = min(100.0, max(0.0, ratio * 100))
    return (f'<div class="bar"><span>{_e(label)}</span><div class="track"><div class="fill" style="width:{width:.1f}%">'
            f'</div></div><span class="val">{_e(text)}</span></div>')


def _card(key: str, value: str) -> str:
    return f'<div class="card"><div class="k">{_e(key)}</div><div class="v">{_e(value)}</div></div>'


def _list(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{_e(x)}</li>" for x in items) + "</ul>" if items else f'<p class="empty">{NO_DATA}</p>'


def _label(actor: str) -> str:
    return AGENT_LABEL.get(actor, actor)


def _count_recovery(trace: list[TraceEvent]) -> dict:
    """stats.report_recovery가 없을 때의 같은 셈법 (docs/tasks/00-공통.md 9절): 한 실행(run)의 첫 실패 = 장애 1건."""
    failures = recovered = injected = 0
    recovery_ms, got_ms, models = 0.0, False, {}
    runs: dict[str, dict] = {}
    for e in sorted(trace, key=lambda x: x.step):
        details = _dict(e.details)
        run = runs.get(e.actor)
        if e.action == "agent_started":
            runs[e.actor] = {"fail": None}
        elif e.action == "agent_failed" and not details.get("final"):
            if run is None:
                run = runs[e.actor] = {"fail": None}
            if run["fail"] is None:
                run["fail"] = e
        elif e.action == "agent_failed":
            runs.pop(e.actor, None)
            if run and run["fail"] is not None:
                failures += 1
                injected += bool(_dict(run["fail"].details).get("injected"))
        elif e.action == "agent_completed":
            runs.pop(e.actor, None)
            if e.model:
                models[e.actor] = e.model
            if run and run["fail"] is not None:
                failures += 1
                recovered += 1
                injected += bool(_dict(run["fail"].details).get("injected"))
                recovery_ms += (e.at - run["fail"].at).total_seconds() * 1000
                got_ms = True
    for run in runs.values():  # 끝나지 않은 실행의 장애
        if run["fail"] is not None:
            failures += 1
            injected += bool(_dict(run["fail"].details).get("injected"))
    return {"failures": failures, "recovered": recovered, "unrecovered": failures - recovered, "injected": injected,
            "recoveryMs": round(recovery_ms) if got_ms else None, "models": models}


def _recovery(trace: list[TraceEvent]) -> dict:
    try:
        from ..autohealing.stats import report_recovery  # 담당 4가 만든다. 아직 없으면 같은 셈법으로 직접 센다
    except ImportError:
        return _count_recovery(trace)
    try:
        return report_recovery(list(trace))
    except Exception as e:  # 요약이 틀어져도 PDF는 나가야 한다
        log.warning("report_recovery 실패, 직접 센 값을 쓴다: %s", type(e).__name__)
        return _count_recovery(trace)


def _recovery_lines(trace: list[TraceEvent]) -> list[str]:
    """Worker별 복구 내용 한 줄: "뉴스 Agent: timeout 실패 2회 → 모델 A → 모델 B로 복구"."""
    by_actor: dict[str, list[TraceEvent]] = {}
    for e in sorted(trace, key=lambda x: x.step):
        by_actor.setdefault(e.actor, []).append(e)
    lines = []
    for actor, events in by_actor.items():
        fails = [e for e in events if e.action == "agent_failed" and not _dict(e.details).get("final")]
        if not fails:
            continue
        kinds = ", ".join(dict.fromkeys(str(_dict(e.details).get("errorType") or "오류") for e in fails))
        path: list[str] = []
        for e in events:
            if e.action == "agent_failover":
                d = _dict(e.details)
                for model in (d.get("from"), d.get("to")):
                    if model and (not path or path[-1] != model):
                        path.append(str(model))
        done = next((e for e in reversed(events) if e.action == "agent_completed"), None)
        gave_up = any(e.action == "agent_failed" and _dict(e.details).get("final") for e in events)
        if done is not None and not gave_up:
            end = f"{done.model or '같은 모델'}로 복구"
        else:
            end = "복구하지 못함"
        route = f" ({' → '.join(path)})" if len(path) > 1 else ""
        lines.append(f"{_label(actor)} Agent: {kinds} 실패 {len(fails)}회{route} → {end}")
    return lines[:MAX_FAIL_LINES]


def _cost(trace: list[TraceEvent]) -> float | None:
    """workflow의 총 비용이 있으면 그것, 없으면 Agent별 비용 합. 둘 다 없으면 None."""
    for e in reversed(trace):
        if e.action in ("workflow_completed", "workflow_failed"):
            cost = _num(_dict(e.details).get("costUsd"))
            if cost is not None:
                return cost
    costs = [_num(_dict(e.details).get("costUsd")) for e in trace if e.action == "agent_completed"]
    costs = [c for c in costs if c is not None]
    return sum(costs) if costs else None


def _footer(report: Report, trace: list[TraceEvent], now: datetime) -> str:
    ordered = sorted(trace, key=lambda x: x.step)
    made: dict[str, TraceEvent] = {}
    for e in ordered:
        if e.action == "agent_completed":
            made[e.actor] = e  # 같은 Agent가 다시 돌면 마지막 것
    agents = "".join(f"<li>{_e(_label(a))} Agent — {_e(e.model or NO_VALUE)}"
                     f"{' (' + _e(e.provider) + ')' if e.provider else ''}</li>" for a, e in made.items())
    agents_html = f"<ul>{agents}</ul>" if agents else '<p class="empty">Agent 실행 기록 없음</p>'
    failed = [_label(a) for a in report.failed_agents] if isinstance(report.failed_agents, list) else []
    failed_html = f'<p class="warn">실패한 Agent: {_e(", ".join(failed))}</p>' if failed else ""
    if ordered:
        rec = _recovery(ordered)
        summary = (f"장애 {rec.get('failures', 0)}건 · 자동 복구 {rec.get('recovered', 0)}건"
                   + (f" · 복구 못함 {rec.get('unrecovered', 0)}건" if rec.get("unrecovered") else ""))
        ms = _num(rec.get("recoveryMs"))
        if ms is not None:
            summary += f" · 복구 시간 합 {ms / 1000:.1f}초"
        lines = _recovery_lines(ordered)
        recovery_html = f"<p>{_e(summary)}</p>" + (_list(lines) if lines else "")
    else:
        recovery_html = '<p class="empty">Agent 실행 기록 없음</p>'
    cost = _cost(ordered)
    cost_text = f"${cost:,.4f}" if cost is not None else NO_DATA
    made_at = now.astimezone(KST).strftime("%Y-%m-%d %H:%M")
    return (f'<div class="foot"><h2>만든 Agent · 자동 복구</h2>{agents_html}{failed_html}{recovery_html}'
            f"<p>비용 {_e(cost_text)} · 생성 {_e(made_at)} KST · {SERVICE_NAME}</p>"
            f'<p class="small">{DISCLAIMER}</p></div>')


def _market_basis(mkt_res: dict, mkt: str) -> str:
    """시세 지표 아래 기준 줄: "시세 지표: 종가 72,000원 · 10월 2일(금) 15:30 장마감 기준" (MarketResult의 price·asOf).
    장 중에 만든 리포트(priceBasis live)는 "시세 지표: 장중 가격 71,500원 · 10월 8일(목) 11:20 기준".
    asOf가 없으면(장마감 기준 이전의 결과) 기준 시각을 알 수 없다고 적고 가격을 보이지 않는다."""
    live = mkt_res.get("priceBasis") == market.BASIS_LIVE
    as_of = _as_of(mkt_res.get("asOf"), mkt) if mkt_res.get("asOf") else None
    if live and as_of is not None:
        as_of = _live_at(datetime.fromisoformat(str(mkt_res["asOf"])), mkt)
    if as_of is None:
        return f'<p class="legend">시세 지표 기준 시각: {NO_DATA}</p>'
    value = _num(mkt_res.get("price"))
    name = "장중 가격" if live else "종가"
    price = f"{name} {_price(value, mkt)}{'원' if mkt == 'KR' else '달러'} · " if value is not None and value > 0 else ""
    return f'<p class="legend">시세 지표: {_e(price)}{_e(as_of)}</p>'


def build_report_html(report: Report, trace: list[TraceEvent], now: datetime | None = None, *,
                      easy: bool = False) -> str:
    """종목 리포트 한 쪽. report.results의 Worker 결과와 Trace로 만든다. 없는 칸은 "자료 없음".

    easy면 주린이모드 쉬운 판(build_easy_report_html — docs/DECISIONS.md 20장). 기본은 자세한 판 (내용·양식은 4판 그대로).
    """
    if easy:
        return build_easy_report_html(report, trace, now)
    now = now or timezone.now()
    results = _dict(report.results)
    mkt_res, fund_res = _dict(results.get("market_agent")), _dict(results.get("fundamental_agent"))
    draft, review, risk = (_dict(results.get(k)) for k in ("report_agent", "review_agent", "risk_agent"))
    targets = _dict(draft.get("targets"))
    when = (report.finished_at or report.created_at).astimezone(KST).strftime("%Y-%m-%d")
    verdict = draft.get("verdict")
    opinion_html = (f'AI 의견 <span class="badge {_e(verdict) if verdict in VERDICT_LABEL else ""}">'
                    f"{_e(VERDICT_LABEL.get(verdict, verdict))}</span>" if verdict else "AI 의견 없음")
    head = (f"<h1>{_e(report.name)} <span class=\"meta\">{_e(report.symbol)} · {_e(report.market)}</span></h1>"
            f'<p class="meta">{_e(when)} · {opinion_html}</p>'  # 서비스 이름은 쪽 머리에 있다
            f'<p class="one">{_e(draft.get("oneLiner") or NO_DATA)}</p>')
    easy = (f'<div class="easy"><h2>쉬운 요약</h2>{_list(_texts(draft.get("plainSummary"), SUMMARY_ITEMS))}'
            f'<p class="notice">{DISCLAIMER}</p></div>')

    candles = _load_candles(report.symbol)
    basis = f"{candles[-1]['date']} 종가 기준 · " if candles else ""
    chart = (f"<h2>가격 차트</h2>{_chart_svg(candles, targets, report.market)}"
             f'<p class="legend">{_e(basis)}일봉(최근 {CHART_DAYS}일) · <span style="color:{ACCENT}">━</span> '
             f"{MA_WINDOW}일 이동평균 · 점선: 제안 진입·목표·손절 (AI 제안)</p>")

    metrics = _dict(fund_res.get("metrics"))
    rank = _num(mkt_res.get("volumeRank"))
    cards = "".join((
        _card("등락률", _fmt(_num(mkt_res.get("changePct")), 2, "%", signed=True)),
        _card("거래대금 순위", f"{rank:.0f}위" if rank is not None else NO_VALUE),
        _card("RSI", _fmt(_num(mkt_res.get("rsi")), 1)),
        _card("변동성", _fmt(_num(mkt_res.get("volatilityPct")), 2, "%")),
        _card("PER", _fmt(_num(metrics.get("per")), 1, "배")),
        _card("PBR", _fmt(_num(metrics.get("pbr")), 2, "배"))))
    basis_html = _market_basis(mkt_res, report.market)

    bars = []
    score, confidence, probability = _num(review.get("score")), _num(draft.get("confidence")), _num(targets.get("probability"))
    if score is not None:
        bars.append(_bar("검토 점수", score / 100, f"{score:.0f}점"))
    if confidence is not None:
        bars.append(_bar("신뢰도", confidence / 100, f"{confidence:.0f}%"))
    if probability is not None:
        bars.append(_bar("목표 도달 확률", probability, f"{probability * 100:.0f}%"))
    bars_html = "".join(bars) or f'<p class="empty">{NO_DATA}</p>'

    risk_html = ""
    if risk:
        level = RISK_LABEL.get(risk.get("level"), risk.get("level") or NO_VALUE)
        warnings = _texts(risk.get("warnings"), LIST_ITEMS)
        risk_html = (f'<p class="warn">리스크 점검: {_e(level)}'
                     f'{" — " + _e(risk.get("summary")) if risk.get("summary") else ""}</p>'
                     + (_list(warnings) if warnings else ""))

    body = (head + easy + chart + f"<h2>핵심 지표</h2><div class=\"cards\">{cards}</div>{basis_html}"
            f"<h2>점수·확률</h2>{bars_html}"
            f'<div class="cols"><div><h2>근거</h2>{_list(_texts(draft.get("reasons"), LIST_ITEMS))}</div>'
            f'<div><h2>리스크</h2>{_list(_texts(draft.get("risks"), LIST_ITEMS))}</div></div>{risk_html}'
            + _footer(report, trace, now))
    return _page(f"{report.name} AI 리포트", body)


# --- 쉬운 판 (주린이모드 — docs/DECISIONS.md 20장, 문장은 easy_text.py = 웹 쉬운 보기와 같은 문장) ---

# 색은 화면 토큰(frontend/src/index.css 밝은 화면)을 옮겨 쓴다: 글자 ink·sub·mute, 바탕 fill·line, 의견 배지 brand·warn 바탕,
# 세 가지 경우 up-soft·down-soft, 위험 메모 warn. 차트·가로선 색은 자세한 판과 같다 (RISE·FALL).
EASY_CSS = """
.ez { font-size: 9.5pt; line-height: 1.42; color: #191f28; }
.ez h1 { font-size: 17pt; margin: 0; letter-spacing: -0.01em; }
.ez .meta { color: #646e7a; margin: .3mm 0 0; }
.ez h2 { font-size: 11pt; margin: 0 0 1.2mm; padding: 0; border: 0; }
.ez h3 { font-size: 9pt; color: #4e5968; margin: 1.6mm 0 .6mm; }
.ez .empty { color: #646e7a; padding: .3mm 0; }
.ez .legend { color: #4e5968; margin-top: .6mm; }
.ez p { margin: .6mm 0; }
.sec { border: 1px solid #e5e8eb; border-radius: 2.5mm; padding: 2.2mm 3.5mm; margin-top: 2.2mm; break-inside: avoid; }
.sec.long { break-inside: auto; }
.riskbox { border: 1.5px solid #ff9f00; background: #fff6e5; border-radius: 2.5mm; padding: 2mm 3.5mm; margin-top: 2.2mm;
           break-inside: avoid; }
.riskbox h2 { color: #9a5b00; margin-bottom: .6mm; }
.riskbox .lvl { font-weight: 700; color: #9a5b00; }
.riskbox ul { padding-left: 4.5mm; }
.op { display: inline-block; padding: .5mm 2.4mm; border-radius: 1.6mm; font-weight: 800; font-size: 11pt;
      background: #f2f4f6; color: #4e5968; }
.op.buy { background: #e8f3ff; color: #1b64da; } .op.avoid { background: #fff6e5; color: #9a5b00; }
.ez .opline { color: #4e5968; margin: .8mm 0 0; }
.ez .one { font-size: 12.5pt; line-height: 1.32; margin: 1.4mm 0 0; }
.trust { background: #f2f4f6; border-radius: 2mm; padding: 1.6mm 2.6mm; margin-top: 2mm; }
.ez .trust p { display: flex; gap: 1.5mm; align-items: flex-start; margin: .4mm 0; color: #4e5968; }
.ez .trust .t1 { font-weight: 700; color: #191f28; }
.ez .trust .tn { font-size: 8pt; }
.ic { width: 3.4mm; height: 3.4mm; flex: none; margin-top: .5mm; }
.ez .easy { margin-top: 2.2mm; padding: 2mm 3.5mm; break-inside: avoid; }
.easy ol { list-style: none; margin: 0; padding: 0; }
.easy ol li { display: flex; gap: 2mm; margin: .8mm 0; font-size: 10pt; }
.easy .n { flex: none; width: 4.6mm; height: 4.6mm; margin-top: .4mm; border-radius: 50%; background: #191f28; color: #fff;
           font-size: 7.5pt; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.ez .easy .notice { margin-top: 1mm; }
.ez .plan .act { background: #e8f3ff; color: #1b64da; border-radius: 1.6mm; padding: 1.2mm 2.4mm; font-size: 8.5pt;
                 margin-top: 1.2mm; }
.dots { list-style: none; margin: 0; padding: 0; }
.dots li { position: relative; padding-left: 3.2mm; margin: .5mm 0; }
.dots li::before { content: ""; position: absolute; left: .3mm; top: 1.9mm; width: 1.4mm; height: 1.4mm; border-radius: 50%;
                   background: #3182f6; }
.dots.risk li::before { background: #ff9f00; }
.src { display: block; font-size: 7.5pt; color: #646e7a; }
.wrong { list-style: none; margin: 0; padding: 1.5mm 2.6mm; background: #f2f4f6; border-radius: 2mm; }
.wrong li { margin: .4mm 0; }
.cite, .note { font-size: 8pt; color: #4e5968; }
.ez .cite { margin-top: 1.4mm; }
.cases { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2mm; margin: 1.2mm 0; }
.case { border-radius: 2mm; padding: 1.5mm 2.6mm; background: #f2f4f6; }
.case.up { background: #ffeeee; } .case.down { background: #e8f3ff; }
.ez .case p { margin: 0; }
.ez .case .ct { font-weight: 700; color: #4e5968; font-size: 8.5pt; }
.ez .case .cv { font-size: 14pt; font-weight: 800; margin: .3mm 0; }
.case.up .cv { color: #f04452; } .case.down .cv { color: #3182f6; }
.ez .case .cn { font-size: 8pt; color: #4e5968; line-height: 1.35; }
.lines { list-style: none; display: flex; flex-wrap: wrap; gap: 1mm 5mm; margin: 1mm 0 0; padding: 0; font-size: 8.5pt;
         color: #4e5968; }
.lines li { display: flex; align-items: center; gap: 1.5mm; margin: 0; }
.lines b { color: #191f28; }
.sw { width: 5mm; border-top: 2px dashed #555; }
.sw.target { border-color: #d2342f; } .sw.stop { border-color: #2a62d2; }
.rsg { display: grid; grid-template-columns: repeat(var(--cols), 1fr); gap: 3.5mm; }
.rs { min-width: 0; } .rs + .rs { border-left: 1px solid #e5e8eb; padding-left: 3.5mm; }
.ez .rs h3 { margin-top: 0; }
.close { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 1.5mm; }
.close .k { font-size: 8pt; color: #4e5968; } .close b { font-size: 11.5pt; } .close .at { font-size: 8pt; color: #646e7a; }
.mets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.2mm; margin: 1.2mm 0 0; }
.mets.c2 { grid-template-columns: repeat(2, 1fr); }
.mets div { background: #f2f4f6; border-radius: 1.6mm; padding: .6mm 1.8mm; min-width: 0; }
.mets dt { font-size: 7.5pt; color: #646e7a; } .mets dd { margin: 0; font-weight: 700; font-size: 10pt; }
.plain { list-style: none; margin: .6mm 0 0; padding: 0; font-size: 8.5pt; color: #4e5968; }
.plain li { margin: .3mm 0; } .plain .d { color: #646e7a; }
.terms { columns: 2; column-gap: 5mm; margin: 0; font-size: 8.5pt; line-height: 1.38; }
.terms div { break-inside: avoid; margin: 0 0 1mm; } .terms dt { display: inline; font-weight: 700; margin-right: 1.2mm; }
.terms dd { display: inline; margin: 0; color: #4e5968; }
.ez .foot { margin-top: 3mm; }
.ez .foot h2 { font-size: 9pt; color: #333; margin-bottom: .6mm; }
.ez .foot p { margin: .3mm 0; }
"""

# 신뢰 패널 아이콘 (화면 TrustPanel의 check·alert·shield와 같은 뜻, 글자 없음)
ICON_OK = ('<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#03a463"/>'
           '<path d="M4.6 8.3l2.3 2.3 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" '
           'stroke-linejoin="round"/></svg>')
ICON_ALERT = ('<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#8b95a1"/>'
              '<path d="M8 4v5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>'
              '<circle cx="8" cy="11.8" r="1.1" fill="#fff"/></svg>')
ICON_SHIELD = ('<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .8l6.2 2.4v4.3c0 3.7-2.6 6.5-6.2 7.7'
               '-3.6-1.2-6.2-4-6.2-7.7V3.2z" fill="#03a463"/><path d="M5.2 8l2 2 3.8-4" fill="none" stroke="#fff" '
               'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')
EASY_CHART = {"right": 96, "height": 190}   # 쉬운 판 차트: 가로선 이름("목표 가격 77,000")이 길어 오른쪽 칸을 넓히고 조금 낮게


def _easy_risk(risk: dict) -> str:
    """위험 점검 AI의 메모 — 결론 위 노란 상자 (컨셉 6장). 보일 것이 없으면 빈 문자열."""
    level = RISK_LABEL.get(risk.get("level"))
    summary = ez.clean(risk.get("summary"))
    warnings = ez.texts(risk.get("warnings"), LIST_ITEMS)
    if not (level or summary or warnings):
        return ""
    t = ez.RISK_TEXT
    return (f'<section class="riskbox"><h2>{_e(t["title"])}</h2>'
            + (f'<p class="lvl">{_e(t["level"].format(level=level))}</p>' if level else "")
            + (f"<p>{_e(summary)}</p>" if summary else "")
            + ("<ul>" + "".join(f"<li>{_e(w)}</li>" for w in warnings) + "</ul>" if warnings else "")
            + "</section>")


def _easy_trust(results: dict, trace: list[TraceEvent]) -> str:
    """신뢰 패널 (TrustPanel): 첫 줄(검토 · 인용 · 자료 시각), 고쳐 쓴 줄, 자동 복구 문장, "AI 검토는 사실을 보증하지 않아요"."""
    info = ez.trust_of(results, trace)
    lines = ez.trust_lines(results, trace)
    split = len(lines) - len(info["recovery"])
    html = f'<p class="t1">{ICON_OK if info["reviewed"] else ICON_ALERT}<span>{_e(lines[0])}</span></p>'
    html += "".join(f"<p>{_e(x)}</p>" for x in lines[1:split])
    html += "".join(f"<p>{ICON_SHIELD}<span>{_e(x)}</span></p>" for x in lines[split:])
    return f'<div class="trust">{html}<p class="tn">{_e(ez.AI_REVIEW_NOTE)}</p></div>'


def _easy_conclusion(opinion: str | None, one_liner: str | None, results: dict, trace: list[TraceEvent]) -> str:
    """결론: "AI 의견: 긍정적" 배지 + 한 줄 풀이(없으면 읽지 못했다는 문장), 한 줄 요약(있을 때만), 신뢰 패널."""
    if opinion in ez.OPINION_LINE:
        top = (f'<span class="op {opinion}">{_e(OPINION_LABEL[opinion])}</span>'
               f'<p class="opline">{_e(ez.OPINION_LINE[opinion])}</p>')
    else:
        top = f'<p class="opline">{_e(ez.NO_OPINION)}</p>'
    one = f'<p class="one">{_e(one_liner)}</p>' if one_liner else ""
    return f'<section class="sec concl">{top}{one}{_easy_trust(results, trace)}</section>'


def _easy_summary(draft: dict | None) -> str:
    """쉬운 요약 번호 1~3 + 통일 면책 문장 (자세한 판 맨 위 상자와 같은 자리·같은 면책)."""
    lines = draft["plainSummary"] if draft else []
    body = ("<ol>" + "".join(f'<li><span class="n">{i}</span><span>{_e(x)}</span></li>' for i, x in enumerate(lines, 1))
            + "</ol>") if lines else f'<p class="empty">{_e(ez.NO_SUMMARY)}</p>'
    return f'<section class="easy"><h2>쉬운 요약</h2>{body}<p class="notice">{DISCLAIMER}</p></section>'


def _easy_plan(opinion: str | None, prices: dict, currency: str) -> str:
    """매매 계획 (말로 — 계좌 수량·금액 없이). 긍정적이고 가격이 맞으면 가격 한 줄과 웹에서 직접 시작해야 한다는 안내."""
    body = "".join(f'<p class="act">{_e(x)}</p>' if x == ez.PLAN_ACTIVATE else f"<p>{_e(x)}</p>"
                   for x in ez.plan_lines(opinion, prices, currency))
    return f'<section class="sec plan"><h2>{_e(ez.PLAN_TITLE)}</h2>{body}</section>'


def _easy_lines(lines: list[str], kind: str) -> str:
    """근거·위험 목록. 끝에 붙은 "(출처: …)"는 떼어 줄 아래 작은 글씨로."""
    items = []
    for line in lines:
        text, source = ez.split_source(line)
        src = f'<span class="src">{_e(ez.REASONS_TEXT["source"].format(source=source))}</span>' if source else ""
        items.append(f"<li>{_e(text)}{src}</li>")
    return f'<ul class="dots {kind}">{"".join(items)}</ul>'


def _easy_reasons(draft: dict, opinion: str | None, currency: str) -> str:
    """근거와 위험 · 이 의견이 틀리는 경우 · 인용 자료 (ReasonsRisks). draft의 targets는 화면에 보일(호가로 내린) 값."""
    t = ez.REASONS_TEXT
    wrong, others = ez.when_wrong(draft, opinion, currency)
    reasons = _easy_lines(draft["reasons"], "reason") if draft["reasons"] else f'<p class="empty">{_e(t["no_reasons"])}</p>'
    risks = _easy_lines(others, "risk") if others else f'<p class="empty">{_e(t["no_risks"])}</p>'
    cites = draft["citations"]
    cite = (f'<p class="cite">{_e(t["citations"].format(n=len(cites), items=" · ".join(cites)))}</p>' if cites else "")
    return (f'<section class="sec"><h2>{_e(t["title"])}</h2><div class="cols">'
            f'<div><h3>{_e(t["reasons"])}</h3>{reasons}</div><div><h3>{_e(t["risks"])}</h3>{risks}</div></div>'
            f'<h3>{_e(t["wrong"])}</h3><ul class="wrong">{"".join(f"<li>{_e(x)}</li>" for x in wrong)}</ul>{cite}</section>')


def _easy_scenario(s: dict) -> str:
    """세 가지 경우 (1주 기준 비율). 계좌 금액은 웹의 매매 계획 카드에 있다고 적는다."""
    t = ez.SCENARIO_TEXT

    def box(kind: str, title: str, value: str, note: str) -> str:
        return (f'<div class="case {kind}"><p class="ct">{_e(title)}</p><p class="cv">{_e(value)}</p>'
                f'<p class="cn">{_e(note)}</p></div>')
    return (f'<section class="sec"><h2>{_e(t["title"])}</h2><p class="note">{_e(t["basis"])}</p><div class="cases">'
            + box("up", t["gain_title"], s["gain"], t["gain_note"])
            + box("down", t["loss_title"], s["loss"], t["loss_note"])
            + box("time", t["time_title"], s["time"], t["time_note"])
            + f'</div><p class="note">{_e(ez.SCENARIO_ACCOUNT_NOTE)}</p></section>')


DATE_ONLY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _easy_close_at(value, mkt: str) -> datetime | None:
    """쉬운 판 시세 칸의 기준 시각(시세 AI의 asOf — 장마감 기준 시각, 장 중에 만들었으면 받은 시각)을 그 시장 시간대로. 읽지 못하면 None.

    화면(ResearchCards의 new Date(asOf), 한국 시간 브라우저)과 같게 읽는다: 시간대가 없으면 한국 시간, 날짜만이면 UTC 자정.
    자세한 판 _as_of는 시간대가 없으면 None이다 (자세한 판은 바꾸지 않는다).
    """
    text = value.strip() if isinstance(value, str) else ""
    try:
        at = datetime.fromisoformat(text)
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC if DATE_ONLY.fullmatch(text) else KST)
    return at.astimezone(market.MARKET_TZ.get(mkt, KST))


def _chart_close_at(candles: list[dict], close_at: datetime | None) -> datetime | None:
    """차트 범례에 장마감 기준 시각을 적을 수 있으면 그 시각: asOf가 차트 마지막 봉과 같은 날일 때만 (리포트보다 뒤에 만든 PDF는 봉이 더 있다)."""
    if close_at is None or len(candles) < 2:
        return None
    return close_at if close_at.date().isoformat() == candles[-CHART_DAYS:][-1]["date"] else None


def _easy_chart(candles: list[dict], prices: dict, mkt: str, currency: str, close_at: datetime | None = None) -> str:
    """가격 흐름: 완성 일봉(이동평균 없음) + 사는·목표·손절 가로선(prices가 있을 때 — 의견 긍정적이고 가격이 맞을 때만), 범례·기준 줄.

    기준 줄은 close_at(_chart_close_at — 마지막 봉과 같은 날의 장마감 기준 시각)이 있으면 "… 장마감 기준", 없으면 마지막 봉 날짜의 "… 종가 기준".
    """
    t = ez.CHART_TEXT
    if len(candles) < 2:
        return f'<section class="sec"><h2>{_e(t["title"])}</h2><p class="empty">{_e(t["empty"])}</p></section>'
    svg = _chart_svg(candles, prices, mkt, average=False, names=(t["entry"], t["target"], t["stop"]), **EASY_CHART)
    lines = [(kind, _num(prices.get(kind))) for kind in ("target", "entry", "stop")]
    lines = [(kind, v) for kind, v in lines if v is not None and v > 0]
    legend = ('<ul class="lines">' + "".join(f'<li><span class="sw {kind}"></span>{_e(t[kind])} '
                                             f'<b>{_e(ez.format_price(v, currency))}</b></li>' for kind, v in lines)
              + "</ul>") if lines else ""
    shown = candles[-CHART_DAYS:]
    day = _as_of(close_at.isoformat(), mkt) if close_at else ez.CHART_DAY_BASIS.format(day=ez.day_label(shown[-1]["date"]))
    basis = ez.CHART_BASIS.format(n=len(shown), basis=day)
    tail = f'<p class="legend">{_e(t["lines"])}</p>' if lines else ""
    return f'<section class="sec"><h2>{_e(t["title"])}</h2>{svg}{legend}<p class="legend">{_e(basis)}</p>{tail}</section>'


def _easy_metrics(items: list[tuple[str, str]]) -> str:
    cols = "" if len(items) == 3 else f" c{len(items)}"
    return (f'<dl class="mets{cols}">' + "".join(f"<div><dt>{_e(k)}</dt><dd>{_e(v)}</dd></div>" for k, v in items)
            + "</dl>")


def _easy_research(research: dict, mkt: str, currency: str, price_at: datetime | None = None) -> str:
    """조사 자료 요약 (ResearchCards): 시세(종가·장마감 기준 시각, 장 중에 만들었으면 장중 가격·받은 시각 — RSI·하루 변동성)
    · 재무·공시 · 뉴스(제목·매체·날짜, 링크 없음). price_at은 시세 AI asOf를 화면처럼 읽은 시각 (_easy_close_at — 시간대가 없으면 한국 시간)."""
    m, f, n = research["market"], research["fundamental"], research["news"]
    if not (m or f or n):
        return ""
    t = ez.RESEARCH_TEXT
    parts = []
    if m:
        live = m["basis"] == "live"
        as_of = (_live_at(price_at, mkt) if live else _as_of(price_at.isoformat(), mkt)) if price_at else None
        if as_of:  # 기준 시각을 모르면 그 가격이 종가인지 알 수 없어 가격을 보이지 않는다 (_market_basis와 같다)
            price = (f'<span class="k">{_e(t["live" if live else "close"])}</span> '
                     f'<b>{_e(ez.format_price(m["price"], currency))}</b> '
                     if m["price"] is not None and m["price"] > 0 else "")
            basis = f'<p class="close">{price}<span class="at">{_e(as_of)}</span></p>'
        else:
            basis = f'<p class="close"><span class="at">{_e(t["no_basis"])}</span></p>'
        parts.append(f'<div class="rs"><h3>{_e(t["market"])}</h3>{basis}'
                     + (f"<p>{_e(m['summary'])}</p>" if m["summary"] else "")
                     + _easy_metrics([(t["rsi"], ez.metric(m["rsi"])), (t["volatility"], ez.metric(m["volatilityPct"], "%"))])
                     + "</div>")
    if f:
        filings = ("".join(f"<li>{_e(x['title'])}" + (f'<span class="d"> · {_e(x["date"])}</span>' if x["date"] else "")
                           + "</li>" for x in f["filings"]))
        parts.append(f'<div class="rs"><h3>{_e(t["fundamental"])}</h3>'
                     + (f"<p>{_e(f['summary'])}</p>" if f["summary"] else "")
                     + _easy_metrics([(t["per"], ez.metric(f["per"], "배")), (t["pbr"], ez.metric(f["pbr"], "배")),
                                      (t["roe"], ez.metric(f["roe"], "%"))])
                     + (f'<h3>{_e(t["filings"])}</h3><ul class="plain">{filings}</ul>' if filings else "") + "</div>")
    if n:
        heads = "".join(f"<li>{_e(x['title'])}<span class=\"d\">"
                        + (f" — {_e(x['source'])}" if x["source"] else "") + (f" · {_e(x['date'])}" if x["date"] else "")
                        + "</span></li>" for x in n["headlines"])
        parts.append(f'<div class="rs"><h3>{_e(t["news"])}</h3>'
                     + (f"<p>{_e(n['summary'])}</p>" if n["summary"] else "")
                     + (f'<ul class="plain">{heads}</ul>' if heads else "")
                     + f'<p class="note">{_e(t["news_source"])}</p></div>')
    # 조사 칸은 나란히 (칸 수만큼 열) — 세로로 쌓으면 A4 두 쪽을 넘는다
    return (f'<section class="sec long"><h2>{_e(t["title"])}</h2><div class="rsg" style="--cols:{len(parts)}">'
            f'{"".join(parts)}</div></section>')


def _easy_terms(plan: bool, chart: bool, research: dict, close_at: datetime | None, chart_close_at: datetime | None) -> list[str]:
    """이 쪽에 실제로 나온 용어 (나오는 차례): 손절·목표 가격·보유 기간(계획·세 가지 경우),
    장마감 기준(그 글자가 쪽에 있을 때 — 시세 칸의 기준 시각, 차트 범례의 장마감 기준 시각),
    종가(그 글자가 쪽에 있을 때 — 시세 칸의 "종가" 가격, 차트 범례의 "… 종가 기준"),
    RSI·변동성(시세 지표 값이 있을 때), PER·PBR·ROE(값이 있을 때)·공시(재무·공시 칸)."""
    terms = ["손절", "목표 가격", "보유 기간"] if plan else []
    m, f = research["market"], research["fundamental"]
    market_basis = bool(m and close_at)   # 시세 칸에 "… 장마감 기준"이 보인다
    if market_basis or chart_close_at is not None:
        terms.append("장마감 기준")
    if (chart and chart_close_at is None) or (market_basis and m["price"] is not None and m["price"] > 0):
        terms.append("종가")
    if m:
        terms += [term for term, key in (("RSI", "rsi"), ("변동성", "volatilityPct")) if m[key] is not None]
    if f:
        terms += [term for term in ("PER", "PBR", "ROE") if f[term.lower()] is not None] + ["공시"]
    return terms


def _easy_glossary(terms: list[str]) -> str:
    """용어 풀이 (종이에서는 눌러 볼 수 없어 쪽 끝에 — 화면 용어 사전 문장 그대로). 용어가 없으면 빈 문자열."""
    if not terms:
        return ""
    items = "".join(f"<div><dt>{_e(term)}</dt><dd>{_e(ez.GLOSSARY[term])}</dd></div>" for term in terms)
    return f'<section class="sec long"><h2>{_e(ez.GLOSSARY_TITLE)}</h2><dl class="terms">{items}</dl></section>'


def _easy_footer(trace: list[TraceEvent], now: datetime) -> str:
    """쉬운 꼬리말 "어떻게 만들었나요": 만든 방법 한 줄, 자동 복구 문장(있을 때), 만든 날, 통일 면책 문장 (모델·비용·오류 코드 없음)."""
    t = ez.FOOTER_TEXT
    made = now.astimezone(KST).strftime("%Y-%m-%d %H:%M")
    return (f'<div class="foot"><h2>{_e(t["title"])}</h2><p>{_e(t["how"])}</p>'
            + "".join(f"<p>{_e(x)}</p>" for x in ez.recovery_sentences(trace))
            + f'<p>{_e(t["made"].format(at=made, service=SERVICE_NAME))}</p><p class="small">{DISCLAIMER}</p></div>')


def build_easy_report_html(report: Report, trace: list[TraceEvent], now: datetime | None = None) -> str:
    """주린이모드 쉬운 판 (웹 쉬운 보기와 같은 문장 — easy_text.py). 길어도 A4 두 쪽.

    차례: 쪽 머리 → 종목·날짜 → (위험 점검 메모) → 결론·신뢰 패널 → 쉬운 요약 + 면책 → 매매 계획 → 근거와 위험 →
    세 가지 경우(긍정적이고 가격이 맞을 때) → 가격 흐름 → 조사 자료 요약 → 용어 풀이 → 꼬리말 + 면책.
    리포트 자료만 쓴다 (계좌·추천 API 값 없음 — 파일이 리포트당 하나라 누가 받아도 같아야 한다). 가격은 제안값을 호가 단위로 내린 값.
    검토 점수·신뢰도·확률·모델 이름·제공자·비용·오류 코드·"Agent"라는 낱말·신청자는 싣지 않는다.
    """
    now = now or timezone.now()
    trace = sorted(trace, key=lambda e: e.step)
    results = _dict(report.results)
    draft = ez.draft_of(results)
    currency = market.CURRENCY.get(report.market, "KRW")
    opinion = draft["verdict"] if draft else None
    one_liner = draft["oneLiner"][:ONE_LINER_MAX] if draft and draft["oneLiner"] else None
    prices = ez.tick_prices(draft["targets"], currency) if draft else {}
    plan = opinion == "buy" and ez.valid_targets(prices)
    when = (report.finished_at or report.created_at).astimezone(KST)
    head = (f"<h1>{_e(report.name)}</h1><p class=\"meta\">{_e(report.symbol)} · "
            f"{_e(ez.MARKET_NAME.get(report.market, report.market))} · "
            f"{_e(ez.HEAD_DATE.format(year=when.year, month=when.month, day=when.day))}</p>")
    candles = _load_candles(report.symbol)
    research = ez.research_of(results)
    m = research["market"]
    price_at = _easy_close_at(m["asOf"], report.market) if m else None  # 시세 칸의 기준 시각
    # 장마감 기준 시각 — 장 중에 만든 리포트(basis live)는 없다 (차트 범례는 마지막 봉의 "… 종가 기준")
    close_at = price_at if m and m["basis"] != "live" else None
    chart_close_at = _chart_close_at(candles, close_at)
    scenario = ez.scenario_of(prices) if plan else None
    body = "".join((
        head, _easy_risk(_dict(results.get("risk_agent"))), _easy_conclusion(opinion, one_liner, results, trace),
        _easy_summary(draft), _easy_plan(opinion, prices, currency),
        _easy_reasons({**draft, "targets": prices}, opinion, currency) if draft else "",
        _easy_scenario(scenario) if scenario else "",
        _easy_chart(candles, prices if plan else {}, report.market, currency, chart_close_at),
        _easy_research(research, report.market, currency, price_at),
        _easy_glossary(_easy_terms(plan, len(candles) >= 2, research, close_at, chart_close_at)),
        _easy_footer(trace, now)))
    return _page(f"{report.name} AI 리포트", f'<main class="ez">{body}</main>', EASY_CSS)


# --- 선별 요약 표지 ---

def _bars_svg(rows: list[tuple[str, float, str]], color: str) -> str:
    """(이름, 값, 오른쪽 글자) 가로 막대. 값이 가장 큰 막대가 전체 폭."""
    if not rows:
        return f'<p class="empty">{NO_DATA}</p>'
    biggest = max(v for _, v, _ in rows) or 1.0
    row_h, label_w, val_w, width = 20, 150, 90, 720
    plot_w = width - label_w - val_w
    parts = [f'<svg class="chart" viewBox="0 0 {width} {row_h * len(rows) + 4}" xmlns="http://www.w3.org/2000/svg">']
    for i, (name, value, text) in enumerate(rows):
        y = i * row_h + 2
        w = max(1.0, plot_w * max(value, 0.0) / biggest)
        parts.append(f'<text x="{label_w - 6}" y="{y + 13}" font-size="10.5" text-anchor="end" fill="#222">{_e(name)}</text>'
                     f'<rect x="{label_w}" y="{y + 2}" width="{w:.1f}" height="{row_h - 6}" rx="2" fill="{color}"/>'
                     f'<text x="{label_w + w + 5:.1f}" y="{y + 13}" font-size="10" fill="#444">{_e(text)}</text>')
    return "".join(parts) + "</svg>"


def _reason_summary(items) -> str:
    counts = Counter(str(_dict(x).get("reason") or "사유 없음") for x in items if isinstance(x, dict))
    if not counts:
        return f'<p class="empty">{NO_DATA}</p>'
    return "<ul>" + "".join(f"<li>{_e(r)} — {n}종목</li>" for r, n in counts.most_common(MAX_DROP_REASONS)) + "</ul>"


# 선별 표지 꼬리말의 선정 방식 (ScreeningResult.selectedBy). 아직 선정 중(null)이거나 없으면 규칙 문장
SELECTED_BY_AI = "AI 선정 팀이 순위를 매기고 안전장치(규칙 코드)가 거른 결과입니다"
SELECTED_BY_RULE = "선별은 AI가 아니라 규칙 점수(결정론적 코드)로 한 것입니다"
NO_CANDIDATES = "규칙 선별을 통과한 종목이 없었어요"   # fallbackReason "no_candidates"


def _selection_note(s: dict) -> str:
    """꼬리말 첫 문장들. ai면 AI 선정 + 안전장치, rule이면 규칙 문장 + Fallback 사유(fallbackReason의 쉬운 문장)."""
    by = s.get("selectedBy")
    if by == "ai":
        return f"{SELECTED_BY_AI}."
    if by != "rule":
        return f"{SELECTED_BY_RULE}."
    reason = s.get("fallbackReason")
    if reason == "no_candidates":
        return f"{SELECTED_BY_RULE}. {NO_CANDIDATES}."
    sentence = selection_fallback_sentence(reason)  # 선정에 맞춘 문장 (모르는 코드는 사유 없이)
    if sentence:
        return f"{SELECTED_BY_RULE}. AI 선정 팀을 쓰지 못한 이유: {sentence}."
    return f"{SELECTED_BY_RULE}."


def build_screening_html(screening: dict, reports: list[Report]) -> str:
    """선별 요약 표지 (`ScreeningResult` 형식). 선별 종목 점수, 거래대금 순위, 탈락·제외 사유, 그날 만든 리포트."""
    s = _dict(screening)
    picks = [p for p in s.get("picks") or [] if isinstance(p, dict)]
    dropped, excluded = s.get("dropped") or [], s.get("excluded") or []
    mkt = s.get("market") or ""
    title = f"선별 요약 · {mkt}" if mkt else "선별 요약"
    if not s:
        return _page(title, f"<h1>{_e(title)}</h1><p class=\"empty\">선별 자료 없음</p>")
    at = str(s.get("at") or "")[:16].replace("T", " ")
    stats = " · ".join(f"{k} {_e(s.get(key) if s.get(key) is not None else NO_VALUE)}" for k, key in (
        ("거래대금 상위", "rankCount"), ("대상", "eligibleCount"), ("점검", "checked")))
    stats += f" · 선별 {len(picks)} · 탈락 {len(dropped)} · 제외 {len(excluded)}"

    scored = sorted(picks, key=lambda p: _num(p.get("score")) or 0, reverse=True)
    score_rows = [(str(p.get("name") or p.get("symbol") or NO_VALUE), _num(p.get("score")) or 0.0,
                   f"{_num(p.get('score')):.1f}점" if _num(p.get("score")) is not None else NO_VALUE) for p in scored]
    ranked = sorted((p for p in picks if _num(p.get("trading_amount")) is not None),
                    key=lambda p: _num(p.get("tradingAmountRank")) or 10 ** 9)
    amount_rows = []
    for p in ranked:
        rank = _num(p.get("tradingAmountRank"))
        amount = _num(p.get("trading_amount")) or 0.0
        unit = amount / 1e8 if mkt != "US" else amount / 1e6
        amount_rows.append((str(p.get("name") or p.get("symbol") or NO_VALUE), amount,
                            f"{f'{rank:.0f}위 · ' if rank is not None else ''}{unit:,.0f}{'억' if mkt != 'US' else 'M'}"))

    rows = []
    for r in reports:
        found = conclusion(r)  # 목록 카드와 같은 규칙: 완성된 리포트만 AI 의견·한 줄 요약 (B3)
        rows.append(f"<tr><td>{_e(r.name)} ({_e(r.symbol)})</td><td>{_e(STATUS_LABEL.get(r.status, r.status))}</td>"
                    f"<td>{_e(VERDICT_LABEL.get(found['opinion'], NO_VALUE))}</td>"
                    f"<td>{_e(found['oneLiner'] or NO_VALUE)}</td></tr>")
    reports_html = ("<table><tr><th>종목</th><th>상태</th><th>AI 의견</th><th>한 줄 요약</th></tr>" + "".join(rows)
                    + "</table>" if rows else f'<p class="empty">{NO_DATA}</p>')

    body = (f"<h1>{_e(title)}</h1><p class=\"meta\">{_e(at)} · {stats}</p>"
            f"<h2>선별 종목 점수</h2>{_bars_svg(score_rows, '#3b6fd4')}"
            f"<h2>거래대금 순위</h2>{_bars_svg(amount_rows, '#2f9e6b')}"
            f'<div class="cols"><div><h2>탈락 사유</h2>{_reason_summary(dropped)}</div>'
            f"<div><h2>제외 사유</h2>{_reason_summary(excluded)}</div></div>"
            f"<h2>이날의 리포트</h2>{reports_html}"
            f'<p class="foot small">{SERVICE_NAME} · {_e(_selection_note(s))} {DISCLAIMER}</p>')
    return _page(title, body)


# --- 파일 만들기 (API가 쓴다) ---

def report_dir() -> Path:
    """만든 파일을 두는 곳: PAPER_ROOT/reports.

    Report.pdf_path는 자동 리포트가 Discord로 보낸 파일(쉬운 판)이다 (auto._send_report). PDF API는 그 열을 쓰지 않고
    ?view=에 맞는 판의 파일을 여기서 찾거나 만든다 (pdf_path를 주면 ?view=expert에도 쉬운 판이 나간다).
    """
    return engine.ROOT / "reports"


def _file_stem(report_id: int, version: int, easy: bool = False) -> str:
    """양식 판별 파일 이름 (확장자 없이). 1판은 판 번호가 없던 예전 이름 `<id>`. 쉬운 판은 끝에 `.easy` (`<id>.v4.easy`)."""
    stem = f"{report_id}" if version <= 1 else f"{report_id}.v{version}"
    return f"{stem}.easy" if easy else stem


def ensure_report_file(report: Report, trace: list[TraceEvent], *, easy: bool = False) -> Path:
    """`PAPER_ROOT/reports/<id>.v<판>.pdf`(Chrome이 없으면 `.html`)가 있으면 그것을, 없으면 만들어 그 경로를 돌려준다.

    easy면 쉬운 판 `<id>.v<판>.easy.pdf` (자세한 판과 따로 만들고 따로 다시 쓴다).
    지금 판(TEMPLATE_VERSION) 파일만 다시 쓴다 — 양식이 바뀌기 전에 만든 파일은 새로 만들고, 만든 뒤 두 판의 예전 판 파일을 지운다.
    임시 이름으로 만든 뒤 이름을 바꿔 넣는다: 같은 리포트를 동시에 두 번 만들어도 반쯤 쓰인 파일이 노출되지 않는다.
    """
    folder = report_dir()
    stem = _file_stem(report.id, TEMPLATE_VERSION, easy)
    for suffix in (".pdf", ".html"):
        done = folder / f"{stem}{suffix}"
        if done.exists() and done.stat().st_size > 0:
            return done
    html = build_report_html(report, trace, easy=easy)
    temp = folder / f"{stem}.{uuid.uuid4().hex}.pdf"   # render_pdf는 같은 이름의 .html도 쓴다
    made = render_pdf(html, temp, engine.engine_config().chrome_bin)
    final = folder / f"{stem}{made.suffix}"
    try:
        os.replace(made, final)
    finally:
        for left in (temp, temp.with_suffix(".html")):  # PDF가 되면 .html은 render_pdf가 지웠다. 실패한 찌꺼기만 남지 않게
            left.unlink(missing_ok=True)
    for version in range(1, TEMPLATE_VERSION):  # 두 판의 예전 판 파일 (다른 요청이 만드는 중인 임시 파일은 건드리지 않는다)
        for variant in (False, True):
            for suffix in (".pdf", ".html"):
                (folder / f"{_file_stem(report.id, version, variant)}{suffix}").unlink(missing_ok=True)
    return final
