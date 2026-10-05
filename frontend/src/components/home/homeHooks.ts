// 홈 카드의 '바뀐 순간' 판단과 받기 전 자리의 기억 (컴포넌트 없음). 움직이는 때는 기다린 끝·사용자가 바꾼 순간·폴링으로 상태가 바뀐 순간뿐이다.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useMe } from "../../api/queries";
import type { ReportSummary } from "../../api/types";
import { inProgressReports, readShownCount, writeShownCount } from "./homeData";

const NONE: ReadonlySet<never> = new Set<never>();

/**
 * useChanged와 같지만 기준이 '처음 알게 된 값'이다 (undefined = 아직 모름). 받기 전 자리표시에서 첫 값으로 바뀌는 것은 바뀜이 아니다 —
 * 그때 체크가 튀어나오면 방금 그 단계를 끝낸 것처럼 보인다. 한 번 바뀌면 계속 true.
 */
export function useChangedSinceKnown<T>(value: T | undefined): boolean {
  const [seen, setSeen] = useState<{ first: T | undefined; changed: boolean }>({ first: value, changed: false });
  // 렌더 중 조건부 파생 상태 (useChanged와 같은 패턴)
  if (seen.first === undefined && value !== undefined) setSeen({ first: value, changed: false });
  const differs = seen.first !== undefined && value !== undefined && !Object.is(seen.first, value);
  if (differs && !seen.changed) setSeen({ first: seen.first, changed: true });
  return seen.changed || differs;
}

/** 상태가 바뀐 행을 강조하는 시간(ms). 정적 배경이라 동작 줄이기에서도 보인다. */
export const CHANGED_MS = 2000;

/**
 * 값이 바뀐 항목의 키 (ms 동안). 처음 받은 값·새로 생긴 항목은 넣지 않는다 — 폴링으로 '상태'가 바뀐 행만 잠깐 강조한다.
 * entries: [키, 값] (예: [계획 id, 상태]).
 */
export function useChangedKeys<K>(entries: readonly (readonly [K, string])[], ms = CHANGED_MS): ReadonlySet<K> {
  const sig = entries.map(([k, v]) => `${String(k)}=${v}`).join("|");
  const [seen, setSeen] = useState(() => ({ sig, map: new Map<K, string>(entries) }));
  const [hot, setHot] = useState<ReadonlySet<K>>(NONE);
  if (seen.sig !== sig) {
    // 렌더 중 조건부 파생 상태 (useChanged와 같은 패턴)
    const changed = entries.filter(([k, v]) => seen.map.has(k) && seen.map.get(k) !== v).map(([k]) => k);
    setSeen({ sig, map: new Map(entries) });
    if (changed.length > 0) setHot(new Set([...hot, ...changed]));
  }
  useEffect(() => {
    if (hot.size === 0) return;
    const timer = window.setTimeout(() => setHot(NONE), ms);
    return () => window.clearTimeout(timer);
  }, [hot, ms]);
  return hot;
}

/** 방금 끝난 내 리포트를 남겨 두는 시간(ms): 리포트 목록 폴링 한 번(30초) — '최근 AI 리포트'에 나타날 때까지 빈틈을 메운다. */
export const FINISHED_MS = 30_000;

/**
 * 만드는 중이던 내 리포트 중 이번에 끝난 것 (완성·실패). 잠깐 '완성됐어요 · 보기'로 남겼다가 접는다.
 * 처음 받은 목록에서 이미 끝나 있던 리포트는 넣지 않는다.
 */
export function useJustFinished(mine: readonly ReportSummary[] | undefined, ms = FINISHED_MS): ReportSummary[] {
  const running = mine ? inProgressReports(mine).map((r) => r.id) : null;
  const sig = running ? running.join(",") : null;
  const [track, setTrack] = useState<{ sig: string | null; ids: ReadonlySet<number>; done: ReportSummary[] }>(() => ({
    sig,
    ids: new Set(running ?? []),
    done: [],
  }));
  if (mine && sig !== track.sig) {
    const finished = mine.filter((r) => track.ids.has(r.id) && (r.status === "completed" || r.status === "failed"));
    const kept = track.done.filter((d) => !finished.some((f) => f.id === d.id));
    setTrack({ sig, ids: new Set(running), done: [...finished, ...kept] });
  }
  useEffect(() => {
    if (track.done.length === 0) return;
    const timer = window.setTimeout(() => setTrack((t) => ({ ...t, done: [] })), ms);
    return () => window.clearTimeout(timer);
  }, [track.done, ms]);
  return track.done;
}

/**
 * 섹션이 지난번에 보인 개수 (행 수·기준 시각 줄 수 — 이 브라우저의 기억, homeData readShownCount). 받기 전 스켈레톤을 그만큼 그려
 * 받은 뒤 아래 내용이 밀리지 않게 한다 — 진행 중 계획이 셋인 사람에게 한 줄 자리만 잡으면 받는 순간 아래 섹션이 200px 넘게 내려간다.
 * shown: 받은 뒤 보이는 개수 (받기 전·처음부터 받지 못했으면 undefined — 기억을 바꾸지 않는다). 기억이 없으면 fallback.
 * 기억은 처음 그릴 때 한 번만 읽는다 (스켈레톤은 처음 받기 전에만 보인다).
 */
export function useShownCount(name: string, shown: number | undefined, fallback: number): number {
  const userId = useMe().data?.id;
  const [remembered] = useState(() => (userId === undefined ? null : readShownCount(userId, name)));
  useEffect(() => {
    if (userId !== undefined && shown !== undefined) writeShownCount(userId, name, shown);
  }, [userId, name, shown]);
  return remembered ?? fallback;
}

/**
 * 지금 화면에서 처음 불러오기부터 실패한 조회 수 (받아 둔 값이 있는데 다시 받기만 실패한 것은 세지 않는다 — 그 값을 그대로 보인다).
 * 숫자가 바뀔 때만 다시 그린다.
 */
export function useFailedCount(): number {
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback((fn: () => void) => cache.subscribe(() => fn()), [cache]);
  const count = useCallback(
    () => cache.findAll({ type: "active" }).filter((q) => q.state.status === "error" && q.state.data === undefined).length,
    [cache],
  );
  return useSyncExternalStore(subscribe, count, () => 0);
}
