// 새로 고침 버튼과 "마지막 갱신 시각": 화면의 모든 조회가 같은 신호를 본다.

type Listener = () => void;
const listeners = new Set<Listener>();
let tick = 0;
let updatedAt: number | null = null;

const emit = () => listeners.forEach((l) => l());

export const subscribeRefresh = (l: Listener) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const getTick = () => tick;
export const getUpdatedAt = () => updatedAt;

/** 새로 고침 버튼: 지금 보이는 조회를 모두 다시 받는다. */
export function requestRefresh() {
  tick += 1;
  emit();
}

export function markUpdated() {
  updatedAt = Date.now();
  emit();
}
