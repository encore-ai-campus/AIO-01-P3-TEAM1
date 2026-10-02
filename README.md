# paper_trading

키움 REST API 시세로 돌리는 팀 모의매매 서비스. 규칙으로 종목을 고르고 여러 AI가 교차검증한 시나리오를 가상 현금 계좌에서 모의 체결하며,
모든 예측과 결과를 기록해 모델·규칙별 성적을 추적한다. 실제 주문은 내지 않는다.

- 시작하기·규칙·명령: [AGENTS.md](AGENTS.md)
- 계획: [TEAM_PAPER_TRADING_PLAN.md](TEAM_PAPER_TRADING_PLAN.md) · 공통 결정: [docs/DECISIONS.md](docs/DECISIONS.md)
- 엔진 설계: [docs/DESIGN.md](docs/DESIGN.md) · 키움 API: [docs/KIWOOM.md](docs/KIWOOM.md)

```bash
cp .env.example .env      # 키를 채운다 (커밋하지 않는다)
uv sync
uv run pytest && uv run pytest backtest
uv run python -m paper_engine --help
```
