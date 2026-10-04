"""CLI.

  python -m paper_engine snapshot 005930 AAPL
  python -m paper_engine evaluate scenario.json [--equity 10000000]
  python -m paper_engine analyze 005930 [--equity 10000000] [--no-web] [--buy] [--by NAME]
  python -m paper_engine track      # AI 시나리오 예측 추적 (완성된 일봉으로 체결·청산 판정)
  python -m paper_engine stats      # 예측 추적 성적과 모델별 예측 성적
  python -m paper_engine account    # 모의 계좌 요약 (현금, 평가액, 손익, 보유)
  python -m paper_engine orders [--all]           # 진행 중(기본)·전체 모의 주문
  python -m paper_engine fills [--limit 20]       # 체결 내역
  python -m paper_engine buy 005930 10 [--limit P] [--target P --stop P [--days N]] [--by NAME]
  python -m paper_engine sell 3 [--by NAME] · cancel 3 · modify 3 [--target P] [--stop P] [--days N]
  python -m paper_engine reservations [--cancel ID]
  python -m paper_engine sync       # 모의 체결·청산을 지금 한 번 확인
  python -m paper_engine halt       # 새 모의 매수 중단 스위치 켜기 (resume으로 해제)
  python -m paper_engine serve      # 상시 실행: 모의 체결, 시장 기록, 일일 리포트, 예약, 전략, 생존 신호
  python -m paper_engine scan KR [--no-ai] [--reports]  # 거래대금 상위(와 증권사 리포트) 스윙 후보 선별 (지금 바로)
  python -m paper_engine info stock 삼성전자     # 읽기 전용 조회 JSON (웹·CLI용)
  python -m paper_engine report runs/x.json [--send]  # 분석 리포트(PDF) 다시 만들기
  python -m paper_engine backup [--restore-redis FILE]  # 백업 (serve는 매일 자동)
  python -m paper_engine record KR [--day 2026-09-30]  # 시장 기록 (serve는 장 마감 후 자동)
  python -m paper_engine daily-report [--days 7] [--send] [--analyze]  # 일일 리포트(PDF) (serve는 매일 7시 자동)

주문은 모두 모의 계좌(docs/DECISIONS.md 4장)에서 체결한다. 증권사에는 조회만 한다.
.env에 OPENCLAW_TARGET이 있으면 알림을 팀 Discord 채널로 보내고, 없으면 콘솔에 출력한다.
buy·sell 등은 웹 화면이 생기기 전 임시 조작 수단이다 (요청자는 --by, 기본 cli).
"""
import argparse
import dataclasses
import json
import re
import sqlite3
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from functools import cached_property
from pathlib import Path

from . import daily, info, report, scheduler
from .agents import executor as ex
from .agents.executor import OrderRejected
from .config import BROKER_KEYS, ROOT, ConfigError, load_config
from .data import broker_reports
from .data.broker import BrokerClient, make_client
from .data.calendar import drop_incomplete
from .data.dart import DartClient
from .data.fina_stat import FinaStatClient
from .data.kiwoom import KiwoomApiError
from .data.sec import SecClient
from .data.snapshot import LIQUIDITY_DAYS, build_snapshot
from .judge import screen
from .judge.risk import SELL_TAX_RATE, AccountContext, assess
from .judge.scenario import Scenario
from .llm import LlmClient
from .notify import Notifier, format_candidate, format_plan, format_recommendation, format_report, \
    format_research, make_notifier
from .pipeline import ModelResponseError, analyze
from .records import account as paper_account
from .records import backup, market_log, paper
from .records.redis_client import Redis, RedisError
from .records.store import Store
from .scheduler import ReservationBook
from .strategies import Strategy, StrategyBook
from .symbols import MAX_REPORT_DAYS, SymbolError
from .trading import MARKET_LISTS, Desk, listed_stocks

MAX_PARALLEL_SYMBOLS = 4
SERVE_POLL_SEC = 2
CALENDAR_TTL_SEC = 600
HEARTBEAT_KEY = "paper:engine:heartbeat"  # 엔진 생존 신호 (웹이 읽는다). serve 루프마다 갱신
HEARTBEAT_TTL_SEC = 120
BACKUP_HOUR = 6  # 매일 이 시각 이후 첫 루프에서 백업한다 (serve)
REPORT_HOUR = 7  # 매일 이 시각(미국장 마감 후) 이후 첫 확인에서 일일 리포트를 보낸다 (serve, AI 분석 포함)
DAILY_JOBS_EVERY_SEC = 60  # 시장 기록과 일일 리포트를 확인하는 주기. 실패하면 이 주기로 다시 시도한다
SCAN_CANDIDATES = 30  # 거래대금 순으로 이만큼만 일봉을 받아 점검한다
SCAN_SHOW = 10
SCAN_ANALYZE_TOP = 3
REPORT_CANDIDATES = 10  # 증권사 리포트 후보 중 규칙 점수를 매길 최대 수 (중복·제외를 뺀 뒤)
ORIGIN_RANK, ORIGIN_REPORT = "거래대금 상위", "증권사 리포트"
DIRECTION_ARROW = {"UP": "↑", "DOWN": "↓", "KEEP": "="}
MARKET_LABEL = {"KR": "국내", "US": "미국"}
DB_PATH = ROOT / "data" / "trading.db"
BACKUP_DIR = ROOT / "data" / "backups"
HALT_FILE = ROOT / "data" / "HALT"
REPORT_DIR = ROOT / "data" / "reports"


_CLIENTS: dict[tuple, BrokerClient] = {}
_CLIENTS_LOCK = threading.Lock()


def _client(cfg) -> BrokerClient:
    """증권사 조회 클라이언트 (docs/DECISIONS.md 3장). 엔진은 여기서만 만든다. 운영은 키움, 로컬 개발은 BROKER=toss면 토스.

    같은 설정이면 프로세스에 하나만 만든다. 키움 호출 한도는 토큰 단위라, serve의 스레드(sync, 전략, 리포트)가
    클라이언트의 호출 간격 조절과 캐시를 같이 써야 한도를 넘지 않는다.
    """
    if not cfg.broker_ready:
        raise SystemExit(f".env 또는 환경변수에 {', '.join(BROKER_KEYS[cfg.broker])} 값이 없습니다.")
    key = (cfg.broker, cfg.toss_client_id, str(cfg.toss_token_cache),
           cfg.kiwoom_appkey, cfg.kiwoom_base_url, str(cfg.token_cache), cfg.data_gokr_api_key)
    with _CLIENTS_LOCK:
        if key not in _CLIENTS:
            _CLIENTS[key] = make_client(cfg, ROOT / ".cache")
        return _CLIENTS[key]


def _client_if_configured(cfg) -> BrokerClient | None:
    """키가 있으면 클라이언트, 없으면 None (기록만 보는 명령은 키 없이도 돈다)."""
    return _client(cfg) if cfg.broker_ready else None


def _dart(cfg) -> DartClient | None:
    return DartClient(cfg.dart_api_key, ROOT / ".cache") if cfg.dart_api_key else None


def _fina(cfg) -> FinaStatClient | None:
    return FinaStatClient(cfg.data_gokr_api_key) if cfg.data_gokr_api_key else None


def _sec(cfg) -> SecClient | None:
    return SecClient(cfg.sec_contact_email, ROOT / ".cache") if cfg.sec_contact_email else None


def _notifier(cfg) -> Notifier:
    return make_notifier(cfg)


def _store(cfg) -> Store:
    return Store(DB_PATH, cfg.paper_capital_krw)


def _book(cfg) -> ReservationBook | None:
    return ReservationBook(Redis(cfg.redis_url)) if cfg.redis_url else None


def _desk(cfg, store=None, notifier=None, client=None, book=None) -> Desk:
    return Desk(cfg, store or _store(cfg), notifier or _notifier(cfg), client, book, HALT_FILE)


def _money(value: float, currency: str) -> str:
    return f"{value:,.0f}원" if currency == "KRW" else f"${value:,.2f}"


def _account_context(cfg, desk: Desk, args, symbol: str, currency: str, liquidity: float,
                     warnings: list[str]) -> AccountContext:
    """리스크 엔진 입력. --equity를 주면 가상 자산으로 평가하고, 아니면 모의 계좌로 평가한다.

    args.max_amount_krw가 있으면(전략의 종목당 한도) 매수 가능 금액을 그 값으로 줄인다.
    리스크 엔진이 매수 가능 금액으로 수량 상한을 두므로 종목당 매수 금액이 한도를 넘지 않는다.
    """
    cap = getattr(args, "max_amount_krw", None)
    if args.equity is None:
        return desk.account_context(symbol, currency, liquidity, warnings, cap)
    fx = 1.0
    if currency != "KRW":
        fx = desk.fx_rate()
        if fx is None:
            raise SystemExit("환율을 조회하지 못해 달러 종목을 평가할 수 없습니다.")
    market = "KR" if currency == "KRW" else "US"
    power = args.equity if cap is None else min(args.equity, cap)
    commission = args.commission if args.commission is not None else cfg.commission[market]
    return AccountContext(equity_krw=args.equity, buying_power=power / fx, commission_rate=commission, fx_rate=fx,
                          avg_daily_trading_amount=liquidity, warnings=warnings,
                          max_total_krw=cfg.max_total_invest_krw)


def cmd_snapshot(args):
    cfg = load_config()
    client = _client(cfg)
    for symbol in args.symbols:
        print(json.dumps(build_snapshot(client, symbol, _dart(cfg), _sec(cfg), _fina(cfg)),
                         ensure_ascii=False, indent=2))


