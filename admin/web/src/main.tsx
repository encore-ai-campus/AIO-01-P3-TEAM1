import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { AuthProvider } from "./auth";
import "./index.css";

async function start() {
  // VITE_MOCK=1일 때만 MSW를 부른다. 운영 빌드에서는 이 분기가 통째로 빠진다.
  if (import.meta.env.VITE_MOCK === "1") {
    const { worker } = await import("./mocks/browser");
    await worker.start({ onUnhandledRequest: "bypass" });
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

void start();
