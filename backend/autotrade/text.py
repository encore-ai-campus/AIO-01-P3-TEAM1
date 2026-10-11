"""알림 문장과 숫자 표기 (컨셉 계획 B6 — docs/API.md "알림 문장", docs/DECISIONS.md 14-7).

- 알림마다 쉬운 문장(주린이모드 켬·Discord)과 전문가 문장(끔 — 2026-10-04 전 문장)을 한 벌(notifications.service.Notice)로 만든다.
  웹 알림은 받는 사람의 주린이모드로 고르고, Discord는 쉬운 문장 + 숫자 한 줄(Notice.numbers)이다.
- **주문·체결·청산·계획 활성화를 말하는 쉬운 문장에는 "모의"를 꼭 넣는다** (공용 채널·초보 화면에서 실제 매매로 읽히지 않게).
- 권유 표현을 쓰지 않는다 (paper_engine.wording.forbidden_phrases — autotrade/tests/test_text.py가 모든 문장을 검사한다).
- 장중 확인 가격 숫자는 넣지 않는다. 넣는 숫자는 진입·목표·손절(추천 값), 체결가·청산가(일어난 사실), 수량·손익뿐이다.
- PlanEvent.message·failure_reason은 여기서 만들지 않는다 (executor가 원래 용어로 남긴다 — 전문가 보기).
- 문장에 종목 이름 바로 뒤 조사(을/를)를 붙이지 않는다 (받침에 따라 달라지므로 "삼성전자 3주를"처럼 수량 뒤에 붙인다).
"""
from dataclasses import replace
from datetime import datetime

from notifications.service import Notice
from paper_engine.agents.executor import money, qty_text, signed_money
from reports.output.text import COMPLETED_LINE
from trading.store import KST

from .models import Recommendation, TradePlan

__all__ = ["money", "qty_text", "signed_money", "pct", "when", "day_time", "EXIT_LABEL", "REASON_TEXT",
           "recommendation", "plan_activated", "order_placed", "order_requeued", "filled", "closed", "ended",
           "MANUAL_START_TAG", "manual_tagged"]

# 청산 사유: 전문가 이름 (docs/API.md "청산 사유" 표의 화면 이름)과 쉬운 문장 앞부분
EXIT_LABEL = {"TARGET": "목표가 도달", "STOP": "손절가 도달", "EXPIRED": "보유 기한 경과", "MANUAL": "사용자 매도"}
EXIT_EASY = {"TARGET": "목표 가격에 닿아", "STOP": "손절 가격에 닿아 손실이 더 커지지 않게", "EXPIRED": "보유 기간이 끝나",
             "MANUAL": "요청대로"}

# 실행 불가 사유 코드 → 쉬운 문장 (docs/API.md "실행 불가 사유 코드". 화면 표는 frontend/src/lib/plainText.ts REASON_TEXT)
REASON_TEXT = {
    "reward_risk_low": "버는 돈에 비해 잃을 수 있는 돈이 커서 안전장치가 막았어요",
    "ev_negative": "비용까지 따지면 기대되는 결과가 0 이하라 안전장치가 막았어요",
    "daily_loss_limit": "오늘은 손실 한도에 닿아 새로 시작할 수 없어요",
    "daily_trades_limit": "오늘 할 수 있는 주문 수를 다 썼어요",
    "warning_stock": "투자경고 같은 매수 유의 종목이라 안전장치가 막았어요",
    "size_too_small": "안전장치가 정한 수량이 1주도 안 돼요",
    "budget_too_small": "내가 정한 금액으로는 1주도 살 수 없어요",
    "expired": "계획의 기한이 끝났어요",
    "plan_exists": "이미 이 종목으로 진행 중인 계획이 있어요",
    "position_exists": "이미 이 종목의 모의 주문이나 보유가 있어요",
    "halted": "지금은 새 모의 매수를 멈춰 두었어요",
    "price_passed": "가격이 이미 목표 가격을 넘었거나 손절 가격 아래로 내려왔어요",
    "cash_short": "매수 가능 금액보다 사려는 금액이 커요",
    "position_limit": "한 종목에 넣을 수 있는 비중 한도를 넘어요",
    "total_limit": "총 투자 금액 한도를 넘어요",
}

SOURCE_WHO = {Recommendation.REPORT: "AI 리포트가", Recommendation.ANALYSIS: "AI 교차검증 분석이",
              Recommendation.DEMO: "정해진 규칙(AI 아님)이"}
SOURCE_EASY = {Recommendation.REPORT: "AI 리포트", Recommendation.ANALYSIS: "AI 교차검증 분석",
               Recommendation.DEMO: "연습용 예시 계획 (AI 아님)"}
