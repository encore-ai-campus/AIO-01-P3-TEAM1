# 설치·실행 프롬프트 (AI 코딩 에이전트용)

저장소를 클론한 뒤, 그 폴더에서 AI 코딩 에이전트(Claude Code, Codex 등)를 열고 이렇게 말하면 된다.

> `SETUP_PROMPT.md`를 읽고 그대로 진행해 줘.

아래부터가 에이전트에게 주는 지시다.

---

## 할 일

이 저장소는 팀 모의매매 웹 서비스다 (Django 백엔드 + 엔진 루프 + React 프론트엔드. 증권사에는 시세 조회만 하고 주문은 가상 계좌에서 체결한다).
방금 클론한 팀원의 PC에서 **종속성을 설치하고, 검사가 통과하는지 확인하고, 서버를 한 번 띄워 본 뒤, 앞으로 어떻게 실행하고 끄는지 안내**하는 것이 목표다.
사용자는 이 프로젝트를 처음 받는 팀원이다. 설치 과정을 일일이 묻지 말고 진행하되, 아래에 "묻는다"고 적은 것만 묻는다.

끝났다고 할 수 있는 상태:
- `uv sync`와 `npm ci`가 끝나 있다.
- 파이썬 검사와 프론트엔드 검사가 통과한다 (실패하면 그대로 보고한다).
- `.env`가 있고, 사용자가 고른 DB 방식대로 설정돼 있다.
- `scripts/dev.sh`로 서버가 뜨고 `http://localhost:<포트>`가 열리는 것을 확인했다.
- 사용자가 실행·종료·로그 보는 법과 로그인 방법을 안다.

## 1. 환경 확인

먼저 운영체제와 도구를 확인한다.

- **macOS, Linux, Windows의 WSL2**에서 돈다. **WSL이 아닌 Windows(PowerShell·cmd·Git Bash)에서는 돌지 않는다**
  (엔진이 Unix 전용 파일 잠금 `fcntl`을 쓰고, 실행 스크립트가 bash·`lsof`·`pgrep`을 쓴다).
  Windows라면 설치를 진행하지 말고, WSL2(Ubuntu)를 설치해 그 안에서 다시 클론하도록 안내하고 멈춘다.
- 필요한 도구:

| 도구 | 조건 | 없을 때 |
|---|---|---|
| `uv` | 있으면 된다 (파이썬 3.12 이상은 uv가 알아서 받는다) | 사용자 폴더에만 설치되는 공식 설치 스크립트로 설치한다: `curl -LsSf https://astral.sh/uv/install.sh \| sh`. 설치했다고 알려 준다 |
| Node.js + `npm` | Node `20.19 이상` 또는 `22.12 이상` (Vite 8 요구 사항) | 시스템을 바꾸는 일이라 알아서 설치하지 않는다. 쓰는 방법(nvm, fnm, brew, apt 등)을 제안하고 **묻는다** |
| `git`, `curl` | 있으면 된다 | 설치 방법을 안내한다 |
| Docker | **필요 없다.** 이 PC가 팀의 개발 DB(PostgreSQL)를 띄우는 호스트 PC일 때만 쓴다 | 넘어간다 |

## 2. `.env` 만들기

`.env`가 없으면 `cp .env.example .env`로 만든다. 있으면 그대로 둔다 (덮어쓰지 않는다).

`.env`에는 비밀 값이 들어간다. **내용을 출력하지 말고, 커밋하지 말고, 비밀 값을 대화에 붙여 넣어 달라고 하지 않는다.**
값이 필요하면 어떤 키에 무엇을 넣어야 하는지 알려 주고 사용자가 편집기로 직접 `.env`에 적게 한다. 어떤 키가 채워졌는지만(값 말고) 확인한다.

사용자에게 **두 가지를 묻는다.**

**(1) DB를 어떻게 쓸지**

| 선택 | `.env` | 설명 |
|---|---|---|
| 내 PC의 SQLite (기본) | `POSTGRES_HOST=` 비워 둔다 | 혼자 개발할 때. 아무것도 받을 필요가 없다 |
| 팀이 같이 보는 개발 DB | `POSTGRES_HOST=<호스트 PC의 IP>`, `POSTGRES_PORT=5434`, `POSTGRES_PASSWORD=<호스트 PC 담당자에게 받은 값>` | 호스트 PC와 같은 네트워크에 있어야 한다. IP와 비밀번호는 사용자가 팀에서 받아 직접 적는다 |

공유 DB를 고르면 `DJANGO_SECRET_KEY`도 채워야 서버가 뜬다. 이 값은 비밀을 받을 필요 없이 임의의 긴 문자열이면 되므로 직접 만들어 넣어도 된다
(예: `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`의 결과를 `.env`에 쓴다. 화면에는 찍지 않는다).

**(2) 팀에서 받은 키가 있는지**

| 키 | 없으면 |
|---|---|
| `KIWOOM_APPKEY`, `KIWOOM_SECRETKEY` (증권사 시세 조회) | 서버는 뜨지만 시세·종목 검색·주문이 "조회할 수 없음"으로 나온다 |
| `DEVPASS_APIKEY`, `ANALYSTS` 등 (AI) | AI 분석 요청이 꺼진다 |
| `DART_API_KEY`, `DATA_GOKR_API` (재무·공휴일) | 재무 정보와 국내 공휴일 반영이 빠진다 |

