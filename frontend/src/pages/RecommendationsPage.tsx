// /recommendations: 새 계획 제안 목록 (전문가 보기: AI 추천, 팀 공용). 모의투자 탭 안의 화면이다 (docs/plans/컨셉변경계획.md 4-1).
// 쉬운 보기: 리포트에서 나온 계획만 앞에, 분석·연습용 예시는 접힌 "다른 계획 ○개" 안에 (출처는 늘 표시).
// 필터(기한 안 / 전체), 카드를 누르면 실행 확인. 연습용 예시 계획 만들기(AI 아님)는 보조 도구라 목록 뒤(PC는 오른쪽 열)에 둔다.
// 배치: 이 화면의 목적은 목록에서 고르는 것 — 목록 제목·필터 → 안내 한 줄 → 카드 → 다른 계획(접힘) → 지금은 시작할 수 없는 제안(접힘) → 만들기 (trade-26).
//   카드는 시작할 수 있는 것만 앞에 두고, 계좌와 무관한 사유(blockedBy)로 시작할 수 없는 것은 아래에 접는다. 같은 종목은 하나만 보이고
//   나머지는 그 카드 안 '같은 종목의 이전 제안 n개'로 접는다 (UX-2, DECISIONS 23장). '전체' 필터에서는 시작할 수 없는 것(기한 지남 포함)을 펼쳐 둔다.
//   연습용 예시는 개발·시연용(D-4)이라 쉬운 보기에서는 접어 둔다. PC는 [목록 | 만들기] 2단.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useCreateDemo } from "../api/autotrade";
import { ApiError, errorMessage } from "../api/client";
import { useRecommendations } from "../api/queries";
import type { Recommendation } from "../api/types";
import { RecommendationCard } from "../components/autotrade/RecommendationCard";
import { Icon } from "../components/Icon";
import { Collapse } from "../components/motion/Collapse";
import { useToast } from "../components/toast";
import { Card, EmptyState, ErrorState, Notice, PageHeader, Segmented, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { revealList, useRevealAfterLoading } from "../hooks/useMotionState";
import { type ProposalGroup, arrangeProposals, otherKinds } from "../lib/autotrade";
import { cn } from "../lib/cn";

type Filter = "open" | "all";

/** 서버가 연습용 예시를 꺼 두었는지 (403). 개발용 설정 이름이 든 서버 문장 대신 쉬운 한 줄로 접는다 (trade-v03). */
const isDemoOff = (err: unknown) => err instanceof ApiError && err.status === 403;

/** 포커스가 갈 곳을 잃었는지 (누른 버튼이 진행 중에 막혀 브라우저가 포커스를 body로 옮긴 경우 포함). */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

function DemoForm({ easy, onOff }: { easy: boolean; onOff: (moveFocus: boolean) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const demo = useCreateDemo();
  const [symbol, setSymbol] = useState("");
  return (
    <>
      <p className="text-[14px] leading-snug text-sub">
        {easy
          ? "AI가 아닌 규칙으로 만든 연습용 예시예요. 최근 변동폭으로 사는·목표·손절 가격을 정해요. AI 리포트가 완성되면 그 계획이 여기에 떠요."
          : "규칙 기반 연습용 예시(AI 아님). 일봉 변동폭(ATR)으로 진입·목표·손절을 정합니다. AI 리포트가 완성되면 AI 추천이 여기에 뜹니다."}
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          demo.mutate(symbol.trim(), {
            onSuccess: (r) => {
              toast(`${r.name} 연습용 예시 계획을 만들었어요.`, "success");
              setSymbol("");
              navigate(`/recommendations/${r.id}`);
            },
            onError: (err) => {
              // 꺼져 있으면 폼이 한 줄로 바뀌어 누른 버튼이 사라진다: 포커스가 이 폼에 있었으면(또는 갈 곳을 잃었으면) 그 줄로 옮긴다 (trade-r6)
              if (isDemoOff(err)) onOff(form.contains(document.activeElement) || focusLost());
            },
          });
        }}
      >
        <label htmlFor="demo-symbol" className="sr-only">
          종목 코드 (선택)
        </label>
        <input
          id="demo-symbol"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="종목 코드 (비우면 자동 선택)"
          maxLength={12}
          autoComplete="off"
          className="h-12 min-w-0 flex-1 rounded-xl bg-fill px-3.5 text-[16px] outline-none focus:ring-2 focus:ring-brand"
        />
        <button
          type="submit"
          disabled={demo.isPending}
          className="press flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-ink px-4 text-[15px] font-semibold text-on-ink hover:bg-ink/85 disabled:opacity-40"
        >
          {demo.isPending && <Spinner />}
          만들기
        </button>
      </form>
      {demo.isError && !isDemoOff(demo.error) && (
        <Notice tone="error" className="mt-3">
          {errorMessage(demo.error)}
        </Notice>
      )}
    </>
  );
}

