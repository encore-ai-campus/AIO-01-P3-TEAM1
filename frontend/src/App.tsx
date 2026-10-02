import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { AuthBridge, RequireAuth } from "./components/RequireAuth";
import { ToastProvider } from "./components/ToastProvider";
import { Card, EmptyState, PageHeader } from "./components/ui";
import { AnalysisPage } from "./pages/AnalysisPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { MyPage } from "./pages/MyPage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { RankingPage } from "./pages/RankingPage";
import { ReportPage } from "./pages/ReportPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SearchPage } from "./pages/SearchPage";
import { StockPage } from "./pages/StockPage";

/** 서버 상태(TanStack Query) + 토스트 + 401 처리. 라우터 안에서 쓴다. */
export function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthBridge />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader title="페이지 없음" back />
      <Card>
        <EmptyState>
          찾는 화면이 없습니다.{" "}
          <Link to="/" className="font-semibold text-brand underline">
            홈으로
          </Link>
        </EmptyState>
      </Card>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="stocks/:symbol" element={<StockPage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="analyses/:id" element={<AnalysisPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="reports/:id" element={<ReportPage />} />
          <Route path="ranking" element={<RankingPage />} />
          <Route path="my" element={<MyPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
