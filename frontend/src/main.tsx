import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App, { Providers } from "./App";
import "./index.css";
import { createQueryClient } from "./lib/queryClient";

async function boot() {
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
