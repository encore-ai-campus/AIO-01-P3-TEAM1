// /recommendations: AI 추천 목록 (팀 공용). 위에 시연용 추천 만들기, 필터 칩(진행 중 / 전체), 카드를 누르면 상세(활성화).
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useCreateDemo } from "../api/autotrade";
import { errorMessage } from "../api/client";
import { useRecommendations } from "../api/queries";
import { RecommendationCard } from "../components/autotrade/RecommendationCard";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { Card, EmptyState, ErrorState, Notice, PageHeader, Segmented, SkeletonCard, Spinner } from "../components/ui";

type Filter = "open" | "all";

function DemoCreate() {
  const navigate = useNavigate();
  const toast = useToast();
  const demo = useCreateDemo();
  const [symbol, setSymbol] = useState("");
  return (
    <Card aria-labelledby="demo-title">
      <h2 id="demo-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="chart" className="size-5 text-[#9a5b00]" />
        시연용 추천 만들기
      </h2>
      <p className="mt-1 text-[14px] leading-snug text-sub">
        규칙 기반 시연용(AI 아님). 일봉 변동폭(ATR)으로 진입·목표·손절을 정합니다. AI 리포트가 완성되면 AI 추천이 여기에 뜹니다.
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          demo.mutate(symbol.trim(), {
            onSuccess: (r) => {
              toast(`${r.name} 시연용 추천을 만들었습니다.`);
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

export function RecommendationsPage() {
  const [params, setParams] = useSearchParams();
  const filter: Filter = params.get("status") === "all" ? "all" : "open";
  const { data, isPending, isError, error, refetch } = useRecommendations({ status: filter });
  const list = data?.results ?? [];

  return (
    <>
      <PageHeader
        title="AI 추천"
        right={
          <Link to="/plans" className="flex h-9 shrink-0 items-center gap-1 rounded-xl bg-card px-3 text-[14px] font-semibold text-sub hover:bg-line">
            <Icon name="flow" className="size-4" />
            내 자동매매
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-6">
        {/* 모바일은 위에, PC는 오른쪽 열에 */}
        <div className="space-y-3 lg:sticky lg:top-8 lg:order-2">
          <DemoCreate />
          <Notice>AI는 제안만 합니다. 수량과 활성화 가능 여부는 리스크 엔진이 내 모의 계좌 기준으로 정합니다.</Notice>
        </div>
        <section aria-labelledby="rec-list-title" className="min-w-0 space-y-3 lg:order-1">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 id="rec-list-title" className="text-[17px] font-bold">
              {filter === "open" ? "활성화할 수 있는 추천" : "모든 추천"}
              {data && <span className="ml-1.5 text-[15px] font-semibold text-mute tabular-nums">{data.count}</span>}
            </h2>
            <Segmented
              label="추천 필터"
              value={filter}
              onChange={(v) => setParams(v === "all" ? { status: "all" } : {}, { replace: true })}
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
          ) : list.length === 0 ? (
            <Card>
              <EmptyState>
                {filter === "open"
                  ? "지금 활성화할 수 있는 추천이 없습니다. AI 리포트·분석이 BUY로 끝나면 여기에 뜹니다. 시연용 추천을 만들어 흐름을 볼 수도 있습니다."
                  : "아직 추천이 없습니다."}
              </EmptyState>
            </Card>
          ) : (
            <ul aria-label="추천 목록" className="grid gap-3 sm:grid-cols-2">
              {list.map((r) => (
                <li key={r.id}>
                  <RecommendationCard r={r} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
