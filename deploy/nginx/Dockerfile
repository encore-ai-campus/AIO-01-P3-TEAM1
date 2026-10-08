# syntax=docker/dockerfile:1
# nginx 이미지: React 빌드 파일을 내주고 /api, /admin을 web으로 넘긴다. 빌드 컨텍스트는 저장소 루트.
FROM node:22-alpine AS build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
# AI 리포트 화면이 ../docs/교육용문서.md를 빌드에 넣는다
COPY docs/ /src/docs/
# macOS에서 빌드하면 한글 파일 이름이 분해형(NFD)으로 들어와 소스의 import 경로(NFC)와 어긋난다. 이름을 NFC로 맞춘다.
RUN node -e "const fs=require('fs');for(const f of fs.readdirSync('/src/docs')){const n=f.normalize('NFC');if(n!==f)fs.renameSync('/src/docs/'+f,'/src/docs/'+n)}" \
    && npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY deploy/nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /src/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
