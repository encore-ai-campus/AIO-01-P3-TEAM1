import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { createChaosRun, type ChaosConfigRequest, type ChaosOptions, type ChaosScope, type ReportList } from "../api";
import { ChaosConfirm, ChaosError, SCOPE_LABEL, errorTypeLabel, pct } from "../components/ChaosRun";
import { Empty, Loaded, PageHeader } from "../components/ui";
import { DASH, REPORT_STATUS_LABEL, fmtTime, fmtUsd } from "../format";
import { POLL_FAST, POLL_SLOW, useApi } from "../hooks";

// F11 장애 주입 (API.md 7장): 장애 주입을 켜고 신청하는 유일한 곳. 관리자 백엔드가 서명해 서비스 내부 API로 보내고,
// 실행은 서비스 엔진이 한다. 만들어지면 리포트 상세(/reports/:id)에서 진행·실행 기록·복구를 본다.

type PresetId = "recovery" | "policy";
const PRESETS: { id: PresetId; title: string; hint: string; scope: ChaosScope; probability: number }[] = [
  { id: "recovery", title: "복구 시연", hint: "주 모델만 실패 (확률 80%) → 재시도·대체 모델로 복구", scope: "primary", probability: 0.8 },
  { id: "policy", title: "정책 시연", hint: "대체 모델까지 실패 (확률 80%) → 필수·선택 Worker 정책", scope: "all", probability: 0.8 },
];
const SYMBOL = /^\d{6}$/;
const SEED = /^\d{1,16}$/; // 서비스 chaos.parse: 0 이상 2^53 미만의 정수
const RECENT = "/api/admin/reports?kind=chaos&days=90&limit=10";

interface Form {
  symbol: string;
  probability: string;
  scope: ChaosScope;
  errorTypes: string[] | null; // null = 서비스 기본(전부) — 보내지 않는다
  workers: string[]; // 비우면 전부 (null로 보낸다)
  seed: string; // 비우면 서비스가 정한다
}

const initial = (): Form => ({
  symbol: "",
  probability: String(PRESETS[0].probability),
  scope: PRESETS[0].scope,
  errorTypes: null,
  workers: [],
  seed: "",
});

/** 지금 값이 어느 프리셋과 같은지 (직접 설정으로 바꿨으면 null) */
function presetOf(f: Form): PresetId | null {
  if (f.errorTypes || f.workers.length || f.seed) return null;
  return PRESETS.find((p) => p.scope === f.scope && Number(f.probability) === p.probability)?.id ?? null;
}

/** 폼 → 신청 본문. 틀리면 사유 문장. */
function toRequest(f: Form): { symbol: string; chaos: ChaosConfigRequest } | string {
  const symbol = f.symbol.trim();
  if (!SYMBOL.test(symbol)) return "종목 코드는 숫자 6자리입니다 (예: 005930)";
  const probability = Number(f.probability);
  if (f.probability.trim() === "" || !Number.isFinite(probability) || probability < 0 || probability > 1) return "실패 확률은 0~1 사이 숫자입니다";
  const seed = f.seed.trim();
  if (seed && !(SEED.test(seed) && Number.isSafeInteger(Number(seed)))) return "seed는 0 이상 2^53 미만의 정수입니다 (비우면 서비스가 정한다)";
  const chaos: ChaosConfigRequest = {
    enabled: true,
    probability,
    scope: f.scope,
    ...(f.errorTypes ? { errorTypes: f.errorTypes } : {}),
    workers: f.workers.length ? f.workers : null,
    ...(seed ? { seed: Number(seed) } : {}),
  };
  return { symbol, chaos };
}