def cmd_evaluate(args):
    cfg = load_config()
    client = _client(cfg)
    with open(args.scenario) as f:
        s = Scenario.from_dict(json.load(f))
    candles = client.completed_daily_candles(s.symbol, s.market_country,
                                             LIQUIDITY_DAYS + 1)[-LIQUIDITY_DAYS:]
    liquidity = sum(float(c["closePrice"]) * float(c["volume"]) for c in candles) / len(candles)
    warnings = [w["warningType"] for w in client.warnings(s.symbol)]
    name = client.stocks([s.symbol])[0]["name"]
    desk = _desk(cfg, client=client)
    account = _account_context(cfg, desk, args, s.symbol, s.currency, liquidity, warnings)
    result = assess(s, account, fractional=args.fractional and s.currency == "USD")
    text = format_report(s, result, name)
    if result.reasons:
        text += "\n탈락 사유: " + "; ".join(result.reasons)
    _notifier(cfg).send(text)


def cmd_analyze(args):
    cfg = load_config()
    if not cfg.llm_api_key:
        raise SystemExit(".env에 DEVPASS_APIKEY가 없습니다.")
    if not cfg.analysts:
        raise SystemExit(".env에 ANALYSTS가 없습니다. .env.example을 참고하세요.")
    buy = bool(getattr(args, "buy", False))
    if buy and args.equity is not None:
        raise SystemExit("--buy는 모의 계좌 기준으로만 동작합니다. --equity를 빼세요.")
    requested_by = getattr(args, "by", None) or "cli"

    client, store, notifier = _client(cfg), _store(cfg), _notifier(cfg)
    desk = _desk(cfg, store, notifier, client)
    dart, sec, fina = _dart(cfg), _sec(cfg), _fina(cfg)
    started = datetime.now().astimezone()
    strategy = getattr(args, "strategy", None)  # 전략이 돌린 분석이면 (id, 이름)
    tag = getattr(args, "tag", None)  # 일일 리포트가 돌린 분석이면 "daily"
    run_file = _run_file_name(started, strategy, tag)
    args.run_file = run_file  # 호출한 쪽(전략, 일일 리포트)이 기록 위치를 알 수 있게 한다
    log = {"startedAt": started.isoformat(),
           "strategy": {"id": strategy[0], "name": strategy[1]} if strategy else None,
           "tag": tag, "roles": getattr(args, "roles", None), "earlier": getattr(args, "earlier", None),
           "maxAmountKrw": getattr(args, "max_amount_krw", None), "analysts": [dataclasses.asdict(m) for m in cfg.analysts],
           "voteWeights": cfg.weights, "researchers": cfg.researchers, "approver": cfg.approver,
           "requiredModels": cfg.required_models, "paperBuy": buy, "requestedBy": requested_by,
           "fractional": getattr(args, "fractional", False),
           "maxTotalInvestKrw": cfg.max_total_invest_krw, "results": []}

    # 계좌 평가는 기록 저장소를 쓰므로 미리 순서대로 하고, 분석만 종목별로 동시에 돌린다.
    client.prices([args.symbols[0]])  # 토큰을 한 번만 발급받도록 먼저 호출한다
    prepared = []
    for symbol in args.symbols:
        snapshot = build_snapshot(client, symbol, dart, sec, fina)
        account = _account_context(cfg, desk, args, symbol, snapshot["currency"],
                                   snapshot["avgDailyTradingAmount"], snapshot["warnings"])
        prepared.append((symbol, snapshot, account))

    def work(item):
        symbol, snapshot, account = item
        llm = LlmClient(cfg.llm_api_key)
        try:
            result = analyze(llm, cfg, snapshot, account, date.today(), web=not args.no_web,
                             fractional=getattr(args, "fractional", False))
        except ModelResponseError as e:
            result = e
        return result, llm.cost, datetime.now().astimezone()

    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_SYMBOLS) as pool:
        outcomes = list(pool.map(work, prepared))

    # 상세 내용은 콘솔(로그)과 리포트에만 남기고, 팀 채널에는 매수 추천과 요약만 보낸다.
    total_cost, failed, picked = 0.0, 0, []
    for (symbol, snapshot, account), (result, cost, analyzed_at) in zip(prepared, outcomes):
        name = snapshot["name"]
        total_cost += cost
        notifier.log(f"\n===== {name} ({symbol}) · 현재가 {snapshot['lastPrice']:,} "
                     f"{snapshot['currency']} =====")
        if isinstance(result, ModelResponseError):
            failed += 1
            notifier.send(f"[모델 응답 에러] {name} ({symbol}): {result}. 이 종목의 분석을 중단함")
            log["results"].append({"snapshot": snapshot, "modelResponseError": str(result),
                                   "costUsd": round(cost, 4)})
            continue
        if result.research_log:
            notifier.log(format_research(snapshot["webResearch"], result.research_log))
        if not result.candidates:
            notifier.log("제안된 시나리오 없음 (AI가 매수 근거를 찾지 못함)")
        trade_ids = {}
        for c in result.candidates:
            notifier.log("\n" + format_candidate(c, name))
            if c.scenario:
                trade_ids[c.id] = store.add_candidate(
                    c, name, started.isoformat(), snapshot["lastCandleDate"],
                    account.commission_rate, SELL_TAX_RATE[snapshot["marketCountry"]], run_file)
        for e in result.errors:
            notifier.log(f"[오류] {e}")
        notifier.log("단계별: " + " · ".join(
            f"{x['stage']} {x['calls']}회 {x['seconds']:.0f}초 ${x['costUsd']:.3f}"
            for x in result.stages))

        # 한 종목에 승인된 시나리오가 여러 개면 점수가 가장 높은 하나만 추천하고 모의 주문한다.
        approved = [c for c in result.candidates if c.selected]
        if approved:
            picked.append(f"{name}({symbol})")
            notifier.send(format_recommendation(approved[0], name))
            _execute(approved[0], name, trade_ids.get(approved[0].id), desk, analyzed_at, account.fx_rate,
                     buy, requested_by)

        log["results"].append({
            "snapshot": snapshot, "research": result.research_log, "errors": result.errors,
            "stages": result.stages, "excluded": result.excluded, "costUsd": round(cost, 4),
            "candidates": [dataclasses.asdict(c) | {"passed": c.passed, "selected": c.selected,
                                                    "rejectReasons": c.reject_reasons}
                           for c in result.candidates]})

    log["costUsd"] = round(total_cost, 4)
    log["screen"] = getattr(args, "screen", None)  # 전략이 돌린 분석이면 종목 선별 결과
    elapsed = (datetime.now().astimezone() - started).total_seconds()
    notifier.log(f"\n소요 {elapsed:.0f}초 · AI 비용 ${total_cost:.3f} · 기록 {run_file}")
    publish_report(cfg, notifier, log, ROOT / run_file, picked)
    if failed:
        raise SystemExit(f"모델 응답 에러로 {failed}개 종목의 분석을 중단했습니다.")


def _run_file_name(started: datetime, strategy: tuple | None, tag: str | None) -> str:
    """실행 기록 위치. 전략이 돌린 분석은 -s{전략 번호}, 일일 리포트가 돌린 분석은 -daily를 붙인다."""
    suffix = f"-s{strategy[0]}" if strategy else f"-{tag}" if tag else ""
    return f"runs/{started:%Y%m%d-%H%M%S}{suffix}.json"


def publish_report(cfg, notifier, log: dict, json_path: Path, picked: list[str]) -> Path:
    """실행 기록을 쓰고, 리포트(PDF)를 만들어 요약과 함께 보낸다. 리포트 경로를 돌려준다."""
    path = report.write_report(log, json_path.with_suffix(".pdf"), cfg.chrome_bin)
    log["reportFile"] = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(log, ensure_ascii=False, indent=1))
    n = report.summary(log)
    strategy, screen = log.get("strategy"), log.get("screen")
    head = (f"[전략 #{strategy['id']} {strategy['name']}]" if strategy
            else "[일일 분석]" if log.get("tag") == "daily" else "[분석 결과]")
    parts = []
    if screen:
        parts.append(f"거래대금 상위 {screen['rankCount']}개 중 규칙 통과 {len(screen['picks'])}개")
    parts.append(f"AI 분석 {n['symbols']}종목")
    parts.append(f"매수 추천 {n['picks']}개" + (f" ({', '.join(picked)})" if picked else ""))
    if n["rejected"]:
        parts.append(f"그 외 시나리오 {n['rejected']}개는 추천하지 않음")
    if n["failed"]:
        parts.append(f"분석 중단 {n['failed']}종목")
    parts.append(f"AI 비용 ${log.get('costUsd', 0):.2f}")
    notifier.send_file(path, f"{head} " + " · ".join(parts) + "\n전체 평가 자료는 첨부 리포트 참고")
    return path


class _LogOnly:
    """알림을 콘솔에만 남기는 notifier (모의 주문 없이 기록만 할 때의 주문 계획처럼 팀에 보낼 필요가 없는 내용)."""

    def __init__(self, notifier):
        self.send = self.log = notifier.log


