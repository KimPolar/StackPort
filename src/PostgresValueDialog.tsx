import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import { PostgresPager } from "./PostgresPager";
import { StructuredPreviewView } from "./StructuredPreviewView";
import { formatStructuredPreview } from "./structuredFilePreview";
import { usePostgresRead } from "./usePostgresRead";

export type PostgresValueRow = { tuple: string; version: string; command: string };
export type PostgresValueTarget = { object: number; column: string; row: PostgresValueRow };
export type PostgresValueFormat = "json" | "xml" | "png";
type ValuePage = { offset: number; total_units: number; has_next: boolean } &
  ({ kind: "text"; text: string } | { kind: "binary"; bytes: number[] });
type SaveReport = { size_bytes: number; audit_warning: boolean };
type Representation = { kind: "json" | "xml"; text: string } | { kind: "png"; base64: string };
const number = new Intl.NumberFormat("ko-KR");
const formatLabels: Record<PostgresValueFormat, string> = { json: "JSON 들여쓰기", xml: "XML 구조", png: "PNG 이미지" };

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

export function PostgresValueDialog({ id, target, title, format, unavailable, onBusy, onClose }: {
  id: string; target: PostgresValueTarget; title: string; format: PostgresValueFormat | null; unavailable: string;
  onBusy: (busy: boolean) => void; onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SaveReport | null>(null);
  const [error, setError] = useState("");
  const [enhanced, setEnhanced] = useState(false);
  const [imageError, setImageError] = useState(false);
  const pathId = useId();
  const pending = useRef(false);
  const args = useMemo(() => unavailable ? null : { id, target, page }, [id, target, page, unavailable]);
  const read = usePostgresRead<ValuePage>("postgres_value_page", args);
  const enhancedArgs = useMemo(() => enhanced && format && !unavailable && !read.error ? { id, target } : null,
    [enhanced, format, unavailable, read.error, id, target]);
  const representation = usePostgresRead<Representation>("postgres_value_representation", enhancedArgs);
  const alternative = representation.data;
  const formatted = useMemo(() => alternative && alternative.kind !== "png" ? formatStructuredPreview(alternative.kind, alternative.text) : null,
    [alternative]);
  const previewError = representation.error || (formatted && "error" in formatted ? formatted.error : "")
    || (alternative?.kind === "png" && imageError ? "PNG 이미지를 표시할 수 없습니다. HEX 페이지에서 값을 확인하세요." : "");
  const showRaw = !enhanced || Boolean(previewError);
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
      const extension = format === "json" || format === "xml" ? format
        : alternative?.kind === "png" && !imageError ? "png" : data?.kind === "binary" ? "bin" : "txt";
      setDestination(`${folder}${separator}cell.${extension}`);
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
      {format && data && <div className="files-preview-modes" role="group" aria-label="셀 보기 방식">
        <button type="button" className="secondary small" aria-pressed={showRaw} onClick={() => setEnhanced(false)}>
          {format === "png" ? "HEX" : "원문"}</button>
        <button type="button" className="secondary small" aria-pressed={!showRaw} onClick={() => { setImageError(false); setEnhanced(true); }}>
          {formatLabels[format]}</button>
      </div>}
      {representation.loading && <p className="form-note" role="status">셀 미리보기를 읽는 중…</p>}
      {previewError && <p className="form-note" role="status">{previewError}</p>}
      {!showRaw && alternative?.kind === "png" && <img className="files-preview-image" alt="셀 PNG 미리보기"
        src={`data:image/png;base64,${alternative.base64}`} onError={() => setImageError(true)} />}
      {!showRaw && formatted && "kind" in formatted && <StructuredPreviewView preview={formatted} />}
      {showRaw && data && <>
        <p className="form-note">{data.kind === "binary" ? "바이너리 HEX" : "텍스트"} · {number.format(data.total_units)} {unit}
          {units > 0 && ` · ${number.format(data.offset + 1)}–${number.format(data.offset + units)} ${unit} 표시`}</p>
        {text ? <pre className={data.kind === "binary" ? "postgres-value-hex" : undefined}
          aria-label={data.kind === "binary" ? "셀 HEX" : "셀 원본 텍스트"} tabIndex={0}>{text}</pre>
          : <p className="form-note">빈 값입니다.</p>}
      </>}
      {showRaw && <PostgresPager label="셀 원본" page={page} next={data?.has_next ?? false} change={setPage} />}
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
