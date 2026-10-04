"""장기투자 API (docs/API.md "장기투자"): 오늘의 내 종목 뉴스, 산 이유, 종목 펀더멘털."""
import re
from datetime import date

from django.db import IntegrityError, transaction
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from paper_engine.judge import fundamentals_check as fc
from paper_engine.longterm.daily_move import clean_text
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from config.api import Rejected
from trading import market
from trading.models import PaperOrder

from . import payloads, sources, theses
from .models import DailyMoveNote, InvestmentThesis

DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
THESIS_KEYS = ("reasons", "axes")
MAX_REASONS, MAX_REASON_LEN = 3, 100
DATE_PARAM = OpenApiParameter("date", str, description="YYYY-MM-DD (없으면 가장 최근 기록일)")


def _date_param(request) -> date | None:
    text = (request.query_params.get("date") or "").strip()
    if not text:
        return None
    try:
        if not DATE.fullmatch(text):
            raise ValueError(text)
        return date.fromisoformat(text)
    except ValueError:
        raise Rejected("date는 YYYY-MM-DD 형식이어야 합니다.") from None


def _held_kr_symbols(user) -> list[str]:
    """내가 지금 보유(EXIT_WATCHING) 중인 국내 종목."""
    return list(PaperOrder.objects.filter(account__user=user, status="EXIT_WATCHING", market="KR")
                .values_list("symbol", flat=True).distinct())


class DailyMovesView(APIView):
    @extend_schema(parameters=[DATE_PARAM], responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """{"date", "results": DailyMove[]} — 내 보유 국내 종목 중 그날 기록이 있는 것 (종목 이름순)."""
        day = _date_param(request)
        notes = DailyMoveNote.objects.filter(symbol__in=_held_kr_symbols(request.user))
        if day is None:
            day = notes.order_by("-day").values_list("day", flat=True).first()
            if day is None:
                return Response({"date": None, "results": []})
        items = notes.filter(day=day).order_by("name", "symbol")
        return Response({"date": f"{day}", "results": [payloads.daily_move_json(n) for n in items]})


class DailyMoveView(APIView):
    @extend_schema(parameters=[DATE_PARAM], responses=OpenApiTypes.OBJECT)
    def get(self, request, symbol: str):
        """DailyMove (보유 여부와 상관없이 팀 공용 기록). date가 없으면 그 종목의 가장 최근 기록."""
        day = _date_param(request)
        notes = DailyMoveNote.objects.filter(symbol=market.norm_symbol(symbol))
        note = notes.filter(day=day).first() if day else notes.order_by("-day", "-id").first()
        if note is None:
            raise NotFound("이 종목의 오늘의 내 종목 뉴스 기록이 없습니다.")
        return Response(payloads.daily_move_json(note))


def _with_last(items) -> list[dict]:
    return [payloads.thesis_json(t, theses.last_check(t)) for t in items]


class ThesesView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """{"results": Thesis[]} — 내 산 이유 (updatedAt 최신순, 최근 점검 포함)."""
        mine = theses.sync_active(InvestmentThesis.objects.filter(user=request.user).order_by("-updated_at", "-id"))
        return Response({"results": _with_last(mine)})


def _thesis_body(data) -> tuple[list[str], list[str] | None]:
    """PUT 본문 검사 → (reasons, axes 또는 None(바꾸지 않음))."""
    if not isinstance(data, dict):
        raise Rejected("요청 본문은 JSON 객체여야 합니다.")
    unknown = sorted(set(data) - set(THESIS_KEYS))
    if unknown:
        raise Rejected(f"모르는 키: {', '.join(unknown)}")
    reasons = data.get("reasons")
    if (not isinstance(reasons, list) or not 1 <= len(reasons) <= MAX_REASONS
            or not all(isinstance(r, str) for r in reasons)):
        raise Rejected("reasons는 이유 1~3개의 목록이어야 합니다.")
    reasons = [clean_text(r, 10_000) for r in reasons]
    if not all(reasons):
        raise Rejected("빈 이유는 넣을 수 없습니다.")
    if any(len(r) > MAX_REASON_LEN for r in reasons):
        raise Rejected(f"이유는 하나에 {MAX_REASON_LEN}자까지입니다.")
    if "axes" not in data:
        return reasons, None
    axes = data["axes"]
    if not isinstance(axes, list) or not all(isinstance(a, str) and a in fc.THESIS_AXES for a in axes):
        raise Rejected(f"axes는 {', '.join(fc.THESIS_AXES)} 중에서 고른 목록이어야 합니다.")
    if len(set(axes)) != len(axes):
        raise Rejected("axes에 같은 값이 두 번 들어 있습니다.")
    return reasons, axes


class ThesisView(APIView):
    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    def put(self, request, symbol: str):
        """산 이유 저장. 없으면 만들고(처음 만들 때만 DART로 기준선을 잡는다), 있으면 reasons·axes만 바꾼다 → Thesis."""
        reasons, axes = _thesis_body(request.data)
        symbol = market.norm_symbol(symbol)
        now = timezone.now()
        thesis = InvestmentThesis.objects.filter(user=request.user, symbol=symbol).first()
        created = False
        if thesis is None:
            item = market.stock_item(symbol)
            if item is None:
                raise NotFound("종목을 찾을 수 없습니다.")
            baseline, period = theses.baseline_for(item, timezone.localdate())
            try:
                with transaction.atomic():
                    thesis = InvestmentThesis.objects.create(
                        user=request.user, symbol=item["symbol"], name=item["name"], market=item["market"],
                        reasons=reasons, axes=axes or [], baseline=baseline, baseline_period=period,
                        created_at=now, updated_at=now)
                created = True
            except IntegrityError:  # 같은 요청이 동시에 두 번 (먼저 만든 것을 바꾼다)
                thesis = InvestmentThesis.objects.get(user=request.user, symbol=item["symbol"])
        if not created:
            thesis.reasons = reasons
            if axes is not None:
                thesis.axes = axes
            thesis.updated_at = now
            thesis.save(update_fields=["reasons", "axes", "updated_at"])
        theses.sync_active([thesis])
        return Response(payloads.thesis_json(thesis, theses.last_check(thesis)))

    @extend_schema(responses={204: None})
    def delete(self, request, symbol: str):
        """산 이유와 점검 기록을 지운다 → 204."""
        deleted, _ = InvestmentThesis.objects.filter(user=request.user, symbol=market.norm_symbol(symbol)).delete()
        if not deleted:
            raise NotFound("이 종목의 산 이유가 없습니다.")
        return Response(status=status.HTTP_204_NO_CONTENT)


class FundamentalsView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request, symbol: str):
        """FundamentalsView: 그 종목의 최근 지표와 절대 기준 판정 (기준선 비교는 thesis.lastCheck). DART 실패·키 없음도 200."""
        item = market.stock_item(symbol)
        if item is None:
            raise NotFound("종목을 찾을 수 없습니다.")
        applicable, reason = sources.applicability(item)
        result = None
        if applicable:
            try:
                data = sources.fundamentals(item["symbol"], timezone.localdate())
            except sources.DartUnavailable as e:
                reason = str(e)
            else:
                if data is None:
                    reason = sources.NO_FILINGS
                else:
                    result = fc.evaluate(data)
        mine = InvestmentThesis.objects.filter(user=request.user, symbol=item["symbol"]).first()
        thesis = None
        if mine is not None:
            theses.sync_active([mine])
            thesis = payloads.thesis_json(mine, theses.last_check(mine))
        return Response(payloads.fundamentals_json(item, applicable=applicable, reason=reason, result=result,
                                                   thesis=thesis))