def _execute(c, name, trade_id, desk: Desk, analyzed_at, fx_rate, buy: bool, requested_by: str):
    """승인된 시나리오의 주문 계획을 세우고, 실행 직전 점검을 거쳐 모의 주문한다 (사용자 컨펌 없음).

    fx_rate는 시나리오 통화 1단위의 원화 가치 (국내면 1, 실행 직전 점검의 1억 원 상한에 쓴다).
    계좌의 매수 가능액·대기 주문 환산에는 달러 환율을 따로 조회해 넘긴다.
    buy가 아니면 주문 계획과 점검 결과를 콘솔에만 남긴다.
    """
    notifier = desk.notifier if buy else _LogOnly(desk.notifier)
    now = datetime.now().astimezone()
    plan = ex.make_plan(c, now.date())
    notifier.send("\n" + format_plan(plan, name))
    if not buy:
        notifier.send("기록만 함 (모의 주문하려면 --buy, 전략은 실행=모의 자동 매수)")
        return
    try:
        last_price = desk.last_price(plan.symbol)
    except (KiwoomApiError, OSError) as e:
        notifier.send(f"[오류] {name} 현재가 조회 실패로 모의 주문하지 않음: {e}")
        return
    if last_price is None:
        notifier.send(f"{name} 모의 주문하지 않음: 현재가를 받지 못함")
        return
    active = {r["symbol"] for r in desk.store.paper_orders(ex.ACTIVE)}
    reasons = ex.pre_trade_checks(c, plan, last_price, analyzed_at, now, fx_rate, active, desk.executor.halted)
    if reasons:
        notifier.send(f"{name} 모의 주문하지 않음: " + "; ".join(reasons))
        return
    try:
        # 중복 종목·매수 가능액은 submit_plan이 주문 잠금 안에서 다시 점검한다 (동시에 도는 전략·예약·CLI 대비).
        desk.executor.submit_plan(c, plan, name, trade_id, requested_by, now, desk.fx_if_needed(plan.currency))
    except OrderRejected as e:
        notifier.send(f"{name} 모의 주문하지 않음: {e}")


def track_paper(client, store: Store, notifier) -> list[str]:
    """진행 중인 모의매매를 완성된 일봉으로 갱신한다. 상태가 바뀐 건마다 알리고, 그 줄들을 돌려준다."""
    active = store.active_trades()
    candles_by_symbol = {}
    lines = []
    for t in active:
        if t["symbol"] not in candles_by_symbol:
            market = "KR" if t["currency"] == "KRW" else "US"
            candles_by_symbol[t["symbol"]] = [
                {"date": c["timestamp"][:10], "open": float(c["openPrice"]),
                 "high": float(c["highPrice"]), "low": float(c["lowPrice"]),
                 "close": float(c["closePrice"])}
                for c in client.completed_daily_candles(t["symbol"], market)]
        candles = [c for c in candles_by_symbol[t["symbol"]] if c["date"] > t["created_date"]]
        o = paper.simulate(t["entry_price"], t["target_price"], t["stop_price"],
                           t["holding_days"], candles)
        if o.status == t["status"]:
            continue
        pnl = None
        if o.status in paper.CLOSED:
            pnl = paper.pnl(t["quantity"], o.fill_price, o.exit_price, t["commission_rate"],
                            t["sell_tax_rate"])
        store.update_outcome(t["id"], o, pnl)
        tail = f" · 손익 {_money(pnl, t['currency'])}" if pnl is not None else ""
        line = (f"#{t['id']} {t['name']} ({t['proposer']}, "
                f"{'선별' if t['selected'] else '탈락'}) {t['status']} → {o.status}{tail}")
        notifier.send(line)
        lines.append(line)
    return lines
def cmd_track(args):
    cfg = load_config()
    client = _client(cfg)
    store = _store(cfg)
    notifier = _notifier(cfg)
    checked = len(store.active_trades())
    track_paper(client, store, notifier)
    notifier.send(f"진행 중 {checked}건 확인 완료")


def cmd_stats(args):
    cfg = load_config(require_broker=False)
    store = _store(cfg)
    notifier = _notifier(cfg)
    notifier.send("AI 시나리오 예측 추적 성적 (선별 여부별)")
    for r in store.summary():
        notifier.send(
            f"  {'선별' if r['selected'] else '탈락'} {r['currency']}: 전체 {r['total']} · "
            f"목표 {r['target']} / 손절 {r['stop']} / 만료 {r['expired']} / 미체결 {r['unfilled']} / "
            f"진행 {r['active']} · 손익 {_money(r['pnl'], r['currency'])}")
    notifier.send("모델별 확률 예측 성적 (청산된 시나리오 기준, Brier는 낮을수록 좋음)")
    stats = store.model_stats()
    if not stats:
        notifier.send("  청산된 시나리오가 아직 없음")
    for r in stats:
        notifier.send(f"  {r['analyst']}: {r['n']}건 · 평균 예측 {r['avg_probability']:.0%} · "
                      f"실제 목표 도달 {r['hit_rate']:.0%} · Brier {r['brier']:.3f}")


# --- 모의 계좌 CLI (웹 화면이 생기기 전 임시 조작 수단) ---

def format_account(s: dict) -> str:
    lines = [f"모의 계좌 ({s['name']}) 총자산 {s['equityKrw']:,.0f}원 = 현금 {s['cashKrw']:,.0f}원 + "
             f"보유 평가 {s['holdingsValueKrw']:,.0f}원",
             f"  초기 자금 {s['initialCapitalKrw']:,.0f}원 대비 {ex.signed_money(s['profitKrw'], 'KRW')} "
             f"({s['profitRate']:+.2%})" if s["profitRate"] is not None else f"  초기 자금 {s['initialCapitalKrw']:,.0f}원"]
    if s["buyingPowerKrw"] is not None:
        lines.append(f"  매수 가능 {s['buyingPowerKrw']:,.0f}원 (체결 대기 매수 {s['pendingKrw']:,.0f}원)")
    if not s["holdings"]:
        lines.append("보유 없음")
    for h in s["holdings"]:
        c = h["currency"]
        last = _money(h["lastPrice"], c) if h["lastPrice"] is not None else "현재가 없음"
        rate = f" ({h['unrealizedRate']:+.2%})" if h["unrealizedRate"] is not None else ""
        levels = (f" · 목표 {_money(h['target'], c)} / 손절 {_money(h['stop'], c)}" if h["target"] is not None
                  else " · 목표·손절 없음")
        lines.append(f"  #{h['id']} {h['name']} ({h['symbol']}) {ex.qty_text(h['quantity'])} · 체결 "
                     f"{_money(h['fillPrice'], c)} · {last} · 평가 {h['valueKrw']:,.0f}원 · "
                     f"{ex.signed_money(h['unrealized'], c)}{rate}{levels}"
                     + (f" · 기한 {h['expireDate']}" if h["expireDate"] else "") + f" · 요청 {h['requestedBy']}")
    lines += [f"참고: {n}" for n in s["notes"]]
    return "\n".join(lines)


def format_order(r) -> str:
    c = r["currency"]
    how = f"지정가 {_money(r['limit_price'], c)}" if r["order_type"] == ex.LIMIT else "시장가"
    parts = [f"#{r['id']} {r['created_at'][:16].replace('T', ' ')} {r['name']} ({r['symbol']}) "
             f"{ex.qty_text(r['quantity'])} {how} · {r['status']}"]
    if r["fill_price"] is not None:
        parts.append(f"체결 {_money(r['fill_price'], c)}")
    if r["target_price"] is not None:
        parts.append(f"목표 {_money(r['target_price'], c)} / 손절 {_money(r['stop_price'], c)}")
    if r["expire_date"]:
        parts.append(f"기한 {r['expire_date']}")
    if r["exit_price"] is not None:
        parts.append(f"청산 {_money(r['exit_price'], c)} ({r['exit_reason']})")
    if r["pnl"] is not None:
        parts.append(f"손익 {ex.signed_money(r['pnl'], c)}")
    parts.append(f"요청 {r['requested_by']}")
    if r["note"]:
        parts.append(r["note"])
    return " · ".join(parts)


def cmd_account(args):
    cfg = load_config(require_broker=False)
    desk = _desk(cfg, client=_client_if_configured(cfg))
    print(format_account(desk.account_summary()))
    if desk.client is None:
        print("참고: 증권사 조회 키가 없어 현재가를 조회하지 않고 체결가로 평가함")


def cmd_orders(args):
    cfg = load_config(require_broker=False)
    rows = _store(cfg).paper_orders(None if args.all else ex.ACTIVE)
    if not rows:
        print("모의 주문 없음" if args.all else "진행 중인 모의 주문 없음 (전체는 --all)")
    for r in rows:
        print(format_order(r))
    print(f"중단 스위치: {'켜짐 (새 모의 매수 막힘)' if HALT_FILE.exists() else '꺼짐'}")


def cmd_fills(args):
    cfg = load_config(require_broker=False)
    rows = _store(cfg).fills(limit=args.limit)
    if not rows:
        print("체결 내역 없음")
    for f in rows:
        c = f["currency"]
        side = "매수" if f["side"] == "BUY" else "매도"
        tax = f" · 세금 {_money(f['tax'], c)}" if f["tax"] else ""
        print(f"{f['filled_at'][:16].replace('T', ' ')} #{f['order_id']} {f['name']} ({f['symbol']}) {side} "
              f"{ex.qty_text(f['quantity'])} @ {_money(f['price'], c)} · 수수료 {_money(f['commission'], c)}{tax} · "
              f"현금 {ex.signed_money(f['cash_change_krw'], 'KRW')} · {f['reason']}")


def _order_command(fn):
    """모의 주문 명령의 거절 사유를 종료 메시지로 보여 준다."""
    try:
        print(fn())
    except (OrderRejected, SymbolError) as e:
        raise SystemExit(f"주문하지 않음: {e}") from None


def cmd_buy(args):
    cfg = load_config()
    desk = _desk(cfg, client=_client(cfg), book=_book(cfg))
    if (args.target is None) != (args.stop is None):
        raise SystemExit("--target과 --stop은 함께 지정해야 합니다.")
    if args.days is not None and args.target is None:
        raise SystemExit("--days는 --target, --stop과 함께 씁니다.")
    _order_command(lambda: desk.buy(args.query, args.quantity, args.by, args.limit, args.target, args.stop,
                                    args.days))


