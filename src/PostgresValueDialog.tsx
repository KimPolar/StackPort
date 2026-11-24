import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { PostgresPager } from "./PostgresPager";
import { usePostgresRead } from "./usePostgresRead";

export type PostgresValueRow = { tuple: string; version: string; command: string };
export type PostgresValueTarget = { object: number; column: string; row: PostgresValueRow };
type ValuePage = { offset: number; total_units: number; has_next: boolean } &
  ({ kind: "text"; text: string } | { kind: "binary"; bytes: number[] });
type SaveReport = { size_bytes: number; audit_warning: boolean };
const number = new Intl.NumberFormat("ko-KR");

function dump(bytes: number[], start: number) {
  const lines = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const row = bytes.slice(index, index + 16);
    const address = (start + index).toString(16).toUpperCase().padStart(8, "0");
    const hex = row.map(byte => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = row.map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${address}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

export function PostgresValueDialog({ id, target, title, unavailable, onBusy, onClose }: {
  id: string; target: PostgresValueTarget; title: string; unavailable: string; onBusy: (busy: boolean) => void; onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SaveReport | null>(null);
  const [error, setError] = useState("");
  const pathId = useId();
  const pending = useRef(false);
  const args = useMemo(() => unavailable ? null : { id, target, page }, [id, target, page, unavailable]);
  const read = usePostgresRead<ValuePage>("postgres_value_page", args);
  const data = read.data;
  const text = data?.kind === "binary" ? dump(data.bytes, data.offset) : data?.text;
  const unit = data?.kind === "binary" ? "B" : "자";
  const units = data?.kind === "binary" ? data.bytes.length : data ? Array.from(data.text).length : 0;

  async function chooseFolder() {
    setError("");
    try {
      const folder = await invoke<string | null>("choose_result_export_directory");
      if (!folder) return;
      const separator = /[\\/]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/";
      setDestination(folder + separator + (data?.kind === "binary" ? "cell.bin" : "cell.txt"));
    } catch (reason) { setError(String(reason)); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !data || unavailable) return;
    pending.current = true; onBusy(true); setBusy(true); setError(""); setReport(null);
    try { setReport(await invoke<SaveReport>("save_postgres_value", { id, target, destination })); }
    catch (reason) { setError(String(reason)); }
    finally { pending.current = false; onBusy(false); setBusy(false); }
  }

  return <Dialog title="PostgreSQL 셀 원본" className="postgres-value-dialog" onClose={onClose} busy={busy}>
    <div className="postgres-value-content">
      <p className="confirm-copy"><strong>{title}</strong></p>
      {unavailable && <p className="form-error" role="alert">{unavailable}</p>}
      {read.error && <p className="form-error" role="alert">{read.error}</p>}
      {read.loading && <p className="form-note" role="status">셀 값을 읽는 중…</p>}
      {data && <>
        <p className="form-note">{data.kind === "binary" ? "바이너리 HEX" : "텍스트"} · {number.format(data.total_units)} {unit}
          {units > 0 && ` · ${number.format(data.offset + 1)}–${number.format(data.offset + units)} ${unit} 표시`}</p>
        {text ? <pre className={data.kind === "binary" ? "postgres-value-hex" : undefined}
          aria-label={data.kind === "binary" ? "셀 HEX" : "셀 원본 텍스트"} tabIndex={0}>{text}</pre>
          : <p className="form-note">빈 값입니다.</p>}
      </>}
      <PostgresPager label="셀 원본" page={page} next={data?.has_next ?? false} change={setPage} />
    </div>
    <form onSubmit={event => void save(event)} aria-busy={busy}>
      <div className="field"><label htmlFor={pathId}>새 파일 경로</label>
        <span className="file-input"><input id={pathId} required value={destination} disabled={busy || Boolean(unavailable)}
          placeholder="새 파일의 절대 경로" onChange={event => setDestination(event.target.value)} />
          <button type="button" className="secondary" disabled={!data || busy || Boolean(unavailable)} onClick={() => void chooseFolder()}>폴더 선택</button></span>
      </div>
      {busy && <p className="form-note" role="status">전체 값을 저장하는 중…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {report && <p className="form-note" role="status">전체 값 저장 완료 · {number.format(report.size_bytes)} B
        {report.audit_warning && " · 작업 기록 저장 실패"}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>닫기</button>
        <button type="submit" className="primary" disabled={!data || busy || Boolean(unavailable)}>전체 값 저장</button></div>
    </form>
  </Dialog>;
}
