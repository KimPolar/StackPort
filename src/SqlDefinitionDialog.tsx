import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SqlReferenceRange } from "./sqlCompletion";
import { SqlSchemaContents, type ObjectDetails } from "./SqlSchemaDetails";

export type SqlDefinition = { details: ObjectDetails; column: string | null; uses: SqlReferenceRange[] };
export type SqlDefinitionResult = SqlDefinition | { error: string };

export function SqlDefinitionDialog({ source, result, onClose, onReveal }: {
  source: string;
  result: Promise<SqlDefinitionResult>;
  onClose: () => void;
  onReveal: (range: SqlReferenceRange) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ddl = useRef<HTMLPreElement>(null);
  const [answer, setAnswer] = useState<SqlDefinitionResult | null>(null);
  const jumpTo = useRef<SqlReferenceRange | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    void result.then(answer => { if (live) setAnswer(answer); });
    return () => { live = false; };
  }, [result]);

  const item = answer && "details" in answer ? answer : null;
  return <dialog className="dialog sql-definition" ref={dialog} aria-labelledby="sql-definition-title" onClose={() => {
    onClose();
    if (jumpTo.current) onReveal(jumpTo.current);
  }}>
    <div className="dialog-heading">
      <h2 id="sql-definition-title">SQL 정의</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="schema-content" aria-busy={!answer}>
      {!answer && <p role="status" className="form-note">현재 연결의 구조를 불러오는 중…</p>}
      {answer && "error" in answer && <p role="alert" className="form-error">{answer.error}</p>}
      {item && <>
        <div className="sql-definition-context">
          <strong>{item.details.object.name}{item.column && ` · ${item.column}`}</strong>
          <span>{item.details.object.kind === "view" ? "뷰" : "테이블"} · main</span>
          {!!item.details.object.ddl && <button type="button" className="secondary small" onClick={() => {
            ddl.current?.focus({ preventScroll: true });
            ddl.current?.scrollIntoView({ block: "nearest" });
          }}>생성 SQL로 이동</button>}
        </div>
        {!!item.uses.length && <details className="sql-definition-uses">
          <summary>현재 문장의 참조 위치 {item.uses.length}개</summary>
          <ul>{item.uses.map(range => {
            const prefix = source.slice(0, range.start);
            const line = prefix.split("\n").length;
            const column = Array.from(prefix.slice(prefix.lastIndexOf("\n") + 1)).length + 1;
            return <li key={range.start}><button type="button" className="secondary small" onClick={() => {
              jumpTo.current = range;
              dialog.current?.close();
            }}>{line}줄 {column}열 <code>{source.slice(range.start, range.end)}</code></button></li>;
          })}</ul>
        </details>}
        <SqlSchemaContents details={item.details} selectedColumn={item.column} ddlRef={ddl} />
      </>}
    </div>
  </dialog>;
}