def cmd_sell(args):
    cfg = load_config()
    desk = _desk(cfg, client=_client(cfg), book=_book(cfg))
    _order_command(lambda: desk.sell(args.order_id, args.by))


def cmd_cancel(args):
    cfg = load_config(require_broker=False)
    _order_command(lambda: _desk(cfg).cancel(args.order_id, args.by))


def cmd_modify(args):
    cfg = load_config(require_broker=False)
    desk = _desk(cfg, client=_client_if_configured(cfg))
    _order_command(lambda: "수정함: " + json.dumps(desk.modify(args.order_id, args.target, args.stop, args.days),
                                                  ensure_ascii=False))


def cmd_reservations(args):
    cfg = load_config(require_broker=False)
    book = _book(cfg)
    if not book:
        raise SystemExit("예약은 .env의 REDIS_URL이 있어야 쓸 수 있습니다.")
    if args.cancel is not None:
        print(f"예약 #{args.cancel} 취소함" if book.remove(args.cancel)
              else f"예약 #{args.cancel}이(가) 없음 (이미 실행됐거나 취소됨)")
        return
    items = book.all()
    if not items:
        print("예약 주문 없음")
    for r in items:
        print(f"{r.label} · 예약 {r.created_at[:16].replace('T', ' ')} (다음 정규장 시작 때 실행)")


def cmd_sync(args):
    cfg = load_config()
    store, notifier = _store(cfg), _notifier(cfg)
    print(_desk(cfg, store, notifier, _client(cfg)).sync())


def cmd_serve(args):
    """상시 실행. 모의 체결 확인, 시장 기록, 일일 리포트, 예약 실행, 전략, 생존 신호를 처리한다."""
    cfg = load_config()
    Service(cfg).run(args.sync_every * 60, args.sync_every_open * 60, args.sync_every_burst,
                     args.burst_window * 60, scan=not args.no_scan)


class Service:
    """serve가 쓰는 상태. 예약 주문·전략·생존 신호는 Redis(REDIS_URL)가 있어야 동작한다.

    스레드: 메인 루프(모의 체결 sync, 백업, 시장 기록·자산 기록, 일일 리포트 시작, 예약 실행, 전략 시작, 생존 신호),
    전략 스레드(전략마다), 일일 리포트 스레드(AI 분석 포함, 한 번에 하나). 메인 루프는 AI 분석을 기다리지 않는다.
    """

    db_path = DB_PATH

    def __init__(self, cfg):
        self.cfg = cfg
        self.notifier = _notifier(cfg)
        self.redis = Redis(cfg.redis_url) if cfg.redis_url else None
        self.book = ReservationBook(self.redis) if self.redis else None
        self.strategies = StrategyBook(self.redis) if self.redis else None
        self._calendars: dict[str, tuple[float, dict | None]] = {}
        # 잠금은 처음 쓸 때 만든다 (Service.__new__로 만든 테스트도 쓸 수 있게).
        # 여기서는 스레드를 띄우기 전에 미리 만든다. 기록 저장소는 못 열면 시작할 때 알 수 있게 메인 스레드 것을 연다.
        for name in ("_local", "_order_lock", "_calendar_lock", "store"):
            getattr(self, name)

    # --- 스레드가 같이 쓰는 것 ---

    @cached_property
    def _local(self):
        return threading.local()

    @property
    def store(self) -> Store:
        """이 스레드의 기록 저장소. sqlite3 연결은 만든 스레드에서만 쓸 수 있어 스레드마다 따로 연다."""
        if getattr(self._local, "store", None) is None:
            self._local.store = Store(self.db_path, self.cfg.paper_capital_krw)
        return self._local.store

    @cached_property
    def _order_lock(self):
        """sync와 예약 실행이 같은 포지션을 동시에 건드리지 않게 한다."""
        return threading.RLock()

    @cached_property
    def _calendar_lock(self):
        return threading.Lock()

    def desk(self, client=None) -> Desk:
        """이 스레드의 모의 주문 창구. 장 시간은 서비스가 캐시한 장 운영 정보를 쓴다."""
        return Desk(self.cfg, self.store, self.notifier, client or _client(self.cfg), self.book, HALT_FILE,
                    self.sessions)

    def run(self, sync_every: float, sync_every_open: float, sync_every_burst: float,
            burst_window: float, scan: bool):
        """sync 주기(초): 정규장 시작 전후 burst_window초 안이면 burst, 거래 시간이면 open, 그 외 기본."""
        if self.strategies:
            for s in self.strategies.ensure_defaults(self.cfg.markets):
                self.notifier.send(f"[전략] 기본 전략 생성: {s.summary()}")
        extra = ("예약 주문" + (", 전략 자동 실행" if scan else "") + ", 생존 신호") if self.redis \
            else "REDIS_URL 없음: 예약·전략·생존 신호 꺼짐"
        self.notifier.send(f"paper_engine 서비스 시작 · 시장 {', '.join(self.cfg.markets)} · 모의 체결 확인 "
                           f"(정규장 시작 ±{burst_window / 60:g}분 {sync_every_burst:g}초, 거래 시간 "
                           f"{sync_every_open / 60:g}분, 그 외 {sync_every / 60:g}분마다) · {extra} · 매일 "
                           f"{BACKUP_HOUR}시 백업, 매일 {REPORT_HOUR}시 리포트(AI 분석 포함), 장 마감 후 시장·자산 기록")
        next_sync, next_daily, failing = 0.0, 0.0, set()
        while True:
            jobs = []
            if time.monotonic() >= next_sync:
                jobs.append(("모의 체결 확인", self.sync_job))
                if self.near_open(burst_window):
                    every = sync_every_burst
                elif self.any_market_open():
                    every = sync_every_open
                else:
                    every = sync_every
                next_sync = time.monotonic() + every
            jobs.append(("백업", self.maybe_backup))
            if time.monotonic() >= next_daily:
                jobs += [("시장 기록", self.maybe_record_markets), ("일일 리포트", self.maybe_daily_report)]
                next_daily = time.monotonic() + DAILY_JOBS_EVERY_SEC
            if self.redis:
                jobs.append(("예약 주문", self.run_due_reservations))
                if scan:
                    jobs.append(("전략", self.start_due_strategies))
                jobs.append(("생존 신호", self.beat))
            self.run_jobs(jobs, failing)
            time.sleep(SERVE_POLL_SEC)

    def run_jobs(self, jobs: list, failing: set):
        for name, job in jobs:
            try:
                job()
                if name in failing:
                    self.notifier.send(f"{name} 복구됨")
                failing.discard(name)
            except (KiwoomApiError, OSError, OrderRejected, RedisError, sqlite3.Error) as e:
                # 같은 오류를 주기마다 알리지 않도록 처음 실패했을 때만 알린다.
                if name not in failing:
                    self.notifier.send(f"[오류] {name} 실패: {e}. 복구될 때까지 다시 시도")
                else:
                    print(f"{name} 실패: {e}", flush=True)
                failing.add(name)

    def sync_job(self):
        # 변화(체결·청산·취소)는 체결기가 알리고, 확인 결과 요약은 콘솔에만 남긴다.
        with self._order_lock:
            print(self.desk().sync(), flush=True)

    def beat(self):
        """엔진 생존 신호 (웹이 엔진이 도는지 볼 때 읽는다)."""
        self.redis.set(HEARTBEAT_KEY, datetime.now().astimezone().isoformat(), ex=HEARTBEAT_TTL_SEC)

    # --- 장 시간 ---

    def near_open(self, window_sec: float) -> bool:
        """운영 시장의 정규장 시작 전후 window_sec초 안인지 (체결과 예약 실행을 빨리 확인하려고 sync를 촘촘히 한다)."""
        now = datetime.now().astimezone()
        try:
            return any(abs((start - now).total_seconds()) <= window_sec
                       for m in self.cfg.markets for start, _ in self.sessions(m))
        except (KiwoomApiError, OSError):
            return False

    def any_market_open(self) -> bool:
        """운영 시장 중 하나라도 거래 시간(시간외 포함)이면 True. 장 시간을 모르면 열린 것으로 본다 (자주 확인하는 쪽이 안전)."""
        now = datetime.now().astimezone()
        try:
            return any(scheduler.current_session(self.sessions(m, extended=True), now) for m in self.cfg.markets)
        except (KiwoomApiError, OSError):
            return True

    def sessions(self, market: str, extended: bool = False) -> list:
        """정규장 목록. extended면 시간외까지 포함한 거래 시간 목록.

        메인 루프와 전략·리포트 스레드가 같이 쓴다. 조회는 잠금 밖에서 한다 (겹치면 두 번 조회할 뿐이다).
        """
        with self._calendar_lock:
            fetched, calendar = self._calendars.get(market, (0.0, None))
        if calendar is None or time.monotonic() - fetched > CALENDAR_TTL_SEC:
            calendar = _client(self.cfg).market_calendar(market)
            with self._calendar_lock:
                self._calendars[market] = (time.monotonic(), calendar)
        return (scheduler.trading_sessions if extended else scheduler.regular_sessions)(calendar)

    # --- 백업 ---

    def maybe_backup(self):
        now = datetime.now().astimezone()
        out_dir = self.cfg.backup_dir or BACKUP_DIR
        if now.hour < BACKUP_HOUR or backup.backed_up_today(out_dir, now):
            return
        lines = backup.run_backup(DB_PATH, self.redis, out_dir, now)
        print("백업: " + " · ".join(lines), flush=True)

    # --- 시장 기록과 일일 리포트 ---

    def maybe_record_markets(self):
        """정규장이 끝난 시장의 그 날 기록이 없으면 남긴다 (records/market_log.py). 국내 기록 직후 일별 자산도 남긴다."""
        now = datetime.now().astimezone()
        for m in self.cfg.markets:
            day = market_log.due_day(self.sessions(m), now)
            if day and not self.store.market_day_recorded(m, day):
                client = _client(self.cfg)
                self.notifier.log(format_record(market_log.record_market(client, self.store, m, day, now)))
                if m == "KR":
                    self.record_equity(client, day, now)
                self.maybe_track_paper(client)

    def record_equity(self, client, day: str, now: datetime) -> dict:
        """그 날 일별 자산 (equity_daily). 보유 종목은 현재가(장 마감 후라 종가)로 평가한다."""
        store = self.store
        prices = daily._prices(client, sorted({r["symbol"] for r in store.paper_orders((ex.EXIT_WATCHING,))}))
        s = paper_account.summary(store, prices, daily._fx(client, store), self.cfg.commission)
        store.record_equity(day, s["cashKrw"], s["holdingsValueKrw"], now.isoformat())
        self.notifier.log(f"[자산 기록] {day}: 총자산 {s['equityKrw']:,.0f}원 (현금 {s['cashKrw']:,.0f}원 + 보유 "
                          f"{s['holdingsValueKrw']:,.0f}원)")
        return s

    def maybe_track_paper(self, client=None) -> list[str]:
        """AI 시나리오 예측을 일봉으로 갱신한다 (장 마감 후 시장 기록 직후, 일일 리포트 직전). 진행 중인 것이 없으면 건너뛴다."""
        if not self.store.active_trades():
            return []
        return track_paper(client or _client(self.cfg), self.store, self.notifier)

    @cached_property
    def _daily_report_lock(self):
        """AI 분석을 하는 일일 리포트는 한 번에 하나만 (비용 중복 방지). 잡은 스레드가 아니라 리포트 스레드가 푼다."""
        return threading.Lock()

    def maybe_daily_report(self) -> threading.Thread | None:
        """REPORT_HOUR 이후 오늘 자동 발송분이 없으면 리포트 스레드를 띄운다 (AI 분석 10~20분, 메인 루프를 막지 않는다)."""
        now = datetime.now().astimezone()
        if now.hour < REPORT_HOUR or any(REPORT_DIR.glob(f"daily-{now:%Y%m%d}.*")):
            return None
        return self.start_daily_report(1, scheduled=True, analyze=True)

    def start_daily_report(self, days: int, scheduled: bool, analyze: bool) -> threading.Thread | None:
        """리포트 스레드를 띄운다. 이미 만드는 중이면 띄우지 않고 None."""
        if not self._daily_report_lock.acquire(blocking=False):
            return None
        t = threading.Thread(target=self._daily_report_safely, args=(days, scheduled, analyze),
                             name="daily-report", daemon=True)
        try:
            t.start()
        except BaseException:
            self._daily_report_lock.release()
            raise
        return t

    def _daily_report_safely(self, days: int, scheduled: bool, analyze: bool):
        try:
            self.send_daily_report(days, scheduled, analyze)
        except Exception as e:  # 스레드에서 난 오류가 조용히 사라지지 않게 알린다
            traceback.print_exc()
            # 자동 발송은 메인 루프가 1분마다 다시 시도하므로 같은 날에는 처음 실패만 알린다
            today = f"{datetime.now():%Y%m%d}"
            if not scheduled or getattr(self, "_daily_report_failed_day", None) != today:
                self.notifier.send(f"[오류] 일일 리포트 실패: {type(e).__name__}: {e}")
            if scheduled:
                self._daily_report_failed_day = today
        finally:
            self._daily_report_lock.release()

    def send_daily_report(self, days: int = 1, scheduled: bool = False, analyze: bool = False) -> Path:
        """일일 리포트(PDF)를 만들어 요약과 함께 보낸다. 매일 자동 발송분은 날짜만, 요청분은 시각까지 파일 이름에 넣는다.

        AI 분석은 prepare_daily_analysis 참고 (오늘 분석이 있으면 재사용, analyze면 새로).
        """
        path, data = build_daily_report(self.cfg, self.store, self.redis, self.notifier, days, scheduled, analyze)
        self.notifier.send_file(path, daily.caption(data))
        return path

    # --- 예약 주문 ---

    def run_due_reservations(self):
        now = datetime.now().astimezone()
        due = [r for r in self.book.all() if r.market in self.cfg.markets and r.is_due(self.sessions(r.market), now)]
        for r in due:
            if not self.book.remove(r.id):
                continue  # 그사이 취소됨
            try:
                with self._order_lock:
                    self.execute_reservation(r, now)
            except OrderRejected as e:
                self.notifier.send(f"[예약] {r.label} 실행하지 않음: {e}")
            except (KiwoomApiError, OSError) as e:
                self.notifier.send(f"[예약] {r.label} 실패: {e}")

    def execute_reservation(self, r, now: datetime):
        """예약 시각에는 요청한 사람이 없을 수 있으므로 다시 묻지 않는다. 점검은 즉시 주문과 같다."""
        self.desk().run_reservation(r, now)

    # --- 전략 ---

    def start_due_strategies(self):
        now = datetime.now().astimezone()
        for s in self.strategies.all():
            if not s.active or s.market not in self.cfg.markets:
                continue
            start = scheduler.upcoming_scan(self.sessions(s.market), now)
            if start and scheduler.claim_scan(self.redis, s.id, start):
                threading.Thread(target=self._run_strategy_safely, args=(s, start), daemon=True).start()

    def _run_strategy_safely(self, s, start: datetime | None):
        try:
            summary = run_strategy(self.cfg, self.notifier, s, start, self.redis)
            self.strategies.record_run(s.id, summary)
        except Exception as e:  # 스레드에서 난 오류가 조용히 사라지지 않게 알린다
            self.notifier.send(f"[오류] 전략 #{s.id} {s.name} 실패: {e}")