/** 연습용 예시 계획 만들기. 쉬운 보기에서는 접어 둔다(보조 도구 — 4-3). 서버가 꺼 두었으면 한 줄로 줄인다. */
function DemoCreate({ easy, off, onOff }: { easy: boolean; off: boolean; onOff: () => void }) {
  const [open, setOpen] = useState(!easy);
  // '만들기'를 누른 뒤 꺼짐으로 바뀌면 그 한 줄로 포커스를 옮긴다 — 누른 버튼이 폼째 사라져 포커스가 body로 떨어지면
  // 다음 Tab이 화면 맨 앞으로 가고 무슨 일이 있었는지도 읽히지 않는다 (계약 0장 7, trade-r6). 줄을 읽어 주는 것도 이 포커스다
  // (role=status는 토스트 영역만 쓴다)
  const offLine = useRef<HTMLParagraphElement>(null);
  const focusOff = useRef(false);
  useEffect(() => {
    if (!off || !focusOff.current) return;
    focusOff.current = false;
    offLine.current?.focus({ preventScroll: true });
  }, [off]);
  const turnOff = (moveFocus: boolean) => {
    focusOff.current = moveFocus;
    onOff();
  };
  const title = (
    <>
      <Icon name="chart" className="size-5 text-warn-ink" />
      연습용 예시 계획 만들기
    </>
  );
  if (off) {
    return (
      <p ref={offLine} tabIndex={-1} className="flex items-start gap-2 rounded-2xl bg-card px-5 py-4 text-[14px] leading-snug text-sub outline-none">
        <Icon name="info" className="mt-0.5 size-4 shrink-0 text-mute-weak" />
        {easy ? "연습용 예시 계획은 지금 만들 수 없어요 (서버에서 꺼 두었어요)." : "연습용 예시 계획은 지금 꺼져 있습니다 (서버 설정)."}
      </p>
    );
  }
  if (!easy) {
    return (
      <Card aria-labelledby="demo-title">
        <h2 id="demo-title" className="mb-1 flex items-center gap-1.5 text-[17px] font-bold">
          {title}
        </h2>
        <DemoForm easy={easy} onOff={turnOff} />
      </Card>
    );
  }
  return (
    <section aria-labelledby="demo-title" className="rounded-2xl bg-card px-5">
      <h2 id="demo-title">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? "demo-body" : undefined}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-14 w-full items-center gap-1.5 py-3 text-left text-[16px] font-bold"
        >
          {title}
          <Icon name="chevron-down" className={cn("ml-auto size-5 text-mute-weak transition-transform duration-fast", open && "rotate-180")} />
        </button>
      </h2>
      <Collapse open={open} id="demo-body">
        <div className="pb-5">
          <DemoForm easy={easy} onOff={turnOff} />
        </div>
      </Collapse>
    </section>
  );
}

