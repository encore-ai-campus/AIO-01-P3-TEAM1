import { Navigate, Route, Routes } from "react-router";
import { RequireAuth } from "./components/Layout";
import Alerts from "./pages/Alerts";
import Costs from "./pages/Costs";
import Deploys from "./pages/Deploys";
import Engine from "./pages/Engine";
import Login from "./pages/Login";
import McpTools from "./pages/McpTools";
import Overview from "./pages/Overview";
import Recovery from "./pages/Recovery";
import ReportDetail from "./pages/ReportDetail";
import Reports from "./pages/Reports";
import Service from "./pages/Service";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route index element={<Overview />} />
        <Route path="service" element={<Service />} />
        <Route path="engine" element={<Engine />} />
        <Route path="deploys" element={<Deploys />} />
        <Route path="reports" element={<Reports />} />
        <Route path="reports/:id" element={<ReportDetail />} />
        <Route path="recovery" element={<Recovery />} />
        <Route path="costs" element={<Costs />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="tools" element={<McpTools />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
