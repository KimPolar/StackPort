import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog, type GridEditExitGuard } from "./Dialog";
import { clipboardPasteLimits, decodeImportFile, fileImportLimits, delimiterNames, fileEncodings, inferSourceColumn,
  parseClipboardRows, parseDelimitedImport, type Delimiter, type FileEncoding } from "./structuredFilePreview";
import type { Cell } from "./sqlResults";

export type GridPasteRequest = ({ engine: "sqlite"; profileId: string } | { engine: "postgres"; id: string; object: number })
  & { source: "clipboard" | "file"; profileName: string; location: string; environment: "DEV" | "STAGING" | "PROD"; table: string };
type RowBatchResult = { rows: number; audit_warning: string | null };
export type GridPasteResult = RowBatchResult & { source: GridPasteRequest["source"] };
type PostgresOutcome = { status: "pasted"; result: RowBatchResult } | { status: "unknown" };
type Column = { name: string; declared_type: string; required: boolean; auto_key: boolean; default_value: string | null; editable: boolean };
type Session = { token: string; columns: Column[] };
type DelimitedSource = Exclude<ReturnType<typeof parseClipboardRows>, { error: string }>;
type JsonCell = { kind: "null" | "text" | "integer" | "real" | "number" | "boolean" | "json" | "blob"; value: string };
type JsonSource = { format: string; headers: string[]; columnCount: number; columnTypes: (string | null)[]; rows: (JsonCell | null)[][] };
type Source = DelimitedSource | JsonSource;
type Kind = "text" | "integer" | "real" | "source" | "blob_hex";
type Blank = "empty" | "null" | "default";
type Mapping = { column: string | null; kind: Kind; blank: Blank };
type Preview = { approval: string; columns: string[]; rows: (Cell | null)[][]; row_count: number };

function mappingFor(postgres: boolean, column: Column | undefined, json = false): Mapping {
  if (column && !column.editable) column = undefined;
  const declared = column?.declared_type.toUpperCase() ?? "";
  const kind = postgres ? "text" : json ? "source" : declared.includes("INT") ? "integer" : /REAL|FLOA|DOUB/.test(declared) ? "real" : "text";
  const preservesEmpty = postgres ? /^(TEXT|CHARACTER)(\b|$)/.test(declared) : kind === "text";
  return { column: column?.name ?? null, kind, blank: preservesEmpty ? "empty" : "default" };
}

const jsonKindLabels: Record<JsonCell["kind"], string> = {
  null: "NULL", text: "문자열", integer: "정수", real: "실수", number: "숫자", boolean: "불리언", json: "JSON", blob: "바이너리",
};

function jsonColumnType(source: JsonSource, index: number) {
  if (source.columnTypes[index]) return source.columnTypes[index];
  const kinds = new Set(source.rows.flatMap(row => {
    const cell = row[index];
    return cell && cell.kind !== "null" ? [jsonKindLabels[cell.kind]] : [];
  }));
  return [...kinds].join(" · ");
}

function jsonSample(cell: JsonCell | null) {
  if (!cell) return "생략";
  if (cell.kind === "null") return "NULL";
  if (cell.kind === "blob") return "\\x" + cell.value;
  return cell.value || "(빈 문자열)";
}

function jsonInput(cell: JsonCell, kind: Kind, postgres: boolean, target?: Column) {
  if (cell.kind === "null") return { kind: "null", value: "" };
  if (postgres) {
    if (cell.kind === "blob" && target?.declared_type !== "bytea") {
      throw new Error(`${target?.name ?? ""} 열 · 바이너리 값은 bytea 열로 매핑하세요.`);
    }
    return { kind: "text", value: cell.kind === "blob" ? "\\x" + cell.value : cell.value };
  }
  const type = kind !== "source" ? kind : cell.kind === "integer" || cell.kind === "boolean" ? "integer"
    : cell.kind === "real" ? "real" : cell.kind === "blob" ? "blob_hex" : "text";
  const value = cell.kind === "boolean" && (type === "integer" || type === "real")
    ? (/^(true|t)$/i.test(cell.value) ? "1" : "0") : cell.value;
  return { kind: type, value: type === "blob_hex" && value.startsWith("\\x") ? value.slice(2) : value };
}

