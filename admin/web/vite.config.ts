import react from "@vitejs/plugin-react";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

// 운영 빌드에는 MSW 서비스 워커 파일(public/mockServiceWorker.js)도 넣지 않는다.
const dropMockWorker = (): Plugin => ({
  name: "drop-mock-service-worker",
  apply: "build",
  closeBundle() {
    rmSync(resolve(import.meta.dirname, "dist/mockServiceWorker.js"), { force: true });
  },
});

// 개발 중에는 /api/admin을 로컬 관리자 백엔드로 넘긴다. 다른 주소면 VITE_API_TARGET=http://127.0.0.1:8100 npm run dev.
// VITE_MOCK=1이면 브라우저에서 MSW가 /api/admin을 가짜로 응답한다 (src/mocks).
export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, ".", "VITE_").VITE_API_TARGET || process.env.VITE_API_TARGET || "http://127.0.0.1:8100";
  return {
    plugins: [react(), dropMockWorker()],
    server: {
      proxy: { "/api/admin": { target, changeOrigin: false } },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/setupTests.ts"],
      css: false,
    },
  };
});
