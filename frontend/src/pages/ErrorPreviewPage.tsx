import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ErrorPanel } from "../components/errors/ErrorPanel";
import type { ErrorKind } from "../components/errors/errorTypes";
import { Icon, type IconName } from "../components/Icon";
import { Card, EmptyState, PageHeader, Spinner } from "../components/ui";
import { cn } from "../lib/cn";

type ScenarioId = "empty" | "network" | "validation" | "rate_limit" | "unavailable" | "workflow" | "pdf";
type Tone = "waiting" | "running" | "failed" | "recovered" | "empty";

interface SceneStep {
  title: string;
  body: string;
  tone: Tone;
  icon: IconName;
  error?: ErrorKind;
}

interface Scenario {
  id: ScenarioId;
  title: string;
  description: string;
  guide?: string;
  steps: SceneStep[];
  retryTo?: number;
  pauseAt?: number;
}

const SCENARIOS: Scenario[] = [
  {
    id: "empty",
    title: "데이터 없음",
    description: "리포트 목록 진입 → 불러오는 중 → 결과 없음",
    steps: [
      { title: "리포트 목록을 열었어요", body: "저장된 리포트를 확인합니다.", tone: "waiting", icon: "doc" },
      { title: "분석 결과를 불러오는 중입니다", body: "서버에서 내 리포트 목록을 확인하고 있어요.", tone: "running", icon: "restart" },
      { title: "아직 분석 결과가 없습니다", body: "리포트를 만들면 이곳에서 결과를 볼 수 있어요.", tone: "empty", icon: "doc" },
    ],
  },
  {
    id: "network",
    title: "실시간 연결 복구",
    description: "DR-NET-01 · 실시간 연결 끊김 → Snapshot Polling 전환 → 화면 갱신 재개",
    guide: "DR-NET-01",
    steps: [
      { title: "리포트를 만드는 중입니다", body: "실시간 연결(SSE)로 Agent 상태를 받고 있어요.", tone: "running", icon: "flow" },
      { title: "실시간 연결이 끊겼어요", body: "현재 화면과 작업은 유지하고 다른 확인 방법으로 전환합니다.", tone: "failed", icon: "wifi-off", error: "network" },
      { title: "Snapshot Polling으로 확인 중", body: "일정 간격으로 현재 상태를 다시 불러오고 있어요.", tone: "running", icon: "restart" },
      { title: "화면 갱신을 다시 시작했어요", body: "리포트 작업은 중단되지 않았고 최신 상태를 표시합니다.", tone: "recovered", icon: "check-circle" },
    ],
  },
  {
    id: "validation",
    title: "입력 오류",
    description: "리포트 신청 → 설정 검증 실패 → 입력 수정 안내",
    steps: [
      { title: "AI 리포트 만들기를 눌렀어요", body: "선택한 종목과 장애 주입 설정을 확인합니다.", tone: "waiting", icon: "doc" },
      { title: "신청 내용을 확인 중입니다", body: "잘못된 값이 서버로 전달되지 않도록 먼저 검사해요.", tone: "running", icon: "restart" },
      { title: "입력한 내용을 확인해 주세요", body: "문제가 있는 설정을 고친 뒤 다시 신청할 수 있어요.", tone: "failed", icon: "alert-circle", error: "validation" },
    ],
    pauseAt: 2,
  },
  {
    id: "rate_limit",
    title: "신청 한도",
    description: "리포트 신청 → 오늘 사용량 확인 → 다음 이용 시간 안내",
    steps: [
      { title: "AI 리포트 만들기를 눌렀어요", body: "오늘 남은 리포트 횟수를 확인합니다.", tone: "waiting", icon: "doc" },
      { title: "오늘 사용량을 확인 중입니다", body: "중복 실행과 예상하지 못한 비용을 막고 있어요.", tone: "running", icon: "restart" },
      { title: "오늘 만들 수 있는 리포트를 모두 만들었어요", body: "새 작업을 시작하지 않고 다음 이용 가능 시간을 안내합니다.", tone: "failed", icon: "clock", error: "rate_limit" },
    ],
    pauseAt: 2,
  },
  {
    id: "unavailable",
    title: "분석 서비스 중단",
    description: "리포트 신청 → 시세·AI 서비스 응답 없음 → 잠시 후 재시도",
    steps: [
      { title: "AI 리포트 만들기를 눌렀어요", body: "시세와 AI 분석 서비스를 확인합니다.", tone: "waiting", icon: "doc" },
      { title: "분석 서비스를 확인 중입니다", body: "리포트를 안전하게 시작할 수 있는지 확인하고 있어요.", tone: "running", icon: "restart" },
      { title: "지금은 분석 서비스를 사용할 수 없어요", body: "작업을 시작하지 않고 다시 시도할 수 있도록 안내합니다.", tone: "failed", icon: "alert", error: "unavailable" },
    ],
    pauseAt: 2,
  },
  {
    id: "workflow",
    title: "Workflow 최종 실패",
    description: "DR-LLM-04 · 필수 Agent 실패 → Join Guard 차단 → 실패 이유·다시 신청",
    guide: "DR-LLM-04",
    steps: [
      { title: "필수 Agent가 자료를 조사 중입니다", body: "시세·재무·공시 결과가 모두 필요한 단계예요.", tone: "running", icon: "flow" },
      { title: "재무·공시 Agent가 응답하지 못했어요", body: "Retry와 Fallback 이후에도 필요한 결과를 받지 못했습니다.", tone: "failed", icon: "alert" },
      { title: "Join Guard가 다음 단계를 막았어요", body: "불완전한 자료로 리포트를 만들지 않도록 작성·검토 단계를 건너뜁니다.", tone: "failed", icon: "shield" },
      { title: "리포트를 완성하지 못했어요", body: "Trace State에서 멈춘 Agent를 확인하거나 다시 신청할 수 있어요.", tone: "failed", icon: "flow", error: "workflow" },
    ],
    pauseAt: 3,
  },
  {
    id: "pdf",
    title: "PDF 생성 실패·재시도",
    description: "웹 리포트 완료 → PDF 준비 실패 → 웹 본문 유지 → 다시 요청 → 다운로드 준비",
    steps: [
      { title: "웹 리포트는 완성됐어요", body: "화면의 본문은 그대로 읽을 수 있습니다.", tone: "recovered", icon: "check-circle" },
      { title: "PDF를 준비하고 있습니다", body: "완성된 리포트를 A4 파일로 만들고 있어요.", tone: "running", icon: "download" },
      { title: "PDF를 열지 못했어요", body: "웹 리포트는 유지하고 PDF만 다시 요청할 수 있어요.", tone: "failed", icon: "doc", error: "pdf" },
      { title: "PDF를 다시 준비하고 있습니다", body: "웹 리포트를 닫지 않고 파일 생성만 다시 요청했어요.", tone: "running", icon: "restart" },
      { title: "PDF 다운로드가 준비됐어요", body: "완성된 파일을 열어 확인할 수 있어요.", tone: "recovered", icon: "check-circle" },
    ],
    pauseAt: 2,
    retryTo: 3,
  },
];

