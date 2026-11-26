import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type ImportReview = {
  token: string;
  bytes: number;
  document_count: number;
  sample: { json: string; truncated: boolean }[];
  atomic: boolean;
  expires_seconds: number;
};

const csvKinds = {
  text: "문자열", int32: "Int32", int64: "Int64", double: "Double", decimal128: "Decimal128",
  boolean: "불리언", date_time: "날짜 · RFC 3339", extended_json: "Extended JSON", skip: "건너뛰기",
};
type CsvField = { name: string; kind: keyof typeof csvKinds };
type CsvInspection = { columns: string[]; digest: number[] };

export type MongoImportReport = {
  status: "complete" | "stopped" | "unconfirmed";
  document_count: number;
  inserted: number;
  stopped_at: number | null;
  reason: string | null;
  audit_warning: boolean;
};

const numbers = new Intl.NumberFormat("ko-KR");

function defaultCsvFields(columns: string[]): CsvField[] {
  const used = new Set<string>();
  const encoder = new TextEncoder();
  return columns.map((column, index) => {
    let name = column;
    if (!name.trim() || name.startsWith("$") || name.includes("\0") || encoder.encode(name).length > 256 || used.has(name)) {
      name = `column_${index + 1}`;
      while (used.has(name)) name += "_";
    }
    used.add(name);
    return { name, kind: "text" };
  });
}

