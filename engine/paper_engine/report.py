"""분석 리포트 (PDF). 팀 채널에는 매수 추천만 보내고, 나머지 평가 자료는 여기에 담아 첨부한다.

실행 기록(runs/*.json에 쓰는 것과 같은 dict)으로 HTML을 만들고, Chrome(headless)으로 PDF로 바꾼다.
런타임을 표준 라이브러리만으로 유지하려고 PDF 라이브러리를 쓰지 않는다. Chrome이 없거나 실패하면
HTML 파일을 그대로 돌려준다.
"""
import shutil
import subprocess
from datetime import datetime
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

from .notify import horizon_label

CHROME_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
PDF_TIMEOUT_SEC = 60
DIRECTION_LABEL = {"POSITIVE": "호재", "NEGATIVE": "악재", "NEUTRAL": "중립"}
MARKET_LABEL = {"KR": "국내", "US": "미국"}
REPORT_DIRECTION_LABEL = {"UP": "상향", "DOWN": "하향", "KEEP": "유지"}
KST = ZoneInfo("Asia/Seoul")
# 뉴스 제목의 출처 표기 (docs/DECISIONS.md 14-7 U12): 제목은 Google 뉴스 RSS 검색 결과이고 저작권은 각 언론사에 있다
NEWS_PROVIDER = "Google 뉴스 검색 결과"
NEWS_CAPTION = f"뉴스 제목: {NEWS_PROVIDER}(각 언론사). 제목만 모은 것이며 본문·사실 여부는 확인하지 않았습니다."
MAX_NEWS = 8

CSS = """
@page { size: A4; margin: 14mm 12mm; }
body { font-family: "Noto Sans CJK KR", "Noto Sans KR", "NanumGothic", sans-serif; font-size: 9.5pt;
       line-height: 1.45; color: #1a1a1a; }
h1 { font-size: 16pt; margin: 0 0 2mm; }
h2 { font-size: 13pt; margin: 7mm 0 2mm; padding-bottom: 1mm; border-bottom: 2px solid #333;
     break-after: avoid; }
h3 { font-size: 10.5pt; margin: 4mm 0 1mm; break-after: avoid; }
p { margin: 1mm 0; }
.meta { color: #555; }
table { border-collapse: collapse; width: 100%; margin: 1.5mm 0 3mm; }
th, td { border: 1px solid #bbb; padding: 1mm 1.8mm; text-align: left; vertical-align: top; }
th { background: #eee; font-weight: 600; white-space: nowrap; }
td.n { text-align: right; white-space: nowrap; }
tr { break-inside: avoid; }
.card { border: 1px solid #999; border-radius: 1.5mm; padding: 2mm 3mm; margin: 2.5mm 0; }
.card.pick { border: 2px solid #1a7f37; }
.tag { display: inline-block; padding: 0 1.5mm; border-radius: 1mm; color: #fff; font-size: 8.5pt; }
.tag.pick { background: #1a7f37; } .tag.drop { background: #b42318; } .tag.hold { background: #9a6700; }
.warn { color: #b42318; }
ul { margin: 0.5mm 0 1mm; padding-left: 5mm; }
.small { font-size: 8.5pt; color: #444; }
"""


def _money(value, currency: str) -> str:
    if value is None:
        return "-"
    return f"{value:,.0f}원" if currency == "KRW" else f"${value:,.2f}"


def _pct(value, signed: bool = False) -> str:
    if value is None:
        return "-"
    return f"{value:+.1%}" if signed else f"{value:.1%}"


def _num(value, digits: int = 0) -> str:
    return "-" if value is None else f"{value:,.{digits}f}"


def _e(value) -> str:
    return escape("" if value is None else str(value))


def _list(items) -> str:
    items = [i for i in (items or []) if i]
    return "<ul>" + "".join(f"<li>{_e(i)}</li>" for i in items) + "</ul>" if items else ""


def news_time(published_at) -> str | None:
    """뉴스 게시 시각 ISO → 한국 시간 "YYYY-MM-DD HH:MM". 읽지 못하면 None."""
    if not isinstance(published_at, str) or not published_at:
        return None
    try:
        at = datetime.fromisoformat(published_at)
    except ValueError:
        return None
    return f"{(at.astimezone(KST) if at.tzinfo else at):%Y-%m-%d %H:%M}"


def news_items(snapshot: dict, limit: int = MAX_NEWS) -> list[dict]:
    """스냅샷 뉴스 → [{"title", "source", "publishedAt"}] (제목이 있는 것만, 스냅샷 순서 = 최신순). 링크는 넣지 않는다."""
    out = []
    for n in snapshot.get("news") or []:
        if isinstance(n, dict) and n.get("title"):
            out.append({"title": str(n["title"]), "source": str(n["source"]) if n.get("source") else None,
                        "publishedAt": str(n["publishedAt"]) if n.get("publishedAt") else None})
    return out[:limit]


def news_line(item: dict) -> str:
    """뉴스 한 줄 (사람이 읽는 글): "제목 (매체 · 2026-09-28 14:05)". 매체·시각이 없으면 그 칸을 뺀다."""
    meta = " · ".join(x for x in (item.get("source"), news_time(item.get("publishedAt"))) if x)
    return f"{item['title']} ({meta})" if meta else item["title"]


