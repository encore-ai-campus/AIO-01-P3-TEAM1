"""MCP 토큰 관리: `python -m paper_admin.tokens add|list|revoke <이름>` (API.md 1장).

토큰 원문은 add할 때 한 번만 출력하고, 파일(ADMIN_DATA_DIR/mcp_tokens.json, 0600)에는 SHA-256만 둔다.
"""
import argparse
import re
import secrets
import sys

from .auth import TokenStore, token_hash
from .config import data_dir
from .util import iso, utcnow

NAME = re.compile(r"^[0-9A-Za-z._-]{1,64}$")


def add(store: TokenStore, name: str) -> str:
    tokens = store.load()
    if any(t["name"] == name for t in tokens):
        raise ValueError(f"이미 있는 이름입니다: {name}")
    token = secrets.token_urlsafe(32)
    tokens.append({"name": name, "sha256": token_hash(token), "createdAt": iso(utcnow())})
    store.save(tokens)
    return token


def revoke(store: TokenStore, name: str) -> bool:
    tokens = store.load()
    kept = [t for t in tokens if t["name"] != name]
    if len(kept) == len(tokens):
        return False
    store.save(kept)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m paper_admin.tokens", description="MCP 토큰 관리")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("add", help="새 토큰 (원문은 한 번만 보인다)").add_argument("name")
    sub.add_parser("list", help="토큰 이름 목록")
    sub.add_parser("revoke", help="토큰 지우기").add_argument("name")
    args = parser.parse_args(argv)
    store = TokenStore(data_dir() / "mcp_tokens.json")
    if args.cmd == "list":
        for t in store.load():
            print(f"{t['name']}\t{t.get('createdAt') or '-'}")
        return 0
    if not NAME.match(args.name):
        print("이름은 영문·숫자·._- 64자까지입니다", file=sys.stderr)
        return 1
    if args.cmd == "add":
        try:
            token = add(store, args.name)
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1
        print(token)
        print("이 토큰은 다시 볼 수 없습니다. 지금 복사해 두세요.", file=sys.stderr)
        return 0
    if not revoke(store, args.name):
        print(f"없는 이름입니다: {args.name}", file=sys.stderr)
        return 1
    print(f"지웠습니다: {args.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
