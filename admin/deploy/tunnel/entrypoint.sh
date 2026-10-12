#!/bin/sh
# TUNNEL_TARGET(예: admin-tunnel@52.78.101.101)으로 붙어 서비스 서버의 127.0.0.1:DB_LOCAL_PORT를 0.0.0.0:5432로 연다.
# 키 파일은 호스트에서 0600이라 그대로 못 쓸 수 있으므로 tmpfs로 복사해 권한을 맞춘다.
set -eu
: "${TUNNEL_TARGET:?TUNNEL_TARGET이 필요합니다 (예: admin-tunnel@서비스 서버 주소)}"
install -m 600 /keys/tunnel_key /tmp/tunnel_key
exec ssh -N -T \
  -i /tmp/tunnel_key -o IdentitiesOnly=yes -o BatchMode=yes \
  -o UserKnownHostsFile=/keys/known_hosts -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 \
  -p "${TUNNEL_PORT:-22}" \
  -L "0.0.0.0:5432:127.0.0.1:${DB_LOCAL_PORT:-15432}" \
  "$TUNNEL_TARGET"