SOURCE_LABEL = {Recommendation.REPORT: "AI 리포트", Recommendation.ANALYSIS: "AI 교차검증 분석",
                Recommendation.DEMO: "연습용 예시 계획 (AI 아님)"}


# --- 숫자 표기 ---

def pct(rate: float) -> str:
    """+12.3% / -4.5%."""
    return f"{rate * 100:+.1f}%"


def when(at: datetime) -> str:
    """10-07 15:30 (KST)."""
    return f"{at.astimezone(KST):%m-%d %H:%M}"


def day_time(at: datetime) -> str:
    """10월 7일 15:30 (KST, 쉬운 문장용)."""
    local = at.astimezone(KST)
    return f"{local.month}월 {local.day}일 {local:%H:%M}"


def _plan_prices(plan: TradePlan) -> tuple[str, str, str]:
    c = plan.currency
    return money(plan.entry_price, c), money(plan.target_price, c), money(plan.stop_price, c)


def _exit_rule(target: str, stop: str) -> str:
    return f"{target}이 되면 팔고, {stop} 아래로 내려가면 손실이 더 커지지 않게 팔아요."


def reason_sentences(codes) -> str:
    """사유 코드 → 쉬운 문장을 "; "로 (같은 문장은 한 번, 모르는 코드는 뺀다)."""
    seen = dict.fromkeys(REASON_TEXT[c] for c in codes or () if c in REASON_TEXT)
    return "; ".join(seen)


# --- 추천 ---

def recommendation(rec: Recommendation) -> Notice:
    """recommendation. 리포트 추천이면 본문 첫 줄이 "리포트가 완성됐어요" (리포트 완성 알림을 대신한다 — reports/output/alerts.py)."""
    c = rec.currency
    entry, target, stop = money(rec.entry_price, c), money(rec.target_price, c), money(rec.stop_price, c)
    first = [COMPLETED_LINE] if rec.source == Recommendation.REPORT else []
    easy = first + [
        (f"{SOURCE_WHO.get(rec.source, 'AI가')} {entry}에 사서 {target}이 되면 팔고, {stop} 아래로 내려가면 "
         "손실이 더 커지지 않게 파는 매매 계획을 냈어요."),
        f"모의 자동매매로 해 볼지는 직접 정해요. {day_time(rec.valid_until)}까지 시작할 수 있어요.",
    ]
    probability = f"확률 {rec.probability:.0%}" + (", 가정" if rec.probability_assumed else "")
    source = SOURCE_LABEL.get(rec.source, rec.source)
    if rec.report_id or rec.analysis_id:
        source += f" #{rec.report_id or rec.analysis_id}"
    expert = first + [
        f"진입 {entry} · 목표 {target} ({pct(rec.target_return)}) · 손절 {stop} ({pct(rec.stop_loss_rate)})",
        f"손익비 {rec.reward_risk:.2f} · 보유 {rec.holding_days}거래일 · 기대수익률 {pct(rec.expected_return)} ({probability})",
        f"출처 {source} · 유효 기한 {when(rec.valid_until)}",
    ] + ([rec.summary] if rec.summary else [])
    head = "연습용 예시 계획(AI 아님)" if rec.source == Recommendation.DEMO else "AI 추천"
    return Notice(
        title=f"{rec.name} 새 매매 계획 제안 · {SOURCE_EASY.get(rec.source, rec.source)}", body="\n".join(easy),
        expert_title=f"{head} · {rec.name} ({rec.symbol})", expert_body="\n".join(expert),
        numbers=(f"진입 {entry} · 목표 {target} ({pct(rec.target_return)}) · 손절 {stop} ({pct(rec.stop_loss_rate)}) · "
                 f"손익비 {rec.reward_risk:.2f}"))


# --- 시연용 수동 시작 ---

MANUAL_START_TAG = "[시연용 수동 시작]"  # 시연용 수동 시작 계획 알림 제목의 꼬리표 (DECISIONS 31장)


def manual_tagged(notice: Notice) -> Notice:
    """시연용 수동 시작 계획(TradePlan.manual_start)의 알림: 쉬운·전문가 제목 앞에 MANUAL_START_TAG. 본문·숫자 줄은 그대로.

    executor._later 한 곳에서 붙인다 (합친 알림·엔진 루프 알림이 모두 거기를 지난다). Notice는 frozen이라 새 객체를 돌려준다.
    """
    return replace(notice, title=f"{MANUAL_START_TAG} {notice.title}",
                   expert_title=None if notice.expert_title is None else f"{MANUAL_START_TAG} {notice.expert_title}")


