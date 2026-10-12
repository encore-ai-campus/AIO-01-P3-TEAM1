import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, createMcpToken, type McpTokenCreated } from "../api";
import { copyText } from "../clipboard";
import { requestRefresh } from "../refresh";

// F10 연결: 토큰 생성(API.md 6-1)과 MCP 클라이언트 연결 명령 복사.

export const SERVER_NAME = "paper-admin";
export const TOKEN_ENV = "PAPER_ADMIN_MCP_TOKEN";
const PLACEHOLDER = "<토큰>";
const NAME = /^[0-9A-Za-z._-]{1,64}$/;
const NAME_RULE = "이름은 영문·숫자·._- 64자까지입니다";

export function claudeCommand(url: string, token = PLACEHOLDER) {
  return `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
}

/** Codex는 토큰을 설정 파일에 두지 않고, 실행할 때 --bearer-token-env-var로 정한 환경 변수에서 읽는다. */
export function codexCommand(url: string, token = PLACEHOLDER) {
  return `codex mcp add ${SERVER_NAME} --url ${url} --bearer-token-env-var ${TOKEN_ENV}\nexport ${TOKEN_ENV}="${token}"`;
}

type CopyState = "idle" | "done" | "fail";
const COPY_LABEL: Record<CopyState, string> = { idle: "복사", done: "복사됨", fail: "복사 실패" };

function CopyBlock({ title, text, note }: { title: string; text: string; note?: ReactNode }) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state !== "done") return;
    const id = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(id);
  }, [state]);
  return (
    <div className="copy-block">
      <div className="copy-head">
        <span>{title}</span>
        <button type="button" aria-label={`${title} ${COPY_LABEL[state]}`} onClick={async () => setState((await copyText(text)) ? "done" : "fail")}>
          {COPY_LABEL[state]}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
      {state === "fail" && <p className="muted">브라우저가 복사를 막았습니다. 위 글자를 직접 골라 복사하세요.</p>}
      {note && <p className="muted">{note}</p>}
    </div>
  );
}

/**
 * 토큰 이름을 넣고 "토큰 생성"을 누르면 원문을 한 번 보이고, 연결 명령의 <토큰> 자리에 채운다.
 * created는 화면(McpTools)이 들고 있다 — 기간을 바꿔 조회가 다시 그려져도 방금 만든 원문이 사라지지 않게.
 */
export default function McpConnect({
  url,
  created,
  onCreated,
}: {
  url: string;
  created: McpTokenCreated | null;
  onCreated: (t: McpTokenCreated | null) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!NAME.test(trimmed)) {
      setError(NAME_RULE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await createMcpToken(trimmed));
      setName("");
      requestRefresh(); // 토큰 목록에 새 이름이 보이게
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "토큰을 만들지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="token-form" onSubmit={submit}>
        <label className="field">
          <span>토큰 이름 (사람마다 하나)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: hwanseok" maxLength={64} autoComplete="off" />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          토큰 생성
        </button>
      </form>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {created ? (
        <>
          <div className="notice warn" role="status">
            <span>
              <strong>{created.name}</strong> 토큰을 만들었습니다. 이 화면을 벗어나면 다시 볼 수 없으니 아래 명령을 지금 복사해 두세요.
            </span>
            <button type="button" onClick={() => onCreated(null)}>
              숨기기
            </button>
          </div>
          <CopyBlock title="토큰" text={created.token} />
        </>
      ) : (
        <p className="muted">토큰을 만들면 아래 명령의 {PLACEHOLDER} 자리에 원문이 채워집니다.</p>
      )}
      <div className="copy-grid">
        <CopyBlock title="Claude Code" text={claudeCommand(url, created?.token)} />
        <CopyBlock
          title="Codex"
          text={codexCommand(url, created?.token)}
          note={
            <>
              Codex는 실행할 때 환경 변수 <code>{TOKEN_ENV}</code>에서 토큰을 읽는다. <code>export</code> 줄은 셸 설정(<code>~/.zshrc</code>·<code>~/.bashrc</code>)에도 넣어 둔다.
            </>
          }
        />
      </div>
    </>
  );
}
