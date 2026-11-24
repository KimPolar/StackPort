import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { FormatOptions, FormatRequest, FormatResult } from "./sqlFormatting";

const optionsKey = "stackport.sql.format.sqlite";
const defaults: FormatOptions = { keywordCase: "upper", indent: "2", blankLines: 1 };

function readOptions(): FormatOptions {
  try {
    const stored = JSON.parse(localStorage.getItem(optionsKey) ?? "null") as Partial<FormatOptions> | null;
    if (!stored) return defaults;
    return {
      keywordCase: stored.keywordCase === "preserve" || stored.keywordCase === "lower" ? stored.keywordCase : defaults.keywordCase,
      indent: stored.indent === "4" || stored.indent === "8" || stored.indent === "tabs" ? stored.indent : defaults.indent,
      blankLines: stored.blankLines === 0 || stored.blankLines === 2 ? stored.blankLines : defaults.blankLines,
    };
  } catch {
    return defaults;
  }
}

export function SqlFormatDialog({ source, start, end, onClose, onApply }: {
  source: string;
  start: number;
  end: number;
  onClose: () => void;
  onApply: (text: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  const applyText = useRef<string | null>(null);
  const [mode, setMode] = useState<FormatRequest["mode"]>("pretty");
  const [options, setOptions] = useState(readOptions);
  const [preview, setPreview] = useState<{ key: string; answer: FormatResult } | null>(null);
  const [error, setError] = useState("");
  const key = `${mode}:${options.keywordCase}:${options.indent}:${options.blankLines}`;
  const input = source.slice(start, end);
  const isSelection = start !== 0 || end !== source.length;

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    try {
      const engine = new Worker(new URL("./sqlFormatting.worker.ts", import.meta.url), { type: "module" });
      worker.current = engine;
      engine.onerror = () => setError("SQLite 서식 도구를 불러올 수 없습니다.");
      return () => { worker.current = null; engine.terminate(); };
    } catch {
      setError("SQLite 서식 도구를 불러올 수 없습니다.");
    }
  }, []);
  useEffect(() => {
    const engine = worker.current;
    if (!engine) return;
    const id = ++generation.current;
    const request: FormatRequest = { source, start, end, mode, options };
    engine.onmessage = (event: MessageEvent<{ id: number; answer: FormatResult }>) => {
      if (id === event.data.id && id === generation.current) setPreview({ key, answer: event.data.answer });
    };
    engine.postMessage({ id, request });
  }, [source, start, end, mode, options, key]);

  function changeOptions(next: FormatOptions) {
    setOptions(next);
    try { localStorage.setItem(optionsKey, JSON.stringify(next)); } catch { /* Settings are optional. */ }
  }

  const answer = preview?.key === key ? preview.answer : null;
  const text = answer && "text" in answer ? answer.text : null;
  const message = error || (answer && "error" in answer ? answer.error : "");
  const changed = text !== null && text !== input && !message;

  return <dialog ref={dialog} className="dialog sql-format" aria-labelledby="sql-format-title" onClose={() => {
    onClose();
    if (applyText.current !== null) onApply(applyText.current);
  }}>
    <div className="dialog-heading">
      <h2 id="sql-format-title">SQL 서식</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="sql-format-body">
      <p className="form-note">SQLite · {isSelection ? "선택 영역" : "문서 전체"}</p>
      <div className="sql-format-options">
        <label className="field">방식<select value={mode} onChange={event => setMode(event.target.value as FormatRequest["mode"])}>
          <option value="pretty">정리</option><option value="compact">축약</option>
        </select></label>
        <label className="field">키워드 대소문자<select value={options.keywordCase} disabled={mode === "compact"}
          onChange={event => changeOptions({ ...options, keywordCase: event.target.value as FormatOptions["keywordCase"] })}>
          <option value="upper">대문자</option><option value="lower">소문자</option><option value="preserve">원래대로</option>
        </select></label>
        <label className="field">들여쓰기<select value={options.indent} disabled={mode === "compact"}
          onChange={event => changeOptions({ ...options, indent: event.target.value as FormatOptions["indent"] })}>
          <option value="2">공백 2칸</option><option value="4">공백 4칸</option><option value="8">공백 8칸</option><option value="tabs">탭</option>
        </select></label>
        <label className="field">문장 사이 빈 줄<select value={options.blankLines} disabled={mode === "compact"}
          onChange={event => changeOptions({ ...options, blankLines: Number(event.target.value) as FormatOptions["blankLines"] })}>
          <option value="0">0줄</option><option value="1">1줄</option><option value="2">2줄</option>
        </select></label>
      </div>
      {message && <p role="alert" className="form-error">{message}</p>}
      {!answer && !message && <p className="form-note" role="status">미리보기를 만드는 중…</p>}
      {text !== null && text === input && <p className="form-note" role="status">서식이 이미 적용되어 있습니다.</p>}
      {!!(text !== null || !message) && input.length <= 256 * 1024 && <div className="sql-format-preview">
        <div><h3>원본</h3><pre aria-label="서식 적용 전 SQL" tabIndex={0}>{input}</pre></div>
        <div><h3>미리보기</h3><pre aria-label="서식 결과 SQL" tabIndex={text !== null ? 0 : undefined}>{text}</pre></div>
      </div>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => dialog.current?.close()}>취소</button>
        <button type="button" className="primary" disabled={!changed} onClick={() => { if (changed) { applyText.current = text; dialog.current?.close(); } }}>서식 적용</button>
      </div>
    </div>
  </dialog>;
}
