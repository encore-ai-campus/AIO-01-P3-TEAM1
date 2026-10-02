// VITE_MOCK=1 npm run dev 일 때 브라우저에서 가짜 API를 켠다. 상태는 localStorage에 저장된다
// (처음부터 다시 하려면 개발자 도구에서 localStorage의 paper-mock-db-v1을 지운다).
import { setupWorker } from "msw/browser";
import { loadPersisted } from "./db";
import { handlers } from "./handlers";

export async function startMockApi() {
  loadPersisted({ persist: true });
  await setupWorker(...handlers).start({ onUnhandledRequest: "bypass", quiet: true });
}
