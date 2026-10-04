// /recommendations: 새 계획 제안 목록 (전문가 보기: AI 추천, 팀 공용). 모의투자 탭 안의 화면이다 (docs/컨셉변경계획.md 4-1).
// 쉬운 보기: 리포트에서 나온 계획만 앞에, 분석·연습용 예시는 접힌 "다른 계획 ○개" 안에 (출처는 늘 표시).
// 옆에 연습용 예시 계획 만들기(AI 아님), 필터 칩(진행 중 / 전체), 카드를 누르면 실행 확인.
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useCreateDemo } from "../api/autotrade";
import { errorMessage } from "../api/client";
import { useRecommendations } from "../api/queries";
import type { Recommendation } from "../api/types";
import { RecommendationCard } from "../components/autotrade/RecommendationCard";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { Card, EmptyState, ErrorState, Notice, PageHeader, Segmented, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { splitProposals } from "../lib/autotrade";

type Filter = "open" | "all";

function DemoCreate({ easy }: { easy: boolean }) {
  const navigate = useNavigate();
  const toast = useToast();
  const demo = useCreateDemo();
  const [symbol, setSymbol] = useState("");
  return (
    <Card aria-labelledby="demo-title">
      <h2 id="demo-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="chart" className="size-5 text-[#9a5b00]" />
        연습용 예시 계획 만들기
      </h2>
      <p className="mt-1 text-[14px] leading-snug text-sub">
        {easy
          ? "AI가 아닌 규칙으로 만든 연습용 예시예요. 최근 변동폭으로 사는·목표·손절 가격을 정해요. AI 리포트가 완성되면 그 계획이 여기에 떠요."
          : "규칙 기반 연습용 예시(AI 아님). 일봉 변동폭(ATR)으로 진입·목표·손절을 정합니다. AI 리포트가 완성되면 AI 추천이 여기에 뜹니다."}
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          demo.mutate(symbol.trim(), {
            onSuccess: (r) => {
              toast(`${r.name} 연습용 예시 계획을 만들었어요.`);
              setSymbol("");
              navigate(`/recommendations/${r.id}`);
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
          className="flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-ink px-4 text-[15px] font-semibold text-white hover:bg-ink/85 disabled:opacity-40"
        >
          {demo.isPending && <Spinner />}
          만들기
        </button>
      </form>
      {demo.isError && (
        <Notice tone="error" className="mt-3">
          {errorMessage(demo.error)}
        </Notice>
      )}
    </Card>
  );
}

function CardList({ list, easy, label }: { list: Recommendation[]; easy: boolean; label: string }) {
  return (
    <ul aria-label={label} className="grid gap-3 sm:grid-cols-2">
      {list.map((r) => (
        <li key={r.id}>
          <RecommendationCard r={r} easy={easy} />
        </li>
      ))}
    </ul>
  );
}

export function RecommendationsPage() {
  const { easy } = useViewMode();
  const [params, setParams] = useSearchParams();
  const filter: Filter = params.get("status") === "all" ? "all" : "open";
  const { data, isPending, isError, error, refetch } = useRecommendations({ status: filter });
  const [showOthers, setShowOthers] = useState(false);
  const { main, others } = splitProposals(data?.results ?? [], easy);
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

  return (
    <>
      <PageHeader
        title={easy ? "새 계획 제안" : "AI 추천"}
        back
        right={
          <Link to="/plans" className="flex h-9 shrink-0 items-center gap-1 rounded-xl bg-card px-3 text-[14px] font-semibold text-sub hover:bg-line">
            <Icon name="flow" className="size-4" />
            {easy ? "모의 자동매매" : "내 자동매매"}
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-6">
        {/* 모바일은 위에, PC는 오른쪽 열에 */}
        <div className="space-y-3 lg:sticky lg:top-8 lg:order-2">
          <Notice>
            {easy
              ? "AI는 제안만 해요. 몇 주를 살지와 시작할 수 있는지는 안전장치가 내 모의 계좌로 정해요."
              : "AI는 제안만 합니다. 수량과 활성화 가능 여부는 리스크 엔진이 내 모의 계좌 기준으로 정합니다."}
          </Notice>
          <DemoCreate easy={easy} />
        </div>
        <section aria-labelledby="rec-list-title" className="min-w-0 space-y-3 lg:order-1">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 id="rec-list-title" className="text-[17px] font-bold">
              {filter === "open" ? (easy ? "지금 시작할 수 있는 계획" : "활성화할 수 있는 추천") : easy ? "모든 계획 제안" : "모든 추천"}
              {data && <span className="ml-1.5 text-[15px] font-semibold text-mute tabular-nums">{easy ? main.length : data.count}</span>}
            </h2>
            <Segmented
              label={easy ? "계획 필터" : "추천 필터"}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "open", label: "진행 중" },
                { value: "all", label: "전체" },
              ]}
            />
          </div>
          {isPending ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <SkeletonCard lines={5} />
              <SkeletonCard lines={5} />
            </div>
          ) : isError ? (
            <Card>
              <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
            </Card>
          ) : main.length === 0 && others.length === 0 ? (
            <Card>
              <EmptyState>
                {filter === "open"
                  ? easy
                    ? "지금 시작할 수 있는 계획이 없어요. AI 리포트의 의견이 긍정적이면 여기에 계획이 떠요."
                    : "지금 활성화할 수 있는 추천이 없습니다. AI 리포트·분석이 BUY로 끝나면 여기에 뜹니다. 연습용 예시 계획을 만들어 흐름을 볼 수도 있습니다."
                  : easy
                    ? "아직 계획 제안이 없어요."
                    : "아직 추천이 없습니다."}
              </EmptyState>
            </Card>
          ) : (
            <>
              {main.length > 0 ? (
                <CardList list={main} easy={easy} label="추천 목록" />
              ) : (
                <Card>
                  <EmptyState>AI 리포트에서 나온 계획이 아직 없어요.</EmptyState>
                </Card>
              )}
              {others.length > 0 && (
                <div>
                  <button
                    type="button"
                    aria-expanded={showOthers}
                    onClick={() => setShowOthers((v) => !v)}
                    className="flex h-11 w-full items-center justify-between rounded-2xl bg-card px-4 text-[15px] font-semibold text-sub hover:bg-line"
                  >
                    다른 계획 {others.length}개 (교차검증 분석·연습용 예시)
                    <span aria-hidden="true">{showOthers ? "▴" : "▾"}</span>
                  </button>
                  {showOthers && (
                    <div className="mt-3">
                      <CardList list={others} easy={easy} label="다른 계획 목록" />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
