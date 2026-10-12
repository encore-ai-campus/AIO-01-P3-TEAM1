import { Link } from "react-router";
import { ApiError, type ChaosConfigRequest, type ChaosConfigSaved, type ChaosScope } from "../api";

// F11 장애 주입 (API.md 7장): 장애 주입 화면(/chaos)과 리포트 상세의 "같은 설정으로 다시"가 같이 쓰는 문장·확인·오류.

export const SCOPE_LABEL: Record<ChaosScope, string> = {
  primary: "주 모델만 (primary)",
  all: "대체 모델까지 (all)",
};

const ERROR_TYPE_LABEL: Record<string, string> = {
  timeout: "응답 지연",
  server_error: "서버 오류",
  bad_output: "잘못된 출력",
};
export const errorTypeLabel = (t: string) => (ERROR_TYPE_LABEL[t] ? `${ERROR_TYPE_LABEL[t]} (${t})` : t);

export const pct = (p: number) => `${Math.round(p * 100)}%`;

/** 저장된 설정에서 신청한 관리자(requestedBy)를 뺀 신청 형식 (seed 포함 그대로) */
export function withoutRequester(c: ChaosConfigSaved): ChaosConfigRequest {
  const rest: ChaosConfigSaved = { ...c };
  delete rest.requestedBy;
  return rest;
}

/** 설정 한 줄: 확률 · 범위 · 실패 종류 · 대상 · seed · 신청 */
export function describeChaos(c: ChaosConfigSaved): string {
  return [
    `확률 ${pct(c.probability)}`,
    `범위 ${c.scope}`,
    `실패 종류 ${c.errorTypes.join(", ")}`,
    `대상 ${c.workers?.length ? c.workers.join(", ") : "전체"}`,
    `seed ${c.seed}`,
    ...(c.requestedBy ? [`신청 ${c.requestedBy}`] : []),
  ].join(" · ");
}

/** 실행 전 확인: 실제 AI 비용이 들고 팀 하루 예산에 든다. */
export function ChaosConfirm({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="notice warn" role="group" aria-label="실행 확인">
      <span>
        실제 AI를 불러 <strong>비용이 들고</strong>(시나리오당 $0.5 안팎) <strong>팀 AI 하루 예산</strong>에 듭니다. 실행할까요?
      </span>
      <span className="button-row">
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          확인하고 실행
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          취소
        </button>
      </span>
    </div>
  );
}

/** 신청 오류: 서비스의 detail 그대로. 409(진행 중)이면 그 실행으로 가는 링크. */
export function ChaosError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "장애 주입을 신청하지 못했습니다";
  const running = error instanceof ApiError && error.status === 409 && typeof error.body.id === "number" ? error.body.id : null;
  return (
    <div className="notice error" role="alert">
      {message}
      {running !== null && (
        <>
          {" "}
          <Link to={`/reports/${running}`}>진행 중인 실행 #{running} 보기</Link>
        </>
      )}
    </div>
  );
}
