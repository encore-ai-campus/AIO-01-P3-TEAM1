"""실험 공용 모듈. 캐시(backtest/cache)만 읽고 증권사 API는 부르지 않는다.

사용:
    from common import Variant, load_market, run_variants, write_report
    data = load_market("KR")
    rows = run_variants(data, [Variant("기준", settings, rule), ...])
    write_report("entry", "진입 방식", {"KR": rows_kr, "US": rows_us}, notes=[...])

결과는 backtest/results/experiments/<name>/ 에 summary.md, summary.json, <market>-trades-N.csv 로 남는다.
"""
import csv
import json
import statistics
import sys
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from run import BENCHMARK, CURRENCY, summarize  # noqa: E402
from sim import EXPIRED, OPEN, STOP, TARGET, Backtest, Result, Rule, Settings  # noqa: E402

CACHE = HERE.parent / "cache"
RESULTS = HERE.parent / "results"
START, END = "2026-06-01", "2026-09-30"
SPLIT = "2026-08-01"  # 앞·뒤 반기 비교 기준
# run.py가 저장한 운영값. 캐시가 없을 때의 기본값
DEFAULT_FX = {"KR": 1.0, "US": 1354.5}
DEFAULT_COMMISSION = {"KR": 0.00015, "US": 0.001}


@dataclass
class MarketData:
    market: str
    candles: dict[str, list[dict]]  # 종목별 완성된 일봉 (과거 → 최신)
    names: dict[str, str]
    bench: list[dict]  # 벤치마크 일봉 (KR KODEX 200, US SPY)
    fx_rate: float
    commission_rate: float

    def base_settings(self, **overrides) -> Settings:
        """운영 기본값과 같은 설정. 필요한 항목만 바꿔 쓴다."""
        base = dict(market=self.market, currency=CURRENCY[self.market], start=START, end=END,
                    fx_rate=self.fx_rate, commission_rate=self.commission_rate)
        return Settings(**(base | overrides))


@dataclass
class Variant:
    label: str
    settings: Settings
    rule: Rule
    backtest_kwargs: dict = field(default_factory=dict)  # screen_fn, scenario_fn, regime_fn


def load_market(market: str) -> MarketData:
    root = CACHE / market
    if not (root / "universe.json").exists():
        raise SystemExit(f"캐시가 없음: {root}. 먼저 `uv run python backtest/run.py --market {market}`를 실행")
    names = json.loads((root / "universe.json").read_text())["universe"]
    candles = {sym: json.loads((root / "candles" / f"{sym}.json").read_text()) for sym in names
               if (root / "candles" / f"{sym}.json").exists()}
    bench = json.loads((root / "candles" / f"{BENCHMARK[market]}.json").read_text())
    fx, commission = DEFAULT_FX[market], DEFAULT_COMMISSION[market]
    summary = RESULTS / market / "summary.json"
    if summary.exists():
        s = json.loads(summary.read_text())["settings"]
        fx, commission = s["fx_rate"], s["commission_rate"]
    return MarketData(market, candles, names, bench, fx, commission)


def split_returns(res: Result) -> tuple[float | None, float | None]:
    """(앞 반기 수익률 %, 뒤 반기 수익률 %). 평가금액 곡선을 SPLIT에서 나눈다."""
    if not res.equity:
        return None, None
    cap = res.settings.capital_krw
    first = [e for d, e, _ in res.equity if d < SPLIT]
    second = [e for d, e, _ in res.equity if d >= SPLIT]
    a = (first[-1] / cap - 1) * 100 if first else None
    pivot = first[-1] if first else cap
    b = (second[-1] / pivot - 1) * 100 if second else None
    return a, b


def run_variant(data: MarketData, v: Variant) -> tuple[Result, dict]:
    res = Backtest(v.settings, v.rule, data.candles, data.names, **v.backtest_kwargs).run()
    sm = summarize(res, data.bench)
    sm["label"] = v.label
    sm["firstHalfPct"], sm["secondHalfPct"] = split_returns(res)
    filled = [t for t in res.trades if t.placed and t.fill_price is not None]
    closed = [t for t in filled if t.closed_at]
    sm["avgHoldDays"] = statistics.mean(_hold_days(t) for t in closed) if closed else None
    return res, sm


def _hold_days(t) -> int:
    """체결일부터 청산일까지의 달력 일수."""
    return (date.fromisoformat(t.closed_at) - date.fromisoformat(t.filled_at)).days