def _status(c: dict) -> tuple[str, str]:
    """(표시 이름, css 종류)"""
    if c.get("selected"):
        return "매수 추천", "pick"
    if c.get("passed"):
        return "최종 컨펌 거부", "hold"
    return "탈락", "drop"


def _reject_reasons(c: dict) -> list[str]:
    if "rejectReasons" in c:
        return c["rejectReasons"]
    return c.get("fact_errors") or []  # 예전 기록에는 판정 사유가 따로 없다


def _candidate(c: dict, currency: str) -> str:
    label, kind = _status(c)
    s = c.get("final") or c.get("scenario")
    head = f'<span class="tag {kind}">{label}</span> <b>{_e(c.get("id"))}</b> · 제안 {_e(c.get("proposer"))}'
    if not s:
        return (f'<div class="card">{head} · 사실·조건 검증 실패'
                f'{_list(c.get("fact_errors"))}</div>')
    entry, target, stop = s["entry_price"], s["target_price"], s["stop_price"]
    a = c.get("assessment") or {}
    rows = [
        ("기간", f'{horizon_label(s.get("horizon"))} · 보유 {s.get("holding_days")}거래일'),
        ("가격", f"진입 {_money(entry, currency)} / 목표 {_money(target, currency)} "
                 f"({_pct(target / entry - 1, True)}) / 손절 {_money(stop, currency)} "
                 f"({_pct(stop / entry - 1, True)})"),
        ("수량", (f'소수점 방식 · 약 {_num(a.get("quantity"), 4)}주' if a.get("fractional")
                  else f'{_num(a.get("quantity"))}주')
                 + f' · 매수 금액 {_money(a.get("amount"), currency)} (제약: {_e(a.get("limited_by"))})'),
        ("손익", f'예상 수익 {_money(a.get("expected_profit"), currency)} · 최대 손실 '
                 f'{_money(a.get("max_loss"), currency)} · 기대값 {_money(a.get("expected_value"), currency)} '
                 f'({_pct(a.get("expected_return"), True)}) · 손익비 {_num(a.get("reward_risk"), 2)}'),
        ("교차검증", f'{_num(c.get("score"))}점 · 확률 가중 평균 {_pct(c.get("consensus_probability"))} · '
                     f'참여 의결권 {_pct(c.get("participation"))}'),
    ]
    html = [f'<div class="card {kind if kind == "pick" else ""}">{head}<table>']
    html += [f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in rows]
    html.append("</table>")
    reach = c.get("reach")
    if reach:
        html.append(f'<p class="{"warn" if reach.get("hard") else ""}">{_e(reach.get("note"))}</p>')
    reasons = _reject_reasons(c)
    if reasons and not c.get("selected"):
        html.append(f'<p class="warn"><b>탈락 사유</b>: {_e("; ".join(reasons))}</p>')
    if s.get("rationale"):
        html.append("<p><b>제안 근거</b></p>" + _list(s["rationale"]))
    if s.get("invalidation"):
        html.append(f"<p><b>무효화 조건</b>: {_e(s['invalidation'])}</p>")
    scores = [("제안자 " + str(c.get("proposer")), c.get("proposer_score"),
               (c.get("scenario") or {}).get("probability"), "자기 평가", [])]
    scores += [(q.get("analyst"), q.get("score"), q.get("probability"), q.get("comment"),
                q.get("weaknesses")) for q in c.get("critiques") or []]
    html.append("<table><tr><th>모델</th><th>점수</th><th>확률</th><th>평가와 약점</th></tr>")
    for who, score, prob, comment, weak in scores:
        html.append(f'<tr><td>{_e(who)}</td><td class="n">{_num(score)}</td>'
                    f'<td class="n">{_pct(prob)}</td><td>{_e(comment)}{_list(weak)}</td></tr>')
    html.append("</table>")
    ap = c.get("approval")
    if ap:
        html.append(f'<p><b>최종 컨펌</b> ({_e(ap.get("approver"))}): '
                    f'{"승인" if ap.get("approved") else "거부"} · {_e(ap.get("reason"))}</p>'
                    + _list(f"남은 위험: {x}" for x in ap.get("concerns") or []))
    html.append("</div>")
    return "".join(html)


def _research(snapshot: dict, log: dict | None) -> str:
    research = snapshot.get("webResearch") or {}
    if not research.get("researchers"):
        return ""
    html = ['<h3>웹 조사 <span class="small">(검증되지 않은 외부 정보)</span></h3>']
    for r in research["researchers"]:
        state = ((log or {}).get("researchers") or {}).get(r.get("id"), "")
        html.append(f'<p class="small"><b>{_e(r.get("id"))}</b> {_e(state)} · {len(r.get("findings") or [])}건</p>')
        rows = []
        for f in r.get("findings") or []:
            source = f.get("sourceTitle") or f.get("sourceUrl") or "출처 없음"
            if f.get("sourceVerified") is False:
                source += " (출처 확인 안 됨)"
            rows.append(f'<tr><td>{DIRECTION_LABEL.get(f.get("direction"), "")}</td>'
                        f'<td class="n">{_e(f.get("date") or "-")}</td><td>{_e(f.get("claim"))}'
                        f'<br><span class="small">{_e(source)}</span></td></tr>')
        for ev in r.get("upcomingEvents") or []:
            rows.append(f'<tr><td>예정</td><td class="n">{_e(ev.get("date"))}</td>'
                        f'<td>{_e(ev.get("event"))}</td></tr>')
        if rows:
            html.append("<table><tr><th>구분</th><th>날짜</th><th>내용</th></tr>" + "".join(rows) + "</table>")
    return "".join(html)


