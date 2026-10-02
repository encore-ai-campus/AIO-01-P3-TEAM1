"""모의 트레이딩 API (docs/API.md "모의 트레이딩"). 로그인은 전역 설정이 확인한다 (안 했으면 401)."""
import math

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from config.api import Rejected, page

from . import market, service
from .models import PaperFill, PaperOrder
from .payloads import fill_json, order_json
from .service import ACTIVE, LIMIT, MARKET
from .store import account_for, order_row

MAX_SEARCH, MAX_QUOTES, MAX_EQUITY_DAYS = 50, 50, 365


def _int_param(request, key: str, default: int, low: int, high: int) -> int:
    try:
        value = int(request.query_params.get(key, default))
    except (TypeError, ValueError):
        return default
    return min(max(value, low), high)


def _body(request) -> dict:
    if not isinstance(request.data, dict):
        raise Rejected("요청 본문은 JSON 객체여야 합니다.")
    return request.data


def _number(data: dict, key: str, required: bool = False) -> float | None:
    value = data.get(key)
    if value is None:
        if required:
            raise Rejected(f"{key}이(가) 필요합니다.")
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Rejected(f"{key}은(는) 숫자여야 합니다.")
    try:
        number = float(value)
    except OverflowError:  # 자릿수가 아주 긴 정수
        number = math.inf
    if not math.isfinite(number):  # JSON의 1e400은 inf로 읽힌다
        raise Rejected(f"{key}이(가) 너무 큽니다.")
    return number


def _days(data: dict) -> int | None:
    value = _number(data, "days")
    if value is None:
        return None
    if value != int(value):
        raise Rejected("days는 정수여야 합니다.")
    return int(value)


class MarketView(APIView):
    def get(self, request):
        return Response(service.market_status(service.now()))


class StockSearchView(APIView):
    def get(self, request):
        query = request.query_params.get("q", "").strip()
        if not query:
            return Response({"results": []})
        return Response({"results": market.search(query, _int_param(request, "limit", 20, 1, MAX_SEARCH))})


class StockDetailView(APIView):
    def get(self, request, symbol: str):
        item = market.stock_item(symbol)
        if item is None:
            raise NotFound("종목을 찾을 수 없습니다.")
        symbol = item["symbol"]
        candles = [{"date": c["timestamp"][:10], "open": float(c["openPrice"]), "high": float(c["highPrice"]),
                    "low": float(c["lowPrice"]), "close": float(c["closePrice"]), "volume": float(c["volume"])}
                   for c in market.candles(symbol)]
        return Response({**item, "currency": market.CURRENCY[item["market"]], "quote": market.quotes([symbol])[0],
                         "candles": candles, "warnings": market.warnings(symbol)})


class QuotesView(APIView):
    def get(self, request):
        symbols = list(dict.fromkeys(s.strip() for s in request.query_params.get("symbols", "").split(",")
                                     if s.strip()))
        if len(symbols) > MAX_QUOTES:
            raise Rejected(f"종목은 한 번에 {MAX_QUOTES}개까지 조회할 수 있습니다.")
        return Response({"quotes": market.quotes(symbols) if symbols else [], "asOf": service.now().isoformat()})


class AccountView(APIView):
    def get(self, request):
        return Response(service.summary(account_for(request.user), service.now()))


class EquityView(APIView):
    def get(self, request):
        days = _int_param(request, "days", 30, 1, MAX_EQUITY_DAYS)
        return Response({"points": service.equity_points(account_for(request.user), days)})


class OrdersView(APIView):
    def get(self, request):
        orders = PaperOrder.objects.filter(account=account_for(request.user)).order_by("-id")
        if request.query_params.get("status", "active") != "all":
            orders = orders.filter(status__in=ACTIVE)
        return page(request, orders, lambda o: order_json(order_row(o)))

    def post(self, request):
        data = _body(request)
        symbol = data.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            raise Rejected("symbol이(가) 필요합니다.")
        order_type = data.get("orderType", MARKET)
        if order_type not in (MARKET, LIMIT):
            raise Rejected("orderType은 MARKET 또는 LIMIT입니다.")
        quantity = _number(data, "quantity", required=True)
        limit = _number(data, "limitPrice", required=order_type == LIMIT)
        out = service.buy(account_for(request.user), request.user.username, symbol, quantity, order_type, limit,
                          _number(data, "targetPrice"), _number(data, "stopPrice"), _days(data), service.now())
        return Response(out, status=status.HTTP_201_CREATED)


class OrderView(APIView):
    def patch(self, request, order_id: int):
        data = _body(request)
        return Response(service.modify(account_for(request.user), order_id, _number(data, "targetPrice"),
                                       _number(data, "stopPrice"), _days(data), service.now()))


class OrderSellView(APIView):
    def post(self, request, order_id: int):
        return Response(service.sell(account_for(request.user), request.user.username, order_id, service.now()))


class OrderCancelView(APIView):
    def post(self, request, order_id: int):
        return Response(service.cancel(account_for(request.user), request.user.username, order_id, service.now()))


class FillsView(APIView):
    def get(self, request):
        fills = PaperFill.objects.filter(account=account_for(request.user)).select_related("order").order_by("-id")
        return page(request, fills, fill_json)


class ReservationsView(APIView):
    def get(self, request):
        return Response({"results": service.reservations(account_for(request.user))})


class ReservationView(APIView):
    def delete(self, request, reservation_id: int):
        service.delete_reservation(account_for(request.user), reservation_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RankingView(APIView):
    def get(self, request):
        return Response(service.ranking(request.user, service.now()))