def run_variants(data: MarketData, variants: list[Variant], name: str | None = None) -> list[dict]:
    """각 변형을 돌려 요약 행을 돌려준다. name을 주면 거래 CSV도 남긴다."""
    rows = []
    for i, v in enumerate(variants, 1):
        res, sm = run_variant(data, v)
        rows.append(sm)
        if name:
            out = RESULTS / "experiments" / name
            out.mkdir(parents=True, exist_ok=True)
            write_trades(out / f"{data.market}-trades-{i}.csv", res)
        print(f"  [{data.market}] {v.label}: {sm['returnPct']:+.2f}% (주문 {sm['orders']}, 체결 {sm['filled']})",
              file=sys.stderr)
    return rows


def write_trades(path: Path, res: Result) -> None:
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", "symbol", "name", "score", "entry", "target", "stop_trigger", "stop_order", "expire",
                    "reward_risk", "approved", "reasons", "limited_by", "placed", "quantity", "status", "filled_at",
                    "fill", "closed_at", "exit", "ret_1share", "pnl"])
        for t in res.trades:
            w.writerow([t.day, t.symbol, t.name, t.score, t.entry, t.target, t.stop_trigger, t.stop_order,
                        t.expire_date, f"{t.reward_risk:.2f}", t.approved, "; ".join(t.reasons), t.limited_by,
                        t.placed, t.quantity, t.status, t.filled_at, t.fill_price, t.closed_at, t.exit_price,
                        None if t.ret is None else f"{t.ret:.4f}", None if t.pnl is None else f"{t.pnl:.2f}"])


def _pct(v, digits=1):
    return "-" if v is None else f"{v:+.{digits}f}%"


def result_table(rows: list[dict]) -> list[str]:
    lines = ["| 변형 | 수익률 | 6~7월 | 8~9월 | 벤치마크 | MDD | 평균 비중 | 주문/체결 | 목표/손절/기한/보유중 | 승률 | PF |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for sm in rows:
        e = sm["exits"]
        pf = "-" if sm["profitFactor"] is None else f"{sm['profitFactor']:.2f}"
        win = "-" if sm["winRatePct"] is None else f"{sm['winRatePct']:.0f}%"
        lines.append(f"| {sm['label']} | {_pct(sm['returnPct'], 2)} | {_pct(sm['firstHalfPct'])} | "
                     f"{_pct(sm['secondHalfPct'])} | {_pct(sm['benchmarkPct'])} | {_pct(sm['mddPct'])} | "
                     f"{sm['avgExposurePct']:.0f}% | {sm['orders']}/{sm['filled']} | "
                     f"{e[TARGET]}/{e[STOP]}/{e[EXPIRED]}/{e[OPEN]} | {win} | {pf} |")
    return lines


def funnel_table(rows: list[dict]) -> list[str]:
    lines = ["| 변형 | 체제 제외일 | 선별 | 시나리오 | 리스크 탈락 | 승인 | 종목 중복 | 보유 수 초과 | 주문 | 체결 |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for sm in rows:
        f = sm["funnel"]
        lines.append(f"| {sm['label']} | {f.get('regimeSkipped', 0)} | {f['picks']} | {f['scenarios']} | "
                     f"{f['riskRejected']} | {f['approved']} | {f['skippedActive']} | "
                     f"{f.get('skippedMaxPositions', 0)} | {f['placed']} | {f['filled']} |")
    return lines


def write_report(name: str, title: str, rows_by_market: dict[str, list[dict]], notes: list[str],
                 findings: list[str] | None = None) -> Path:
    """results/experiments/<name>/summary.md 와 summary.json을 쓴다. 돌려주는 값은 summary.md 경로."""
    out = RESULTS / "experiments" / name
    out.mkdir(parents=True, exist_ok=True)
    lines = [f"# 실험: {title}", "", f"기간 {START} ~ {END}, 자본금 1000만원, AI 없음. 기준(운영 규칙)은 첫 행."]
    for market, rows in rows_by_market.items():
        lines += ["", f"## {market}", ""] + result_table(rows) + ["", "퍼널:", ""] + funnel_table(rows)
    if findings:
        lines += ["", "## 해석", ""] + [f"- {x}" for x in findings]
    lines += ["", "## 주의", ""] + [f"- {x}" for x in notes]
    lines += ["", "파일: `<시장>-trades-N.csv` (N은 표의 행 순서), `summary.json`"]
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    (out / "summary.json").write_text(json.dumps(rows_by_market, ensure_ascii=False, indent=1, default=str))
    return out / "summary.md"


def settings_dict(s: Settings) -> dict:
    return asdict(s)
