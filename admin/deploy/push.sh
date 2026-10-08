#!/usr/bin/env bash
# 이 PC의 admin/을 관리 서버에 올리고 다시 띄운다 (admin/README.md 3-4). 관리 서버는 Actions가 배포하지 않는다.
#
#   admin/deploy/push.sh ubuntu@<관리 서버 주소> [-i <키>]
#
# 서버의 ~/paper_admin/src/에 admin/을 그대로 맞춰 쓰고(.env·secrets·records는 src 밖이라 건드리지 않는다),
# 강제 명령 스크립트 deploy_record.py를 ~/paper_admin/에 복사한 뒤 compose를 다시 빌드해 띄운다.
set -euo pipefail
target="${1:?사용법: push.sh ubuntu@<관리 서버 주소> [ssh 옵션...]}"; shift
cd "$(dirname "$0")/.."
ssh_opts=("$@")
ssh_cmd() { ssh ${ssh_opts[@]+"${ssh_opts[@]}"} "$@"; }   # macOS bash 3.2: 빈 배열 + set -u

rsync -az --delete -e "ssh ${ssh_opts[*]:-}" \
  --exclude node_modules --exclude dist --exclude .venv --exclude data --exclude __pycache__ \
  --exclude .pytest_cache --exclude .ruff_cache --exclude 'deploy/secrets' --exclude 'deploy/records' --exclude '.env' \
  ./ "$target:paper_admin/src/"
ssh_cmd "$target" 'set -e
  cd ~/paper_admin
  install -m 755 src/server/paper_admin/deploy_record.py deploy_record.py
  mkdir -p records && touch records/deploys.jsonl && chmod 644 records/deploys.jsonl
  cd src/deploy && docker compose --env-file ../../.env up -d --build --remove-orphans
  docker compose --env-file ../../.env ps'
