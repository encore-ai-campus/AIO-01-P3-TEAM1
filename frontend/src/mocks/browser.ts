// VITE_MOCK=1 npm run dev 일 때 브라우저에서 가짜 API를 켠다. 상태는 localStorage에 저장된다
// (처음부터 다시 하려면 개발자 도구에서 localStorage의 paper-mock-db-v4를 지운다).
// 브라우저에서는 끝난 예시 리포트(완성·실패)를 넣고, 출처 줄에 가짜 시세임을 밝힌다.
import { setupWorker } from "msw/browser";
import { loadPersisted } from "./db";
import { handlers } from "./handlers";

export async function startMockApi() {
  loadPersisted({ persist: true, sampleReports: true, quoteProvider: "가짜 API(VITE_MOCK)" });
  await setupWorker(...handlers).start({ onUnhandledRequest: "bypass", quiet: true });
}