def screen_market(cfg, market: str, candidates: int, reports: bool = False,
                  exclude: dict[str, str] | frozenset = frozenset()) -> dict:
    """거래대금 상위에서 ETF 등을 빼고 규칙으로 점수를 매긴다. 결과는 알림과 에이전트 설명에 쓴다.

    reports면 최근 증권사 리포트 헤드라인의 종목(broker_reports.candidates)도 같은 규칙에 태운다. 거래대금 상위에서
    이미 점검한 종목과 exclude(종목코드 → 사유. 보유·자동 관리·최근 분석 종목)는 빼고 REPORT_CANDIDATES개까지.
    pick과 탈락에는 출처(origin)를 붙인다.
    """
    client = _client(cfg)
    ranks = client.rankings("MARKET_TRADING_AMOUNT", market, "1d", count=100)
    infos = {i["symbol"]: i for i in client.stocks([r["symbol"] for r in ranks])}
    excluded = [{"symbol": r["symbol"], "name": infos.get(r["symbol"], {}).get("name", ""),
                 "reason": screen.eligible(infos[r["symbol"]]) if r["symbol"] in infos else "종목 정보 없음"}
                for r in ranks]
    excluded = [e for e in excluded if e["reason"]]
    eligible = [r for r in ranks if r["symbol"] in infos and not screen.eligible(infos[r["symbol"]])]
    calendar = client.market_calendar(market)
    picks, dropped = [], []

    def check(symbol, name, trading_amount, extra):
        candles = drop_incomplete(client.daily_candles(symbol, 130), calendar, datetime.now(timezone.utc))
        if trading_amount is None:  # 리포트 후보는 순위가 없어 마지막 완성 봉으로 거래대금을 어림한다
            trading_amount = float(candles[-1]["closePrice"]) * float(candles[-1]["volume"]) if candles else 0.0
        result = screen.score(symbol, name, candles, trading_amount)
        if isinstance(result, screen.Pick):
            picks.append(dataclasses.asdict(result) | extra)
            return True
        dropped.append({"symbol": symbol, "name": name, "reason": result} | extra)
        return False

    for r in eligible[:candidates]:
        check(r["symbol"], infos[r["symbol"]]["name"], float(r["tradingAmount"]),
              {"tradingAmountRank": r["rank"], "origin": ORIGIN_RANK})
    result = {"market": market, "at": datetime.now().astimezone().isoformat(),
              "rankedAt": None, "rankCount": len(ranks), "eligibleCount": len(eligible),
              "checked": min(len(eligible), candidates), "picks": picks, "dropped": dropped,
              "excluded": excluded, "rules": screen.__doc__}
    if reports:
        checked = {r["symbol"] for r in eligible[:candidates]}
        result["reportCandidates"] = _screen_reports(client, market, checked, exclude, check)
    picks.sort(key=lambda p: p["score"], reverse=True)
    return result

def _screen_reports(client, market: str, checked: set[str], exclude, check) -> dict:
    """증권사 리포트 후보를 중복·제외 규칙으로 거른 뒤 check(규칙 점수)에 태운다. 결과 요약을 돌려준다."""
    out = {"fetched": [], "skipped": [], "checked": 0, "passed": 0, "dropped": 0, "error": None}
    try:
        found = broker_reports.candidates(market, listed_stocks(client, MARKET_LISTS[market]))
    except Exception as e:  # 리포트 후보는 보조라 실패해도 거래대금 상위 선별은 그대로 쓴다
        out["error"] = f"{type(e).__name__}: {e}"
        return out
    out["fetched"] = found
    fresh = []
    for c in found:
        if c["symbol"] in checked:
            reason = "거래대금 상위 후보와 중복"
        elif c["symbol"] in exclude:
            reason = exclude[c["symbol"]] if isinstance(exclude, dict) else "제외 대상"
        elif len(fresh) >= REPORT_CANDIDATES:
            reason = f"리포트 후보 {REPORT_CANDIDATES}개 초과"
        else:
            fresh.append(c)
            continue
        out["skipped"].append({"symbol": c["symbol"], "name": c["name"], "reason": reason})
    infos = {i["symbol"]: i for i in client.stocks([c["symbol"] for c in fresh])} if fresh else {}
    for c in fresh:
        extra = {"tradingAmountRank": None, "origin": ORIGIN_REPORT,
                 **{k: c.get(k) for k in ("broker", "targetPrice", "direction", "title", "publishedAt")}}
        reason = screen.eligible(infos[c["symbol"]]) if c["symbol"] in infos else "종목 정보 없음"
        if reason:
            out["skipped"].append({"symbol": c["symbol"], "name": c["name"], "reason": reason})
            continue
        out["checked"] += 1
        if check(c["symbol"], c["name"], None, extra):
            out["passed"] += 1
        else:
            out["dropped"] += 1
    return out


