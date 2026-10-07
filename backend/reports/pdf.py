"""AI 리포트 A4 PDF (docs/tasks/05-프론트.md T5-11~T5-14, TEAM_DEV_PLAN.md 6-3, docs/DECISIONS.md 14-7 "PDF").

`build_report_html`이 종목 리포트 한 쪽(길어도 두 쪽)을, `build_screening_html`이 선별 요약 표지를 HTML 문자열로 만든다.
가격 차트·점수 막대는 SVG·CSS를 문자열로 직접 만든다 (외부 라이브러리 없음). PDF 변환은 엔진의 `render_pdf`(Chrome headless).
Agent가 아직 결과를 다 못 채웠어도(`Report.results`가 비어 있어도) 있는 만큼만 그리고 없는 칸은 "자료 없음"으로 둔다.

서비스 이름은 "모매매"(2026-10-07 바뀜 — docs/DECISIONS.md 18장, 로고 모양은 15-7). 쪽 머리에 로고(8~10mm)와 이름,
오른쪽에 작은 글씨 "AI 리포트 · 모의투자 연습용"을 두고 가는 선을 긋는다 (면책 문장·날짜는 본문·꼬리말에 있어 머리에 다시 넣지 않는다).
맨 위에 쉬운 요약 상자(`results.report_agent.plainSummary`, B1)와 통일 면책 문장을 두고, 꼬리말도 같은 면책 문장이다.
가격은 장마감 기준이다: 차트는 완성 일봉(`trading.market.completed_candles` — 장중 미완성 봉 없음)으로 그리고
범례에 "YYYY-MM-DD 종가 기준"을, 시세 지표 아래에 `market_agent`의 종가·`asOf`("… 장마감 기준")를 적는다.

만든 파일은 `PAPER_ROOT/reports/<id>.v<TEMPLATE_VERSION>.pdf`(Chrome이 없으면 `.html`)로 두고 다시 쓴다. 양식을 바꾸면
TEMPLATE_VERSION을 올린다 — 이름이 달라져 예전 양식 파일(판 번호 없는 `<id>.pdf` = 1판 포함)을 쓰지 않고 새로 만들며, 그때 예전 파일을 지운다.

리포트 신청자의 로그인 아이디는 넣지 않는다 (아이디는 로그인 정보다). 비밀 값도 넣지 않는다.
"""
import logging
import math
import os
import uuid
from collections import Counter
from datetime import datetime
from html import escape
from pathlib import Path

from django.utils import timezone
from paper_engine.report import render_pdf
from trading import market

from config import engine

from .models import Report, TraceEvent
from .payloads import KST, conclusion

log = logging.getLogger(__name__)

SERVICE_NAME = "모매매"  # 화면 frontend/src/lib/plainText.ts SERVICE_NAME과 같다
BRAND_NOTE = "AI 리포트 · 모의투자 연습용"  # 쪽 머리 오른쪽 작은 글씨
DISCLAIMER = "이 리포트는 AI가 만든 참고 자료이며 투자 권유가 아닙니다. 모든 매매는 모의 계좌에서만 이뤄집니다."  # 통일 면책 문장
# 양식 판. 양식을 바꾸면 올린다 (예전 판 파일은 다음 요청 때 새로 만든다).
# 2: 2026-10 쉬운 요약·장마감 기준. 3: 2026-10-05 서비스 이름 종이배·로고 머리. 4: 2026-10-07 서비스 이름 모매매
TEMPLATE_VERSION = 4
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

# 로고: 종이배 모양 (frontend/src/components/BrandMark.tsx와 같은 모양, 48px 이상 판 — 돛의 접힌 선 포함). brand 타일 + 흰 배.
# 늘이기·그림자·물결·화살표를 더하지 않고, 배를 노란색으로 칠하지 않는다 (docs/DECISIONS.md 15-7).
LOGO_SVG = ('<svg class="logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
            '<rect width="32" height="32" rx="8" fill="#3182F6"/>'
            '<path fill="#FFFFFF" d="M4.8 17.29A0.8 0.8 0 0 1 5.43 16L9.31 16A0.5 0.5 0 0 0 9.74 15.75L14.71 7.3A1.5 1.5 0 0 1 '
            '17.29 7.3L22.26 15.75A0.5 0.5 0 0 0 22.69 16L26.57 16A0.8 0.8 0 0 1 27.2 17.29L22.45 23.42A1.5 1.5 0 0 1 21.26 24'
            'L10.74 24A1.5 1.5 0 0 1 9.55 23.42Z"/>'
            '<path fill="#3182F6" d="M16.11 7.79A0.04 0.04 0 0 1 16.19 7.77L19.53 15.47A0.45 0.45 0 0 1 19.11 16.1L17.98 16.1'
            'A0.45 0.45 0 0 1 17.53 15.73Z"/></svg>')

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


