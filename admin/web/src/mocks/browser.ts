// VITE_MOCK=1 npm run dev 에서 브라우저가 쓰는 가짜 API
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);