const toneClass: Record<Tone, string> = {
  waiting: "bg-fill text-sub",
  running: "bg-brand-soft text-brand-ink",
  failed: "bg-up-soft text-up-ink",
  recovered: "bg-ok-soft text-ok-ink",
  empty: "bg-fill text-mute",
};

/** VITE_MOCK=1 전용. 실제 요청 없이 사용자 행동부터 결과까지 오류·복구 흐름을 재생한다. */
export function ErrorPreviewPage() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>("network");
  const scenario = SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0];
  const [index, setIndex] = useState(0);
  const last = scenario.steps.length - 1;
  const paused = scenario.pauseAt === index;
  const step = scenario.steps[index];

  useEffect(() => {
    if (index >= last || paused) return;
    const timer = window.setTimeout(() => setIndex((value) => Math.min(value + 1, last)), 1100);
    return () => window.clearTimeout(timer);
  }, [index, last, paused, scenarioId]);

  const choose = (id: ScenarioId) => {
    setScenarioId(id);
    setIndex(0);
  };
  const retry = () => setIndex(scenario.retryTo ?? 0);

  return (
    <>
      <PageHeader title="오류·복구 시나리오" back />
      <div className="space-y-3 lg:space-y-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-[18px] font-bold">사용자 행동부터 결과까지 재생</h1>
              <p className="mt-1 text-[14px] leading-relaxed text-sub">실제 API·AI 비용 없이 프로젝트 가이드의 로딩·오류·복구 상황을 순서대로 확인합니다.</p>
            </div>
            <Link to="/ui/workflows" className="press inline-flex h-11 items-center rounded-xl bg-fill px-3.5 text-[14px] font-semibold text-brand-ink hover:bg-line">Agent Workflow 보기</Link>
          </div>
          <p className="mt-2 text-[12px] font-semibold text-warn-ink">예시 데이터 · 실제 실행이 아닙니다</p>
          <div role="group" aria-label="오류·복구 시나리오" className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SCENARIOS.map((item) => (
              <button key={item.id} type="button" aria-pressed={scenarioId === item.id} onClick={() => choose(item.id)} className={cn("press min-h-16 rounded-xl border-2 p-3 text-left", scenarioId === item.id ? "border-warn bg-warn-soft" : "border-line bg-card hover:bg-fill")}>
                <span className="block text-[14px] font-bold">{item.title}</span>
                <span className="mt-1 block text-[12px] leading-snug text-sub">{item.description}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card aria-labelledby="scenario-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="scenario-title" className="text-[17px] font-bold">{scenario.title}</h2>
              <p className="mt-0.5 text-[13px] text-mute">{scenario.guide ? `${scenario.guide} · ` : ""}단계 {index + 1}/{scenario.steps.length}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setIndex(0)} className="press h-10 rounded-xl bg-fill px-3 text-[13px] font-semibold hover:bg-line">처음부터</button>
              <button type="button" disabled={index >= last || paused} onClick={() => setIndex((value) => Math.min(value + 1, last))} className="press h-10 rounded-xl bg-ink px-3 text-[13px] font-semibold text-on-ink disabled:opacity-40">다음 단계</button>
            </div>
          </div>
          <ol aria-label="시나리오 진행 단계" className="mt-4 space-y-2">
            {scenario.steps.map((item, position) => {
              const current = position === index;
              const done = position < index;
              return (
                <li key={`${scenario.id}-${item.title}`} aria-current={current ? "step" : undefined} className={cn("flex gap-3 rounded-xl px-3 py-2.5", current ? toneClass[item.tone] : "bg-fill/60", position > index && "opacity-45")}>
                  <span className={cn("grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-bold", done ? "bg-ok text-white" : current ? "bg-card" : "bg-line text-mute")}>
                    {done ? <Icon name="check" className="size-4" /> : position + 1}
                  </span>
                  <span className="min-w-0"><b className="block text-[14px]">{item.title}</b><span className="mt-0.5 block text-[12px] leading-snug opacity-80">{item.body}</span></span>
                </li>
              );
            })}
          </ol>
        </Card>

        {step.error ? (
          <ErrorPanel kind={step.error} onRetry={step.error === "rate_limit" ? undefined : retry} secondary={step.error === "pdf" ? null : undefined} />
        ) : step.tone === "running" ? (
          <Card aria-live="polite" className="flex min-h-48 flex-col items-center justify-center text-center">
            <Spinner className="size-8 text-brand" /><h2 className="mt-4 text-[18px] font-bold">{step.title}</h2><p className="mt-1 max-w-lg text-[14px] leading-relaxed text-sub">{step.body}</p>
          </Card>
        ) : step.tone === "empty" ? (
          <Card className="min-h-48"><EmptyState icon="doc" title={step.title}>{step.body}</EmptyState></Card>
        ) : (
          <Card aria-live="polite" className="flex min-h-48 flex-col items-center justify-center text-center">
            <span className={cn("grid size-12 place-items-center rounded-full", toneClass[step.tone])}><Icon name={step.icon} className="size-6" /></span><h2 className="mt-4 text-[18px] font-bold">{step.title}</h2><p className="mt-1 max-w-lg text-[14px] leading-relaxed text-sub">{step.body}</p>
          </Card>
        )}
      </div>
    </>
  );
}