def _page(title: str, body: str) -> str:
    return (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{_e(title)} · {SERVICE_NAME}</title>'
            f"<style>{CSS}</style></head><body>{_brand_head()}{body}</body></html>")


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


def _chart_svg(candles: list[dict], targets: dict, mkt: str) -> str:
    """최근 일봉 캔들 + 20일 이동평균 + 제안 진입·목표·손절 가로선. 일봉이 2개 미만이면 안내 문구."""
    if len(candles) < 2:
        return '<p class="empty">시세 자료 없음</p>'
    ma_all = _moving_average([c["close"] for c in candles], MA_WINDOW)
    shown, ma = candles[-CHART_DAYS:], ma_all[-CHART_DAYS:]
    lines = [("진입", _num(targets.get("entry")), "#555"), ("목표", _num(targets.get("target")), RISE),
             ("손절", _num(targets.get("stop")), FALL)]
    lines = [x for x in lines if x[1] is not None and x[1] > 0]
    values = [c["high"] for c in shown] + [c["low"] for c in shown] + [v for _, v, _ in lines] + \
        [m for m in ma if m is not None]
    lo, hi = min(values), max(values)
    pad = (hi - lo) * 0.06 or hi * 0.02 or 1.0
    lo, hi = lo - pad, hi + pad
    width, height, left, right, top, bottom = 720, 250, 58, 66, 8, 20
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
        from .stats import report_recovery  # 담당 4가 만든다. 아직 없으면 같은 셈법으로 직접 센다
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
    asOf가 없으면(장마감 기준 이전의 결과) 기준 시각을 알 수 없다고 적고 가격을 보이지 않는다."""
    as_of = _as_of(mkt_res.get("asOf"), mkt) if mkt_res.get("asOf") else None
    if as_of is None:
        return f'<p class="legend">시세 지표 기준 시각: {NO_DATA}</p>'
    close = _num(mkt_res.get("price"))
    price = f"종가 {_price(close, mkt)}{'원' if mkt == 'KR' else '달러'} · " if close is not None and close > 0 else ""
    return f'<p class="legend">시세 지표: {_e(price)}{_e(as_of)}</p>'


def build_report_html(report: Report, trace: list[TraceEvent], now: datetime | None = None) -> str:
    """종목 리포트 한 쪽. report.results의 Worker 결과와 Trace로 만든다. 없는 칸은 "자료 없음"."""
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
            f'<p class="foot small">{SERVICE_NAME} · 선별은 AI가 아니라 규칙 점수(결정론적 코드)로 한 것입니다. {DISCLAIMER}</p>')
    return _page(title, body)


# --- 파일 만들기 (API가 쓴다) ---

def report_dir() -> Path:
    """만든 파일을 두는 곳: PAPER_ROOT/reports. (나중에 Report.pdf_path 열이 생기면 그 열을 쓴다)"""
    return engine.ROOT / "reports"


def _file_stem(report_id: int, version: int) -> str:
    """양식 판별 파일 이름 (확장자 없이). 1판은 판 번호가 없던 예전 이름 `<id>`."""
    return f"{report_id}" if version <= 1 else f"{report_id}.v{version}"


def ensure_report_file(report: Report, trace: list[TraceEvent]) -> Path:
    """`PAPER_ROOT/reports/<id>.v<판>.pdf`(Chrome이 없으면 `.html`)가 있으면 그것을, 없으면 만들어 그 경로를 돌려준다.

    지금 판(TEMPLATE_VERSION) 파일만 다시 쓴다 — 양식이 바뀌기 전에 만든 파일은 새로 만들고, 만든 뒤 예전 판 파일을 지운다.
    임시 이름으로 만든 뒤 이름을 바꿔 넣는다: 같은 리포트를 동시에 두 번 만들어도 반쯤 쓰인 파일이 노출되지 않는다.
    """
    folder = report_dir()
    stem = _file_stem(report.id, TEMPLATE_VERSION)
    for suffix in (".pdf", ".html"):
        done = folder / f"{stem}{suffix}"
        if done.exists() and done.stat().st_size > 0:
            return done
    html = build_report_html(report, trace)
    temp = folder / f"{stem}.{uuid.uuid4().hex}.pdf"   # render_pdf는 같은 이름의 .html도 쓴다
    made = render_pdf(html, temp, engine.engine_config().chrome_bin)
    final = folder / f"{stem}{made.suffix}"
    try:
        os.replace(made, final)
    finally:
        for left in (temp, temp.with_suffix(".html")):  # PDF가 되면 .html은 render_pdf가 지웠다. 실패한 찌꺼기만 남지 않게
            left.unlink(missing_ok=True)
    for version in range(1, TEMPLATE_VERSION):  # 예전 판 파일 (다른 요청이 만드는 중인 임시 파일은 건드리지 않는다)
        for suffix in (".pdf", ".html"):
            (folder / f"{_file_stem(report.id, version)}{suffix}").unlink(missing_ok=True)
    return final
