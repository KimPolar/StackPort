import { useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealEditorRange } from "./editorSearch";

const labels = { syntax: "문법 오류", object: "객체 참조 오류", type: "타입 오류", policy: "읽기 전용 정책", sqlite: "SQLite 오류" };
type Issue = { kind: keyof typeof labels; message: string; start: number; end: number; line: number; column: number; precise: boolean };
type Diagnosis = { status: "report"; checked: number; partial: boolean; issues: Issue[] } | { status: "too_large" };
type Completed = { profileId: string; sql: string; answer: Diagnosis | { error: string } };
const limit = 256 * 1024;
const limitMessage = "실시간 진단은 UTF-8로 256 KiB 이하의 SQL을 지원합니다.";

export function SqlDiagnostics({ profileId, sql, enabled, editorRef }: {
  profileId: string;
  sql: string;
  enabled: boolean;
  editorRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [completed, setCompleted] = useState<Completed | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const large = sql.length > limit;
  const active = enabled && !!profileId && (large || !!sql.trim());

  useEffect(() => {
    if (!active || large) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      if (inFlight.current) await inFlight.current;
      if (!live) return;
      const task = invoke<Diagnosis>("diagnose_sql", { profileId, sql }).then(answer => {
        if (live) setCompleted({ profileId, sql, answer });
      }, error => {
        if (live) setCompleted({ profileId, sql, answer: { error: String(error) } });
      });
      inFlight.current = task;
      await task;
      if (inFlight.current === task) inFlight.current = null;
    }, 500);
    return () => { live = false; window.clearTimeout(timer); };
  }, [active, large, profileId, sql]);

  if (!active) return null;
  const answer = large ? { status: "too_large" as const }
    : completed?.profileId === profileId && completed.sql === sql ? completed.answer : null;
  if (!answer || ("status" in answer && answer.status === "report" && !answer.checked && !answer.issues.length && !answer.partial)) return null;

  function reveal(issue: Issue) {
    const editor = editorRef.current;
    if (!editor || editor.value !== sql) return;
    revealEditorRange(editor, issue.start, issue.end);
  }

  return <section className="sql-diagnostics" aria-label="SQL 실시간 진단">
    {"error" in answer ? <p role="status">검사할 수 없습니다. {answer.error}</p> : answer.status === "too_large" ? <p role="status">{limitMessage}</p> : <>
      <p role="status">{answer.checked}개 문장 검사 · 문제 {answer.issues.length}개
        {answer.partial && " · 검사 한도에 도달해 일부 문장을 확인했습니다."}</p>
      {!!answer.issues.length && <ul>
        {answer.issues.map((issue, index) => <li key={index}>
          <button type="button" onClick={() => reveal(issue)}>
            <span className="sql-diagnostic-location">{issue.precise ? `${issue.line}줄 ${issue.column}열` : `${issue.line}줄 문장`}</span>
            <span><strong>{labels[issue.kind]}</strong> <span>{issue.message}</span></span>
          </button>
        </li>)}
      </ul>}
    </>}
  </section>;
}
