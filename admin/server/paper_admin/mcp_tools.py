"""MCP 도구 목록 (API.md 6장). MCP 서버(mcp_server)가 도구를 등록할 때와 관리자 API가 목록을 낼 때 같이 쓴다.

MCP SDK를 import하지 않는다 — 관리자 API 프로세스는 목록만 읽는다.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    path: str               # 부르는 관리자 API 경로
    params: tuple[str, ...] = ()

    def as_dict(self) -> dict:
        return {"name": self.name, "description": self.description, "path": self.path, "params": list(self.params)}


TOOLS: tuple[Tool, ...] = (
    Tool("overview", "관리자 개요: 서비스·엔진·배포·리포트 장애·복구 지표·AI 비용·알림을 나쁜 것부터 한 줄씩 요약한다.",
         "/api/admin/overview"),
    Tool("service_status", "서비스 주소(/api/health, /)의 응답 여부·응답 시간과 최근 24시간 가동률을 본다.", "/api/admin/service"),
    Tool("engine_status", "엔진 루프의 마지막 동작 시각(2분 넘으면 멈춤)·버전·중단 스위치·최근 단계 오류·한도를 본다.",
         "/api/admin/engine"),
    Tool("deploy_history", "서버별 지금 버전과 배포 기록(성공·실패·되돌림)을 최신순으로 본다. limit 1~200.",
         "/api/admin/deploys", ("limit",)),
    Tool("report_failures", "기간 안 AI 리포트의 실패·복구·장애 주입 목록. days 1~90, kind all|failed|recovered|chaos, "
         "team stock_report|stock_selection|빈 값, limit 1~500.", "/api/admin/reports", ("days", "kind", "team", "limit")),
    Tool("report_trace", "리포트 하나의 실행 기록(재시도·대체 모델 전환·포기)을 시간순으로 보고 복구 요약을 함께 본다.",
         "/api/admin/reports/{report_id}/trace", ("report_id",)),
    Tool("recovery_stats", "기간 안 자동 복구율·평균 복구 시간·오류 종류별·Worker별 장애 수. days 1~90.",
         "/api/admin/recovery", ("days",)),
    Tool("ai_costs", "날짜별 AI 비용(리포트·분석·장기투자)과 오늘 예산·한도 대비 사용량. days 1~90.",
         "/api/admin/costs", ("days",)),
    Tool("alerts_and_jobs", "Discord 알림 발송 실패·오래된 대기와 오래 멈춘 분석·리포트 작업을 본다. hours 1~168.",
         "/api/admin/alerts", ("hours",)),
)
BY_NAME = {t.name: t for t in TOOLS}