def _snapshot(snapshot: dict) -> str:
    ind = snapshot.get("indicators") or {}
    currency = snapshot.get("currency", "KRW")
    cells = [("현재가", _money(snapshot.get("lastPrice"), currency)),
             ("20일선", _num(ind.get("sma20"), 2)), ("60일선", _num(ind.get("sma60"), 2)),
             ("120일선", _num(ind.get("sma120"), 2)), ("RSI14", _num(ind.get("rsi14"), 1)),
             ("ATR14", _num(ind.get("atr14"), 2)), ("변동성(연)", _pct(ind.get("volatility20"))),
             ("5일", _pct(ind.get("change5d"), True)), ("20일", _pct(ind.get("change20d"), True)),
             ("60일", _pct(ind.get("change60d"), True))]
    html = ("<table><tr>" + "".join(f"<th>{k}</th>" for k, _ in cells) + "</tr><tr>"
            + "".join(f'<td class="n">{v}</td>' for _, v in cells) + "</tr></table>")
    news = [news_line(n) for n in news_items(snapshot)]
    if news:
        html += f'<h3>뉴스 제목</h3>{_list(news)}<p class="small">{_e(NEWS_CAPTION)}</p>'
    if "brokerReports" in snapshot:
        html += _broker_reports(snapshot["brokerReports"], currency)
    return html


def _broker_reports(items: list | None, currency: str) -> str:
    """스냅샷의 brokerReports (뉴스 헤드라인에서 뽑은 목표가·방향)."""
    rows = [[_td(_e((r.get("publishedAt") or "")[:10]), True), _td(_e(r.get("broker") or "-")),
             _td(_money(r.get("targetPrice"), currency), True),
             _td(REPORT_DIRECTION_LABEL.get(r.get("direction"), "-")), _td(_e(r.get("title")))]
            for r in items or []]
    return ('<h3>증권사 리포트 <span class="small">(뉴스 헤드라인 기반, 본문 없음)</span></h3>'
            + _table(["날짜", "증권사", "목표가", "방향", "제목"], rows))


def _result(entry: dict) -> str:
    snap = entry.get("snapshot") or {}
    currency = snap.get("currency", "KRW")
    candidates = entry.get("candidates") or []
    picks = sum(1 for c in candidates if c.get("selected"))
    html = [f'<h2>{_e(snap.get("name"))} ({_e(snap.get("symbol"))}) '
            f'<span class="small">시나리오 {len(candidates)}개 · 추천 {picks}개 · '
            f'AI 비용 ${entry.get("costUsd", 0):.3f}</span></h2>', _snapshot(snap)]
    if entry.get("modelResponseError"):
        html.append(f'<p class="warn"><b>모델 응답 에러</b>: {_e(entry["modelResponseError"])}. '
                    "이 종목의 분석을 중단함</p>")
    elif not candidates:
        html.append("<p>제안된 시나리오 없음 (AI가 매수 근거를 찾지 못함)</p>")
    html += [_candidate(c, currency) for c in candidates]
    html.append(_research(snap, entry.get("research")))
    if entry.get("errors"):
        html.append("<h3>오류</h3>" + _list(entry["errors"]))
    if entry.get("stages"):
        html.append('<p class="small">단계별: ' + " · ".join(
            f'{_e(x["stage"])} {x["calls"]}회 {x["seconds"]:.0f}초 ${x["costUsd"]:.3f}'
            for x in entry["stages"]) + "</p>")
    return "".join(html)


