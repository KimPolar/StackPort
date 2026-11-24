import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { proposeSqlAliasRename, type SqlAliasRenameEdit, type SqlAliasRenameTarget, type SqlReferenceRange } from "./sqlCompletion";

export function SqlAliasRenameDialog({ source, target, onClose, onValidate, onApply }: {
  source: string;
  target: SqlAliasRenameTarget | null;
  onClose: () => void;
  onValidate: (range: SqlReferenceRange, text: string) => Promise<void>;
  onApply: (range: SqlReferenceRange, update: SqlAliasRenameEdit) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const accepted = useRef<SqlAliasRenameEdit | null>(null);
  const [next, setNext] = useState(target?.alias ?? "");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.select();
  }, []);

  const proposed = target ? proposeSqlAliasRename(source, target, next) : null;
  const rename = proposed && "text" in proposed ? proposed : null;
  const message = error || (proposed && "error" in proposed ? proposed.error : "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!target || !rename || checking) return;
    setError("");
    setChecking(true);
    try {
      await onValidate(target.statement, rename.text);
      if (!dialog.current?.open) return;
      accepted.current = rename;
      dialog.current.close();
    } catch (error) {
      if (dialog.current?.open) setError(String(error));
    } finally {
      if (dialog.current?.open) setChecking(false);
    }
  }

  return <dialog className="dialog" ref={dialog} aria-labelledby="sql-alias-title" onClose={() => {
    onClose();
    if (target && accepted.current) onApply(target.statement, accepted.current);
  }}>
    <div className="dialog-heading">
      <h2 id="sql-alias-title">테이블 별칭 변경</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <form onSubmit={submit} aria-busy={checking}>
      {target ? <>
        <label className="field">새 별칭<input ref={input} autoFocus value={next} maxLength={256} disabled={checking}
          aria-invalid={!!message} aria-describedby={message ? "sql-alias-error" : undefined}
          onChange={event => { setNext(event.target.value); setError(""); }} /></label>
        <p className="form-note">현재 문장의 선언 및 참조 {target.occurrences.length}곳</p>
        {rename && <ul className="sql-alias-preview" aria-label="변경 위치">
          {target.occurrences.slice(0, 12).map(range => {
            const before = source.slice(0, range.start);
            const line = before.split("\n").length;
            const column = Array.from(before.slice(before.lastIndexOf("\n") + 1)).length + 1;
            return <li key={range.start}><span>{line}줄 {column}열 · {range.start === target.declaration.start ? "선언" : "참조"}</span><code>{source.slice(range.start, range.end)}</code>
              <span aria-hidden>→</span><code>{rename.spelling}</code></li>;
          })}
          {target.occurrences.length > 12 && <li>외 {target.occurrences.length - 12}곳</li>}
        </ul>}
        {message && <p id="sql-alias-error" role="alert" className="form-error">{message}</p>}
        {checking && <p role="status" className="form-note">SQLite에서 변경 전후의 참조를 확인하는 중…</p>}
      </> : <p role="alert" className="form-note">지원되는 SQLite 조회 문장에서 테이블 별칭을 선언하거나 참조한 위치에 커서를 두세요.</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => dialog.current?.close()}>취소</button>
        <button type="submit" className="primary" disabled={!rename || checking}>별칭 변경</button>
      </div>
    </form>
  </dialog>;
}