function ChaosForm({ options, disabled }: { options: ChaosOptions | undefined; disabled: boolean }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(initial);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setConfirming(false);
  };
  const preset = presetOf(form);
  const allTypes = options?.errorTypes ?? [];
  const types = form.errorTypes ?? allTypes;
  const scopes = options?.scopes ?? (["primary", "all"] as ChaosScope[]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const req = toRequest(form);
    if (typeof req === "string") {
      setError(new Error(req));
      return;
    }
    setError(null);
    setConfirming(true);
  }

  async function run() {
    const req = toRequest(form);
    if (typeof req === "string") return;
    setBusy(true);
    setError(null);
    try {
      const created = await createChaosRun(req.symbol, req.chaos);
      navigate(`/reports/${created.id}`);
    } catch (err) {
      setError(err);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="chaos-form" onSubmit={submit} aria-label="장애 주입 신청">
      <fieldset disabled={disabled || busy}>
        <label className="field">
          <span>종목 코드 (6자리)</span>
          <input
            value={form.symbol}
            onChange={(e) => set({ symbol: e.target.value })}
            placeholder="예: 005930"
            inputMode="numeric"
            maxLength={6}
            autoComplete="off"
          />
        </label>

        <div className="presets" role="group" aria-label="프리셋">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="preset"
              aria-pressed={preset === p.id}
              onClick={() => set({ scope: p.scope, probability: String(p.probability), errorTypes: null, workers: [], seed: "" })}
            >
              <strong>{p.title}</strong>
              <span className="muted">{p.hint}</span>
            </button>
          ))}
        </div>

        <details open={preset === null}>
          <summary>직접 설정{preset === null && <span className="muted"> (적용 중)</span>}</summary>
          <div className="chaos-custom">
            <label className="field">
              <span>실패 확률 (0~1, {Number.isFinite(Number(form.probability)) ? pct(Number(form.probability)) : DASH})</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={form.probability}
                onChange={(e) => set({ probability: e.target.value })}
              />
            </label>

            <fieldset className="checks">
              <legend>실패 종류</legend>
              {allTypes.map((t) => (
                <label key={t}>
                  <input
                    type="checkbox"
                    checked={types.includes(t)}
                    onChange={(e) => {
                      const next = allTypes.filter((x) => (x === t ? e.target.checked : types.includes(x)));
                      if (next.length > 0) set({ errorTypes: next }); // 하나는 남긴다
                    }}
                  />
                  {errorTypeLabel(t)}
                </label>
              ))}
            </fieldset>

            <fieldset className="checks">
              <legend>대상 Worker (비우면 전부)</legend>
              {(options?.workers ?? []).map((w) => (
                <label key={w.id}>
                  <input
                    type="checkbox"
                    checked={form.workers.includes(w.id)}
                    onChange={(e) =>
                      set({ workers: e.target.checked ? [...form.workers, w.id] : form.workers.filter((x) => x !== w.id) })
                    }
                  />
                  {w.title} <code>{w.id}</code>
                </label>
              ))}
            </fieldset>

            <fieldset className="checks">
              <legend>범위</legend>
              {scopes.map((s) => (
                <label key={s}>
                  <input type="radio" name="chaos-scope" checked={form.scope === s} onChange={() => set({ scope: s })} />
                  {SCOPE_LABEL[s] ?? s}
                </label>
              ))}
            </fieldset>

            <label className="field">
              <span>seed (비우면 서비스가 정한다 — 같은 seed면 같은 판정)</span>
              <input value={form.seed} onChange={(e) => set({ seed: e.target.value })} inputMode="numeric" autoComplete="off" />
            </label>
          </div>
        </details>

        <button type="submit" className="primary" disabled={confirming}>
          실행
        </button>
      </fieldset>
      {confirming && <ChaosConfirm busy={busy} onConfirm={() => void run()} onCancel={() => setConfirming(false)} />}
      <ChaosError error={error} />
    </form>
  );
}

function Recent() {
  const q = useApi<ReportList>(RECENT, POLL_FAST);
  return (
    <Loaded q={q}>
      {(d) =>
        d.results.length === 0 ? (
          <Empty>최근 90일 장애 주입 실행이 없습니다.</Empty>
        ) : (
          <table className="narrow">
            <thead>
              <tr>
                <th>번호</th>
                <th>시각</th>
                <th>종목</th>
                <th>상태</th>
                <th title="장애 / 복구 / 미복구 · 주입">장애/복구/미복구 · 주입</th>
                <th>비용</th>
              </tr>
            </thead>
            <tbody>
              {d.results.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/reports/${r.id}`}>#{r.id}</Link>
                  </td>
                  <td>{fmtTime(r.createdAt)}</td>
                  <td>
                    {r.name} <span className="muted">{r.symbol}</span>
                  </td>
                  <td>
                    <span className={r.status === "failed" ? "down-text" : undefined}>{REPORT_STATUS_LABEL[r.status]}</span>
                  </td>
                  <td className="num">
                    {r.failures} / {r.recovered} / <span className={r.unrecovered > 0 ? "down-text" : undefined}>{r.unrecovered}</span> · {r.injected}
                  </td>
                  <td className="num">{fmtUsd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    </Loaded>
  );
}

export default function Chaos() {
  const q = useApi<ChaosOptions>("/api/admin/chaos/options", POLL_SLOW);
  const off = q.errorStatus === 404;
  return (
    <>
      <PageHeader title="장애 주입" />
      <p className="muted">
        리포트 실행의 AI 호출을 일부러 실패시켜 재시도·대체 모델 전환·포기가 실행 기록에 남는지 본다. 종목 리포트 팀만 · 진행 중 1건까지 · 서비스 화면에는 나오지 않는다.
      </p>
      {off ? (
        <div className="notice warn" role="status">
          장애 주입이 꺼져 있습니다 (ADMIN_CHAOS_SECRET 없음). 관리 서버 .env의 ADMIN_CHAOS_SECRET에 서비스 CHAOS_CONTROL_SECRET과 같은 값을 넣고 다시 띄우면 켜집니다.
        </div>
      ) : (
        q.error && <div className="notice error">{q.error}</div>
      )}
      <ChaosForm options={q.data} disabled={q.data === undefined} />
      <h2>최근 장애 주입 실행 (90일, 10건)</h2>
      <Recent />
    </>
  );
}
