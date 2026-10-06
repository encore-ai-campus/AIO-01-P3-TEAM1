// 계정: 투자자 프로필(투자 성향·경험 진단)과 주린이모드, 내 정보 공개·닉네임 (docs/API.md "계정").
// 주린이모드는 서버(계정)에 저장한다. 화면은 Me.beginnerMode로 읽고(hooks/useBeginnerMode.ts), 바꾸면 Me도 같이 고친다.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { keys } from "./queries";
import type { InvestorAnswers, InvestorProfile, Me } from "./types";

/** 프로필이 바뀌면 같이 바뀌는 것: Me.beginnerMode. */
function useApplyProfile() {
  const qc = useQueryClient();
  return (p: InvestorProfile) => {
    qc.setQueryData(keys.investorProfile, p);
    qc.setQueryData<Me | null>(keys.me, (me) => (me ? { ...me, beginnerMode: p.beginnerMode } : me));
  };
}

/** 내 투자자 프로필. 진단 전이면 answers부터 assessedAt까지 null, beginnerMode true. 우리 변경 요청만 바꾸므로 오래 둔다. */
export function useInvestorProfile(enabled = true) {
  return useQuery({
    queryKey: keys.investorProfile,
    queryFn: () => api.get<InvestorProfile>("/api/me/investor-profile"),
    enabled,
    staleTime: Infinity,
  });
}

/** 진단 제출 (PUT). 서버가 점수·단계·추천을 계산해 저장한다. beginnerMode는 바꾸지 않는다 — 추천을 받아들이면 useSetBeginnerMode. */
export function useSubmitInvestorProfile() {
  const apply = useApplyProfile();
  return useMutation({
    mutationFn: (answers: InvestorAnswers) => api.put<InvestorProfile>("/api/me/investor-profile", { answers }),
    onSuccess: apply,
  });
}

/**
 * 주린이모드 스위치 (PATCH {beginnerMode}). 진단 전에도 된다.
 * 누르자마자 화면이 바뀌게 Me·프로필을 먼저 고치고(낙관적), 실패하면 되돌린다.
 */
export function useSetBeginnerMode() {
  const qc = useQueryClient();
  const apply = useApplyProfile();
  return useMutation({
    mutationFn: (beginnerMode: boolean) => api.patch<InvestorProfile>("/api/me/investor-profile", { beginnerMode }),
    onMutate: async (beginnerMode) => {
      await qc.cancelQueries({ queryKey: keys.investorProfile });
      const prevMe = qc.getQueryData<Me | null>(keys.me);
      const prevProfile = qc.getQueryData<InvestorProfile>(keys.investorProfile);
      qc.setQueryData<Me | null>(keys.me, (me) => (me ? { ...me, beginnerMode } : me));
      if (prevProfile) {
        qc.setQueryData<InvestorProfile>(keys.investorProfile, { ...prevProfile, beginnerMode });
      }
      return { prevMe, prevProfile };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prevMe !== undefined) qc.setQueryData(keys.me, ctx.prevMe);
      if (ctx?.prevProfile) qc.setQueryData(keys.investorProfile, ctx.prevProfile);
    },
    onSuccess: apply,
  });
}

/**
 * 내 정보 공개·닉네임 (PATCH /api/me/profile). 바뀐 Me를 넣고 랭킹을 다시 받는다 (공개를 켜면 랭킹에 내 줄이 생긴다).
 * 마이(공개 스위치·닉네임)와 랭킹 화면(비공개일 때 그 자리 공개 스위치)이 같이 쓴다. 실패 알림은 부르는 쪽이 정한다 (토스트 또는 칸 아래).
 */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { isPublic?: boolean; nickname?: string }) => api.patch<Me>("/api/me/profile", body),
    onSuccess: (me) => {
      qc.setQueryData(keys.me, me);
      void qc.invalidateQueries({ queryKey: keys.ranking });
    },
  });
}