def recently_analyzed(now: datetime) -> dict[str, str]:
    """최근 24시간 안에 분석한 종목(일일 분석 포함) → 사유. 예: "이미 분석됨 (runs/20260930-070512-daily.json 07:05)"."""
    out = {}
    for symbol, r in daily.recent_analyses(ROOT / "runs", now, include_daily=True).items():
        try:
            at = datetime.fromisoformat(r["startedAt"]).astimezone(now.tzinfo)
            when = f"{at:%H:%M}" if at.date() == now.date() else f"{at:%m-%d %H:%M}"
            out[symbol] = f"이미 분석됨 ({r['runFile']} {when})"
        except (KeyError, TypeError, ValueError):
            out[symbol] = f"최근 {daily.RECENT_ANALYSIS_HOURS}시간 안에 분석함"
    return out
def exclusions(cfg, notifier, now: datetime, recent: dict[str, str] | None = None) -> dict[str, str]:
    """리포트 후보에서 뺄 종목 → 사유: 모의 계좌 보유, 체결 대기 모의 주문, 최근 24시간 안에 분석한 종목.

    recent는 recently_analyzed의 결과 (없으면 여기서 읽는다).
    """
    out: dict[str, str] = {}
    for r in _store(cfg).paper_orders(ex.ACTIVE):
        out.setdefault(r["symbol"], "보유 종목" if r["status"] == ex.EXIT_WATCHING else "모의 주문 체결 대기")
    for symbol, reason in (recently_analyzed(now) if recent is None else recent).items():
        out.setdefault(symbol, reason)
    return out


def analysis_targets(picks: list[dict], n: int, skip: dict[str, str] | None = None) -> list[str]:
    """AI 분석할 종목코드. 점수순 n개이되, 리포트 출처 pick이 하나도 못 들었으면 마지막 자리를 그것으로 바꾼다.

    skip(종목코드 → 사유. 최근 24시간 안에 분석한 종목)에 있는 pick은 건너뛰고 다음 순위로 채운다. 건너뛴 pick에는
    "skipped"에 사유를 붙인다 (picks의 순서·점수는 그대로). 리포트 출처 규칙도 건너뛰지 않은 pick 안에서 적용한다.
    """
    skip = skip or {}
    top, passed = [], []
    for p in picks:
        if len(top) >= n:
            break
        (passed if p["symbol"] in skip else top).append(p)
    if top and not any(p.get("origin") == ORIGIN_REPORT for p in top):
        for p in picks:
            if p.get("origin") != ORIGIN_REPORT:
                continue
            if p["symbol"] in skip:
                passed.append(p)
                continue
            top = top[:-1] + [p]
            break
    for p in passed:
        p["skipped"] = skip[p["symbol"]]
    return [p["symbol"] for p in top]


def _skip_label(reason: str) -> str:
    """알림용 짧은 분석 제외 사유: 기록 파일 이름을 뺀다. 예: "이미 분석됨 07:05"."""
    return re.sub(r" \(runs/\S+ (.+)\)$", r" \1", reason)


def _report_tag(p: dict, currency: str) -> str:
    """리포트 출처 pick의 꼬리표. 예: [리포트: 미래에셋증권 목표가 186,000원 ↑]"""
    parts = [p.get("broker") or "증권사 미상"]
    if p.get("targetPrice"):
        parts.append(f"목표가 {_money(p['targetPrice'], currency)}")
    if p.get("direction") in DIRECTION_ARROW:
        parts.append(DIRECTION_ARROW[p["direction"]])
    return f" [리포트: {' '.join(parts)}]"


def format_screen(result: dict, title: str, start: datetime | None) -> str:
    market, currency = result["market"], "KRW" if result["market"] == "KR" else "USD"
    when = f" · 정규장 {start:%m-%d %H:%M} 시작" if start else ""
    lines = [f"[종목 선별] {title} ({MARKET_LABEL[market]}){when}",
             f"거래대금 상위 {result['rankCount']}개 → ETF·ETN 등 제외 {result['eligibleCount']}개 → 상위 "
             f"{result['checked']}개 점검, 규칙 통과 {len(result['picks'])}개 (탈락 {len(result['dropped'])}개)"]
    rc = result.get("reportCandidates")
    if rc is not None:
        lines.append(f"증권사 리포트 후보 {len(rc['fetched'])}개 → 중복·제외 {len(rc['skipped'])}개 → "
                     f"점검 {rc['checked']}개, 규칙 통과 {rc['passed']}개"
                     + (f" (리포트 조회 실패: {rc['error']})" if rc.get("error") else ""))
    for i, p in enumerate(result["picks"][:SCAN_SHOW], 1):
        tag = _report_tag(p, currency) if p.get("origin") == ORIGIN_REPORT else ""
        if p.get("skipped"):
            tag += f" [분석 제외: {_skip_label(p['skipped'])}]"
        lines.append(f"{i}. {p['name']} ({p['symbol']}) {p['score']:.0f}점 · 종가 {_money(p['close'], currency)} · "
                     f"20일 {p['change20d']:+.1%} · RSI {p['rsi']:.0f} · ATR {p['atr_ratio']:.1%} · "
                     f"거래대금 {_money(p['trading_amount'], currency)}{tag}")
    if not result["picks"]:
        lines.append("규칙을 통과한 종목 없음")
    if rc and rc["skipped"]:
        lines.append("리포트 후보 제외: " + ", ".join(f"{x['name']}({x['symbol']}) {x['reason']}"
                                                  for x in rc["skipped"]))
    lines.append("규칙 점수는 추세·모멘텀·RSI·변동성 기준이며 매수 추천이 아님")
    return "\n".join(lines)
def run_strategy(cfg, notifier, s, start: datetime | None, redis: Redis | None) -> str:
    """전략 한 번 실행: 규칙 선별 → 상위 몇 개 AI 교차검증 (실행이 paper면 승인된 시나리오를 모의 자동 매수).

    팀 채널에는 매수 추천과 요약만 보내고, 선별 결과와 평가 자료는 리포트(PDF)로 첨부한다.
    """
    # 최근 24시간 안에 분석한 종목(일일 분석 포함)은 AI 분석 대상에서 빼고 다음 순위로 채운다. 보유·주문 종목은
    # 리포트 후보에서만 뺀다 (일일 분석이 없던 날에는 전략이 분석할 수 있게).
    now = datetime.now().astimezone()
    recent = recently_analyzed(now)
    exclude = exclusions(cfg, notifier, now, recent)
    result = screen_market(cfg, s.market, s.candidates, reports=s.reports, exclude=exclude)
    result["strategy"] = {"id": s.id, "name": s.name, "action": s.action}
    top = analysis_targets(result["picks"], s.analyze_top, recent)
    result["analyzed"], result["runFile"] = top, None
    result["skipped"] = [{"symbol": p["symbol"], "name": p["name"], "reason": p["skipped"]}
                         for p in result["picks"] if p.get("skipped")]
    notifier.log(format_screen(result, f"#{s.id} {s.name}", start))
    if top and cfg.llm_api_key and cfg.analysts:
        mode = "승인되면 모의 자동 매수" if s.auto_buy else "알림만, 모의 주문 없음"
        notifier.log(f"상위 {len(top)}개 AI 교차검증 ({mode}, {s.limit_text()}): {', '.join(top)}")
        usd_krw = float(_client(cfg).exchange_rate()["rate"]) if s.max_currency == "USD" else 1.0
        args = argparse.Namespace(symbols=top, equity=None, commission=None, no_web=False, buy=s.auto_buy,
                                  by=f"strategy:{s.id}", strategy=(s.id, s.name),
                                  max_amount_krw=s.max_amount_krw(usd_krw), screen=result,
                                  fractional=s.fractional)
        try:
            cmd_analyze(args)
        except SystemExit as e:
            notifier.log(f"[전략 #{s.id}] AI 분석 일부 실패: {e}")  # 종목별 오류는 이미 알렸다
        result["runFile"] = getattr(args, "run_file", None)
    else:
        # AI 분석 없이 선별만 한 경우에도 리포트를 보낸다.
        now = datetime.now().astimezone()
        log = {"startedAt": now.isoformat(), "strategy": {"id": s.id, "name": s.name}, "paperBuy": False,
               "results": [], "costUsd": 0.0, "screen": result}
        publish_report(cfg, notifier, log, ROOT / f"runs/{now:%Y%m%d-%H%M%S}-s{s.id}.json", [])
    if redis:
        scheduler.save_scan_result(redis, s.id, result)
    names = ", ".join(p["name"] for p in result["picks"][:3]) or "없음"
    return f"규칙 통과 {len(result['picks'])}개, 상위 {names}" + (f", AI 분석 {len(top)}개" if top else "")


