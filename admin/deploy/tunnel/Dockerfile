# 서비스 DB로 가는 SSH 터널 (README.md 7장). 서비스 서버의 127.0.0.1:DB_LOCAL_PORT를 이 컨테이너의 5432로 연다.
# 키는 서비스 서버의 전용 사용자에 permitopen으로 그 포트만 열어 둔 것이다. 끊기면 compose가 다시 띄운다.
FROM alpine:3.22
RUN apk add --no-cache openssh-client \
    && adduser -D -u 1000 tunnel
COPY entrypoint.sh /entrypoint.sh
USER tunnel
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
