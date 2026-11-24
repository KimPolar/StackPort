import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { SqlParameterValue } from "./SqlParameterFields";
import type { TableQuery } from "./TableQueryControls";

export type CsvSource =
  | { kind: "sql"; sql: string; parameters?: SqlParameterValue[] }
  | { kind: "table"; request: TableQuery };
export type CsvReport = { path: string; rows: number; size_bytes: number; protected_fields: number; audit_warning: string | null };
type CsvOutcome = { status: "exported"; report: CsvReport } | { status: "cancelled" | "timed_out" };
const number = new Intl.NumberFormat("ko-KR");

export function CsvExportDialog({ profile, query, onClose, onExported }: {
  profile: { id: string; name: string; environment: string };
  query: CsvSource;
  onClose: () => void;
  onExported: (report: CsvReport) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [destination, setDestination] = useState("");
  const [header, setHeader] = useState(true);
  const [spreadsheetSafe, setSpreadsheetSafe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [rows, setRows] = useState(0);
  const [notice, setNotice] = useState("");
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!token) return;
    let live = true;
    let reading = false;
    const interval = window.setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const progress = await invoke<number | null>("csv_export_progress", { token });
        if (live && progress !== null) setRows(progress);
      } catch {
        // The export's response supplies the final status if polling fails.
      } finally {
        reading = false;
      }
    }, 400);
    return () => { live = false; window.clearInterval(interval); };
  }, [token]);

  async function chooseFolder() {
    setError("");
    try {
      const folder = await invoke<string | null>("choose_csv_directory");
      if (folder) {
        const separator = /[\\/]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/";
        setDestination(`${folder}${separator}stackport-results.csv`);
      }
    } catch (error) {
      setError(String(error));
    }
  }

  async function start() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setRows(0); setNotice(""); setError("");
    try {
      const request = await invoke<string>("prepare_query");
      setToken(request);
      const response = await invoke<CsvOutcome>("export_sqlite_csv", {
        token: request,
        profileId: profile.id,
        query,
        options: { destination, include_header: header, spreadsheet_safe: spreadsheetSafe },
      });
      if (response.status === "exported") onExported(response.report);
      else if (response.status === "cancelled") setNotice("내보내기를 중단했습니다.");
      else setError("내보내기 제한 시간 5분을 초과했습니다. 조회 범위를 줄여 다시 시도하세요.");
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false); setToken(""); setStopping(false);
    }
  }

  async function cancel() {
    if (!token || stopping) return;
    setStopping(true);
    try {
      const accepted = await invoke<boolean>("cancel_query", { token });
      if (pending.current) setNotice(accepted ? "중단을 요청했습니다." : "파일 저장을 마무리하고 있습니다.");
    } catch (error) {
      if (pending.current) { setError(String(error)); setStopping(false); }
    }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby="csv-export-title" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="csv-export-title">CSV 내보내기</h2>
      <button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <p className="confirm-copy"><strong>{profile.name}</strong> · {profile.environment}<br />
        {query.kind === "table" ? `${query.request.object}의 적용된 필터와 정렬` : "마지막으로 실행한 SQL과 매개변수"}로 전체 결과를 다시 조회합니다.
      </p>
      <label className="field">새 CSV 파일 경로<span className="file-input">
        <input required disabled={busy} value={destination} placeholder="새 파일의 절대 경로" onChange={event => setDestination(event.target.value)} />
        <button type="button" className="secondary" disabled={busy} onClick={() => void chooseFolder()}>폴더 선택</button>
      </span></label>
      <fieldset className="csv-options" disabled={busy}>
        <legend className="sr-only">CSV 옵션</legend>
        <label><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)} /> 열 이름 포함</label>
        <label><input type="checkbox" checked={spreadsheetSafe} onChange={event => setSpreadsheetSafe(event.target.checked)} /> 수식처럼 보이는 텍스트 앞에 작은따옴표 추가</label>
      </fieldset>
      <p className="form-note">CSV에는 조회 데이터가 포함됩니다. 파일을 보관할 위치와 공유 대상을 확인하세요.</p>
      {busy && <p role="status" className="query-notice">{notice || `${number.format(rows)}행 기록 · 파일을 만드는 중`}</p>}
      {!busy && notice && <p role="status" className="query-notice">{notice}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-actions">
        {busy ? <button type="button" className="secondary" disabled={!token || stopping} onClick={() => void cancel()}>내보내기 중단</button> : <>
          <button type="button" className="secondary" onClick={onClose}>닫기</button>
          <button type="submit" className="primary">CSV 저장</button>
        </>}
      </div>
    </form>
  </dialog>;
}