export function MongoDocumentImportDialog({ id, database, collection, environment, onBusy, onClose, onDone }: {
  id: string; database: string; collection: string; environment: string;
  onBusy: (busy: boolean) => void; onClose: () => void; onDone: (report: MongoImportReport) => void;
}) {
  const [path, setPath] = useState("");
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [header, setHeader] = useState(true);
  const [csv, setCsv] = useState<CsvInspection | null>(null);
  const [fields, setFields] = useState<CsvField[]>([]);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const token = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const production = environment === "PROD";
  const partialPossible = Boolean(review && !review.atomic && review.document_count > 1);
  const approvalRequired = review && ((!acceptPartial && partialPossible) || (production && confirmation !== "PROD"));
  const readingColumns = format === "csv" && !csv;

  useEffect(() => () => {
    if (token.current) void invoke("discard_mongo_document_import", { id, token: token.current }).catch(() => {});
  }, [id]);
  useEffect(() => { if (review) heading.current?.focus(); }, [review]);

  function resetReview() {
    if (token.current) void invoke("discard_mongo_document_import", { id, token: token.current }).catch(() => {});
    token.current = null;
    setReview(null);
    setConfirmation("");
    setAcceptPartial(false);
    setError("");
  }

  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try { await action(); }
    catch (cause) { resetReview(); setError(String(cause)); }
    finally { pending.current = false; onBusy(false); setBusy(false); }
  }

  function changeSource(nextPath: string, nextFormat = format) {
    setPath(nextPath);
    setFormat(nextFormat);
    setCsv(null);
    setError("");
  }

  async function readCsvColumns() {
    setCsv(null);
    const inspected = await invoke<CsvInspection>("inspect_mongo_import_csv", { id, path, header });
    setCsv(inspected);
    setFields(defaultCsvFields(inspected.columns));
  }

  function changeField(index: number, change: Partial<CsvField>) {
    setFields(current => current.map((field, position) => position === index ? { ...field, ...change } : field));
    setError("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (approvalRequired) return;
    void perform(async () => {
      if (review) {
        const result = await invoke<MongoImportReport>("apply_mongo_document_import", { id, token: review.token, confirmation, acceptPartial });
        token.current = null;
        onDone(result);
      } else if (readingColumns) {
        await readCsvColumns();
      } else {
        const source = format === "csv" && csv ? { format, header, digest: csv.digest, fields } : { format: "json" };
        const result = await invoke<ImportReview>("review_mongo_document_import", { id, database, collection, path, source });
        token.current = result.token;
        setReview(result);
      }
    });
  }

  return <Dialog title="MongoDB 문서 가져오기" busy={busy} className="restore-dialog mongo-namespace-dialog" onClose={onClose}>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{environment}</strong> · {database}.{collection}</p>
      <label className="field">파일 형식<select value={format} disabled={busy || Boolean(review)}
        onChange={event => changeSource(path, event.target.value as typeof format)}>
        <option value="json">JSON</option><option value="csv">CSV</option>
      </select></label>
      <label className="field">가져올 {format.toUpperCase()} 파일 경로<span className="file-input">
        <input required readOnly={Boolean(review)} disabled={busy} value={path} onChange={event => changeSource(event.target.value)}
          placeholder="파일의 절대 경로" />
        {!review && <button type="button" className="secondary" disabled={busy} onClick={() => void perform(async () => {
          const file = await invoke<string | null>("choose_mongo_import_file");
          if (file) changeSource(file, /\.csv$/i.test(file) ? "csv" : "json");
        })}>파일 선택</button>}
      </span></label>
      {!review && format === "json" && <p className="form-note">UTF-8 JSON 객체·배열 또는 줄마다 한 문서인 JSON Lines를 가져옵니다. 파일당 32 MiB와 문서 1,000개까지 검토할 수 있습니다.</p>}
      {!review && format === "csv" && <>
        <label className="files-check"><input type="checkbox" checked={header} disabled={busy} onChange={event => {
          setHeader(event.target.checked); setCsv(null); setError("");
        }} /> 첫 행을 머리글로 사용</label>
        {csv ? <>
          <div className="mongo-structure-browser mongo-import-mapping"><table aria-label="CSV 열 매핑">
            <thead><tr><th scope="col">CSV 열</th><th scope="col">대상 필드</th><th scope="col">BSON 타입</th></tr></thead>
            <tbody>{fields.map((field, index) => <tr key={index}>
              <th scope="row">{csv.columns[index] || `열 ${index + 1}`}</th>
              <td><input aria-label={`${index + 1}열 대상 필드`} maxLength={256}
                required={field.kind !== "skip"} disabled={busy || field.kind === "skip"} value={field.name}
                onChange={event => changeField(index, { name: event.target.value })} /></td>
              <td><select aria-label={`${index + 1}열 BSON 타입`} disabled={busy} value={field.kind}
                onChange={event => changeField(index, { kind: event.target.value as CsvField["kind"] })}>
                {Object.entries(csvKinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
              </select></td>
            </tr>)}</tbody>
          </table></div>
          <p className="form-note">따옴표 없는 \N은 BSON null로 가져옵니다. 대상 이름의 점은 필드 이름에 그대로 포함됩니다.</p>
        </> : <p className="form-note">UTF-8 CSV 파일을 사용하세요. 열을 읽으면 대상 필드와 BSON 타입을 선택할 수 있습니다.</p>}
      </>}
      {review && <>
        <h3 className="mongo-edit-review-heading" ref={heading} tabIndex={-1}>문서 {numbers.format(review.document_count)}개 추가 · {numbers.format(review.bytes)} B</h3>
        <p className="form-note">미리보기는 최대 3개 문서를 Canonical Extended JSON으로 표시합니다. 검토는 {review.expires_seconds / 60}분 동안 유효합니다.</p>
        <div className="mongo-edit-compare">
          {review.sample.map((sample, index) => <section key={index}>
            <strong>문서 {index + 1}{sample.truncated && " · 일부 표시"}</strong>
            <pre aria-label={`문서 ${index + 1} 미리보기`}>{sample.json}{sample.truncated && "…"}</pre>
          </section>)}
        </div>
        {review.atomic ? <p className="form-note">한 트랜잭션으로 저장합니다. 중복 키나 검증 오류가 발생하면 전체 작업을 취소합니다.</p>
          : partialPossible && <label className="files-check"><input type="checkbox" checked={acceptPartial} disabled={busy}
            onChange={event => setAcceptPartial(event.target.checked)} /> 첫 오류에서 중단되며 그 전에 저장된 문서는 유지됩니다.</label>}
        {production && <label className="field">운영 환경 확인<input required autoComplete="off" placeholder="PROD" disabled={busy}
          value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {review && <button type="button" className="secondary" disabled={busy} onClick={resetReview}>다시 검토</button>}
        {!review && format === "csv" && csv && <button type="button" className="secondary" disabled={busy}
          onClick={() => void perform(readCsvColumns)}>열 다시 읽기</button>}
        <button type="submit" className="primary" disabled={busy || Boolean(approvalRequired)}>
          {busy ? "처리 중…" : review ? "검토한 문서 추가" : readingColumns ? "CSV 열 읽기" : "파일 검토"}
        </button>
      </div>
    </form>
  </Dialog>;
}

export function MongoDocumentImportReport({ report }: { report: MongoImportReport }) {
  const status = report.status === "complete" ? "가져오기 완료" : report.status === "stopped" ? "가져오기 중단" : "저장 결과 미확인";
  return <p className={report.status === "complete" ? "form-note mongo-note" : "error-banner"} role={report.status === "complete" ? "status" : "alert"}>
    {status} · {numbers.format(report.document_count)}개 중 저장 확인 {numbers.format(report.inserted)}개
    {report.stopped_at !== null && (report.status === "unconfirmed"
      ? ` · 문서 ${numbers.format(report.stopped_at)}부터 결과 미확인`
      : ` · 문서 ${numbers.format(report.stopped_at)}에서 중단`)}
    {report.reason && ` · ${report.reason}`}
    {report.audit_warning && " · 완료 감사 기록 저장 실패"}
  </p>;
}
