import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// 개발 중에는 /api와 /admin을 로컬 Django(runserver)로 넘긴다. Django를 다른 포트에 띄웠으면
// VITE_API_TARGET=http://127.0.0.1:8001 npm run dev 처럼 준다 (frontend/.env.local에 적어도 된다).
// VITE_MOCK=1이면 브라우저에서 MSW가 /api를 가짜로 응답한다 (src/mocks).
const DJANGO = "http://127.0.0.1:8000";

export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, ".", "VITE_").VITE_API_TARGET || DJANGO;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      // AI 리포트 화면이 저장소의 docs/교육용문서.md를 복사하지 않고 ?raw로 읽는다 (?raw는 폴더 단위로만 허용된다).
      // 대신 루트의 비밀 파일은 막는다 (앞 넷은 Vite 기본값).
      fs: {
        allow: [".", ".."],
        deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "team_accounts.txt", "*.sqlite3", "*.db"],
      },
      // 브라우저가 보낸 Host를 그대로 넘긴다 (운영 nginx의 proxy_set_header Host와 같게).
      // Host가 바뀌면 Django의 CSRF 출처 검사(Origin과 Host 비교)에 걸려 로그인부터 403이 난다.
      proxy: {
        "/api": { target, changeOrigin: false },
        "/admin": { target, changeOrigin: false },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  };
});