def _screen(screen: dict) -> str:
    currency = "KRW" if screen.get("market") == "KR" else "USD"
    picks, dropped, excluded = (screen.get(k) or [] for k in ("picks", "dropped", "excluded"))
    analyzed = set(screen.get("analyzed") or [])
    html = [f'<h2>종목 선별 ({MARKET_LABEL.get(screen.get("market"), "")})</h2>',
            f'<p>거래대금 상위 {screen.get("rankCount")}개 → ETF·ETN 등 제외 {screen.get("eligibleCount")}개 → '
            f'상위 {screen.get("checked")}개 점검 → 규칙 통과 {len(picks)}개, 탈락 {len(dropped)}개</p>']
    rc = screen.get("reportCandidates")
    if rc is not None:
        html.append(_report_candidates(rc))
    html.append('<p class="small">규칙 점수는 추세·모멘텀·RSI·변동성 기준이며 매수 추천이 아니다.</p>')
    if picks:
        # 분석 제외 열: 최근 24시간 안에 이미 분석해 AI 분석 대상에서 건너뛴 pick의 사유 (있을 때만)
        skipped = any(p.get("skipped") for p in picks)
        html.append("<h3>규칙 통과</h3><table><tr><th>순위</th><th>종목</th><th>점수</th><th>종가</th>"
                    "<th>20일</th><th>RSI</th><th>ATR</th><th>거래대금</th><th>출처</th>"
                    + ("<th>분석 제외</th>" if skipped else "") + "<th>AI 분석</th></tr>")
        for i, p in enumerate(picks, 1):
            html.append(
                f'<tr><td class="n">{i}</td><td>{_e(p["name"])} ({_e(p["symbol"])})</td>'
                f'<td class="n">{p["score"]:.0f}</td><td class="n">{_money(p["close"], currency)}</td>'
                f'<td class="n">{_pct(p["change20d"], True)}</td><td class="n">{p["rsi"]:.0f}</td>'
                f'<td class="n">{_pct(p["atr_ratio"])}</td>'
                f'<td class="n">{_money(p["trading_amount"], currency)}</td><td>{_origin(p, currency)}</td>'
                + (f'<td class="small">{_e(p.get("skipped") or "")}</td>' if skipped else "")
                + f'<td>{"○" if p["symbol"] in analyzed else ""}</td></tr>')
        html.append("</table>")
    if dropped:
        html.append("<h3>규칙 탈락</h3><table><tr><th>종목</th><th>거래대금 순위</th><th>출처</th><th>사유</th></tr>"
                    + "".join(f'<tr><td>{_e(d["name"])} ({_e(d["symbol"])})</td>'
                              f'<td class="n">{_e(d.get("tradingAmountRank") or "-")}</td>'
                              f'<td>{_e(d.get("origin") or "거래대금 상위")}</td>'
                              f'<td>{_e(d["reason"])}</td></tr>' for d in dropped) + "</table>")
    if excluded:
        html.append(f'<h3>선별 대상 제외 ({len(excluded)}개)</h3><p class="small">'
                    + _e(", ".join(f'{x["name"]}({x["symbol"]}): {x["reason"]}' for x in excluded))
                    + "</p>")
    return "".join(html)


def _origin(p: dict, currency: str) -> str:
    """선별 pick의 출처. 증권사 리포트면 증권사·목표가·방향과 헤드라인을 붙인다."""
    origin = p.get("origin") or "거래대금 상위"
    if origin != "증권사 리포트":
        return _e(origin)
    parts = [p.get("broker") or "증권사 미상"]
    if p.get("targetPrice"):
        parts.append(f"목표가 {_money(p['targetPrice'], currency)}")
    if p.get("direction") in REPORT_DIRECTION_LABEL:
        parts.append(REPORT_DIRECTION_LABEL[p["direction"]])
    return f'{_e(origin)}: {_e(" ".join(parts))}<br><span class="small">{_e(p.get("title"))}</span>'


def _report_candidates(rc: dict) -> str:
    """증권사 리포트 후보 요약: 가져온 수, 중복·제외 수와 이유, 규칙 점검·통과·탈락 수."""
    if rc.get("error"):
        return f'<p class="warn">증권사 리포트 후보를 가져오지 못함: {_e(rc["error"])}</p>'
    skipped = rc.get("skipped") or []
    reasons: dict[str, int] = {}
    for x in skipped:
        reasons[x["reason"]] = reasons.get(x["reason"], 0) + 1
    why = ", ".join(f"{r} {n}개" for r, n in reasons.items())
    # 제외된 종목 이름은 콘솔 로그(format_screen)에만 남긴다
    return (f'<p>증권사 리포트 후보 {len(rc.get("fetched") or [])}개 → 중복·제외 {len(skipped)}개'
            + (f" ({_e(why)})" if why else "")
            + f' → {rc.get("checked", 0)}개 점검 → 규칙 통과 {rc.get("passed", 0)}개, 탈락 {rc.get("dropped", 0)}개</p>')


def summary(log: dict) -> dict:
    """리포트와 알림 요약에 쓰는 개수."""
    results = log.get("results") or []
    candidates = [c for r in results for c in r.get("candidates") or []]
    picks = [c for c in candidates if c.get("selected")]
    return {"symbols": len(results), "scenarios": len(candidates), "picks": len(picks),
            "rejected": len(candidates) - len(picks),
            "failed": sum(1 for r in results if r.get("modelResponseError"))}


