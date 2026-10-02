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

## 웹 실행 (로컬 개발)

```bash
cd backend && uv run python manage.py migrate                # DB 표 (로컬 SQLite)
cd backend && uv run python manage.py create_team_accounts   # 팀원 계정 5개 → team_accounts.txt (git 제외, 다시 실행해도 안전)
cd backend && uv run python manage.py runserver              # Django API (기본 127.0.0.1:8000)
cd backend && uv run python manage.py run_engine             # 지정가 체결·목표/손절 청산·예약 실행·일별 자산·AI 분석 작업
cd frontend && npm ci && npm run dev                         # 화면 (http://localhost:5173)
```

- 로그인 아이디·비밀번호는 `team_accounts.txt`에 있다. 팀원마다 모의 계좌(초기 자금 `PAPER_CAPITAL_KRW`)가 하나씩 생긴다.
- 8000 포트를 다른 프로그램이 쓰고 있으면 `runserver 127.0.0.1:8001`로 띄우고 `VITE_API_TARGET=http://127.0.0.1:8001 npm run dev`.
- 백엔드 없이 화면만 볼 때는 `VITE_MOCK=1 npm run dev` (가짜 API).
- 휴대폰에서 볼 때는 `npm run dev -- --host`로 띄우고 `.env`의 `DJANGO_ALLOWED_HOSTS`에 PC의 IP를 더한다.
- API 계약은 [docs/API.md](docs/API.md), 결정은 [docs/DECISIONS.md](docs/DECISIONS.md) 8장.
