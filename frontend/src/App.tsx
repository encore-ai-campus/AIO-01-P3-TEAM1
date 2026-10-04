import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { AuthBridge, RequireAuth } from "./components/RequireAuth";
import { ToastProvider } from "./components/ToastProvider";
import { Card, EmptyState, PageHeader } from "./components/ui";
import { ADMIN_PATH } from "./lib/secretTaps";
import { AdminPage } from "./pages/AdminPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { DayPage } from "./pages/DayPage";
import { DayQuizPage } from "./pages/DayQuizPage";
import { DayReviewPage } from "./pages/DayReviewPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { MyPage } from "./pages/MyPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { PlanPage } from "./pages/PlanPage";
import { PlansPage } from "./pages/PlansPage";
import { PortfolioPage } from "./pages/PortfolioPage";
import { RankingPage } from "./pages/RankingPage";
import { RecommendationPage } from "./pages/RecommendationPage";
import { RecommendationsPage } from "./pages/RecommendationsPage";
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
          {/* 복구 지표는 관리자 화면으로 옮겼다 (예전 주소는 그리로 보낸다) */}
          <Route path="reports/health" element={<Navigate to={ADMIN_PATH} replace />} />
          <Route path="ops" element={<AdminPage />} />
          <Route path="reports/:id" element={<ReportPage />} />
          <Route path="recommendations" element={<RecommendationsPage />} />
          <Route path="recommendations/:id" element={<RecommendationPage />} />
          <Route path="plans" element={<PlansPage />} />
          <Route path="plans/:id" element={<PlanPage />} />
          {/* 단타 연습장 (모의투자 탭 안. 주린이모드 끔 + 퀴즈 통과일 때 계획을 만든다) */}
          <Route path="day" element={<DayPage />} />
          <Route path="day/quiz" element={<DayQuizPage />} />
          <Route path="day/review" element={<DayReviewPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="ranking" element={<RankingPage />} />
          <Route path="my" element={<MyPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