def build_html(log: dict) -> str:
    """log는 실행 기록. log["screen"]이 있으면 종목 선별 결과도 넣는다."""
    n = summary(log)
    strategy = log.get("strategy")
    title = (f'전략 #{strategy["id"]} {strategy["name"]}' if strategy
             else "일일 분석" if log.get("tag") == "daily" else "종목 분석")
    mode = "승인 시 모의 매수" if log.get("paperBuy") else "기록만 (모의 주문 없음)"
    rows = []
    for r in log.get("results") or []:
        snap = r.get("snapshot") or {}
        cs = r.get("candidates") or []
        picks = [c for c in cs if c.get("selected")]
        if r.get("modelResponseError"):
            outcome = '<span class="tag drop">분석 중단</span>'
        elif picks:
            outcome = '<span class="tag pick">매수 추천</span>'
        elif cs:
            outcome = f"추천 없음 (시나리오 {len(cs)}개 탈락)"
        else:
            outcome = "제안 없음"
        best = max((c.get("score") or 0 for c in cs), default=None)
        rows.append(f'<tr><td>{_e(snap.get("name"))} ({_e(snap.get("symbol"))})</td>'
                    f'<td class="n">{_money(snap.get("lastPrice"), snap.get("currency", "KRW"))}</td>'
                    f'<td class="n">{len(cs)}</td><td class="n">{_num(best)}</td><td>{outcome}</td></tr>')
    html = [f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{_e(title)}</title>'
            f"<style>{CSS}</style></head><body>",
            f"<h1>{_e(title)} 리포트</h1>",
            f'<p class="meta">{_e((log.get("startedAt") or "")[:16].replace("T", " "))} · {mode} · '
            f'분석 {n["symbols"]}종목 · 시나리오 {n["scenarios"]}개 (추천 {n["picks"]}, 그 외 {n["rejected"]}) · '
            f'AI 비용 ${log.get("costUsd", 0):.3f}</p>']
    if rows:
        html.append("<table><tr><th>종목</th><th>현재가</th><th>시나리오</th><th>최고 점수</th>"
                    "<th>결과</th></tr>" + "".join(rows) + "</table>")
    html += [_result(r) for r in log.get("results") or []]
    if log.get("screen"):
        html.append(_screen(log["screen"]))
    analysts = ", ".join(f'{m["id"]}({m["size"]})' for m in log.get("analysts") or [])
    html.append(f'<p class="small">분석가: {_e(analysts)} · 조사자: {_e(", ".join(log.get("researchers") or []))} '
                f'· 승인자: {_e(log.get("approver"))}<br>AI가 낸 확률과 점수는 검증되지 않은 추정이다. '
                "수량과 한도, 통과 여부는 코드(리스크 엔진)가 정한다.</p></body></html>")
    return "".join(html)


# --- 일일 리포트 (daily.collect가 만든 dict) ---

def _signed_money(value, currency: str) -> str:
    if value is None:
        return "-"
    return ("+" if value >= 0 else "-") + _money(abs(value), currency)


def _money_by_currency(amounts: dict | None, signed: bool = False) -> str:
    """{"KRW": .., "USD": ..}. 값이 없는 통화는 뺀다."""
    fmt = _signed_money if signed else _money
    parts = [fmt(v, c) for c, v in (amounts or {}).items() if v is not None]
    return " / ".join(parts) or "-"


def _time(iso) -> str:
    return (iso or "")[:16].replace("T", " ") or "-"


def _table(headers: list[str], rows: list[list[str]], empty: str = "없음") -> str:
    """셀 값은 호출하는 쪽이 이스케이프한다 (숫자 셀은 td.n)."""
    if not rows:
        return f"<p>{_e(empty)}</p>"
    head = "".join(f"<th>{h}</th>" for h in headers)
    body = "".join("<tr>" + "".join(r) + "</tr>" for r in rows)
    return f"<table><tr>{head}</tr>{body}</table>"


def _td(value, numeric: bool = False) -> str:
    return f'<td class="n">{value}</td>' if numeric else f"<td>{value}</td>"


def _daily_account(a: dict | None) -> str:
    html = ["<h2>모의 계좌</h2>"]
    if not a:
        return html[0] + "<p>없음</p>"
    if a.get("error"):
        return html[0] + f'<p class="warn">계좌 평가 실패: {_e(a["error"])}</p>'
    prev = a.get("previous")
    change = (f'{_signed_money(a.get("dailyChangeKrw"), "KRW")} (전일 기록 {_e(prev["day"])} '
              f'{_money(prev["equity_krw"], "KRW")})' if prev else "- (전일 기록 없음)")
    rows = [(f'총자산 ({_e(a.get("name") or "")})', f'{_money(a.get("equityKrw"), "KRW")} = 현금 '
             f'{_money(a.get("cashKrw"), "KRW")} + 보유 평가 {_money(a.get("holdingsValueKrw"), "KRW")}'),
            ("초기 자금 대비", f'{_signed_money(a.get("profitKrw"), "KRW")} ({_pct(a.get("profitRate"), True)}) · '
                            f'초기 자금 {_money(a.get("initialCapitalKrw"), "KRW")}'),
            ("전일 대비", change),
            ("매수 가능 금액", f'{_money(a.get("buyingPowerKrw"), "KRW")} (현금 − 체결 대기 매수 '
                            f'{_money(a.get("pendingKrw"), "KRW")})')]
    if a.get("usdKrw"):
        rows.append(("환율", f'1달러 = {_num(a.get("usdKrw"), 2)}원'))
    html.append("<table>" + "".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in rows) + "</table>")
    if a.get("notes"):
        html.append('<p class="small">' + _e(" · ".join(a["notes"])) + "</p>")
    html.append("<h3>보유 종목</h3>")
    items = []
    for i in a.get("holdings") or []:
        c = i.get("currency") or "KRW"
        items.append([_td(f'#{i["id"]} {_e(i.get("name"))} ({_e(i.get("symbol"))})'),
                      _td(_num(i.get("quantity"), 4 if (i.get("quantity") or 0) % 1 else 0), True),
                      _td(_money(i.get("lastPrice"), c), True), _td(_money(i.get("fillPrice"), c), True),
                      _td(_money(i.get("valueKrw"), "KRW"), True),
                      _td(f'{_signed_money(i.get("unrealized"), c)} ({_pct(i.get("unrealizedRate"), True)})', True),
                      _td(_e(i.get("requestedBy")))])
    html.append(_table(["종목", "수량", "현재가", "체결가", "평가금액(원)", "평가 손익", "요청자"], items,
                       "보유 종목 없음"))
    return "".join(html)


