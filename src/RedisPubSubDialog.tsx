import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { RedisBytes } from "./RedisEditDialog";

type Message = { sequence: number; received_at_ms: number; channel: RedisBytes; payload: RedisBytes };
type Snapshot = { status: "subscribed" | "reconnecting" | "failed"; error: string | null; interruptions: number; evicted: number; messages: Message[] };
type PublishReport = { receivers: number; audit_warning: boolean };

const numbers = new Intl.NumberFormat("ko-KR");
const times = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "numeric", second: "numeric", fractionalSecondDigits: 3 });
const encoder = new TextEncoder();
const statuses = { subscribed: "구독 중", reconnecting: "재연결 중", failed: "구독 실패" };

export function RedisPubSubDialog({ id, allowPublish, environment, target, onBusy, onFailure, onClose }: {
  id: string; allowPublish: boolean; environment: string; target: string;
  onBusy: (busy: boolean) => void; onFailure: (message: string) => boolean; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [subscription, setSubscription] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const current = useRef<string | null>(null);
  const mounted = useRef(false);
  const production = environment === "PROD";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = current.current;
      if (active) void invoke("redis_stop_subscription", { id, subscription: active }).catch(() => {});
    };
  }, [id]);

  useEffect(() => {
    if (!subscription) return;
    let live = true;
    let timer: number | undefined;
    async function poll() {
      try {
        const next = await invoke<Snapshot>("redis_subscription_snapshot", { id, subscription });
        if (!live) return;
        setSnapshot(next);
        if (next.status !== "failed") timer = window.setTimeout(() => void poll(), 650);
      } catch (cause) {
        if (live) setError(String(cause));
      }
    }
    void poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [id, subscription, pollVersion]);

  async function change(action: "start" | "stop" | "clear") {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError("");
    try {
      if (action === "start") {
        setPassword(""); setConfirmation("");
        const active = await invoke<string>("redis_start_subscription", { id, name, pattern, password, confirmation });
        if (!mounted.current) { await invoke("redis_stop_subscription", { id, subscription: active }); return; }
        current.current = active;
        setSubscription(active);
      } else if (action === "stop") {
        await invoke("redis_stop_subscription", { id, subscription });
        current.current = null;
        setSubscription(null); setSnapshot(null);
      } else {
        await invoke("redis_clear_subscription_history", { id, subscription });
        setSnapshot(value => value && { ...value, messages: [], evicted: 0 });
        setPollVersion(value => value + 1);
      }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  return <Dialog title="Redis Pub/Sub" busy={busy} onClose={onClose} className="redis-pubsub">
    <div className="redis-pubsub-body">
      <p className="confirm-copy"><strong>{target} · {environment}</strong><br />채널은 서버 전체에서 공유됩니다. 연결이 끊긴 동안의 메시지는 다시 받을 수 없습니다.</p>
      <div className="redis-pubsub-grid">
        <section className="results-card" aria-label="메시지 구독">
          <div className="panel-heading"><h3>구독</h3>{snapshot && <span role="status">{statuses[snapshot.status]}</span>}</div>
          {subscription ? <div className="redis-pubsub-active">
            <p><span>{pattern ? "패턴" : "채널"}</span> <code>{name}</code></p>
            {snapshot?.interruptions ? <p className="form-note">연결 중단 {numbers.format(snapshot.interruptions)}회</p> : null}
            {snapshot?.error && <p className="form-error" role="alert">{snapshot.error}</p>}
            <button type="button" className="secondary small" disabled={busy} onClick={() => void change("stop")}>구독 종료</button>
          </div> : <form onSubmit={event => { event.preventDefault(); void change("start"); }}>
            <label className="field">구독 방식<select value={pattern ? "pattern" : "channel"} onChange={event => setPattern(event.target.value === "pattern")} disabled={busy}>
              <option value="channel">채널 이름</option><option value="pattern">패턴</option>
            </select></label>
            <label className="field">{pattern ? "구독 패턴" : "구독 채널"}<input required maxLength={512} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
            <label className="field">구독 연결 암호<input type="password" autoComplete="off" value={password} maxLength={4096} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
            {production && <label className="field">구독 운영 환경 확인<input required autoComplete="off" placeholder="PROD" value={confirmation}
              onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>}
            <button type="submit" className="primary small" disabled={busy || !name || (production && confirmation !== "PROD")}>구독 시작</button>
          </form>}
          {error && <p className="error-banner" role="alert">{error}</p>}
        </section>
        <section className="results-card" aria-label="메시지 발행">
          <div className="panel-heading"><h3>발행</h3></div>
          {allowPublish ? <PublishComposer id={id} production={production} disabled={busy} onFailure={onFailure}
            onBusy={active => { setBusy(active); onBusy(active); }} /> :
            <p className="result-empty">메시지를 보내려면 연결할 때 발행을 허용하세요.</p>}
        </section>
      </div>
      <section className="results-card" aria-label="수신 기록">
        <div className="panel-heading"><h3>수신 기록</h3>
          {subscription && <button type="button" className="secondary small" disabled={busy || !snapshot?.messages.length} onClick={() => void change("clear")}>
            기록 비우기</button>}
        </div>
        {snapshot?.messages.length ? <div className="redis-values" tabIndex={0} role="region" aria-label="Redis 수신 메시지 목록">
          <table><thead><tr><th scope="col">수신 시각</th><th scope="col">채널</th><th scope="col">메시지</th></tr></thead>
            <tbody>{snapshot.messages.map(message => <tr key={message.sequence}>
              <td>{times.format(message.received_at_ms)}</td><td><MessageBytes value={message.channel} /></td>
              <td><MessageBytes value={message.payload} /></td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="result-empty">{subscription ? "수신한 메시지가 없습니다." : "구독을 시작하면 여기에 메시지가 표시됩니다."}</p>}
        <p className="form-note redis-pubsub-retention">창을 닫거나 구독을 종료하면 기록이 지워집니다. 최근 100건을 메모리에 보관합니다.
          {snapshot?.evicted ? ` 오래된 메시지 ${numbers.format(snapshot.evicted)}건을 지웠습니다.` : ""}</p>
      </section>
    </div>
  </Dialog>;
}

function MessageBytes({ value }: { value: RedisBytes }) {
  return <>{value.encoding === "hex" && <small>HEX </small>}<code>{value.text || "(빈 값)"}</code>
    {value.truncated && <small> … ({numbers.format(value.bytes)} B)</small>}</>;
}

function PublishComposer({ id, production, disabled, onBusy, onFailure }: {
  id: string; production: boolean; disabled: boolean; onBusy: (busy: boolean) => void; onFailure: (message: string) => boolean;
}) {
  const [channel, setChannel] = useState("");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [review, setReview] = useState(false);
  const [report, setReport] = useState<PublishReport | null>(null);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const bytes = encoder.encode(message).length;
  useEffect(() => { if (review) heading.current?.focus(); }, [review]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || disabled) return;
    setError(""); setReport(null);
    if (!review) { setReview(true); setConfirmation(""); return; }
    if (production && confirmation !== "PROD") return;
    pending.current = true; onBusy(true);
    try {
      const next = await invoke<PublishReport>("redis_publish_message", { id, channel, message, confirmed: true, confirmation });
      setReport(next); setMessage(""); setReview(false); setConfirmation("");
    } catch (cause) {
      const reason = String(cause);
      if (!onFailure(reason)) setError(reason);
    } finally { pending.current = false; onBusy(false); }
  }

  return <form onSubmit={event => void submit(event)}>
    {review ? <>
      <h4 ref={heading} tabIndex={-1}>발행 내용 확인</h4>
      <div className="edit-preview"><strong>{channel}</strong><pre>{message || "(빈 메시지)"}</pre></div>
      {production && <label className="field">발행 운영 환경 확인<input required placeholder="PROD" autoComplete="off" value={confirmation}
        onChange={event => setConfirmation(event.target.value)} disabled={disabled} /></label>}
    </> : <>
      <label className="field">발행 채널<input maxLength={512} value={channel} required onChange={event => setChannel(event.target.value)} disabled={disabled} /></label>
      <label className="field">발행 메시지<textarea className="edit-value" maxLength={65536} value={message} onChange={event => setMessage(event.target.value)} disabled={disabled} /></label>
      <p className={bytes <= 65536 ? "form-note" : "form-error"}>{numbers.format(bytes)} B / 64 KiB</p>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {report && <p className="success-banner" role="status">발행 완료 · 서버가 보고한 수신 {numbers.format(report.receivers)}건
      {report.audit_warning && <strong className="audit-warning">발행 결과를 작업 기록에 저장할 수 없습니다.</strong>}</p>}
    <div className="redis-pubsub-actions">
      {review && <button type="button" className="secondary small" onClick={() => { setReview(false); setError(""); }} disabled={disabled}>수정으로 돌아가기</button>}
      <button type="submit" className="primary small" disabled={disabled || !channel || bytes > 65536 || (review && production && confirmation !== "PROD")}>
        {review ? "메시지 발행" : "발행 미리 보기"}</button>
    </div>
  </form>;
}
