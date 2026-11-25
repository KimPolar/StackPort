import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CornerDownLeft } from "lucide-react";
import { Dialog } from "./Dialog";
import type { RedisBytes } from "./RedisEditDialog";
import { useNativeRead } from "./usePostgresRead";

type Command = { name: string; usage: string; warning: string | null };
type Reply = { kind: "simple" | "bulk"; value: RedisBytes } | { kind: "integer"; value: string }
  | { kind: "array"; length: number; items: Reply[] } | { kind: "null" | "error" };
type Result = { reply: Reply; truncated: boolean };
export type RedisConsoleEntry = { id: string; line: string; elapsed: number; result: Result | null; error: string };

const catalogArgs = {};
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const encoder = new TextEncoder();
const role: Record<Reply["kind"], string> = {
  simple: "단순 문자열", bulk: "바이트 문자열", integer: "정수", array: "배열", null: "NULL", error: "오류",
};

export function RedisConsoleDialog({ id, target, history, onRecord, onClear, onClose, onFailure }: {
  id: string; target: string; history: RedisConsoleEntry[]; onRecord: (entry: RedisConsoleEntry) => void;
  onClear: () => void; onClose: () => void; onFailure: (message: string) => boolean;
}) {
  const [line, setLine] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const recall = useRef(-1);
  const draft = useRef("");
  const { data: catalog, error: catalogError } = useNativeRead<Command[]>("redis_console_commands", catalogArgs);
  const trimmed = line.trimStart();
  const name = trimmed.split(/[ \t]/, 1)[0].toUpperCase();
  const command = catalog?.find(item => item.name === name);
  const supported = catalog?.filter(item => item.warning === null) ?? [];
  const matching = !command && name && !/[ \t]/.test(trimmed)
    ? supported.filter(item => item.name.startsWith(name)).slice(0, 6) : [];
  const output = history.find(item => item.id === selected) ?? history[0];
  const tooLong = encoder.encode(line).length > 4096;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { if (!busy) field.current?.focus(); }, [busy]);

  function enter(value: string) {
    recall.current = -1;
    setLine(value);
    field.current?.focus();
  }

  function promptKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Tab" && matching.length === 1) {
      event.preventDefault(); enter(`${matching[0].name} `); return;
    }
    if (!history.length || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    if (recall.current < 0) draft.current = line;
    recall.current = Math.max(-1, Math.min(history.length - 1, recall.current + (event.key === "ArrowUp" ? 1 : -1)));
    setLine(recall.current < 0 ? draft.current : history[recall.current].line);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!command || command.warning || tooLong || pending.current) return;
    pending.current = true; setBusy(true);
    const started = performance.now();
    const commandLine = line.trim();
    const key = crypto.randomUUID();
    try {
      const result = await invoke<Result>("redis_run_console", { id, line: commandLine });
      if (mounted.current) {
        onRecord({ id: key, line: commandLine, result, elapsed: performance.now() - started, error: "" });
        setSelected(key);
        enter("");
      }
    } catch (cause) {
      const message = String(cause);
      if (mounted.current && !onFailure(message)) {
        onRecord({ id: key, line: commandLine, result: null, elapsed: performance.now() - started, error: message });
        setSelected(key);
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  return <Dialog title="Redis 명령 콘솔" className="redis-console" busy={busy} onClose={onClose}>
    <div className="redis-console-body">
      <p className="confirm-copy"><strong>{target}</strong> · 읽기 전용</p>
      <div className="redis-console-layout">
        <section className="results-card redis-console-output" aria-label="명령 실행 결과" aria-busy={busy}>
          <div className="panel-heading"><h3>실행 결과</h3>
            {output && <button type="button" className="secondary small" disabled={busy} onClick={() => enter(output.line)}>다시 입력</button>}
          </div>
          {busy && <p className="result-empty" role="status">명령을 실행하는 중…</p>}
          {!output && !busy && <p className="result-empty">명령을 실행하면 응답을 확인할 수 있습니다.</p>}
          {output && <div className="redis-console-response" tabIndex={0} role="region" aria-label="Redis 응답 본문">
            <div className="redis-console-response-title"><code>{output.line}</code><span>{number.format(output.elapsed)} ms</span></div>
            {output.error && <p className="form-error" role="alert">{output.error}</p>}
            {output.result && <>
              <ReplyView reply={output.result.reply} />
              {output.result.truncated && <p className="form-note">응답 트리는 최대 256개 항목까지 표시합니다.</p>}
            </>}
          </div>}
        </section>
        <section className="results-card redis-console-history" aria-label="콘솔 실행 기록">
          <div className="panel-heading"><h3>실행 기록</h3>
            {history.length > 0 && <button type="button" className="secondary small" disabled={busy}
              onClick={() => { onClear(); enter(""); setSelected(null); }}>기록 비우기</button>}
          </div>
          {history.length > 0 ? <ul className="redis-key-list">{history.map(entry => <li key={entry.id}>
            <button type="button" disabled={busy} aria-current={entry.id === output?.id || undefined} onClick={() => setSelected(entry.id)}>
              <code>{entry.line}</code>{entry.error && <small>오류</small>}
            </button>
          </li>)}</ul> : <p className="result-empty">이 연결에서 실행한 명령이 없습니다.</p>}
          <p className="form-note">최근 30건을 연결이 유지되는 동안 보관합니다.</p>
        </section>
      </div>
      <form className="redis-console-prompt" onSubmit={event => void submit(event)}>
        <div className="redis-console-command-line">
          <label className="field">Redis 명령<input ref={field} value={line} maxLength={4096}
            disabled={busy} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="예: TYPE my:key"
            onChange={event => { recall.current = -1; setLine(event.target.value); }} onKeyDown={promptKey} /></label>
          <button type="submit" className="primary" disabled={busy || !command || Boolean(command.warning) || tooLong}>
            <CornerDownLeft size={15} aria-hidden /> 실행</button>
        </div>
        {catalogError && <p className="form-error" role="alert">{catalogError}</p>}
        {tooLong && <p className="form-error" role="alert">명령은 4,096바이트 이하로 입력하세요.</p>}
        {command?.warning ? <p className="form-error" role="status">{command.warning}</p> : command && <p className="form-note"><code>{command.usage}</code></p>}
        {matching.length > 0 && <div className="redis-console-completions" role="group" aria-label="명령 자동 완성">
          {matching.map(item => <button type="button" className="secondary small" key={item.name} disabled={busy}
            onClick={() => enter(`${item.name} `)}><code>{item.name}</code></button>)}
          {matching.length === 1 && <p className="form-note">Tab으로 완성</p>}
        </div>}
        {catalog && name && !command && matching.length === 0 && <p className="form-note">지원 명령에서 읽기 전용 명령을 선택하세요.</p>}
        <details><summary>지원 명령</summary><div className="redis-console-completions">
          {supported.map(item => <button type="button" className="secondary small" disabled={busy} key={item.name}
            title={item.usage} onClick={() => enter(`${item.name} `)}><code>{item.name}</code></button>)}
        </div></details>
        <p className="form-note">↑·↓ 키로 이전 입력을 불러옵니다. 공백을 포함한 인수는 따옴표로 감싸세요.</p>
      </form>
    </div>
  </Dialog>;
}

function ReplyView({ reply }: { reply: Reply }) {
  switch (reply.kind) {
    case "array": return <div className="redis-console-reply">
      <small>{role.array} · {number.format(reply.length)}개</small>
      {reply.items.length > 0 && <ol>{reply.items.map((item, index) => <li key={index}><ReplyView reply={item} /></li>)}</ol>}
    </div>;
    case "bulk":
    case "simple": return <div className="redis-console-reply"><small>{role[reply.kind]} · {reply.value.encoding.toUpperCase()}</small>
      <code>{reply.value.bytes > 0 ? reply.value.text : "(빈 문자열)"}{reply.value.truncated && "…"}</code>
      {reply.value.truncated && <small>{number.format(reply.value.bytes)} B</small>}</div>;
    case "integer": return <div className="redis-console-reply"><small>{role.integer}</small><code>{reply.value}</code></div>;
    case "null": return <div className="redis-console-reply"><code>NULL</code></div>;
    case "error": return <div className="redis-console-reply"><small>{role.error}</small><span>서버가 이 응답 항목을 거부했습니다.</span></div>;
  }
}