def _daily_analysis(a: dict | None) -> str:
    html = ["<h2>AI 분석</h2>"]
    if not a:
        return html[0] + "<p>없음 (분석하지 않음)</p>"
    notes = a.get("notes") or []
    symbols = a.get("symbols") or []
    if not symbols:
        return html[0] + f'<p>없음 ({_e("; ".join(notes) or "분석하지 않음")})</p>'
    picks = sum(1 for x in symbols if x["outcome"] == "매수 추천")
    earlier = sum(1 for x in symbols if x.get("earlier"))
    if a.get("runFile"):
        run = (f'{_e(_time(a.get("startedAt")))} · {"오늘 앞서 한 분석 재사용" if a.get("reused") else "새로 분석"} '
               f'{len(symbols) - earlier}종목 · AI 비용 ${a.get("costUsd") or 0:.2f} · 기록 {_e(a["runFile"])}')
    else:
        run = "새로 분석한 종목 없음"
    html.append(f'<p class="meta">{run}{f" · 최근 분석 재사용 {earlier}종목" if earlier else ""} · '
                f'매수 추천 {picks}개</p>')
    html.append('<p class="small">기록만, 모의 주문 없음. 보유 종목은 매수 시나리오 기준 재평가라 보유 유지 판단의 참고용이다. '
                "전체 평가 자료는 같이 보낸 분석 리포트 참고.</p>")
    kinds = {"매수 추천": "pick", "분석 중단": "drop"}
    rows = []
    for x in symbols:
        c, p = x.get("currency") or "KRW", x.get("pick")
        outcome = (f'<span class="tag {kinds[x["outcome"]]}">{_e(x["outcome"])}</span>' if x["outcome"] in kinds
                   else _e(x["outcome"]) + (f' (시나리오 {x["scenarios"]}개)' if x.get("scenarios") else ""))
        if x.get("earlier"):
            outcome += (f'<br><span class="small">이미 분석됨 ({_e(x["earlier"]["runFile"])}, '
                        f'{_e(_time(x["earlier"]["startedAt"]))})</span>')
        if p:
            plan = (f'{_money(p.get("entry"), c)} / {_money(p.get("target"), c)} / {_money(p.get("stop"), c)}<br>'
                    f'<span class="small">확률 {_pct(p.get("probability"))} · 보유 {_e(p.get("holdingDays") or "-")}거래일</span>')
            reason = p.get("reason")
        else:
            plan, reason = "-", "; ".join(x.get("reasons") or [])
        rows.append([_td(f'{_e(x.get("name"))} ({_e(x.get("symbol"))})'), _td(_e(x.get("role") or "-")),
                     _td(outcome), _td(_num(x.get("bestScore")), True), _td(plan), _td(_e(reason or "-"))])
    html.append(_table(["종목", "역할", "결과", "최고 점수", "추천 시나리오 (진입 / 목표 / 손절)", "사유"], rows,
                       "분석한 종목 없음"))
    if notes:
        html.append('<p class="small">' + _e(" · ".join(notes)) + "</p>")
    return "".join(html)


def _daily_trades(t: dict) -> str:
    html = ["<h2>진행 중 모의 주문</h2>"]
    rows = []
    for r in t.get("active") or []:
        c = r["currency"]
        size = _num(r["quantity"], 4 if r["quantity"] % 1 else 0) + "주"
        if not r.get("filled"):
            how = f'지정가 {_money(r.get("limitPrice"), c)}' if r.get("orderType") == "LIMIT" else "시장가"
            size += f'<br><span class="small">체결 대기 · {how}</span>'
        pnl = f'목표 {_signed_money(r["expectedGain"], c)}<br>손절 {_signed_money(r["expectedLoss"], c)}'
        if r.get("unrealized") is not None:
            pnl += f'<br>현재 {_signed_money(r["unrealized"], c)}'
        rows.append([_td(f'#{r["id"]} {_e(r["name"])} ({_e(r["symbol"])})<br>'
                         f'<span class="small">{_e(r["status"])} · 요청 {_e(r.get("requestedBy"))}</span>'),
                     _td(size, True), _td(_money(r.get("fillPrice"), c), True),
                     _td(_money(r.get("lastPrice"), c), True),
                     _td(f'{_money(r.get("target"), c)} / {_money(r.get("stop"), c)}<br>'
                         f'<span class="small">기한 {_e(r.get("expireDate") or "-")}</span>'),
                     _td(pnl, True)])
    html.append(_table(["종목", "수량", "체결가", "현재가", "목표 / 손절", "예상 손익"], rows))
    html.append('<p class="small">예상 손익은 목표가·손절가에 청산될 때의 값 (수수료·세금 전). '
                "현재는 체결가 대비 현재가 평가. 목표·손절·기한 조건이 2회 연속 확인되면 엔진이 모의 매도한다.</p>")

    html.append(f'<h2>기간 내 종료 주문 <span class="small">(신규 {t.get("openedCount", 0)}건)</span></h2>')
    rows = []
    for r in t.get("finished") or []:
        c = r["currency"]
        rows.append([_td(f'#{r["id"]} {_e(r["name"])} ({_e(r["symbol"])})'),
                     _td(_e(r["status"]) + (f' · {_e(r["exitReason"])}' if r.get("exitReason") else "")),
                     _td(_money(r.get("fillPrice"), c), True), _td(_money(r.get("exitPrice"), c), True),
                     _td(_signed_money(r.get("pnl"), c), True), _td(_e(_time(r.get("closedAt")))),
                     _td(_e(r.get("requestedBy"))), _td(_e(r.get("note")))])
    html.append(_table(["종목", "상태", "체결가", "청산가", "손익", "종료", "요청자", "메모"], rows))
    realized = t.get("realized") or {}
    krw = t.get("realizedKrw")
    html.append(f"<p><b>기간 확정 손익</b>: {_money_by_currency(realized, True) if realized else '없음'}"
                + (f" (원화 {_signed_money(krw, 'KRW')})" if krw is not None and set(realized) != {"KRW"} else "")
                + "</p>")

    html.append("<h2>누적 성적 <span class=\"small\">(모의 주문 청산 기준, 수수료·세금 포함)</span></h2>")
    rows = [[_td(_e(c)), _td(_num(v["count"]), True), _td(_num(v["wins"]), True),
             _td(_pct(v.get("winRate")), True), _td(_signed_money(v["pnl"], c), True)]
            for c, v in sorted((t.get("cumulative") or {}).items())]
    html.append(_table(["통화", "청산", "이익", "승률", "손익 합계"], rows))
    return "".join(html)


