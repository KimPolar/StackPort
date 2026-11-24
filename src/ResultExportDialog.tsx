import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { SqlParameterValue } from "./SqlParameterFields";
import type { TableQuery } from "./TableQueryControls";

export type ExportSource =
  | { kind: "sql"; sql: string; parameters?: SqlParameterValue[] }
  | { kind: "table"; request: TableQuery };
type ExportFormat = "CSV" | "JSON";
export type ExportReport = { format: ExportFormat; path: string; rows: number; size_bytes: number; protected_fields: number; audit_warning: string | null };
export type ExportOutcome = { status: "exported"; report: ExportReport } | { status: "cancelled" | "timed_out" };
export type ExportFileOptions = { destination: string; format: ExportFormat; include_header: boolean; spreadsheet_safe: boolean };
export type ExportDriver = {
  prepare: () => Promise<string>;
  run: (token: string, options: ExportFileOptions) => Promise<ExportOutcome>;
  progress: (token: string) => Promise<number | null>;
  cancel: (token: string) => Promise<boolean>;
};
const number = new Intl.NumberFormat("ko-KR");

export function ResultExportDialog({ profile, query, onClose, onExported }: {
  profile: { id: string; name: string; environment: string };
  query: ExportSource;
  onClose: () => void;
  onExported: (report: ExportReport) => void;
}) {
  const driver: ExportDriver = {
    prepare: () => invoke<string>("prepare_query"),
    run: (token, options) => {
      const source = { token, profileId: profile.id, query };
      const { destination, include_header, spreadsheet_safe } = options;
      return options.format === "CSV"
        ? invoke<ExportOutcome>("export_sqlite_csv", { ...source, options: { destination, include_header, spreadsheet_safe } })
        : invoke<ExportOutcome>("export_sqlite_json", { ...source, destination });
    },
    progress: token => invoke<number | null>("result_export_progress", { token }),
    cancel: token => invoke<boolean>("cancel_query", { token }),
  };
  const source = query.kind === "table" ? `${query.request.object}의 적용된 필터와 정렬` : "마지막으로 실행한 SQL과 매개변수";
  return <ResultFileDialog profile={profile} source={source} driver={driver} onClose={onClose} onExported={onExported} />;
}

export function ResultFileDialog({ profile, source, driver, onClose, onExported, unavailable = "" }: {
  profile: { name: string; environment: string };
  source: string;
  driver: ExportDriver;
  onClose: () => void;
  onExported: (report: ExportReport) => void;
  unavailable?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pathId = useId();
  const pending = useRef(false);
  const [format, setFormat] = useState<ExportFormat>("CSV");
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
        const progress = await driver.progress(token);
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
      const folder = await invoke<string | null>("choose_result_export_directory");
      if (folder) {
        const separator = /[\\/]$/.test(folder) ? "" : folder.includes("\\") ? "\\" : "/";
        setDestination(`${folder}${separator}stackport-results.${format.toLowerCase()}`);
      }
    } catch (error) {
      setError(String(error));
    }
  }

  function changeFormat(next: ExportFormat) {
    setFormat(next);
    setDestination(current => current.replace(/\.(csv|json)$/i, `.${next.toLowerCase()}`));
    setNotice("");
    setError("");
  }

  async function start() {
    if (pending.current || unavailable) return;
    pending.current = true;
    setBusy(true); setRows(0); setNotice(""); setError("");
    try {
      const request = await driver.prepare();
      setToken(request);
      const response = await driver.run(request, { destination, format, include_header: header, spreadsheet_safe: spreadsheetSafe });
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
      const accepted = await driver.cancel(token);
      if (pending.current) {
        setNotice(accepted ? "중단을 요청했습니다." : "내보내기 상태를 확인하고 있습니다.");
        if (!accepted) setStopping(false);
      }
    } catch (error) {
      if (pending.current) { setError(String(error)); setStopping(false); }
    }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby="result-export-title" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="result-export-title">결과 내보내기</h2>
      <button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button>
    </div>
    <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <p className="confirm-copy"><strong>{profile.name}</strong> · {profile.environment}<br />
        {source}로 전체 결과를 다시 조회합니다.
      </p>
      <label className="field">파일 형식
        <select disabled={busy} value={format} onChange={event => changeFormat(event.target.value as ExportFormat)}>
          <option value="CSV">CSV</option>
          <option value="JSON">JSON</option>
        </select>
      </label>
      <div className="field"><label htmlFor={pathId}>새 {format} 파일 경로</label><span className="file-input">
        <input id={pathId} required disabled={busy} value={destination} placeholder="새 파일의 절대 경로" onChange={event => setDestination(event.target.value)} />
        <button type="button" className="secondary" disabled={busy} onClick={() => void chooseFolder()}>폴더 선택</button>
      </span></div>
      {format === "CSV" && <fieldset className="csv-options" disabled={busy}>
        <legend className="sr-only">CSV 옵션</legend>
        <label><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)} /> 열 이름 포함</label>
        <label><input type="checkbox" checked={spreadsheetSafe} onChange={event => setSpreadsheetSafe(event.target.checked)} /> 수식처럼 보이는 텍스트 앞에 작은따옴표 추가</label>
      </fieldset>}
      <p className="form-note">조회 데이터가 포함된 파일입니다. 보관 위치와 공유 대상을 확인하세요.</p>
      {busy && <p role="status" className="query-notice">{notice || `${number.format(rows)}행 기록 · 파일을 만드는 중`}</p>}
      {!busy && notice && <p role="status" className="query-notice">{notice}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {unavailable && <p role="alert" className="form-error">{unavailable}</p>}
      <div className="dialog-actions">
        {busy ? <button type="button" className="secondary" disabled={!token || stopping} onClick={() => void cancel()}>내보내기 중단</button> : <>
          <button type="button" className="secondary" onClick={onClose}>닫기</button>
          <button type="submit" className="primary" disabled={Boolean(unavailable)}>{format} 저장</button>
        </>}
      </div>
    </form>
  </dialog>;
}
