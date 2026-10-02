"""파이프라인 백테스트 (AI 없음). 사용법은 backtest/README.md.

  uv run python backtest/run.py --market KR
  uv run python backtest/run.py --market US --refresh   # 캐시를 버리고 다시 받는다

증권사 API(운영은 키움, 로컬 개발 환경은 BROKER=toss면 토스)는 조회만 한다 (랭킹, 종목 정보, 일봉, 환율).
토큰은 운영과 같은 캐시를 쓴다.
수수료율은 모의 계좌와 같은 PAPER_COMMISSION_KR|US를 쓴다.
"""
import argparse
import csv
import json
import statistics
import sys
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sim import OPEN, STOP, TARGET, EXPIRED, UNFILLED, Backtest, Rule, Settings  # noqa: E402
from paper_engine.config import ROOT, load_config  # noqa: E402
from paper_engine.data.broker import BrokerClient, make_client  # noqa: E402
from paper_engine.data.calendar import drop_incomplete  # noqa: E402
from paper_engine.records.market_log import AMOUNT  # noqa: E402
from paper_engine.records.store import Store  # noqa: E402
from paper_engine.judge import screen  # noqa: E402

HERE = Path(__file__).resolve().parent
HISTORY_SINCE = "2025-11-01"  # 6월 1일 선별에 일봉 130개가 필요하다
DB_PATH = ROOT / "data" / "trading.db"  # serve가 쌓는 시장 기록 (rankings 표)
BENCHMARK = {"KR": "069500", "US": "SPY"}  # KODEX 200, SPDR S&P 500
CURRENCY = {"KR": "KRW", "US": "USD"}
RULES = [
    Rule("AI 유사 (목표 2.0·손절 1.5 ATR)", 2.0, 1.5),
    Rule("목표 3.0·손절 1.0 ATR", 3.0, 1.0),
    Rule("목표 4.0·손절 1.5 ATR", 4.0, 1.5),
    Rule("목표 5.0·손절 2.0 ATR", 5.0, 2.0),
]


# --- 데이터 (조회만, 캐시) ---

def fetch_candles(client: BrokerClient, symbol: str, since: str) -> list[dict]:
    """since 이후 일봉 (과거 → 최신, 수정주가). "date" 키를 붙인다."""
    bars, before, seen = {}, None, set()
    while True:
        page, before = client.candles_before(symbol, before, 200)
        count = len(bars)
        for c in page:
            bars[c["timestamp"][:10]] = c | {"date": c["timestamp"][:10]}
        # 커서가 반복되거나 새 날짜가 없으면 멈춘다 (서버가 같은 페이지를 계속 줄 때 끝나지 않는 것을 막는다)
        if not before or not page or min(bars) <= since or before in seen or len(bars) == count:
            break
        seen.add(before)
    return [bars[d] for d in sorted(bars) if d >= since]


def recorded_universe(market: str, db_path: Path = DB_PATH) -> dict[str, str]:
    """시장 기록(serve가 장 마감 후 쌓는 rankings 표)의 거래대금 상위 종목 → 처음 기록된 날. 기록이 없으면 빈 dict."""
    if not db_path.exists():
        return {}
    store = Store(db_path)
    out: dict[str, str] = {}
    for d in store.market_days(market, limit=100_000):
        for r in store.rankings(market, d["day"], AMOUNT):
            out.setdefault(r["symbol"], d["day"])
    return out