function CardList({ list, easy, label, reveal }: { list: ProposalGroup<Recommendation>[]; easy: boolean; label: string; reveal: boolean }) {
  // 카드 5개 이하면 순서대로 살짝 올라오고, 많으면 목록 전체가 한 번에 페이드 (처음 불러왔을 때만).
  // 방식은 처음 개수로 정해 둔다 (필터로 개수가 바뀌어 rise↔fade가 바뀌면 애니메이션이 다시 돈다)
  const [kind] = useState<"rise" | "fade">(() => (list.length <= 5 ? "rise" : "fade"));
  return (
    <ul {...revealList(reveal, kind)} aria-label={label} className="grid gap-3 sm:grid-cols-2 sm:items-start">
      {list.map((g) => (
        <li key={g.rec.id}>
          <RecommendationCard r={g.rec} rest={g.rest} restOlder={g.restOlder} easy={easy} />
        </li>
      ))}
    </ul>
  );
}

/** 목록 아래의 접힘 한 줄 (다른 계획 · 지금은 시작할 수 없는 제안). */
function Fold({ id, label, open, onToggle, children }: { id: string; label: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={onToggle}
        className="press flex min-h-12 w-full items-center justify-between gap-2 rounded-2xl bg-card px-4 py-2 text-left text-[15px] font-semibold text-sub hover:bg-line"
      >
        {label}
        <Icon name="chevron-down" className={cn("size-5 shrink-0 text-mute-weak transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id={id} className="mt-3">
        {children}
      </Collapse>
    </div>
  );
}

export function RecommendationsPage() {
  const { easy } = useViewMode();
  const [params, setParams] = useSearchParams();
  const filter: Filter = params.get("status") === "all" ? "all" : "open";
  // 필터를 바꾸는 동안 이전 목록을 흐리게 남긴다 (스켈레톤으로 바뀌며 높이가 출렁이지 않게 — trade-17)
  const { data, isPending, isError, error, refetch, isFetching, isPlaceholderData } = useRecommendations({ status: filter }, true, { keepPrevious: true });
  const reveal = useRevealAfterLoading(isPending);
  const [showOthers, setShowOthers] = useState(false);
  // 시작할 수 없는 제안: 기본은 접고, '전체'를 고르면 펼친다 (기한이 지난 것을 보려고 고른 필터다). 한 번 누르면 그 선택을 따른다
  const [blockedOpen, setBlockedOpen] = useState<boolean | null>(null);
  const showBlocked = blockedOpen ?? filter === "all";
  const [demoOff, setDemoOff] = useState(false);
  const { ready, others, blocked } = arrangeProposals(data?.results ?? [], easy);
  const empty = ready.length === 0 && others.length === 0 && blocked.length === 0;
  const setFilter = (v: Filter) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (v === "all") sp.set("status", "all");
        else sp.delete("status");
        return sp;
      },
      { replace: true },
    );
  // 목록 제목은 시간 사실만 말한다: '시작할 수 있는'은 안전장치가 정하므로 쓰지 않는다 (trade-04)
  const heading = filter === "open" ? (easy ? "기한이 남은 계획" : "유효한 추천") : easy ? "모든 계획 제안" : "모든 추천";

  return (
    <>
      <PageHeader
        title={easy ? "새 계획 제안" : "AI 추천"}
        back
        right={
          // 보이는 높이는 36px, 누르는 자리는 위아래로 넓혀 44px (trade-22)
          <Link
            to="/plans"
            className="press relative flex h-9 shrink-0 items-center gap-1 rounded-xl bg-card px-3 text-[14px] font-semibold text-sub before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-line"
          >
            <Icon name="flow" className="size-4" />
            {easy ? "모의 자동매매" : "내 자동매매"}
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-6">
        <section aria-labelledby="rec-list-title" className="min-w-0 space-y-3">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 id="rec-list-title" className="text-[17px] font-bold">
              {heading}
              {data && <span className="ml-1.5 text-[15px] font-semibold text-mute tabular-nums">{easy ? ready.length : data.count}</span>}
              {isPlaceholderData && <Spinner className="ml-2 size-3.5 align-[-2px] text-mute" />}
            </h2>
            <Segmented
              label={easy ? "계획 필터" : "추천 필터"}
              value={filter}
              onChange={setFilter}
              surface="page"
              options={[
                { value: "open", label: easy ? "기한 안" : "유효" },
                { value: "all", label: "전체" },
              ]}
            />
          </div>
          {/* 안전 문구는 목록 바로 위 캡션으로 (예전 안내 띠보다 가볍게, 그래도 카드보다 먼저 읽히게) */}
          <p className="px-1 text-[13px] leading-snug text-sub">
            {easy
              ? "AI는 제안만 해요. 넣을 돈은 내가 정하고, 모의 자동매매를 시작할 수 있는지는 안전장치가 내 모의 계좌로 확인해요."
              : "AI는 제안만 합니다. 투자 금액은 내가 정하고, 활성화 가능 여부는 리스크 엔진이 내 모의 계좌 기준으로 확인합니다."}
          </p>
          {isPending || (isPlaceholderData && empty) ? (
            // 처음 불러올 때만 스켈레톤. 앞 필터의 '없어요' 문구는 새 결과가 올 때까지 보이지 않는다
            <div className="grid gap-3 sm:grid-cols-2">
              <SkeletonCard lines={5} />
              <SkeletonCard lines={5} />
            </div>
          ) : isError ? (
            <Card>
              <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
            </Card>
          ) : (
            <div
              aria-busy={isPlaceholderData || undefined}
              className={cn("space-y-3 transition-opacity duration-fast", isPlaceholderData && "opacity-60")}
            >
              {empty ? (
                <Card>
                  <EmptyState
                    compact
                    icon="sparkle"
                    title={filter === "open" ? (easy ? "기한이 남은 계획 제안이 없어요" : "유효한 추천이 없습니다") : easy ? "아직 계획 제안이 없어요" : "아직 추천이 없습니다"}
                    action={{ label: easy ? "종목 고르고 리포트 만들기" : "종목 검색", to: "/search" }}
                  >
                    {easy
                      ? "AI 리포트의 의견이 긍정적이면 여기에 계획이 떠요."
                      : `AI 리포트·분석이 BUY로 끝나면 여기에 뜹니다.${demoOff ? "" : " 연습용 예시 계획을 만들어 흐름을 볼 수도 있습니다."}`}
                  </EmptyState>
                </Card>
              ) : (
                <>
                  {ready.length > 0 ? (
                    <CardList list={ready} easy={easy} label="추천 목록" reveal={reveal} />
                  ) : (
                    <p className="rounded-2xl bg-card px-5 py-4 text-[14px] text-mute">
                      {easy
                        ? others.length > 0
                          ? "AI 리포트에서 나온 계획이 아직 없어요."
                          : "지금 시작할 수 있는 계획 제안이 없어요. 아래에서 시작할 수 없는 이유를 볼 수 있어요."
                        : "지금 활성화할 수 있는 추천이 없습니다."}
                    </p>
                  )}
                  {others.length > 0 && (
                    <Fold
                      id="other-recs"
                      label={`다른 계획 ${others.length}개 (${otherKinds(others.map((g) => g.rec))})`}
                      open={showOthers}
                      onToggle={() => setShowOthers((v) => !v)}
                    >
                      <CardList list={others} easy={easy} label="다른 계획 목록" reveal={false} />
                    </Fold>
                  )}
                  {blocked.length > 0 && (
                    <Fold
                      id="blocked-recs"
                      label={easy ? `지금은 시작할 수 없는 제안 ${blocked.length}개` : `지금은 활성화할 수 없는 추천 ${blocked.length}개`}
                      open={showBlocked}
                      onToggle={() => setBlockedOpen(!showBlocked)}
                    >
                      <CardList list={blocked} easy={easy} label={easy ? "시작할 수 없는 제안 목록" : "활성화할 수 없는 추천 목록"} reveal={false} />
                    </Fold>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        <aside aria-label={easy ? "연습용 예시 만들기" : "연습용 예시"} className="space-y-3 lg:sticky lg:top-8">
          <DemoCreate easy={easy} off={demoOff} onOff={() => setDemoOff(true)} />
        </aside>
      </div>
    </>
  );
}
