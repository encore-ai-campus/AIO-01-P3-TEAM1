#!/usr/bin/env bash
# 서버에서 도는 배포 스크립트 (deploy.yml이 docker-compose.yml과 같이 올려 실행한다).
#
#   IMAGE_PREFIX=ghcr.io/<소유자>/paper-trading IMAGE_TAG=<커밋 해시> ./remote_deploy.sh
#
# 새 이미지를 받아 띄우고 상태를 확인한다. 실패하면 직전에 성공한 버전으로 되돌리고 실패로 끝난다.
# (DB 마이그레이션은 되돌리지 않는다. 되돌릴 수 없는 모델 변경은 두 번에 나눠 배포한다.)
# 같은 폴더에 .env.docker가 있어야 한다 (이 스크립트는 그 파일을 만들거나 바꾸지 않는다).
set -euo pipefail
cd "$(dirname "$0")"

: "${IMAGE_PREFIX:?IMAGE_PREFIX가 필요합니다}"
: "${IMAGE_TAG:?IMAGE_TAG가 필요합니다}"
[ -f .env.docker ] || { echo "오류: $(pwd)/.env.docker가 없습니다 (.env.docker.example을 복사해 값을 채운다)" >&2; exit 1; }

previous="$(cat .deployed_tag 2>/dev/null || true)"
port="$(sed -n 's/^HTTP_PORT=//p' .env.docker | tail -1)"
port="${port:-80}"

compose() { # 태그, compose 인자...
  local tag="$1"; shift
  IMAGE_PREFIX="$IMAGE_PREFIX" IMAGE_TAG="$tag" docker compose --env-file .env.docker -f docker-compose.yml "$@"
}

healthy() { # 화면(nginx)과 API(web)가 응답할 때까지 최대 2분
  local i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null -m 3 "http://127.0.0.1:$port/api/health" \
       && curl -fsS -o /dev/null -m 3 "http://127.0.0.1:$port/"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

prune_images() { # 지금 버전과 직전 버전(되돌릴 때 쓴다)만 남기고 지운다. 디스크가 작은 서버에서 이미지가 쌓이지 않게
  local name ref tag
  for name in nginx web engine; do
    docker image ls --format '{{.Repository}}:{{.Tag}}' "$IMAGE_PREFIX-$name" | while read -r ref; do
      tag="${ref##*:}"
      [ "$tag" = "$IMAGE_TAG" ] || [ "$tag" = "$previous" ] || docker image rm "$ref" > /dev/null 2>&1 || true
    done
  done
  docker image prune -f > /dev/null
}

record() { echo "$(date '+%Y-%m-%d %H:%M:%S') $IMAGE_TAG $1" >> deploy_history.log; }  # 배포 기록 (보고서 근거)
# deploy.yml이 이 줄을 읽어 관리 서버의 배포 기록으로 보낸다 (admin/API.md 5-2의 result)
result() { echo "DEPLOY_RESULT=$1 PREVIOUS=${previous:--}"; }

echo "배포: $IMAGE_PREFIX-*:$IMAGE_TAG (직전: ${previous:-없음})"
# 이미지를 받지 못하면 아무것도 바꾸지 않고 끝난다 (돌고 있는 버전은 그대로)
compose "$IMAGE_TAG" pull --quiet nginx web engine

# up은 마이그레이션이 실패하거나 web이 상태 확인을 통과하지 못하면 실패로 끝난다
if compose "$IMAGE_TAG" up -d --no-build --remove-orphans && healthy; then
  echo "$IMAGE_TAG" > .deployed_tag
  result success   # 새 버전이 떴다. 아래 정리·기록이 실패해도 결과는 성공이다
  prune_images || echo "경고: 이전 이미지 정리 실패 (배포는 성공)" >&2
  record "성공" || true
  echo "배포 성공: $IMAGE_TAG"
  exit 0
fi

echo "새 버전이 뜨지 않았습니다. 최근 로그:" >&2
compose "$IMAGE_TAG" ps -a >&2 || true
compose "$IMAGE_TAG" logs --tail 40 migrate web nginx >&2 || true
if [ -n "$previous" ] && [ "$previous" != "$IMAGE_TAG" ]; then
  echo "직전 버전($previous)으로 되돌립니다" >&2
  if compose "$previous" up -d --no-build --remove-orphans && healthy; then
    record "실패 → $previous(으)로 되돌림"
    result rolled_back
    echo "되돌리기 성공: $previous" >&2
  else
    record "실패 → 되돌리기도 실패"
    result rollback_failed
    echo "되돌리기도 실패했습니다. 직접 확인이 필요합니다" >&2
  fi
else
  record "실패 (되돌릴 직전 버전 없음)"
  result failed
fi
exit 1