# --- 계획 ---

def plan_activated(plan: TradePlan) -> Notice:
    entry, target, stop = _plan_prices(plan)
    qty = qty_text(plan.quantity)
    tail = f"{day_time(plan.entry_deadline)}까지 사지 못하면 사지 않고 끝나요."
    numbers = (f"{qty} · 진입 {entry} 지정가 · 목표 {target} · 손절 {stop} · 진입 기한 {when(plan.entry_deadline)}")
    return Notice(
        title=f"{plan.name} 모의 자동매매를 시작했어요",
        body=f"모의 계좌에서 {plan.name} {qty}를 {entry} 이하에 사는 주문을 낼게요. 산 뒤에는 {_exit_rule(target, stop)} {tail}",
        expert_title=f"{plan.name} 자동매매 계획 활성화", expert_body=numbers, numbers=numbers)


def _order_line(plan: TradePlan, quantity: float) -> str:
    return f"{plan.name} {qty_text(quantity)} {money(plan.entry_price, plan.currency)} 지정가 매수"


def order_placed(plan: TradePlan, order_id: int, quantity: float, started: bool = False) -> Notice:
    """order_placed. started: 활성화 요청 안에서 낸 첫 주문이라 시작 알림과 합친 하나다 (docs/API.md "알림 합치기") — 시작 안내를 함께 쓴다."""
    entry, target, stop = _plan_prices(plan)
    qty = qty_text(quantity)
    deadline = day_time(plan.entry_deadline)
    if started:
        return Notice(
            title=f"{plan.name} 모의 자동매매를 시작하고 매수 주문을 냈어요",
            body=(f"모의 계좌에 {plan.name} {qty}를 {entry} 이하에 사는 주문을 냈어요. 산 뒤에는 {_exit_rule(target, stop)} "
                  f"{deadline}까지 사지 못하면 사지 않고 끝나요."),
            expert_title=f"{plan.name} 자동매매 계획 활성화 · 진입 주문 접수",
            expert_body=(f"{_order_line(plan, quantity)} 주문 접수 (모의 주문 #{order_id}). 목표 {target} · 손절 {stop} · "
                         f"진입 기한 {when(plan.entry_deadline)}"),
            numbers=f"{qty} · 지정가 {entry} · 목표 {target} · 손절 {stop} · 모의 주문 #{order_id}")
    return Notice(
        title=f"{plan.name} 모의 매수 주문을 냈어요",
        body=f"모의 계좌에 {plan.name} {qty}를 {entry} 이하에 사는 주문을 냈어요. {deadline}까지 기다려요.",
        expert_title=f"{plan.name} 진입 주문 접수",
        expert_body=f"{_order_line(plan, quantity)} 주문 접수 (모의 주문 #{order_id}). 진입 기한 {when(plan.entry_deadline)}",
        numbers=f"{qty} · 지정가 {entry} · 모의 주문 #{order_id}")


def order_requeued(plan: TradePlan, order_id: int, quantity: float, previous_quantity: float) -> Notice:
    """order_requeued (웹만 — 부르는 쪽이 discord=False). 수량이 줄었으면 그 말을 더한다."""
    entry, _, _ = _plan_prices(plan)
    qty = qty_text(quantity)
    reduced = quantity < previous_quantity
    shrink = (f" 매수 가능 금액·총 투자 금액 한도에 맞춰 수량을 {qty_text(previous_quantity)}에서 {qty}로 줄였어요."
              if reduced else "")
    expert_shrink = f", 리스크 점검으로 {qty_text(previous_quantity)} → {qty}" if reduced else ""
    return Notice(
        title=f"{plan.name} 모의 매수 주문을 다시 냈어요",
        body=(f"그날 정해진 가격에 사지 못해 모의 계좌에 {plan.name} {qty}를 {entry} 이하에 사는 주문을 다시 냈어요.{shrink} "
              f"{day_time(plan.entry_deadline)}까지 기다려요."),
        expert_title=f"{plan.name} 진입 주문 다시 접수",
        expert_body=(f"{_order_line(plan, quantity)} 다시 주문 (모의 주문 #{order_id}{expert_shrink}). "
                     f"진입 기한 {when(plan.entry_deadline)}"),
        numbers=f"{qty} · 지정가 {entry} · 모의 주문 #{order_id}")


