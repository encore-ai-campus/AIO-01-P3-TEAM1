/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1"이면 브라우저에서 MSW 가짜 API를 켠다. */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