def cmd_scan(args):
    """전략 없이 바로 선별만 한다 (AI 분석은 --no-ai가 없으면 상위 3개, 모의 주문 없음). --reports면 증권사 리포트 후보도."""
    cfg = load_config()
    s = Strategy(id=0, name="수동 선별", market=args.market,
                 analyze_top=0 if args.no_ai else SCAN_ANALYZE_TOP, reports=args.reports)
    run_strategy(cfg, _notifier(cfg), s, None, None)


def cmd_info(args):
    """읽기 전용 조회 (JSON). 웹이 생기기 전 CLI 조회와 웹(4C)이 쓴다."""
    cfg = load_config(require_broker=False)
    redis = Redis(cfg.redis_url) if cfg.redis_url else None
    store = _store(cfg)
    if args.what == "strategies":
        data = info.strategies(redis) if redis else []
    elif args.what == "scans":
        data = info.scan_results(redis, args.strategy, args.market) if redis else []
    elif args.what == "stock":
        if not args.query:
            raise SystemExit("info stock에는 종목코드나 이름이 필요합니다")
        data = info.stock(" ".join(args.query), redis, store)
    elif args.what == "holdings":
        data = _desk(cfg, store, client=_client_if_configured(cfg)).account_summary()
    else:
        data = info.orders(redis, store)
    print(info.dump(data))


def cmd_report(args):
    """실행 기록으로 리포트를 다시 만든다. --send면 요약과 함께 보낸다."""
    cfg = load_config(require_broker=False)
    json_path = Path(args.run_file).resolve()
    log = json.loads(json_path.read_text())
    if args.send:
        picked = [f"{r['snapshot']['name']}({r['snapshot']['symbol']})" for r in log.get("results") or []
                  if any(c.get("selected") for c in r.get("candidates") or [])]
        path = publish_report(cfg, _notifier(cfg), log, json_path, picked)
    else:
        path = report.write_report(log, json_path.with_suffix(".pdf"), cfg.chrome_bin)
    print(path)


def format_record(r: dict) -> str:
    currency = "KRW" if r["market"] == "KR" else "USD"
    bench = "-" if r["benchClose"] is None else _money(r["benchClose"], currency)
    change = "" if r["benchChange"] is None else f" ({r['benchChange']:+.2%})"
    fx = "-" if r["usdKrw"] is None else f"{r['usdKrw']:,.2f}"
    return (f"[시장 기록] {MARKET_LABEL[r['market']]} {r['day']}: 거래대금 상위 {r['amount']} · 상승 {r['gainers']} · "
            f"하락 {r['losers']} · 벤치마크 {market_log.BENCHMARK[r['market']]} {bench}{change} · 환율 {fx}")
def cmd_record(args):
    """시장 기록을 지금 남긴다. 랭킹은 지금 조회한 값이므로 --day는 방금 끝난 거래일에만 맞다."""
    cfg = load_config()
    client = _client(cfg)
    now = datetime.now().astimezone()
    day = args.day or market_log.due_day(
        scheduler.regular_sessions(client.market_calendar(args.market)), now)
    if not day:
        raise SystemExit("기록할 거래일이 없습니다. 정규장 종료 15분 뒤부터 다음 정규장 시작 전까지 기록할 수 있습니다.")
    print(format_record(market_log.record_market(client, _store(cfg), args.market, day, now)))


def _daily_data(cfg, store: Store, redis: Redis | None, now: datetime, days: int, **analysis) -> dict:
    return daily.collect(store, redis, _client(cfg), now, days, markets=cfg.markets, commission=cfg.commission,
                         runs_dir=ROOT / "runs", halt_file=HALT_FILE, backup_dir=cfg.backup_dir or BACKUP_DIR,
                         **analysis)


def make_daily_report(cfg, store: Store, redis: Redis | None, now: datetime, days: int,
                      scheduled: bool, **analysis) -> tuple[Path, dict]:
    """일일 리포트 파일을 만들고 (경로, 자료)를 돌려준다. 모의 계좌를 현재가로 평가한다 (주문 없음).

    analysis는 daily.collect의 AI 분석 인자 (prepare_daily_analysis의 결과).
    """
    data = _daily_data(cfg, store, redis, now, days, **analysis)
    name = f"daily-{now:%Y%m%d}" if scheduled else f"daily-{now:%Y%m%d-%H%M%S}"
    return report.write_daily_report(data, REPORT_DIR / f"{name}.pdf", cfg.chrome_bin), data


def run_daily_analysis(cfg, notifier, symbols: list[str], roles: dict[str, str] | None = None,
                       earlier: list[dict] | None = None) -> str | None:
    """일일 리포트용 AI 교차검증 (모의 주문 없음, 웹 조사 포함). 실행 기록 위치(runs/…-daily.json)를 돌려준다.

    AI 설정이 없거나 종목이 없으면 돌리지 않고 None. 분석 리포트(PDF)와 요약은 cmd_analyze가 '[일일 분석]'으로 보낸다.
    roles와 earlier(최근 분석을 재사용한 종목)는 기록에 넣어 둔다 (같은 날 리포트를 다시 만들 때 쓴다).
    """
    if not (cfg.llm_api_key and cfg.analysts and symbols):
        return None
    args = argparse.Namespace(symbols=list(symbols), equity=None, commission=None, no_web=False, buy=False,
                              by="daily", strategy=None, max_amount_krw=None, screen=None, fractional=False,
                              tag="daily", roles=roles, earlier=earlier)
    try:
        cmd_analyze(args)
    except SystemExit as e:
        notifier.log(f"[일일 분석] AI 분석 일부 실패: {e}")  # 종목별 오류는 이미 알렸다
    return getattr(args, "run_file", None)


def prepare_daily_analysis(cfg, store: Store, redis: Redis | None, notifier, days: int, scheduled: bool,
                           analyze: bool) -> dict:
    """일일 리포트의 AI 분석을 준비하고 daily.collect에 넘길 인자를 돌려준다.

    오늘 일일 분석 기록이 있으면 재사용한다 (비용 중복 방지). 단 사용자가 분석을 요청했으면(analyze이고 자동 발송이
    아니면) 새로 한다. 기록이 없고 analyze가 아니면 분석하지 않는다. 분석이 실패해도 이유만 남기고 리포트는 만든다.
    대상은 daily.analysis_symbols: 최근 24시간 안에 전략·수동 분석이 한 종목은 그 결과를 쓰고(earlier),
    활성 전략이 분석하는 시장의 거래대금 상위는 뺀다.
    """
    now = datetime.now().astimezone()
    existing = daily.latest_daily_run(ROOT / "runs", f"{now:%Y%m%d}")
    if existing and not (analyze and not scheduled):
        return {"analysis_run": existing, "reused": True}
    if not analyze:
        return {"analysis_notes": ["오늘 일일 분석 없음 (새로 분석하려면 daily-report --analyze)"]}
    if not (cfg.llm_api_key and cfg.analysts):
        return {"analysis_notes": ["AI 설정 없음 (.env의 DEVPASS_APIKEY, ANALYSTS)"]}
    notes = []
    items = daily.analysis_symbols(_daily_data(cfg, store, redis, now, days),
                                   daily.recent_analyses(ROOT / "runs", now),
                                   daily.active_strategy_markets(redis, notes), notes=notes)
    earlier = [x for x in items if x["earlier"]]
    targets = [x for x in items if not x["earlier"]]
    if not targets:
        return {"earlier": earlier, "analysis_notes": notes + ["새로 분석할 종목 없음"]}
    roles = {t["symbol"]: t["role"] for t in targets}
    (notifier.log if scheduled else notifier.send)(
        f"AI 분석 {len(targets)}종목 시작 (약 $0.3/종목), 끝나면 리포트를 보냄: "
        + ", ".join(f"{t['name']}({t['symbol']})" for t in targets))
    try:
        run_file = run_daily_analysis(cfg, notifier, [t["symbol"] for t in targets], roles, earlier)
    except Exception as e:  # 분석이 실패해도 리포트는 보낸다
        traceback.print_exc()
        return {"earlier": earlier, "analysis_notes": notes + [f"AI 분석 실패: {type(e).__name__}: {e}"]}
    path = ROOT / run_file if run_file else None
    if not (path and path.exists()):
        return {"earlier": earlier, "analysis_notes": notes + ["AI 분석 기록이 없음 (분석이 끝나지 않음)"]}
    return {"analysis_run": path, "roles": roles, "earlier": earlier, "analysis_notes": notes}


def build_daily_report(cfg, store: Store, redis: Redis | None, notifier, days: int, scheduled: bool,
                       analyze: bool) -> tuple[Path, dict]:
    """AI 분석(필요하면)을 하고 일일 리포트 파일을 만든다. 계좌는 분석이 끝난 뒤 다시 평가한다."""
    if scheduled and store.active_trades():  # 리포트가 최신 예측 추적 결과를 담게 한다
        try:
            track_paper(_client(cfg), store, notifier)
        except (KiwoomApiError, OSError) as e:
            notifier.log(f"[예측 추적 갱신] 실패: {e}")
    analysis = prepare_daily_analysis(cfg, store, redis, notifier, days, scheduled, analyze)
    return make_daily_report(cfg, store, redis, datetime.now().astimezone(), days, scheduled, **analysis)


def cmd_daily_report(args):
    cfg = load_config()
    redis = Redis(cfg.redis_url) if cfg.redis_url else None
    notifier = _notifier(cfg)
    path, data = build_daily_report(cfg, _store(cfg), redis, notifier, args.days, False, args.analyze)
    if args.send:
        notifier.send_file(path, daily.caption(data))
    print(path)


