import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, api, errorMessage } from "../../api/client";
import { keys, useJob, useMe, useQuota } from "../../api/queries";
import { formatUsd } from "../../lib/format";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
import { useToast } from "../toast";
import { LiveDot, Notice, Spinner } from "../ui";

// 진행 중 작업은 사용자·종목별로 이 탭에 기억한다 (sessionStorage) — 다른 화면에 다녀오거나 새로 고쳐도 '분석 중'과 경과 시간이 이어지고,
// 같은 분석을 또 누르지 않게 버튼을 막아 둔다. 서버도 같은 사용자의 같은 종목 작업이 진행 중이면 그 작업 번호를 돌려준다.
// 키에 사용자 id를 넣는다: 같은 탭에서 로그아웃하고 다른 계정으로 들어와도 앞 사람의 작업(남의 작업 — 서버가 404)을 읽지 않게.
const JOB_TTL_MS = 6 * 3_600_000; // 이보다 오래된 기록은 버린다
const jobKey = (userId: number, symbol: string) => `paper-analysis-job:${userId}:${symbol}`;

interface StoredJob {
  jobId: number;
  /** 끝났는데 사용자가 입력 중이라 결과로 옮기지 않았다 → 다시 와도 자동 이동하지 않고 '결과 보기'만 보인다. */
  held?: boolean;
  at: number;
}

function readJob(userId: number | null, symbol: string, now: number): StoredJob | null {
  if (userId === null) return null;
  try {
    const v = JSON.parse(sessionStorage.getItem(jobKey(userId, symbol)) ?? "null") as StoredJob | null;
    if (v && typeof v.jobId === "number" && typeof v.at === "number" && now - v.at < JOB_TTL_MS) return v;
  } catch {
    // 저장소를 못 쓰면 이 화면에 있는 동안만 기억한다
  }
  return null;
}

function writeJob(userId: number | null, symbol: string, job: StoredJob | null) {
  if (userId === null) return;
  try {
    if (job) sessionStorage.setItem(jobKey(userId, symbol), JSON.stringify(job));
    else sessionStorage.removeItem(jobKey(userId, symbol));
  } catch {
    // 저장소를 못 쓰면 이 화면에 있는 동안만 기억한다
  }
}

/**
 * 작업이 서버에 없다 (404 남의 작업·서버가 다시 시작돼 사라진 작업 등 — 4xx는 다시 물어도 같다). 401은 로그인 화면으로 가는 길이라 빼고,
 * 5xx·연결 끊김은 잠깐일 수 있어 계속 묻는다 (돌아오면 이어서 확인).
 */
const isGone = (err: unknown) => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401;
const GONE_TEXT = "분석 작업을 찾지 못했어요. 다시 요청해 주세요.";

/** 사용자가 지금 다른 일을 하는 중인지: 시트·대화상자가 열려 있거나 입력칸에 포커스가 있으면 화면을 옮기지 않는다 (입력을 잃지 않게). */
function userIsBusy(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.hasAttribute("data-scroll-lock")) return true;
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** 1초마다 지금 시각 (active인 동안만). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** 경과 시간 "0:42" · "12:05". */
function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * 종목 상세의 보조 버튼 "AI 교차검증 분석" (docs/DECISIONS.md 13-1 D-1 — 큰 버튼 "AI 리포트 만들기" 아래).
 * 남은 횟수 → 요청 → 작업 상태 5초 폴링 → 끝나면 분석 상세(여러 AI가 서로 검증한 과정)로.
 * 끝났을 때 사용자가 입력 중이거나 시트가 열려 있으면 옮기지 않고 '분석이 끝났어요 · 결과 보기'를 보이고 토스트로도 알린다
 * (카드 안 글은 화면 읽기에 알려지지 않고, 시트가 열려 있으면 배경이 inert다 — 토스트 영역은 role=status·data-inert-exempt). 실패도 토스트로 알린다.
 * easy면 쉬운 설명 (비용 표시 없이 남은 횟수만).
 */
