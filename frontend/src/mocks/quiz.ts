// 가짜 API의 단타 연습 퀴즈 (docs/API.md "단타 연습 퀴즈"). 정답·해설은 이 "서버" 코드에만 둔다 —
// 화면 코드(src/pages, src/components, src/lib)는 GET 응답(정답 없음)만 쓴다.
import type { DayQuizQuestion, DayQuizQuestionId, DayQuizResult } from "../api/types";

interface QuizItem extends DayQuizQuestion {
  answer: string;
  explanation: string;
}

const ITEMS: QuizItem[] = [
  {
    id: "q1",
    text: "단타 연습장에서 산 주식은 언제 정리되나요?",
    choices: [
      { id: "a", text: "목표 가격에 닿을 때까지 며칠이고 가지고 있어요" },
      { id: "b", text: "그날 15:15가 지나면 목표·손절에 닿지 않았어도 정리돼요" },
      { id: "c", text: "다음 날 장이 시작할 때 정리돼요" },
      { id: "d", text: "내가 팔 때까지 계속 가지고 있어요" },
    ],
    answer: "b",
    explanation: "단타 계획은 밤을 넘기지 않아요. 그 세션 15:15 이후 첫 확인에서 체결 대기 주문은 취소하고, 가진 주식은 바로 정리해요(장 마감 전 정리).",
  },
  {
    id: "q2",
    text: "손절 가격을 정해 두는 이유로 맞는 것은?",
    choices: [
      { id: "a", text: "손실이 더 커지기 전에 정해 둔 가격에서 팔려고" },
      { id: "b", text: "손절 가격에 닿으면 반드시 이익이 나서" },
      { id: "c", text: "손절 가격을 정하면 가격이 그 아래로 내려가지 않아서" },
      { id: "d", text: "수수료를 아끼려고" },
    ],
    answer: "a",
    explanation: "손절은 손실을 정해 둔 만큼으로 줄이려는 장치예요. 가격이 갑자기 크게 움직이면 손절 가격보다 더 낮게 팔릴 수도 있어요.",
  },
  {
    id: "q3",
    text: "하루에 여러 번 사고팔 때 비용에 대해 맞는 것은?",
    choices: [
      { id: "a", text: "모의 투자라 비용은 계산하지 않아요" },
      { id: "b", text: "수수료는 이익이 났을 때만 내요" },
      { id: "c", text: "살 때와 팔 때 수수료가 붙고, 팔 때는 거래세(0.20%)도 붙어 자주 거래할수록 비용이 쌓여요" },
      { id: "d", text: "거래세는 살 때만 내요" },
    ],
    answer: "c",
    explanation: "단타는 거래가 잦아 비용이 손익을 크게 좌우해요. 이 서비스는 모의 계좌에도 수수료(매수·매도)와 매도 거래세를 똑같이 계산해요.",
  },
  {
    id: "q4",
    text: "VI(변동성 완화장치)가 걸리면 어떻게 되나요?",
    choices: [
      { id: "a", text: "그 종목 거래가 그날 내내 멈춰요" },
      { id: "b", text: "가격이 반드시 오른다는 신호예요" },
      { id: "c", text: "장이 바로 끝나요" },
      { id: "d", text: "가격이 짧은 시간에 크게 움직이면 잠시(보통 2분) 단일가 매매로 바뀌어 바로 체결되지 않을 수 있어요" },
    ],
    answer: "d",
    explanation: "VI는 급격한 가격 변동을 잠시 식히는 장치예요. 그동안은 주문이 바로 체결되지 않아 생각한 가격과 다르게 체결될 수 있어요.",
  },
  {
    id: "q5",
    text: "모의 단타 연습 결과에 대해 맞는 것은?",
    choices: [
      { id: "a", text: "모의 체결은 실제 호가·체결 속도와 달라, 실제 매매에서는 결과가 달라질 수 있어요" },
      { id: "b", text: "모의에서 번 만큼 실제 계좌에서도 벌 수 있어요" },
      { id: "c", text: "모의 투자에서는 손실이 나지 않아요" },
      { id: "d", text: "모의 결과는 실제 계좌에 반영돼요" },
    ],
    answer: "a",
    explanation: "모의 체결은 약 5초마다 확인한 가격으로 흉내 낸 것이라 실제 호가·체결과 달라요. 연습 결과가 실제 결과를 말해 주지 않아요.",
  },
];

/** GET 응답: 정답·해설을 뺀 문항. */
export function quizQuestions(): DayQuizQuestion[] {
  return ITEMS.map(({ id, text, choices }) => ({ id, text, choices: choices.map((c) => ({ ...c })) }));
}

/** POST 본문 검사. 틀리면 사유, 맞으면 null. */
export function quizAnswersError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "answers가 필요합니다.";
  const a = raw as Record<string, unknown>;
  const ids = ITEMS.map((q) => q.id as string);
  const unknown = Object.keys(a).filter((k) => !ids.includes(k));
  if (unknown.length) return `모르는 문항입니다: ${unknown.join(", ")}`;
  for (const q of ITEMS) {
    if (!(q.id in a)) return `${q.id}에 답해 주세요.`;
    if (!q.choices.some((c) => c.id === a[q.id])) return `${q.id}에 없는 보기입니다.`;
  }
  return null;
}

/** 채점 (passedAt은 부르는 쪽이 정한다). */
export function gradeQuiz(answers: Record<DayQuizQuestionId, string>): Omit<DayQuizResult, "passedAt"> {
  const results = ITEMS.map((q) => ({ id: q.id, correct: answers[q.id] === q.answer, explanation: q.explanation }));
  const correct = results.filter((r) => r.correct).length;
  return { passed: correct === ITEMS.length, correct, total: ITEMS.length, results };
}

/** 테스트용: 모두 맞힌 답 (가짜 API 테스트에서만 쓴다). */
export function quizAnswerKey(): Record<DayQuizQuestionId, string> {
  return Object.fromEntries(ITEMS.map((q) => [q.id, q.answer])) as Record<DayQuizQuestionId, string>;
}