def _ranking_table(items: list, currency: str) -> str:
    rows = [[_td(_num(r.get("rank")), True), _td(f'{_e(r.get("name") or "")} ({_e(r.get("symbol"))})'),
             _td(_money(r.get("lastPrice"), currency), True), _td(_pct(r.get("changeRate"), True), True),
             _td(_money(r.get("tradingAmount"), currency), True)] for r in items]
    return _table(["순위", "종목", "현재가", "등락", "거래대금"], rows)


def _daily_markets(markets: dict) -> str:
    html = ["<h2>시장 동향</h2>"]
    for m, d in (markets or {}).items():
        currency = "KRW" if m == "KR" else "USD"
        html.append(f'<h3>{_e(MARKET_LABEL.get(m, m))} <span class="small">기록 {_num(d.get("recordedDays"))}일'
                    f' · 최신 {_e(d.get("latestDay") or "-")}</span></h3>')
        if d.get("note"):
            html.append(f"<p>{_e(d['note'])}</p>")
        days = d.get("days") or []
        bench = _e(days[-1]["benchSymbol"]) if days else ""
        rows = [[_td(_e(x["day"])), _td(_money(x.get("benchClose"), currency), True),
                 _td(_pct(x.get("benchChange"), True), True), _td(_num(x.get("usdKrw"), 2), True)]
                for x in days]
        html.append(_table(["거래일", f"벤치마크 {bench} 종가", "등락", "환율"], rows))
        for key, title in (("amount", "거래대금 상위 10"), ("gainers", "상승률 상위 10"), ("losers", "하락률 상위 10")):
            html.append(f"<h3>{title}</h3>" + _ranking_table(d.get(key) or [], currency))
    return "".join(html)


def _predictions(p: dict | None) -> str:
    html = ["<h3>예측 기록 현황</h3>"]
    s = (p or {}).get("summary")
    if not s or not s.get("total"):
        return html[0] + "<p>기록 없음</p>"
    html.append(f'<p>시나리오 {_num(s["total"])}건 · 선별(통과) {_num(s["selected"])}건 · '
                f'진행 중 {_num(s["active"])}건 · 청산 {_num(s["closed"])}건 (목표·손절·만료·미체결)</p>')
    if s.get("resolved"):
        html.append(f'<p>체결 후 청산 {_num(s["resolved"])}건 중 목표 도달률 {s["hit_rate"]:.0%} · '
                    f'AI가 말한 평균 확률 {s["avg_probability"]:.0%} (AI 확률 vs 실제 도달률)</p>')
    models = p.get("models") or []
    if not models:
        html.append(f'<p>아직 청산된 시나리오 없음 ({_num(s["active"])}건 진행 중)</p>')
    else:
        rows = [[_td(_e(m["analyst"])), _td(_num(m["n"]), True), _td(f'{m["avg_probability"]:.0%}', True),
                 _td(f'{m["hit_rate"]:.0%}', True), _td(f'{m["brier"]:.3f}', True)] for m in models]
        html.append(_table(["모델", "건수", "평균 확률", "적중률", "Brier (낮을수록 좋음)"], rows))
    return "".join(html)


