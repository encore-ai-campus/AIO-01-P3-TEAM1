import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 개발 중에는 /api와 /admin을 로컬 Django(runserver)로 넘긴다.
const DJANGO = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": DJANGO,
      "/admin": DJANGO,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
  },
});