def cmd_backup(args):
    cfg = load_config(require_broker=False)
    redis = Redis(cfg.redis_url) if cfg.redis_url else None
    if args.restore_redis:
        if not redis:
            raise SystemExit(".env에 REDIS_URL이 없습니다.")
        print(f"Redis 키 {backup.restore_redis(redis, Path(args.restore_redis))}개 복원")
        return
    out_dir = cfg.backup_dir or BACKUP_DIR
    for line in backup.run_backup(DB_PATH, redis, out_dir, datetime.now().astimezone()):
        print(line)
    print(f"위치: {out_dir}")


def cmd_halt(args):
    HALT_FILE.parent.mkdir(parents=True, exist_ok=True)
    HALT_FILE.write_text(f"{datetime.now().astimezone().isoformat()}\n")
    print("중단 스위치를 켰습니다. 새 모의 매수를 받지 않습니다. 이미 접수한 주문의 체결과 청산은 계속합니다.")


def cmd_resume(args):
    HALT_FILE.unlink(missing_ok=True)
    print("중단 스위치를 껐습니다.")


def _positive(text: str) -> float:
    value = float(text.replace(",", ""))
    if value <= 0:
        raise argparse.ArgumentTypeError(f"0보다 커야 합니다: {text}")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(prog="paper_engine", description="모의매매 엔진 (키움 조회 + 모의 계좌)")
    sub = parser.add_subparsers(required=True)

    def add(name, func, help_):
        p = sub.add_parser(name, help=help_, description=help_)
        p.set_defaults(func=func)
        return p

    def add_account_options(p):
        p.add_argument("--equity", type=float,
                       help="가상 총자산(원). 지정하면 모의 계좌 대신 이 값으로 평가")
        p.add_argument("--commission", type=float, help="--equity 사용 시 수수료율 (기본: PAPER_COMMISSION_KR|US)")
        p.add_argument("--fractional", action="store_true",
                       help="미국 종목에서 1주를 못 살 때 소수점 방식(금액 ÷ 진입가만큼 소수점 수량)으로 계산")

    p = add("snapshot", cmd_snapshot, "종목 스냅샷(지표 포함)을 JSON으로 출력")
    p.add_argument("symbols", nargs="+")

    p = add("evaluate", cmd_evaluate, "시나리오 JSON을 리스크 엔진으로 평가")
    p.add_argument("scenario")
    add_account_options(p)

    p = add("analyze", cmd_analyze, "AI 교차검증으로 시나리오를 만들고 평가. 기본은 기록만, --buy면 승인된 시나리오를 모의 매수")
    p.add_argument("symbols", nargs="+")
    add_account_options(p)
    p.add_argument("--no-web", action="store_true", help="웹 조사 단계를 건너뜀")
    p.add_argument("--buy", action="store_true", help="승인된 시나리오를 실행 직전 점검 후 모의 계좌로 매수 (진입가 지정가)")
    p.add_argument("--by", default="cli", metavar="NAME", help="요청자 (기본 cli)")

    add("track", cmd_track, "AI 시나리오 예측 추적: 체결·청산 상태를 완성된 일봉으로 갱신")
    add("stats", cmd_stats, "예측 추적 성적과 모델별 예측 성적")
    add("account", cmd_account, "모의 계좌 요약 (현금, 평가액, 손익, 보유)")
    p = add("orders", cmd_orders, "모의 주문 목록 (기본: 진행 중)")
    p.add_argument("--all", action="store_true", help="종료·취소된 주문도 모두")
    p = add("fills", cmd_fills, "모의 체결 내역 (최신순)")
    p.add_argument("--limit", type=int, default=20, help="최근 N건 (기본 20)")
    p = add("buy", cmd_buy, "모의 매수. 정규장 밖 시장가는 다음 정규장 시작 예약 (REDIS_URL 필요)")
    p.add_argument("query", help="종목코드나 정확한 종목명")
    p.add_argument("quantity", type=_positive, help="수량 (국내는 정수 주, 미국은 소수점 가능)")
    p.add_argument("--limit", type=_positive, metavar="P", help="지정가 (오늘 정규장 끝까지 유효). 없으면 시장가")
    p.add_argument("--target", type=_positive, metavar="P", help="목표가 (--stop과 함께. 체결 후 자동 청산 감시)")
    p.add_argument("--stop", type=_positive, metavar="P", help="손절가")
    p.add_argument("--days", type=int, metavar="N", help="보유 기한 (달력 일수, 기본 30. 지나면 다음 정규장에서 청산)")
    p.add_argument("--by", default="cli", metavar="NAME", help="요청자 (기본 cli)")
    p = add("sell", cmd_sell, "보유 포지션 전량 모의 매도 (체결 대기 주문이면 취소, 정규장 밖이면 예약)")
    p.add_argument("order_id", type=int, help="모의 주문 번호 (orders로 확인)")
    p.add_argument("--by", default="cli", metavar="NAME", help="요청자 (기본 cli)")
    p = add("cancel", cmd_cancel, "체결 대기 모의 주문 취소")
    p.add_argument("order_id", type=int)
    p.add_argument("--by", default="cli", metavar="NAME", help="요청자 (기본 cli)")
    p = add("modify", cmd_modify, "진행 중 모의 주문의 목표가·손절가·기한 수정")
    p.add_argument("order_id", type=int)
    p.add_argument("--target", type=_positive, metavar="P")
    p.add_argument("--stop", type=_positive, metavar="P")
    p.add_argument("--days", type=int, metavar="N", help="오늘부터 달력 일수")
    p = add("reservations", cmd_reservations, "예약 주문 목록 (REDIS_URL 필요)")
    p.add_argument("--cancel", type=int, metavar="ID", help="예약 취소")
    add("sync", cmd_sync, "모의 체결·청산을 지금 한 번 확인 (지정가 체결, 당일 미체결 취소, 목표·손절·기한 청산)")
    p = add("serve", cmd_serve, "상시 실행: 모의 체결 확인, 시장·자산 기록, 일일 리포트, 예약, 전략, 생존 신호")
    p.add_argument("--sync-every", type=float, default=5, metavar="MIN",
                   help="장 밖 모의 체결 확인 주기 (분, 기본 5)")
    p.add_argument("--sync-every-burst", type=float, default=10, metavar="SEC",
                   help="정규장 시작 전후 확인 주기 (초, 기본 10)")
    p.add_argument("--burst-window", type=float, default=2, metavar="MIN",
                   help="정규장 시작 전후 촘촘히 확인하는 구간 (분, 기본 앞뒤 2분)")
    p.add_argument("--sync-every-open", type=float, default=1, metavar="MIN",
                   help="거래 시간(시간외 포함) 중 확인 주기 (분, 기본 1). 체결과 손절 대응이 빨라진다")
    p.add_argument("--no-scan", action="store_true", help="매일 개장 1시간 전 전략 실행을 끔")
    p = add("scan", cmd_scan, "거래대금 상위에서 스윙 후보 종목 선별 (ETF 제외) 후 알림")
    p.add_argument("market", choices=["KR", "US"])
    p.add_argument("--no-ai", action="store_true", help="상위 종목 AI 교차검증을 건너뜀")
    p.add_argument("--reports", action="store_true",
                   help="최근 증권사 리포트 헤드라인의 종목도 후보에 넣음 (보유·주문·최근 분석 종목은 뺌)")
    p = add("info", cmd_info, "읽기 전용 조회 (JSON): 전략, 선별 결과, 종목별 선정 이유, 모의 계좌 보유, 모의 주문")
    p.add_argument("what", choices=["strategies", "scans", "stock", "holdings", "orders"])
    p.add_argument("query", nargs="*", help="stock: 종목코드나 이름")
    p.add_argument("--strategy", type=int)
    p.add_argument("--market", choices=["KR", "US"])
    p = add("report", cmd_report, "실행 기록(runs/*.json)으로 분석 리포트(PDF)를 다시 만듦")
    p.add_argument("run_file")
    p.add_argument("--send", action="store_true", help="요약과 함께 알림으로 보냄")
    p = add("backup", cmd_backup, "기록 저장소(SQLite)와 Redis(paper:*) 백업. serve는 매일 자동으로 한다")
    p.add_argument("--restore-redis", metavar="FILE", help="백업 JSON으로 Redis paper:* 키 복원")
    p = add("record", cmd_record, "시장 기록: 거래대금 상위 100, 등락률 상위·하위 30, 벤치마크, 환율 (serve는 장 마감 후 자동)")
    p.add_argument("market", choices=["KR", "US"])
    p.add_argument("--day", help="거래일 YYYY-MM-DD (기본: 방금 끝난 정규장)")
    p = add("daily-report", cmd_daily_report,
            "일일 리포트(PDF): 모의 계좌, AI 분석, 모의 주문, 시장 기록, 전략·분석 기록 (오늘 일일 분석이 있으면 재사용)")
    p.add_argument("--days", type=int, default=1, choices=range(1, MAX_REPORT_DAYS + 1),
                   metavar="N", help=f"최근 N일 (1~{MAX_REPORT_DAYS}, 기본 1)")
    p.add_argument("--send", action="store_true", help="요약과 함께 알림으로 보냄")
    p.add_argument("--analyze", action="store_true",
                   help="보유·주문·거래대금 상위 종목을 새로 AI 분석 (모의 주문 없음, 약 $0.3/종목)")
    add("halt", cmd_halt, "중단 스위치 켜기: 새 모의 매수를 막음 (청산은 계속)")
    add("resume", cmd_resume, "중단 스위치 끄기")

    args = parser.parse_args(argv)
    try:
        args.func(args)
    except ConfigError as e:
        raise SystemExit(str(e)) from None


if __name__ == "__main__":
    main()