키가 하나도 없어도 설치와 실행은 된다. 그때는 무엇이 안 되는지 알려 주고, 화면만 볼 때는 가짜 API로 띄우는 방법
(`cd frontend && VITE_MOCK=1 npm run dev`)도 안내한다.
`.env.example`의 `BROKER=toss`(토스 조회)는 권하지 않는다 — 호스트 PC 담당자 개인의 키를 쓰는 개발용 설정이고, 같은 키를 여러 PC에서 쓰면 서로의 토큰을 무효로 만든다.

## 3. 종속성 설치

```bash
uv sync                       # 저장소 루트에서. 엔진 + 백엔드 + 개발 도구 (파이썬도 필요하면 받는다)
cd frontend && npm ci         # 프론트엔드
```

## 4. 검사

설치가 제대로 됐는지 확인한다. 이 검사들은 네트워크와 `.env`의 키를 쓰지 않는다 (테스트는 가짜 객체로 돌고, 항상 SQLite 메모리 DB를 쓴다).

```bash
uv run ruff check . && uv run pytest -q        # 파이썬 (엔진 + 백엔드)
uv run pytest backtest -q                      # 백테스트
cd frontend && npx tsc --noEmit && npx vitest run
```

실패하면 **소스 코드를 고쳐서 맞추려 하지 말고** 어떤 검사가 어떤 메시지로 실패했는지 보고한다. 환경 문제(도구 버전, 설치 누락)면 그것을 고친다.

## 5. 계정

- **내 PC의 SQLite를 쓰는 경우**: 팀 계정을 만든다.
  ```bash
  cd backend && uv run python manage.py migrate && uv run python manage.py create_team_accounts
  ```
  아이디·비밀번호 5개가 저장소 루트의 `team_accounts.txt`에 저장된다 (git 제외). 내용을 출력하지 말고, 그 파일에서 하나를 골라 로그인하면 된다고 알려 준다.
- **공유 DB를 쓰는 경우**: 계정이 이미 있다. **`create_team_accounts`를 실행하지 않는다** (공유 DB에 계정이 새로 생긴다). 사용자가 팀에서 받은 계정으로 로그인한다.

## 6. 서버 띄우기

```bash
scripts/dev.sh
```

이 스크립트가 Django API, 엔진 루프, 프론트엔드를 백그라운드로 띄우고 접속 주소를 보여 준다. 실제로 한 번 실행해 뜨는지 확인한다
(사용자가 띄우지 말라고 했으면 실행하지 않고 방법만 안내한다). 확인할 것: 출력에 세 서비스가 "실행 중"으로 나오는지, `curl -s http://localhost:<프론트 포트>/api/health`가 `{"status": "ok"}`인지.

알아 둘 동작 (사용자에게도 알려 준다):
- 프론트엔드는 `0.0.0.0`에 뜬다. 같은 네트워크의 다른 기기에서 `http://<이 PC의 IP>:<포트>`로 들어올 수 있다.
- 기본 포트는 프론트 5173, Django 8000이다. 다른 프로그램이 쓰고 있으면 다음 빈 포트를 알아서 쓰고 출력에 적는다. 다른 프로그램을 끄지 않는다.
- 공유 DB를 쓰는 경우 엔진 루프는 띄우지 않고("띄우지 않음"으로 나온다) 마이그레이션도 알아서 적용하지 않는다. 정상이다 — 엔진 루프는 DB가 있는 호스트 PC에서만 돈다.
- 실패하면 `.cache/dev/backend.log`, `engine.log`, `frontend.log`, `migrate.log`를 보고 원인을 알려 준다.

## 7. 마지막에 사용자에게 알려 줄 것

짧게, 아래 순서로 정리해 준다.

1. 설치한 것과 버전 (uv, 파이썬, Node), 새로 설치한 도구가 있으면 그것.
2. 검사 결과 (통과한 수, 실패가 있으면 내용).
3. 접속 주소와 로그인 방법 (SQLite면 `team_accounts.txt`, 공유 DB면 받은 계정).
4. 자주 쓰는 명령:
   ```bash
   scripts/dev.sh            # 전부 (다시) 띄운다
   scripts/dev.sh status     # 상태와 접속 주소
   scripts/dev.sh logs       # 로그 (Ctrl+C로 끝)
   scripts/dev.sh stop       # 전부 내린다
   ```
5. `.env`에서 비어 있어 꺼진 기능 (값은 말하지 않는다).
6. 다음에 읽을 문서: `TEAM_DEV_PLAN.md`(팀이 이어서 개발할 일, DB 접속 방법), `AGENTS.md`(규칙과 명령), `docs/API.md`(웹 API 계약).

## 하지 않는 것

- 커밋·푸시를 하지 않는다. 소스 코드를 고치지 않는다 (설치와 `.env` 설정만 한다).
- `.env`, `team_accounts.txt`의 내용을 출력하지 않는다.
- 화면이나 API로 AI 분석·AI 리포트를 요청하지 않는다 (실제 비용이 든다). 실제 주문 API는 이 프로젝트에 없다.
- 공유 DB를 쓰는 PC에서 `create_team_accounts`, `scripts/dev.sh import-sqlite`, `scripts/dev.sh db-stop`, `manage.py migrate`, `manage.py run_engine`을 실행하지 않는다.
  공유 DB의 데이터를 손으로 고치지 않는다.
- 이 저장소와 관계없는 프로세스·컨테이너·포트를 건드리지 않는다.
