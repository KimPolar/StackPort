import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IBuffer } from "@xterm/xterm";
import { X } from "lucide-react";

export type TerminalOutputFormat = "txt" | "ansi";

export function terminalText(buffer: IBuffer, columns: number) {
  const lines: string[] = [];
  let logicalLine = "";
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const next = buffer.getLine(index + 1);
    let endColumn = columns;
    if (next?.isWrapped && next.getCell(0)?.getWidth() === 2 && line.getCell(columns - 1)?.getCode() === 0) {
      // A full-width character starts on the next row when only one cell fits here.
      endColumn--;
    }
    logicalLine += line.translateToString(!next?.isWrapped, 0, endColumn);
    if (!next?.isWrapped) {
      lines.push(logicalLine);
      logicalLine = "";
    }
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

export function TerminalOutputDialog({ tab, capture, onClose, onSaved }: {
  tab: string;
  capture: (format: TerminalOutputFormat) => string;
  onClose: () => void;
  onSaved: (path: string, bytes: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [format, setFormat] = useState<TerminalOutputFormat>("txt");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);

  function changeFormat(next: TerminalOutputFormat) {
    setFormat(next);
    setDestination(current => current.replace(/\.(txt|ansi)$/i, `.${next}`));
    setError("");
  }

  async function chooseFolder() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const folder = await invoke<string | null>("choose_result_export_directory");
      if (folder) {
        const separator = /[\\/]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/";
        setDestination(`${folder}${separator}stackport-terminal.${format}`);
      }
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const text = capture(format);
      if (!text) throw "저장할 터미널 출력이 없습니다.";
      const path = destination.trim();
      const bytes = await invoke<number>("export_terminal_output", { destination: path, format, text });
      onSaved(path, bytes);
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby="terminal-output-title" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="terminal-output-title">터미널 출력 저장</h2>
      <button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="confirm-copy"><strong>{tab}</strong>의 기본 화면과 스크롤백에 남은 내용을 저장합니다. 출력에 민감한 정보가 포함될 수 있으니 저장 위치를 확인하세요.</p>
      <label className="field">파일 형식
        <select disabled={busy} value={format} onChange={event => changeFormat(event.target.value as TerminalOutputFormat)}>
          <option value="txt">TXT · 일반 텍스트</option>
          <option value="ansi">ANSI · 색상 및 화면 형식 포함</option>
        </select>
      </label>
      <label className="field">새 출력 파일 경로<span className="file-input">
        <input required disabled={busy} value={destination} placeholder="새 파일의 절대 경로" onChange={event => setDestination(event.target.value)} />
        <button type="button" className="secondary" disabled={busy} onClick={() => void chooseFolder()}>폴더 선택</button>
      </span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? "처리 중…" : "저장"}</button>
      </div>
    </form>
  </dialog>;
}
