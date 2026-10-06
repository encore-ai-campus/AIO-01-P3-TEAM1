# paper_trading

키움 REST API 시세로 돌리는 팀 모의매매 서비스. 규칙으로 종목을 고르고 여러 AI가 교차검증한 시나리오를 가상 현금 계좌에서 모의 체결하며,
모든 예측과 결과를 기록해 모델·규칙별 성적을 추적한다. 실제 주문은 내지 않는다.

- 시작하기·규칙·명령: [AGENTS.md](AGENTS.md)
- 지금 상태·기술 스택·남은 작업: [docs/TEAM_PAPER_TRADING_PLAN.md](docs/TEAM_PAPER_TRADING_PLAN.md) · 공통 결정: [docs/DECISIONS.md](docs/DECISIONS.md)
- 엔진 설계: [docs/DESIGN.md](docs/DESIGN.md) · 키움 API: [docs/KIWOOM.md](docs/KIWOOM.md) · 배포와 CI/CD: [docs/DEPLOY.md](docs/DEPLOY.md)

```bash
cp .env.example .env      # 키를 채운다 (커밋하지 않는다)
uv sync
uv run pytest && uv run pytest backtest
uv run python -m paper_engine --help
```

## 웹 실행 (로컬 개발)

처음 클론했으면 AI 코딩 에이전트에게 "`SETUP_PROMPT.md`를 읽고 그대로 진행해 줘"라고 하면 설치부터 실행까지 안내한다
(직접 하려면 `cp .env.example .env` → `uv sync` → `cd frontend && npm ci`). macOS·Linux·WSL2에서 돈다.

```bash
scripts/dev.sh            # Django API + 엔진 루프 + 프론트엔드를 한 번에 (다시) 띄운다. 끝나면 주소와 DB 위치를 보여 준다
scripts/dev.sh stop       # 전부 내린다          · status · logs [backend|engine|frontend] · db (DB 셸) · import-sqlite
```

프론트엔드는 `0.0.0.0`에 떠서 같은 네트워크의 휴대폰·다른 PC에서 `http://<이 PC의 IP>:5173`으로 볼 수 있다. Django는 이 PC에서만 접근한다.
DB는 `.env`의 `POSTGRES_HOST`가 비어 있으면 SQLite(`backend/db.sqlite3`), `127.0.0.1`이면 이 PC의 PostgreSQL 컨테이너를 띄워 쓴다
(`POSTGRES_BIND=0.0.0.0`이면 같은 네트워크에서 DB 접속 가능, 개발할 때만). 8000 포트가 사용 중이면 다음 빈 포트를 알아서 쓴다.
팀원이 이어서 개발할 일과 DB 접속 방법은 [TEAM_DEV_PLAN.md](TEAM_DEV_PLAN.md). 하나씩 직접 띄우려면:

```bash
cd backend && uv run python manage.py migrate                # DB 표
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

## 배포와 CI/CD (Docker)

push하면 GitHub Actions가 검사한다 (린트 → 테스트 → 프론트 빌드 → 이미지 빌드와 기동 확인). `main`은 검사를 통과하면 이미지를 올리고
서버에 배포하며, 새 버전이 뜨지 않으면 직전 버전으로 되돌린다. 서버를 연결하기 전에는 검사만 돈다. 설정과 동작은 [docs/DEPLOY.md](docs/DEPLOY.md).

```bash
cd deploy && cp .env.docker.example .env.docker      # 값을 채운다 (커밋하지 않는다)
docker compose --env-file .env.docker up -d --build   # nginx · web · engine · db · redis
./smoke_test.sh                                       # 띄운 스택 확인
```
