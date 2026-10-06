// 주린이모드(쉬운 보기)와 화면별 "이 화면만 자세히 보기"(?view=expert).
// 주린이모드는 계정(서버)에 저장한 값(Me.beginnerMode)이고, ?view=는 그 화면에만 쓰고 저장하지 않는다 (docs/API.md "투자자 프로필과 주린이모드").
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { useInvestorProfile, useSetBeginnerMode } from "../api/profile";
import { useMe } from "../api/queries";
import type { InvestorProfile } from "../api/types";

/** 화면 보기: easy 쉬운 보기(주린이모드 켬) · expert 전문가 보기(끔). */
export type ViewMode = "easy" | "expert";

export interface BeginnerMode {
  /** 지금 주린이모드 (진단 전·값을 모를 때 기본 true). */
  beginnerMode: boolean;
  /** 스위치 (PATCH). Me·프로필을 먼저 바꾸고 실패하면 되돌린다. */
  setBeginnerMode: (on: boolean) => void;
  /** 진단 결과 (아직 받지 않았으면 undefined). */
  profile: InvestorProfile | undefined;
  /** 프로필을 받지 못했으면 그 오류 (없으면 null). 화면은 스켈레톤 대신 오류와 다시 시도를 보인다. */
  profileError: unknown;
  /** 프로필 다시 받기. */
  refetchProfile: () => void;
  /** Me를 받는 중 (beginnerMode가 기본값일 수 있다). */
  isLoading: boolean;
  /** 스위치 요청을 보내는 중. */
  isSaving: boolean;
}

/** 주린이모드 읽기·바꾸기. 값은 Me.beginnerMode(로그인하면 이미 받아 둔 값), 없으면 프로필, 그것도 없으면 true. */
export function useBeginnerMode(): BeginnerMode {
  const me = useMe();
  const profile = useInvestorProfile(Boolean(me.data));
  const mutation = useSetBeginnerMode();
  const { mutate } = mutation;
  const setBeginnerMode = useCallback((on: boolean) => mutate(on), [mutate]);
  const { refetch } = profile;
  const refetchProfile = useCallback(() => void refetch(), [refetch]);
  return {
    beginnerMode: me.data?.beginnerMode ?? profile.data?.beginnerMode ?? true,
    setBeginnerMode,
    profile: profile.data,
    profileError: profile.isError ? profile.error : null,
    refetchProfile,
    isLoading: me.isPending,
    isSaving: mutation.isPending,
  };
}

/** ?view= 값 → 덮어쓰기 (expert·easy만 인정). */
export function parseViewParam(value: string | null): ViewMode | null {
  return value === "expert" || value === "easy" ? value : null;
}

/** 주린이모드와 화면별 덮어쓰기로 이 화면의 보기를 정한다. */
export function resolveView(beginnerMode: boolean, override: ViewMode | null): ViewMode {
  return override ?? (beginnerMode ? "easy" : "expert");
}

export interface ViewModeState {
  /** 이 화면의 보기. */
  view: ViewMode;
  easy: boolean;
  expert: boolean;
  /** ?view=로 이 화면만 바꿨는지 (null이면 주린이모드를 따른다). */
  override: ViewMode | null;
  beginnerMode: boolean;
  /**
   * 이 화면만 보기 바꾸기 (주소의 ?view=, 다른 쿼리는 그대로 둔다). 주린이모드와 같은 보기면 ?view=를 지운다.
   * null이면 덮어쓰기를 지운다. 기록을 쌓지 않는다 (replace).
   */
  setView: (view: ViewMode | null) => void;
}

/** 화면별 보기: 주린이모드 켬 → 쉬운 보기, 끔 → 전문가 보기. "이 화면만 자세히 보기"는 setView("expert"). */
export function useViewMode(): ViewModeState {
  const { beginnerMode } = useBeginnerMode();
  const [params, setParams] = useSearchParams();
  const override = parseViewParam(params.get("view"));
  const view = resolveView(beginnerMode, override);
  const setView = useCallback(
    (next: ViewMode | null) =>
      setParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next === null || next === resolveView(beginnerMode, null)) sp.delete("view");
          else sp.set("view", next);
          return sp;
        },
        { replace: true },
      ),
    [setParams, beginnerMode],
  );
  return { view, easy: view === "easy", expert: view === "expert", override, beginnerMode, setView };
}
