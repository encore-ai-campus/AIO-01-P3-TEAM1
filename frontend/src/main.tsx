import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App, { Providers } from "./App";
import "./index.css";
import { createQueryClient } from "./lib/queryClient";
import { initTheme } from "./lib/theme";

async function boot() {
  // 화면 모드: index.html 인라인 스크립트가 첫 페인트 전에 칠한 테마를 이어받고, 기기 설정·다른 탭의 변경을 듣는다
  initTheme();
  // VITE_MOCK=1 npm run dev: 실제 Django 대신 브라우저 안의 가짜 API(MSW)를 쓴다
  if (import.meta.env.VITE_MOCK === "1") {
    const { startMockApi } = await import("./mocks/browser");
    await startMockApi();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <Providers client={createQueryClient()}>
          <App />
        </Providers>
      </BrowserRouter>
    </StrictMode>,
  );
}

void boot();
