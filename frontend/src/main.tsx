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
    // 일부 인앱 브라우저는 Service Worker 등록을 끝내지 못한다. 디자인 검수용 /ui/* 화면까지 흰 화면으로
    // 남지 않도록 일정 시간 뒤에는 앱 셸을 먼저 그린다. 일반 브라우저에서는 MSW가 준비되는 즉시 그대로 시작한다.
    await Promise.race([
      startMockApi().catch(() => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
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
