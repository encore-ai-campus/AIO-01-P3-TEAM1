import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { Layout } from "./components/Layout";
import { ScrollManager } from "./components/motion/ScrollManager";
import { IntroGate } from "./components/brand/IntroGate";
import { Icon } from "./components/Icon";
import { AuthBridge, RequireAuth } from "./components/RequireAuth";
import { ToastProvider } from "./components/ToastProvider";
import { Card, EmptyState, PageHeader } from "./components/ui";
import { ADMIN_PATH } from "./lib/secretTaps";
import { AdminPage } from "./pages/AdminPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { BrandPreviewPage } from "./pages/BrandPreviewPage";
import { ErrorPreviewPage } from "./pages/ErrorPreviewPage";
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
import { WorkflowPreviewPage } from "./pages/WorkflowPreviewPage";

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

/**
 * 없는 주소. 예전 알림·Discord 링크로 온 사람도 여기로 오므로 다음 행동(홈·리포트)을 엄지 자리에 큰 버튼으로 둔다.
 * PC는 제목과 카드를 가운데 한 열(640px)로 모으고, 카드 아래에 자주 가는 화면(모의투자·종목 찾기) 바로가기를 한 줄 더 둔다 (모바일은 아래 탭이 그 역할).
 */
function NotFound() {
  const { pathname } = useLocation();
  const quick = "press inline-flex h-11 items-center gap-1 rounded-full bg-fill px-4 text-[14px] font-semibold text-ink hover:bg-line";
  return (
    <div className="lg:mx-auto lg:w-full lg:max-w-[640px] lg:pt-[6vh]">
      <PageHeader title="화면 없음" back />
      <Card>
        <EmptyState
          icon="search"
          title="찾는 화면이 없어요"
          action={{ label: "홈으로", to: "/" }}
          secondary={{ label: "리포트 보기", to: "/reports" }}
        >
          주소가 바뀌었거나 지워진 화면일 수 있어요.
          <span className="mt-1 block text-[13px] break-all text-mute">{pathname}</span>
        </EmptyState>
        <nav aria-label="자주 가는 화면" className="hidden flex-wrap items-center justify-center gap-2 border-t border-line pt-5 lg:flex">
          <span className="mr-1 text-[13px] text-mute">자주 가는 화면</span>
          <Link to="/portfolio" className={quick}>
            모의투자 보기
            <Icon name="chevron" className="size-4 text-mute" />
          </Link>
          <Link to="/search" className={quick}>
            종목 찾기
            <Icon name="chevron" className="size-4 text-mute" />
          </Link>
        </nav>
      </Card>
    </div>
  );
}

export default function App() {
  return (
    <>
      {/* 화면을 옮길 때의 스크롤 (새 화면은 맨 위, 뒤로 가기는 보던 자리) — 로그인 화면 포함 */}
      <ScrollManager />
      {/* 앱을 / 또는 /login으로 열 때마다 로그인 화면 앞에 인트로 (끝나면 사라진다). 다른 화면으로 바로 연 주소·디자인 검수 화면·움직임 줄이기에서는 건너뛴다 */}
      <IntroGate />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* 디자인 검수 화면은 실제 API·로그인 없이 열려야 한다. VITE_MOCK=1 개발 서버에만 존재한다. */}
        {import.meta.env.VITE_MOCK === "1" && <Route path="/ui/errors" element={<ErrorPreviewPage />} />}
        {import.meta.env.VITE_MOCK === "1" && <Route path="/ui/workflows" element={<WorkflowPreviewPage />} />}
        {import.meta.env.VITE_MOCK === "1" && <Route path="/ui/brand" element={<BrandPreviewPage />} />}
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
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="ranking" element={<RankingPage />} />
            <Route path="my" element={<MyPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}
