import { useId } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { Icon, type IconName } from "../Icon";
import { Spinner, type StateAction } from "../ui";
import type { ErrorKind } from "./errorTypes";

interface ErrorCopy {
  title: string;
  message: string;
  next: string;
  icon: IconName;
}

const COPY: Record<ErrorKind, ErrorCopy> = {
  network: {
    title: "서버에 연결하지 못했어요",
    message: "인터넷 연결이나 서버 상태를 확인하지 못했어요.",
    next: "연결을 확인한 뒤 다시 시도해 주세요.",
    icon: "wifi-off",
  },
  validation: {
    title: "입력한 내용을 확인해 주세요",
    message: "리포트를 신청하는 데 필요한 정보가 올바르지 않아요.",
    next: "입력 내용을 고친 뒤 다시 신청할 수 있어요.",
    icon: "alert-circle",
  },
  rate_limit: {
    title: "오늘 만들 수 있는 리포트를 모두 만들었어요",
    message: "하루 리포트 신청 한도에 도달했어요.",
    next: "다음 이용 가능 시간에 다시 신청해 주세요.",
    icon: "clock",
  },
  budget: {
    title: "오늘 팀 AI 비용 예산을 다 썼어요",
    message: "팀 전체가 오늘 쓸 수 있는 AI 비용을 모두 썼어요.",
    next: "내일 0시에 다시 신청할 수 있어요.",
    icon: "clock",
  },
  unavailable: {
    title: "지금은 분석 서비스를 사용할 수 없어요",
    message: "시세 또는 AI 분석 서비스가 잠시 응답하지 않고 있어요.",
    next: "잠시 후 다시 시도해 주세요.",
    icon: "alert",
  },
  workflow: {
    title: "리포트를 완성하지 못했어요",
    message: "Multi-Agent Workflow 실행 중 필요한 단계를 완료하지 못했어요.",
    next: "Trace State에서 멈춘 단계를 확인하거나 리포트를 다시 만들 수 있어요.",
    icon: "flow",
  },
  pdf: {
    title: "PDF를 열지 못했어요",
    message: "리포트는 완성됐지만 PDF 파일을 준비하지 못했어요.",
    next: "웹 리포트를 먼저 확인하고 PDF를 다시 요청해 주세요.",
    icon: "doc",
  },
  unknown: {
    title: "문제가 발생했어요",
    message: "요청을 처리하는 중 예상하지 못한 문제가 생겼어요.",
    next: "다시 시도해 주세요. 같은 문제가 계속되면 리포트 목록으로 돌아가 주세요.",
    icon: "alert",
  },
};

function Action({ action, primary }: { action: StateAction; primary: boolean }) {
  const cls = cn(
    "press inline-flex h-12 w-full items-center justify-center rounded-xl px-5 text-[15px] font-semibold sm:w-auto",
    primary ? "bg-brand text-white hover:bg-brand-dark" : "bg-fill text-sub hover:bg-line",
  );
  return "to" in action ? (
    <Link className={cls} to={action.to}>
      {action.label}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={action.onClick}>
      {action.label}
    </button>
  );
}

/** 문제 → 쉬운 설명 → 다음 행동 순서의 공통 오류 화면. 개발자 오류 원문은 기본 화면에 노출하지 않는다. */
export function ErrorPanel({
  kind,
  detail,
  onRetry,
  retrying = false,
  secondary = { label: "리포트 목록으로", to: "/reports" },
  compact = false,
  className,
}: {
  kind: ErrorKind;
  detail?: string;
  onRetry?: () => void;
  retrying?: boolean;
  secondary?: StateAction | null;
  compact?: boolean;
  className?: string;
}) {
  const copy = COPY[kind];
  const titleId = useId();
  return (
    <section
      role="alert"
      aria-labelledby={titleId}
      className={cn("rounded-2xl bg-card text-center", compact ? "px-4 py-5" : "px-5 py-8 sm:px-8", className)}
    >
      <span aria-hidden="true" className={cn("mx-auto grid place-items-center rounded-full bg-up-soft text-up-ink", compact ? "size-10" : "size-12")}>
        <Icon name={copy.icon} className={compact ? "size-5" : "size-6"} />
      </span>
      <h2 id={titleId} className={cn("font-bold text-ink", compact ? "mt-3 text-[16px]" : "mt-4 text-[18px]")}>
        {copy.title}
      </h2>
      <p className={cn("text-[14px] leading-relaxed text-sub", compact ? "mt-1.5" : "mt-2")}>{detail || copy.message}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-mute">{copy.next}</p>
      {(onRetry || secondary) && (
        <div className={cn("mx-auto flex max-w-[320px] flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center", compact ? "mt-4" : "mt-6")}>
          {onRetry && (
            <button
              type="button"
              onClick={() => !retrying && onRetry()}
              aria-disabled={retrying || undefined}
              aria-busy={retrying || undefined}
              className="press inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 text-[15px] font-semibold text-white hover:bg-brand-dark sm:w-auto"
            >
              {retrying && <Spinner />}
              다시 시도
            </button>
          )}
          {secondary && <Action action={secondary} primary={!onRetry} />}
        </div>
      )}
    </section>
  );
}