export function AnalysisRequest({ symbol, name, easy = false, titleId }: { symbol: string; name: string; easy?: boolean; titleId?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const ownId = useId();
  const headingId = titleId ?? ownId;
  const { data: me } = useMe(); // RequireAuth 안이라 처음부터 있다
  const userId = me?.id ?? null;
  const { data: quota } = useQuota();
  const [stored, setStored] = useState<StoredJob | null>(() => readJob(userId, symbol, Date.now()));
  const [gone, setGone] = useState(false); // 기억한 작업이 서버에 없었다 → 안내를 남기고 그 작업은 잊는다
  const jobId = stored?.jobId ?? null;
  const { data: job, error: jobError } = useJob(jobId);

  // 작업이 서버에 없으면 잊는다: jobId가 비면 useJob이 그 작업을 더 묻지 않는다 (5초 폴링이 멈춘다). 안내는 한 번 — 다시 요청하면 지운다.
  // 렌더 중 조건부 파생 상태 (그 작업을 지운 뒤에는 jobError가 없어 다시 들어오지 않는다)
  if (stored !== null && isGone(jobError)) {
    setStored(null);
    setGone(true);
  }

  const request = useMutation({
    mutationFn: () => api.post<{ jobId: number }>("/api/analyses", { symbol }),
    onSuccess: (res) => {
      const next = { jobId: res.jobId, at: Date.now() };
      writeJob(userId, symbol, next);
      setStored(next);
      setGone(false);
      void qc.invalidateQueries({ queryKey: keys.quota });
    },
  });

  const doneId = job?.status === "DONE" ? (job.result?.analysisIds[0] ?? null) : null;
  const held = stored?.held ?? false;
  const announced = useRef<number | null>(null); // 이동을 미루고 토스트로 알린 결과 (한 번만)
  useEffect(() => {
    if (doneId === null) return;
    void qc.invalidateQueries({ queryKey: ["analyses"] });
    if (held || userIsBusy()) {
      if (jobId !== null) writeJob(userId, symbol, { jobId, at: Date.now(), held: true }); // 다시 와도 '결과 보기'만
      // 입력 중이라 화면을 옮기지 않았다 → 끝난 것을 알린다 (다시 온 화면(held)에서는 카드의 '결과 보기'만 — 이미 알린 결과다)
      if (!held && announced.current !== doneId) {
        announced.current = doneId;
        toast(`${name} 교차검증 분석이 끝났어요`, "success", {
          action: {
            label: "결과 보기",
            onClick: () => {
              writeJob(userId, symbol, null);
              navigate(`/analyses/${doneId}`);
            },
          },
        });
      }
      return;
    }
    writeJob(userId, symbol, null);
    navigate(`/analyses/${doneId}`);
  }, [doneId, held, jobId, name, navigate, qc, symbol, toast, userId]);

  const failed = job?.status === "FAILED" || (job?.status === "DONE" && doneId === null);
  // 실패·없어진 작업은 이 화면에서만 알리고 잊는다 (다시 요청할 수 있게). 5xx·연결 끊김은 기록을 남긴다 (돌아오면 이어서 확인)
  useEffect(() => {
    if (failed || gone) writeJob(userId, symbol, null);
  }, [failed, gone, userId, symbol]);
  const failAnnounced = useRef<number | null>(null);
  useEffect(() => {
    if (!failed || jobId === null || failAnnounced.current === jobId) return;
    failAnnounced.current = jobId;
    toast(`${name} 교차검증 분석에 실패했어요`, "error");
  }, [failed, jobId, name, toast]);

  const running = jobId !== null && !failed && !jobError && doneId === null && (!job || job.status === "QUEUED" || job.status === "RUNNING");
  const now = useNow(running);
  const startedAt = job?.createdAt ? new Date(job.createdAt).getTime() : (stored?.at ?? now);
  const disabled = !quota || !quota.enabled || quota.remaining <= 0 || running || request.isPending;
  const problem = request.isError
    ? errorMessage(request.error)
    : gone
      ? GONE_TEXT
      : jobError
        ? errorMessage(jobError) // 5xx·연결 끊김: 계속 묻는다 (되면 이 글도 사라진다)
        : failed
          ? `분석에 실패했어요: ${job?.error ?? "결과가 없어요."}`
          : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-[17px] font-bold">
            교차검증 분석
          </h2>
          <p className="mt-0.5 text-[13px] leading-snug text-sub">
            {easy
              ? "AI 여러 곳이 각자 계획을 내고 서로 검증하는 과정을 볼 수 있어요. 몇 분 걸려요."
              : "여러 모델이 시나리오를 내고 교차검증 → 리스크 엔진 → 최종 승인을 거쳐요."}
          </p>
          <p className="mt-0.5 text-[13px] text-mute">
            {quota
              ? !quota.enabled
                ? "AI 키가 없어 분석을 요청할 수 없어요."
                : quota.remaining <= 0
                  ? `오늘 분석 한도(${quota.limitPerUser}회)를 다 썼어요. 내일 다시 요청할 수 있어요.`
                  : easy
                    ? `오늘 ${quota.remaining}번 더 분석할 수 있어요`
                    : `오늘 ${quota.remaining}번 더 분석할 수 있어요 · 예상 비용 약 ${formatUsd(quota.estimatedCostUsd)}`
              : "남은 횟수를 확인하는 중…"}
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => request.mutate()}
          className="press flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-fill px-4 text-[15px] font-semibold text-ink hover:bg-line disabled:cursor-not-allowed disabled:opacity-40"
        >
          {request.isPending ? <Spinner /> : <Icon name="sparkle" className="size-4 text-brand" />}
          AI 교차검증 분석
        </button>
      </div>

      <Collapse open={running}>
        <Notice>
          <p className="flex items-center gap-2 font-semibold">
            <LiveDot />
            {name} 교차검증 분석 중이에요
            <span className="font-normal tabular-nums opacity-80">· {formatElapsed(now - startedAt)}</span>
          </p>
          <p className="mt-0.5 text-[13px] opacity-80">
            {job?.status === "RUNNING" ? "AI들이 계획을 검증하고 있어요" : "차례를 기다리고 있어요"}. 몇 분 걸려요 — 다른 화면에 다녀와도 이어서 확인하고,
            끝나면 결과로 옮겨요.
          </p>
        </Notice>
      </Collapse>
      <Collapse open={doneId !== null}>
        <div className="flex items-center justify-between gap-3 rounded-xl bg-ok-soft px-3.5 py-2.5">
          <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <Icon name="check-circle" className="size-4 shrink-0 text-ok" />
            분석이 끝났어요
          </p>
          {doneId !== null && (
            <Link
              to={`/analyses/${doneId}`}
              onClick={() => writeJob(userId, symbol, null)}
              className="press inline-flex h-11 shrink-0 items-center gap-0.5 rounded-xl bg-card px-3.5 text-[14px] font-semibold text-brand-ink hover:bg-line dark:bg-line"
            >
              결과 보기 <Icon name="chevron" className="size-4" />
            </Link>
          )}
        </div>
      </Collapse>
      <Collapse open={problem !== null}>
        <Notice tone="error">{problem ?? ""}</Notice>
      </Collapse>
    </div>
  );
}