def _daily_records(r: dict, markets: dict) -> str:
    html = ["<h2>기록</h2>", "<h3>전략</h3>"]
    if r.get("redisError"):
        html.append(f'<p class="warn">Redis 조회 실패: {_e(r["redisError"])}</p>')
    strategies = r.get("strategies")
    if strategies is None:
        html.append("<p>없음 (REDIS_URL 없음)</p>")
    else:
        rows = [[_td(_e(s["summary"])),
                 _td(f'{_e(_time(s.get("lastRunAt")))}<br>{_e(s.get("lastSummary") or "")}'),
                 _td(_e(", ".join(s.get("latestPicks") or []) or "-"))] for s in strategies]
        html.append(_table(["전략", "마지막 실행", "최근 선별 상위 5"], rows))
    html.append("<h3>기간 내 분석 실행</h3>")
    rows = [[_td(_e(_time(x["startedAt"]))), _td(_e(x.get("strategy") or "수동")), _td(_num(x["symbols"]), True),
             _td(_e(", ".join(x["picks"]) or "없음")), _td(_num(x.get("failed")), True),
             _td(f'${x.get("costUsd") or 0:.2f}', True)] for x in r.get("runs") or []]
    html.append(_table(["시각", "전략", "분석 종목", "매수 추천", "중단", "AI 비용"], rows))
    html.append("<h3>예약 주문</h3>")
    reservations = r.get("reservations")
    html.append("<p>없음 (REDIS_URL 없음)</p>" if reservations is None
                else _list(reservations) or "<p>없음</p>")
    html.append(_predictions(r.get("predictions")))
    html.append("<h3>AI 시나리오 예측 추적 성적</h3>")
    rows = [[_td("선별" if x["selected"] else "탈락"), _td(_e(x["currency"])), _td(_num(x["total"]), True),
             _td(f'{x["target"] or 0} / {x["stop"] or 0} / {x["expired"] or 0}', True),
             _td(_num(x["active"]), True), _td(_signed_money(x["pnl"], x["currency"]), True)]
            for x in r.get("paper") or []]
    html.append(_table(["구분", "통화", "전체", "목표 / 손절 / 만료", "진행", "손익"], rows))
    counts = ", ".join(f'{MARKET_LABEL.get(m, m)} {_num(d.get("recordedDays"))}일' for m, d in (markets or {}).items())
    html.append("<table>" + "".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in (
        ("중단 스위치", '<span class="warn">켜짐 (새 모의 매수 막힘)</span>' if r.get("halted") else "꺼짐"),
        ("최근 백업", _e(r.get("latestBackup") or "없음")),
        ("시장 기록 일수", _e(counts or "없음") + ' <span class="small">(백테스트 유니버스용)</span>'))) + "</table>")
    return "".join(html)


def build_daily_html(data: dict) -> str:
    """data는 daily.collect의 결과."""
    p = data.get("period") or {}
    title = f'일일 리포트 · {_time(p.get("since"))} ~ {_time(p.get("until"))}'
    html = [f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{_e(title)}</title>'
            f"<style>{CSS}</style></head><body>",
            f"<h1>{_e(title)}</h1>",
            f'<p class="meta">기간 {_e(p.get("days"))}일 · 만든 시각 {_e(_time(p.get("until")))}</p>',
            _daily_account(data.get("account")),
            _daily_analysis(data.get("analysis")),
            _daily_trades(data.get("trades") or {}),
            _daily_markets(data.get("markets") or {}),
            _daily_records(data.get("records") or {}, data.get("markets") or {}),
            '<p class="small">AI 분석 섹션 외에는 AI 판단 없음, 기록과 조회값만 담음.</p></body></html>']
    return "".join(html)


def write_daily_report(data: dict, pdf_path: Path, chrome_bin: str | None = None,
                       run=subprocess.run) -> Path:
    """일일 리포트를 쓰고 그 경로를 돌려준다. PDF를 만들지 못하면 HTML 경로를 돌려준다."""
    return _render_pdf(build_daily_html(data), pdf_path, chrome_bin, run)


def find_chrome(configured: str | None = None) -> str | None:
    for name in ((configured,) if configured else CHROME_NAMES):
        path = shutil.which(name)
        if path:
            return path
    return None


def render_pdf(html: str, pdf_path: Path, chrome_bin: str | None = None, run=subprocess.run) -> Path:
    """완성된 HTML을 PDF로 만들어 그 경로를 돌려준다. PDF를 만들지 못하면 HTML 파일 경로를 돌려준다.

    웹의 리포트 PDF(backend/reports/output/pdf.py)처럼 HTML을 직접 만든 쪽이 쓴다.
    """
    return _render_pdf(html, pdf_path, chrome_bin, run)


def _render_pdf(html: str, pdf_path: Path, chrome_bin: str | None, run) -> Path:
    """HTML을 Chrome(headless)으로 PDF로 바꾼다. 만들지 못하면 HTML 파일 경로를 돌려준다."""
    html_path = pdf_path.with_suffix(".html")
    html_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(html, encoding="utf-8")
    chrome = find_chrome(chrome_bin)
    if not chrome:
        return html_path
    try:
        run([chrome, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
             f"--print-to-pdf={pdf_path}", html_path.resolve().as_uri()],
            capture_output=True, timeout=PDF_TIMEOUT_SEC, check=True)
    except (OSError, subprocess.SubprocessError):
        return html_path
    if not pdf_path.exists() or pdf_path.stat().st_size == 0:
        return html_path
    html_path.unlink(missing_ok=True)
    return pdf_path


def write_report(log: dict, pdf_path: Path, chrome_bin: str | None = None,
                 run=subprocess.run) -> Path:
    """리포트를 쓰고 그 경로를 돌려준다. PDF를 만들지 못하면 HTML 경로를 돌려준다."""
    return _render_pdf(build_html(log), pdf_path, chrome_bin, run)