def load_data(client: BrokerClient, market: str, refresh: bool) -> tuple[dict, dict]:
    """(종목별 완성된 일봉, 종목 이름). 유니버스는 여러 기간의 거래대금 상위 100의 합집합."""
    cache = HERE / "cache" / market
    (cache / "candles").mkdir(parents=True, exist_ok=True)
    uni_file = cache / "universe.json"
    if refresh or not uni_file.exists():
        # 키움은 당일 순위만 준다. 당일 거래대금 상위 100 + 시장 기록(rankings 표)에 쌓인 날들의 상위 100
        ranks, _ = client.rankings_with_time("MARKET_TRADING_AMOUNT", market, "1d", count=100, exclude_caution=False)
        symbols = {r["symbol"]: "1d" for r in ranks}
        for symbol, day in recorded_universe(market).items():
            symbols.setdefault(symbol, day)
        infos = []
        keys = list(symbols)
        for i in range(0, len(keys), 50):
            infos += client.stocks(keys[i:i + 50])
        universe = {i["symbol"]: i["name"] for i in infos if not screen.eligible(i)}
        excluded = {i["symbol"]: screen.eligible(i) for i in infos if screen.eligible(i)}
        uni_file.write_text(json.dumps({"fetchedAt": datetime.now().astimezone().isoformat(),
                                        "universe": universe, "excluded": excluded}, ensure_ascii=False, indent=1))
    names = json.loads(uni_file.read_text())["universe"]
    calendar = client.market_calendar(market)
    now = datetime.now(timezone.utc)
    candles = {}
    for n, sym in enumerate([*names, BENCHMARK[market]], 1):
        f = cache / "candles" / f"{sym}.json"
        if refresh or not f.exists():
            print(f"  일봉 {n}/{len(names) + 1} {sym}", file=sys.stderr)
            # 장중이면 오늘 봉은 미완성이라 저장하지 않는다
            f.write_text(json.dumps(drop_incomplete(fetch_candles(client, sym, HISTORY_SINCE), calendar, now)))
        candles[sym] = drop_incomplete(json.loads(f.read_text()), calendar, now)
    return candles, names


# --- 결과 정리 ---

def mdd(values: list[float]) -> float:
    peak, worst = values[0], 0.0
    for v in values:
        peak = max(peak, v)
        worst = min(worst, v / peak - 1)
    return worst


def summarize(res, bench: list[dict]) -> dict:
    s = res.settings
    placed = [t for t in res.trades if t.placed]
    filled = [t for t in placed if t.fill_price is not None]
    closed = [t for t in filled if t.status in (TARGET, STOP, EXPIRED)]
    wins = [t for t in closed if t.pnl > 0]
    gross_win = sum(t.pnl for t in closed if t.pnl > 0)
    gross_loss = -sum(t.pnl for t in closed if t.pnl < 0)
    equity = [e for _, e, _ in res.equity]
    b = [c for c in bench if s.start <= c["date"] <= s.end]
    by_status = {k: sum(1 for t in filled if t.status == k) for k in (TARGET, STOP, EXPIRED, OPEN)}

    def mean_ret(rows):
        rows = [t.ret for t in rows if t.ret is not None]
        return (statistics.mean(rows), len(rows)) if rows else (None, 0)

    all_filled = [t for t in res.trades if t.fill_price is not None]
    return {
        "rule": res.rule.name,
        "period": f"{res.equity[0][0]} ~ {res.equity[-1][0]}" if res.equity else "",
        "tradingDays": len(res.equity),
        "finalEquityKrw": equity[-1] if equity else s.capital_krw,
        "returnPct": (equity[-1] / s.capital_krw - 1) * 100 if equity else 0.0,
        "mddPct": mdd(equity) * 100 if equity else 0.0,
        "avgExposurePct": statistics.mean(x for _, _, x in res.equity) * 100 if res.equity else 0.0,
        "benchmarkPct": (float(b[-1]["closePrice"]) / float(b[0]["openPrice"]) - 1) * 100 if b else None,
        "funnel": res.funnel,
        "orders": len(placed), "filled": len(filled), "unfilled": sum(1 for t in placed if t.status == UNFILLED),
        "exits": by_status,
        "winRatePct": len(wins) / len(closed) * 100 if closed else None,
        "profitFactor": gross_win / gross_loss if gross_loss else None,
        "realizedPnlKrw": sum(t.pnl for t in closed) * s.fx_rate,
        "openPnlKrw": sum(t.pnl for t in filled if t.status == OPEN) * s.fx_rate,
        "avgWinPct": statistics.mean(t.ret for t in wins) * 100 if wins else None,
        "avgLossPct": statistics.mean(t.ret for t in closed if t.pnl <= 0) * 100 if len(wins) < len(closed) else None,
        # 리스크 엔진 필터 평가: 모든 시나리오를 1주씩 샀다고 보고 (체결된 것만) 1주 수익률 평균
        "filterCheck": {"approved": mean_ret([t for t in all_filled if t.approved]),
                        "rejected": mean_ret([t for t in all_filled if not t.approved]),
                        "all": mean_ret(all_filled),
                        "allTargetRatePct": (sum(1 for t in all_filled if t.status == TARGET) /
                                             len(all_filled) * 100) if all_filled else None},
    }


def pct(v, digits=1):
    return "-" if v is None else f"{v:+.{digits}f}%"


def money(v):
    return f"{v:,.0f}원"