def filled(plan: TradePlan, fill_price: float, quantity: float, started: bool = False) -> Notice:
    """filled. started: 활성화 요청 안에서 바로 체결돼 시작·주문 알림과 합친 하나다 (docs/API.md "알림 합치기")."""
    c = plan.currency
    _, target, stop = _plan_prices(plan)
    fill, qty = money(fill_price, c), qty_text(quantity)
    lead = "모의 자동매매를 시작하자마자 " if started else ""
    return Notice(
        title=f"{plan.name} 모의 계좌에서 샀어요",
        body=f"{lead}모의 계좌에서 {plan.name} {qty}를 {fill}에 샀어요. {_exit_rule(target, stop)}",
        expert_title=f"{plan.name} 진입 체결",
        expert_body=(f"{'자동매매 계획 활성화 뒤 바로 ' if started else ''}{fill} × {qty}. "
                     f"목표 {target} / 손절 {stop} 자동 감시"),
        numbers=f"체결 {fill} × {qty} · 목표 {target} · 손절 {stop}")


def closed(plan: TradePlan, exit_price: float | None, exit_reason: str | None, pnl_krw: float | None,
           quantity: float | None = None) -> Notice:
    c = plan.currency
    exit_text = money(exit_price, c) if exit_price is not None else "체결가"
    label = EXIT_LABEL.get(exit_reason or "", exit_reason or "청산")
    prefix = EXIT_EASY.get(exit_reason or "")
    qty = qty_text(quantity if quantity else plan.quantity)
    pnl = "" if pnl_krw is None else f" · 실현 손익 {signed_money(pnl_krw, 'KRW')}"
    easy_pnl = "" if pnl_krw is None else f" 실현 손익은 {signed_money(pnl_krw, 'KRW')}이에요 (비용 포함)."
    sold = f"모의 계좌에서 {plan.name} {qty}를 {exit_text}에 모두 팔았어요."
    return Notice(
        title=f"{plan.name} 모의 계좌에서 모두 팔았어요",
        body=(f"{prefix} {sold}" if prefix else sold) + easy_pnl,
        expert_title=f"{plan.name} 청산 · {label}", expert_body=f"{exit_text}에 전량 매도{pnl}",
        numbers=f"청산 {exit_text} · {label}{pnl}")


# 계획이 주문 없이(또는 체결 없이) 끝난 까닭 → 쉬운 본문. executor._end가 고른다
END_EASY = {
    "no_order_by_deadline": "진입 기한까지 모의 주문을 내지 못해 모의 자동매매를 끝냈어요. 산 것은 없어요.",
    "unfilled_by_deadline": "진입 기한까지 {entry} 이하로 내려오지 않아 모의 계좌에서 사지 않고 끝냈어요. 돈은 그대로예요.",
    "user_stopped": "요청대로 모의 자동매매를 멈췄어요. 산 것은 없어요.",
    "order_cancelled": "모의 주문을 직접 취소해서 모의 자동매매도 멈췄어요. 산 것은 없어요.",
    "order_rejected": "모의 주문을 낼 수 없어 모의 자동매매를 시작하지 못했어요.",
    "engine_cancelled": "체결하려던 순간 모의 주문이 취소돼 모의 자동매매를 이어가지 못했어요.",
    "cash_short": "체결하려던 순간 모의 계좌의 현금이 모자라 모의 주문이 취소됐어요. 모의 자동매매를 이어가지 못했어요.",
    "requeue_blocked": "모의 주문을 다시 내기 전에 안전장치가 막아 모의 자동매매를 끝냈어요.",
    "requeue_too_small": ("모의 주문을 다시 내려 했지만 매수 가능 금액·총 투자 금액 한도 안에서는 1주도 살 수 없어 "
                          "모의 자동매매를 끝냈어요."),
}
END_TITLE = {TradePlan.CANCELLED: "모의 자동매매를 멈췄어요", TradePlan.EXPIRED: "모의 자동매매가 사지 않고 끝났어요",
             TradePlan.FAILED: "모의 자동매매를 이어가지 못했어요"}
END_EXPERT_TITLE = {TradePlan.CANCELLED: "계획 중단", TradePlan.EXPIRED: "계획 만료", TradePlan.FAILED: "계획 실패"}


def ended(plan: TradePlan, status: str, why: str, reason: str, codes=()) -> Notice:
    """cancelled·expired·failed. why는 END_EASY의 키, reason은 전문가 문장(= failure_reason), codes는 실행 불가 사유 코드."""
    entry, _, _ = _plan_prices(plan)
    easy = END_EASY.get(why, END_EASY["order_rejected"]).format(entry=entry)
    plain = reason_sentences(codes)
    if plain:
        easy += f" 사유: {plain}."
    return Notice(title=f"{plan.name} {END_TITLE[status]}", body=easy,
                  expert_title=f"{plan.name} {END_EXPERT_TITLE[status]}", expert_body=reason)