function defaultLabel(column: Column | undefined, postgres: boolean) {
  if (column?.auto_key) return postgres ? "자동 생성" : "자동 기본 키";
  return column?.default_value == null ? "미입력 · NULL" : "DB 기본값";
}

export function GridPasteDialog({ request, onClose, onApplied, onBusy, onExitGuard, unavailable = "", onUnknown }: {
  request: GridPasteRequest; onClose: () => void; onApplied: (report: GridPasteResult) => void;
  onBusy: (busy: boolean) => void; onExitGuard: (guard: GridEditExitGuard | null) => void;
  unavailable?: string; onUnknown?: () => void;
}) {
  const importing = request.source === "file";
  const action = importing ? "가져오기" : "붙여넣기";
  const [session, setSession] = useState<Session | null>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<"auto" | "delimited" | "json">("auto");
  const [encoding, setEncoding] = useState<FileEncoding | "auto">("auto");
  const [delimiter, setDelimiter] = useState<Delimiter | "auto">("auto");
  const [fileFormat, setFileFormat] = useState<{ encoding: FileEncoding; description: string } | null>(null);
  const [header, setHeader] = useState(importing);
  const [preserveBlanks, setPreserveBlanks] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [mapping, setMapping] = useState<Mapping[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [finished, setFinished] = useState(false);
  const [discard, setDiscard] = useState<{ after?: () => void } | null>(null);
  const pending = useRef(false);
  const live = useRef(false);
  const dirty = importing ? file !== null : text.length > 0;
  const production = request.environment === "PROD";
  const postgres = request.engine === "postgres";
  const isJsonFile = format === "json" || (format === "auto" && (file?.name.toLowerCase().endsWith(".json") || file?.type === "application/json"));
  const jsonSource = source && "format" in source ? source : null;
  const tableColumns = session?.columns ?? [];
  const editableColumns = tableColumns.filter(column => column.editable);
  const findColumn = (name: string | null) => tableColumns.find(column => column.name === name);
  const inferred = useMemo(() => importing && source
    ? Array.from({ length: source.columnCount }, (_, index) => "format" in source
      ? jsonColumnType(source, index) : inferSourceColumn(source.rows, index))
    : [], [importing, source]);

  useEffect(() => {
    let active = true;
    live.current = true;
    let token: string | undefined;
    const cancel = (token: string) => {
      const result = request.engine === "postgres" ? invoke("cancel_postgres_row_change", { id: request.id, token })
        : invoke("cancel_row_change", { token });
      void result.catch(() => {});
    };
    const target = request.engine === "postgres" ? { id: request.id, object: request.object }
      : { profileId: request.profileId, table: request.table };
    const change = { kind: importing ? "import_file" : "paste" };
    invoke<Session>(postgres ? "begin_postgres_row_change" : "begin_row_change", { ...target, change })
      .then(result => {
        token = result.token;
        if (active) setSession(result);
        else cancel(token);
      }, reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; live.current = false; if (token) cancel(token); };
  }, [request, postgres, importing]);

  useEffect(() => {
    if (!dirty) return;
    onExitGuard(after => setDiscard({ after }));
    return () => onExitGuard(null);
  }, [dirty, onExitGuard]);

  function requestClose() {
    if (discard) setDiscard(null);
    else if (dirty) setDiscard({});
    else onClose();
  }

  function mapColumns(parsed: Source) {
    const byPosition = editableColumns.filter(column => !column.auto_key);
    setMapping(Array.from({ length: parsed.columnCount }, (_, index) => mappingFor(postgres,
      parsed.headers ? findColumn(parsed.headers[index]) : byPosition[index], "format" in parsed,
    )));
    setSource(parsed);
  }

  async function analyzeFile() {
    if (!file) return;
    if (file.size > fileImportLimits.bytes) { setError("4 MiB 이하의 파일을 선택하세요."); return; }
    pending.current = true;
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer().catch(() => null);
      if (!live.current) return;
      if (!bytes) { setError("파일을 읽지 못했습니다. 파일을 다시 선택하세요."); return; }
      if (isJsonFile) {
        const decoded = decodeImportFile(bytes, encoding);
        if ("error" in decoded) { setError(decoded.error); return; }
        const parsed = await invoke<JsonSource>("inspect_json_import", { source: decoded.text });
        if (live.current) {
          setFileFormat({ encoding: decoded.encoding, description: parsed.format });
          mapColumns(parsed);
        }
        return;
      }
      const parsed = parseDelimitedImport(bytes, file.name, { encoding, delimiter, header, preserveBlanks });
      if ("error" in parsed) { setError(parsed.error); return; }
      setFileFormat({ encoding: parsed.encoding, description: delimiterNames[parsed.delimiter] });
      mapColumns(parsed.source);
    } catch (reason) {
      if (live.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  function updateMapping(index: number, next: Mapping) {
    setMapping(previous => previous.map((item, position) => position === index ? next : item));
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || busy || !session || finished || discard || unavailable) return;
    setError("");
    if (!source) {
      if (importing) await analyzeFile();
      else {
        const parsed = parseClipboardRows(text, header, preserveBlanks);
        if ("error" in parsed) setError(parsed.error);
        else mapColumns(parsed);
      }
      return;
    }
    if (preview && production && confirmation !== "PROD") { setError("운영 환경을 확인하려면 PROD를 입력하세요."); return; }
    const columns = mapping.flatMap(item => item.column === null ? [] : [item.column]);
    if (!columns.length || new Set(columns).size !== columns.length) {
      setError("대상 열을 하나 이상 선택하고 같은 대상 열을 중복 지정하지 마세요.");
      return;
    }
    pending.current = true;
    setBusy(true);
    if (preview) onBusy(true);
    try {
      const token = session.token;
      if (preview) {
        const args = { token, approval: preview.approval, confirmation };
        if (request.engine === "postgres") {
          const outcome = await invoke<PostgresOutcome>("apply_postgres_row_paste", { ...args, id: request.id });
          if (live.current) {
            if (outcome.status === "pasted") onApplied({ ...outcome.result, source: request.source });
            else { setFinished(true); onUnknown?.(); }
          }
        } else {
          const report = await invoke<RowBatchResult>("apply_row_paste", args);
          if (live.current) onApplied({ ...report, source: request.source });
        }
      } else {
        const json = "format" in source;
        const rows = json ? source.rows.map(row => mapping.flatMap(({ column, kind }, index) => {
          const cell = row[index];
          return column === null || cell === null ? [] : [{ column, input: jsonInput(cell, kind, postgres, findColumn(column)) }];
        })) : source.rows.map((row, rowIndex) => mapping.flatMap(({ column, kind, blank }, index) => {
          const value = row[index];
          if (column === null) return [];
          if (value === null) return [{ column, input: { kind: "null", value: "" } }];
          if (source.quotedEmpty?.[rowIndex]?.has(index)) return [{ column, input: { kind: "text", value: "" } }];
          if (value === "" && blank === "default") return [];
          const inputKind = value ? kind : blank === "null" ? "null" : "text";
          return [{ column, input: { kind: inputKind, value } }];
        }));
        const args = { token, columns, rows };
        const result = request.engine === "postgres" ? await invoke<Preview>("preview_postgres_row_paste", { ...args, id: request.id })
          : await invoke<Preview>(json ? "preview_sqlite_json_import" : "preview_row_paste", args);
        if (live.current) setPreview(result);
      }
    } catch (reason) {
      if (live.current) { setError(reason instanceof Error ? reason.message : String(reason)); if (preview) setFinished(true); }
    } finally {
      if (preview) onBusy(false);
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  const omitted = preview ? tableColumns.filter(column => !preview.columns.includes(column.name)) : [];
  const previewLabel = `${action} 미리보기`;

  return <Dialog title={`${postgres ? "PostgreSQL" : "SQLite"} ${importing ? "파일 가져오기" : "행 붙여넣기"}`} className="grid-paste-dialog" onClose={requestClose} busy={busy} interceptEscape>
    <form onSubmit={submit} aria-busy={busy}>
      <p className="confirm-copy"><strong>{request.profileName} · {request.table}</strong>{" "}
        <span className={`environment ${request.environment.toLowerCase()}`}>{request.environment}</span><br />{request.location}</p>
      {unavailable && <p className="form-error" role="alert">{unavailable} 창을 닫고 다시 연결하세요.</p>}
      {discard ? <>
        <p role="alert">{importing ? "적용하지 않은 가져오기가 있습니다." : "적용하지 않은 붙여넣기가 있습니다."}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => setDiscard(null)}>계속 편집</button>
          <button type="button" className="danger" onClick={() => { onExitGuard(null); onClose(); discard.after?.(); }}>변경 버리기</button>
        </div>
      </> : <>
        {!session && busy && <p role="status">테이블 열을 읽는 중…</p>}
        {session && importing && <div hidden={source !== null}>
          <label className="field">가져올 파일<input type="file" accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,text/plain,application/json"
            disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(""); }} /></label>
          <label className="field">파일 형식<select value={format} disabled={busy}
            onChange={event => { setFormat(event.target.value as typeof format); setError(""); }}>
            <option value="auto">자동 · 파일 확장자</option>
            <option value="delimited">구분 텍스트</option>
            <option value="json">JSON</option>
          </select></label>
          <label className="field">파일 인코딩<select value={encoding} disabled={busy}
            onChange={event => { setEncoding(event.target.value as FileEncoding | "auto"); setError(""); }}>
            <option value="auto">자동 · BOM 또는 UTF-8</option>
            {Object.entries(fileEncodings).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          {!isJsonFile && <label className="field">파일 구분자<select value={delimiter} disabled={busy}
            onChange={event => { setDelimiter(event.target.value as Delimiter | "auto"); setError(""); }}>
            <option value="auto">자동</option>
            {Object.entries(delimiterNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>}
          <p className="form-note">CSV, TSV, TXT, JSON · 최대 {fileImportLimits.rows.toLocaleString("ko-KR")}행, {fileImportLimits.columns}열, 4 MiB</p>
        </div>}
        {session && !source && <>
          {!importing && <label className="field">붙여넣을 범위<textarea rows={8} value={text} disabled={busy} spellCheck={false} autoFocus
            onChange={event => { setText(event.target.value); setError(""); }} /></label>}
          {!isJsonFile && <><label className="paste-header"><input type="checkbox" checked={header} disabled={busy}
            onChange={event => { setHeader(event.target.checked); setError(""); }} />첫 행에 열 이름이 있음</label>
          <label className="paste-header"><input type="checkbox" checked={preserveBlanks} disabled={busy}
            onChange={event => { setPreserveBlanks(event.target.checked); setError(""); }} />StackPort의 NULL과 빈 문자열 복원</label></>}
          {!importing && <p className="form-note">복사한 탭 구분 범위를 붙여넣으세요. 최대 {clipboardPasteLimits.rows}행, {clipboardPasteLimits.columns}열입니다.</p>}
        </>}
        {source && file && fileFormat && <p className="form-note">{file.name} · {fileEncodings[fileFormat.encoding]} · {fileFormat.description}</p>}
        {source && !preview && <>
          <p className="form-note">{source.rows.length}개 행 · {source.columnCount}개 원본 열. {jsonSource
            ? "저장할 대상 열을 확인하세요. 속성이 없는 값에는 DB 기본값을 사용합니다."
            : "저장할 대상과 빈 셀 처리 방식을 확인하세요."}</p>
          {jsonSource && !postgres && <p className="form-note">SQLite가 선택한 입력 형식을 바꾸면 가져오기 전체가 롤백됩니다. 정밀도가 필요한 소수는 문자열로 보존하거나 실수 변환을 선택하세요.</p>}
          <div className="grid-paste-mappings">{mapping.map((item, index) => {
            const column = findColumn(item.column);
            return <fieldset key={index} disabled={busy}>
              <legend>원본 열 {index + 1}{source.headers?.[index] && ` · ${source.headers[index]}`}</legend>
              {inferred[index] && <p className="form-note">원본 형식 · {inferred[index]}</p>}
              {"format" in source
                ? <p className="paste-sample">{jsonSample(source.rows[0][index])}</p>
                : source.rows[0][index] !== "" && <p className="paste-sample">{source.rows[0][index] ?? "NULL"}</p>}
              <label className="field">대상 열<select aria-label={`원본 열 ${index + 1} 대상`} value={item.column === null ? "" : `column:${item.column}`}
                onChange={event => updateMapping(index, mappingFor(postgres,
                  findColumn(event.target.value ? event.target.value.slice("column:".length) : null), Boolean(jsonSource)))}>
                <option value="">건너뛰기</option>
                {editableColumns.map(target => <option value={`column:${target.name}`} key={target.name}>{target.name || '""'}{target.required ? " · 필수" : ""}{postgres && ` · ${target.declared_type}`}</option>)}
              </select></label>
              {column && <>
                {!postgres && <label className="field">입력 형식<select aria-label={`원본 열 ${index + 1} 입력 형식`} value={item.kind}
                  onChange={event => updateMapping(index, { ...item, kind: event.target.value as Kind })}>
                  {jsonSource && <option value="source">원본 형식 유지</option>}
                  <option value="text">문자열</option><option value="integer">정수</option><option value="real">{jsonSource ? "실수 (64비트)" : "실수"}</option>
                  {jsonSource && <option value="blob_hex">HEX 바이너리</option>}
                </select></label>}
                {!jsonSource && <label className="field">빈 셀<select aria-label={`원본 열 ${index + 1} 빈 셀`} value={item.blank}
                  onChange={event => updateMapping(index, { ...item, blank: event.target.value as Blank })}>
                  <option value="empty">빈 문자열</option><option value="null">NULL</option><option value="default">DB 기본값</option>
                </select></label>}
              </>}
            </fieldset>;
          })}</div>
        </>}
        {preview && <>
          <p className="form-note">{preview.row_count}개 행을 새로 추가합니다. 한 행이라도 저장에 실패하면 전체를 롤백합니다.</p>
          {preview.rows.length < preview.row_count && <p className="form-note">미리보기에 처음 {preview.rows.length}행을 표시합니다.</p>}
          <div className="table-wrap grid-paste-preview" tabIndex={0} role="region" aria-label={`${previewLabel} 스크롤`}>
            <table aria-label={previewLabel}><thead><tr><th scope="col">#</th>
              {preview.columns.map(name => <th scope="col" key={name}>{name}</th>)}
            </tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}><th scope="row">{index + 1}</th>
              {row.map((cell, column) => <td key={column} title={cell === null ? findColumn(preview.columns[column])?.default_value ?? undefined : undefined}>
                {cell === null ? defaultLabel(findColumn(preview.columns[column]), postgres) : cell.kind === "null" ? "NULL" : cell.display || "(빈 문자열)"}
              </td>)}
            </tr>)}</tbody></table>
          </div>
          {omitted.length > 0 && <details className="form-note"><summary>DB에서 채울 열 {omitted.length}개</summary><ul>
            {omitted.map(column => <li key={column.name}>{column.name} · {column.default_value ?? defaultLabel(column, postgres)}</li>)}
          </ul></details>}
          {production && !finished && <label className="field">운영 환경 확인 · PROD 입력<input value={confirmation}
            aria-required="true" autoComplete="off" disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
        </>}
        {error && <p className="form-error" role="alert">{error}{finished && " 창을 닫은 뒤 대상 테이블을 다시 조회하세요."}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={requestClose} disabled={busy}>닫기</button>
          {source && !finished && <button type="button" className="secondary" disabled={busy} onClick={() => {
            if (preview) setPreview(null); else setSource(null);
            setConfirmation(""); setError("");
          }}>{preview ? "열 매핑 수정" : importing ? "파일 설정 수정" : "범위 수정"}</button>}
          {session && !finished && <button type="submit" className="primary" disabled={busy || !dirty || Boolean(unavailable)}>
            {busy ? "처리 중…" : preview ? `${action} 적용` : source ? previewLabel : "열 매핑"}
          </button>}
        </div>
      </>}
    </form>
  </Dialog>;
}