def write_outputs(out: Path, market: str, s: Settings, results: list, summaries: list[dict], notes: list[str]):
    out.mkdir(parents=True, exist_ok=True)
    for i, (res, sm) in enumerate(zip(results, summaries), 1):
        with open(out / f"trades-{i}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["day", "symbol", "name", "score", "entry", "target", "stop_trigger", "stop_order",
                        "expire", "reward_risk", "approved", "reasons", "limited_by", "placed", "quantity",
                        "status", "filled_at", "fill", "closed_at", "exit", "ret_1share", "pnl"])
            for t in res.trades:
                w.writerow([t.day, t.symbol, t.name, t.score, t.entry, t.target, t.stop_trigger, t.stop_order,
                            t.expire_date, f"{t.reward_risk:.2f}", t.approved, "; ".join(t.reasons), t.limited_by,
                            t.placed, t.quantity, t.status, t.filled_at, t.fill_price, t.closed_at, t.exit_price,
                            None if t.ret is None else f"{t.ret:.4f}", None if t.pnl is None else f"{t.pnl:.2f}"])
        with open(out / f"equity-{i}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "equity_krw", "exposure"])
            w.writerows([(d, f"{e:.0f}", f"{x:.3f}") for d, e, x in res.equity])
    (out / "summary.json").write_text(json.dumps({"settings": asdict(s), "results": summaries},
                                                 ensure_ascii=False, indent=1, default=str))

    lines = [f"# 백테스트 ({market}) {s.start} ~ {s.end}", "",
             f"- 자본금 {money(s.capital_krw)}, 총 금액 한도 "
             f"{money(s.max_total_krw) if s.max_total_krw else '자본금'}, 수수료 {s.commission_rate:.3%}"
             + (f", 환율 {s.fx_rate:,.2f} (고정)" if market == "US" else ""),
             f"- 매일 정규장 전 선별: 전일 거래대금 상위 {s.candidates}개 규칙 점수 → 상위 {s.analyze_top}개 시나리오",
             "- AI 호출 없음. 시나리오는 규칙 (진입 = 전일 종가, 목표·손절 = ATR 배수, 확률 0.45, 보유 10거래일)",
             "", "## 결과", "",
             "| 규칙 | 수익률 | 벤치마크 | MDD | 평균 투자 비중 | 주문/체결 | 목표/손절/기한/보유중 | 승률 | PF |",
             "|---|---|---|---|---|---|---|---|---|"]
    for sm in summaries:
        e = sm["exits"]
        pf = "-" if sm["profitFactor"] is None else f"{sm['profitFactor']:.2f}"
        win = "-" if sm["winRatePct"] is None else f"{sm['winRatePct']:.0f}%"
        lines.append(f"| {sm['rule']} | {pct(sm['returnPct'], 2)} | {pct(sm['benchmarkPct'])} | "
                     f"{pct(sm['mddPct'])} | {sm['avgExposurePct']:.0f}% | {sm['orders']}/{sm['filled']} | "
                     f"{e[TARGET]}/{e[STOP]}/{e[EXPIRED]}/{e[OPEN]} | {win} | {pf} |")
    lines += ["", "## 단계별 통과 (파이프라인 퍼널)", "",
              "| 규칙 | 선별 종목 | 시나리오 | 리스크 탈락 | 승인 | 같은 종목 진행 중 | 주문 | 체결 |",
              "|---|---|---|---|---|---|---|---|"]
    for sm in summaries:
        f = sm["funnel"]
        lines.append(f"| {sm['rule']} | {f['picks']} | {f['scenarios']} | {f['riskRejected']} | {f['approved']} | "
                     f"{f['skippedActive']} | {f['placed']} | {f['filled']} |")
    lines += ["", "## 리스크 엔진", "", "탈락 사유 (한 시나리오에 여러 개일 수 있다)와 수량을 정한 제약:", ""]
    for sm in summaries:
        f = sm["funnel"]
        reasons = ", ".join(f"{k} {v}" for k, v in sorted(f["rejectReasons"].items(), key=lambda x: -x[1])) or "없음"
        limited = ", ".join(f"{k} {v}" for k, v in sorted(f["limitedBy"].items(), key=lambda x: -x[1])) or "-"
        lines.append(f"- **{sm['rule']}**: 탈락 — {reasons} / 수량 제약 — {limited}")
    lines += ["", "필터 평가: 승인 여부와 관계없이 모든 시나리오를 1주씩 샀다고 보고 (체결된 것만) 비용 차감 수익률 평균",
              "", "| 규칙 | 승인된 시나리오 | 탈락한 시나리오 | 전체 | 전체 목표가 도달률 |", "|---|---|---|---|---|"]
    for sm in summaries:
        fc = sm["filterCheck"]

        def cell(x):
            return "-" if x[0] is None else f"{x[0] * 100:+.2f}% ({x[1]}건)"
        lines.append(f"| {sm['rule']} | {cell(fc['approved'])} | {cell(fc['rejected'])} | {cell(fc['all'])} | "
                     f"{'-' if fc['allTargetRatePct'] is None else f'{fc['allTargetRatePct']:.0f}%'} |")
    lines += ["", "## 주의", ""] + [f"- {n}" for n in notes]
    lines += ["", "파일: `trades-N.csv` (시나리오별 판정과 결과, N은 결과 표의 순서), `equity-N.csv` (일별 평가금액), "
              "`summary.json`"]
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    return "\n".join(lines)


NOTES = [
    "유니버스는 오늘 기준 거래대금 랭킹(1일~1년) 상위 종목의 합집합이다. 과거 시점의 랭킹은 API로 받을 수 없어서, "
    "기간 중에 거래가 늘어난 종목이 미리 포함되는 편향(미래 정보)이 있다. 상장폐지·거래정지된 종목은 빠져 있다.",
    "매일의 거래대금 순위는 이 유니버스 안에서 전일 일봉(종가 × 거래량)으로 다시 매긴다.",
    "AI 분석가·검증·최종 컨펌 단계는 빠져 있다. 규칙 시나리오가 리스크 엔진을 통과하면 매수한다. "
    "확률은 0.45로 고정이라 기대값 판정은 사실상 손익비로만 갈린다.",
    "매수 유의 종목 정보와 과거 시점의 일일 손실 한도는 재현하지 않았다 (선별이 장 전에 돌아 당일 손실은 항상 0).",
    "일봉만 보므로 같은 날 손절·목표가 모두 닿으면 손절, 장중 체결일의 목표가 도달은 인정하지 않는다. "
    "손절은 손절 주문가(감시가 −1%)에 판다고 본다 (실제로는 감시가 근처에서 체결되는 경우가 많아 보수적이다).",
    "기간 마지막 날 보유 중인 종목은 마지막 종가로 평가했다 (보유중).",
]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--market", choices=["KR", "US"], default="KR")
    p.add_argument("--start", default="2026-06-01")
    p.add_argument("--end", default="2026-09-30")
    p.add_argument("--capital", type=float, default=10_000_000)
    p.add_argument("--max-total", type=float, default=None, help="총 금액 한도 (원). 없으면 자본금")
    p.add_argument("--refresh", action="store_true", help="캐시를 버리고 데이터를 다시 받는다")
    args = p.parse_args()

    cfg = load_config()
    client = make_client(cfg, ROOT / ".cache")
    print(f"[{args.market}] 데이터 준비", file=sys.stderr)
    candles, names = load_data(client, args.market, args.refresh)
    fx = 1.0 if args.market == "KR" else float(client.exchange_rate()["rate"])
    commission = cfg.commission[args.market]
    bench = candles.pop(BENCHMARK[args.market])
    s = Settings(market=args.market, currency=CURRENCY[args.market], start=args.start, end=args.end,
                 capital_krw=args.capital, fx_rate=fx, commission_rate=commission, max_total_krw=args.max_total)
    results, summaries = [], []
    for rule in RULES:
        res = Backtest(s, rule, candles, names).run()
        results.append(res)
        summaries.append(summarize(res, bench))
    # 운영 총 금액 한도(.env)를 걸었을 때 (자본금보다 작을 때만)
    limit = cfg.max_total_invest_krw
    if args.max_total is None and limit and limit < args.capital:
        rule = RULES[2]
        res = Backtest(replace(s, max_total_krw=limit), rule, candles, names).run()
        res.rule = replace(rule, name=f"{rule.name}, 총 한도 {limit / 10_000:,.0f}만원")
        results.append(res)
        summaries.append(summarize(res, bench))
    notes = [f"유니버스 {len(names)}종목 (ETF·ETN 등 제외 후)."] + NOTES
    if args.market == "US":
        notes.append("원화 환산은 오늘 환율로 고정했다. 환율 변동 손익은 빠져 있다.")
    out = HERE / "results" / args.market
    print(write_outputs(out, args.market, s, results, summaries, notes))
    print(f"\n결과: {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
