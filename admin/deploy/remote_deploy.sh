#!/usr/bin/env bash
# 관리 서버에서 도는 배포 스크립트 (.github/workflows/admin-deploy.yml이 compose.yml과 같이 ~/paper_admin/app/에 올려 실행한다).
#
#   IMAGE_PREFIX=ghcr.io/<소유자>/paper-trading-admin IMAGE_TAG=<커밋 해시> ./remote_deploy.sh
#
# 새 이미지를 받아 띄우고 상태를 확인한다. 실패하면 직전에 성공한 버전으로 되돌리고 실패로 끝난다.
# 설정은 ../.env (ADMIN_HOME, 비밀 값). 이 스크립트는 그 파일을 만들거나 바꾸지 않는다.
set -euo pipefail
cd "$(dirname "$0")"

: "${IMAGE_PREFIX:?IMAGE_PREFIX가 필요합니다}"
: "${IMAGE_TAG:?IMAGE_TAG가 필요합니다}"
env_file=../.env
[ -f "$env_file" ] || { echo "오류: $(cd .. && pwd)/.env가 없습니다 (deploy/.env.example을 복사해 값을 채운다)" >&2; exit 1; }

previous="$(cat .deployed_tag 2>/dev/null || true)"
# 직전 버전의 이미지 이름. 저장소를 합치며(2026-10-08) paper-admin → paper-trading-admin으로 바뀌어 태그와 같이 남긴다
previous_prefix="$(cat .deployed_prefix 2>/dev/null || echo "${IMAGE_PREFIX%/*}/paper-admin")"
port="$(sed -n 's/^ADMIN_HTTP_PORT=//p' "$env_file" | tail -1)"
port="${port:-8080}"

compose() { # 이미지 이름, 태그, compose 인자...
  local prefix="$1" tag="$2"; shift 2
  IMAGE_PREFIX="$prefix" IMAGE_TAG="$tag" docker compose --env-file "$env_file" -f compose.yml "$@"
}

healthy() { # 화면(nginx)과 관리자 API가 응답할 때까지 최대 2분
  local i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null -m 3 "http://127.0.0.1:$port/healthz" \
       && curl -fsS -o /dev/null -m 3 "http://127.0.0.1:$port/api/admin/health"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

prune_images() { # 지금 버전과 직전 버전만 남긴다 (디스크가 작은 서버)
  local prefix name ref keep
  # 합치기 전 이름(paper-admin)의 이미지도 직전 버전이 아니면 지운다
  for prefix in "$IMAGE_PREFIX" "$previous_prefix" "${IMAGE_PREFIX%/*}/paper-admin"; do
    for name in server web tunnel; do
      docker image ls --format '{{.Repository}}:{{.Tag}}' "$prefix-$name" | while read -r ref; do
        keep=0
        [ "$ref" = "$IMAGE_PREFIX-$name:$IMAGE_TAG" ] && keep=1
        [ "$ref" = "$previous_prefix-$name:$previous" ] && keep=1
        [ "$keep" = 1 ] || docker image rm "$ref" > /dev/null 2>&1 || true
      done
    done
  done
  docker image prune -f > /dev/null
}

record() { echo "$(date '+%Y-%m-%d %H:%M:%S') $IMAGE_TAG $1" >> deploy_history.log; }

echo "배포: $IMAGE_PREFIX-*:$IMAGE_TAG (직전: ${previous:-없음})"
compose "$IMAGE_PREFIX" "$IMAGE_TAG" pull --quiet

if compose "$IMAGE_PREFIX" "$IMAGE_TAG" up -d --no-build --remove-orphans && healthy; then
  echo "$IMAGE_TAG" > .deployed_tag
  echo "$IMAGE_PREFIX" > .deployed_prefix
  prune_images || echo "경고: 이전 이미지 정리 실패 (배포는 성공)" >&2
  record "성공" || true
  echo "배포 성공: $IMAGE_TAG"
  exit 0
fi

echo "새 버전이 뜨지 않았습니다. 최근 로그:" >&2
compose "$IMAGE_PREFIX" "$IMAGE_TAG" ps -a >&2 || true
compose "$IMAGE_PREFIX" "$IMAGE_TAG" logs --tail 40 >&2 || true
if [ -n "$previous" ] && [ "$previous" != "$IMAGE_TAG" ]; then
  echo "직전 버전($previous_prefix-*:$previous)으로 되돌립니다" >&2
  if compose "$previous_prefix" "$previous" up -d --no-build --remove-orphans && healthy; then
    record "실패 → $previous(으)로 되돌림"
    echo "되돌리기 성공: $previous" >&2
  else
    record "실패 → 되돌리기도 실패"
    echo "되돌리기도 실패했습니다. 직접 확인이 필요합니다" >&2
  fi
else
  record "실패 (되돌릴 직전 버전 없음)"
fi
exit 1
