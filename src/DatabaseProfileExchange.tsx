import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

export type DatabaseExchangeMode = "import" | "export";
type Engine = "sqlite" | "postgres" | "mysql" | "redis" | "mongodb" | "sql_server" | "oracle" | "snowflake";
type Source = { engine: Engine; id: string; revision: number | null };
type Summary = { name: string; target: string; environment: string };
type Candidate = Summary & { source: Source };
type ImportProfile = Summary & { engine: Engine; requires_ca: boolean; requires_client_identity: boolean };
type Preview = { digest: string; profiles: ImportProfile[] };
type ExportReport = { path: string; count: number; audit_warning: string | null };
type Report = { message: string; path?: string; warning?: string | null };
type LocalFile = "sqlite_path" | "ca_path" | "client_certificate_path" | "client_key_path";
type Selection = { name: string } & Partial<Record<LocalFile, string>>;

const engineName: Record<Engine, string> = {
  sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL · MariaDB", redis: "Redis", mongodb: "MongoDB",
  sql_server: "SQL Server", oracle: "Oracle Database", snowflake: "Snowflake",
};
const localFileLabel: Record<LocalFile, string> = {
  sqlite_path: "SQLite 파일 경로",
  ca_path: "CA 인증서 경로",
  client_certificate_path: "클라이언트 인증서 경로",
  client_key_path: "클라이언트 개인 키 경로",
};

export function DatabaseProfileExchange({ mode, projectId, onClose, onImported }: {
  mode: DatabaseExchangeMode; projectId: string; onClose: () => void; onImported: () => Promise<void>;
}) {
  const importing = mode === "import";
  const [path, setPath] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Record<number, Selection>>({});
  const [loading, setLoading] = useState(!importing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const pending = useRef(false);
  const selections = Object.keys(selected).map(Number);

  useEffect(() => {
    if (importing) return;
    let live = true;
    void invoke<Candidate[]>("list_database_exchange_candidates", { projectId })
      .then(items => { if (live) setCandidates(items); })
      .catch(cause => { if (live) setError(String(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [importing, projectId]);

  function updatePath(value: string) {
    setPath(value);
    if (importing) {
      setPreview(null);
      setSelected({});
    }
    setError("");
  }

  function toggle(index: number, name: string, checked: boolean) {
    setSelected(current => {
      const next = { ...current };
      if (checked) next[index] = { name };
      else delete next[index];
      return next;
    });
  }

  function changeSelection(index: number, field: keyof Selection, value: string) {
    setSelected(current => current[index] ? { ...current, [index]: { ...current[index], [field]: value } } : current);
  }

  async function choosePath(index?: number, field?: LocalFile) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      let chosen: string | null;
      if (field === "sqlite_path") chosen = await invoke("choose_sqlite_file");
      else if (field === "ca_path") chosen = await invoke("choose_postgres_ca");
      else if (field) chosen = await invoke("choose_mysql_client_tls_file", { key: field === "client_key_path" });
      else chosen = await invoke("choose_database_profile_path", { import: importing });
      if (!chosen) return;
      if (index !== undefined && field) changeSelection(index, field, chosen);
      else updatePath(chosen);
    } catch (cause) {
      setError(String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || loading || report) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (importing && !preview) {
        setPreview(await invoke<Preview>("preview_database_profile_import", { path }));
      } else if (preview) {
        const count = await invoke<number>("import_database_profiles", {
          projectId, path, digest: preview.digest, selected: selections.map(index => ({ index, ...selected[index] })),
        });
        await onImported();
        setReport({ message: `데이터베이스 연결 ${count}개를 가져왔습니다.` });
      } else {
        const result = await invoke<ExportReport>("export_database_profiles", {
          projectId, destination: path, selected: selections.map(index => candidates[index].source),
        });
        setReport({ message: `데이터베이스 연결 ${result.count}개를 내보냈습니다.`, path: result.path, warning: result.audit_warning });
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const title = importing ? "데이터베이스 연결 가져오기" : "데이터베이스 연결 내보내기";
  const reviewing = !importing || preview !== null;
  const buttonLabel = !importing ? "선택한 연결 내보내기" : preview ? "선택한 연결 가져오기" : "파일 확인";
  return <Dialog title={title} busy={busy} onClose={onClose} className="ssh-exchange-dialog database-exchange-dialog">
    {report ? <>
      <div className="exchange-result" role="status">
        <strong>{report.message}</strong>
        {report.path && <span>{report.path}</span>}
        {report.warning && <span className="audit-warning">{report.warning}</span>}
      </div>
      <div className="dialog-actions"><button type="button" className="primary" onClick={onClose}>완료</button></div>
    </> : <form onSubmit={event => void submit(event)} aria-busy={busy || loading}>
      <p className="form-note">{importing
        ? "연결과 대상 서버를 확인한 뒤 가져올 항목을 선택하세요. 필요한 로컬 파일은 여기서 지정합니다."
        : "JSON에는 선택한 연결의 설정과 SQLite 파일 이름을 담습니다. 암호, 토큰, 인증서와 개인 키 경로는 제외합니다."}</p>
      <PathField label={importing ? "가져올 JSON 파일 경로" : "새 JSON 파일 경로"} value={path}
        autoFocus disabled={busy} onChange={updatePath} onChoose={() => void choosePath()} />
      {loading && <p className="form-note" role="status">연결을 불러오는 중…</p>}
      {reviewing && !loading && <fieldset className="exchange-list" disabled={busy}>
        <legend>{importing ? "가져올 연결 선택" : "내보낼 연결 선택"}</legend>
        {preview ? preview.profiles.map((item, index) => {
          const selection = selected[index];
          const files: LocalFile[] = [];
          if (item.engine === "sqlite") files.push("sqlite_path");
          if (item.requires_ca) files.push("ca_path");
          if (item.requires_client_identity) files.push("client_certificate_path", "client_key_path");
          return <div key={index} className="database-exchange-entry">
            <ProfileChoice item={item} engine={item.engine} checked={selection !== undefined}
              onSelect={checked => toggle(index, item.name, checked)} />
            {selection && <fieldset className="database-exchange-fields">
              <legend>{item.name} 가져오기 설정</legend>
              <label className="field">연결 이름<input required maxLength={80} value={selection.name}
                onChange={event => changeSelection(index, "name", event.target.value)} /></label>
              {files.map(field => <PathField key={field} label={localFileLabel[field]} value={selection[field] ?? ""}
                onChange={value => changeSelection(index, field, value)}
                onChoose={() => void choosePath(index, field)} />)}
            </fieldset>}
          </div>;
        }) : candidates.length ? candidates.map((item, index) =>
          <ProfileChoice key={item.source.id} item={item} engine={item.source.engine} checked={selected[index] !== undefined}
            onSelect={checked => toggle(index, item.name, checked)} />)
          : <p className="form-note">저장된 데이터베이스 연결이 없습니다.</p>}
      </fieldset>}
      {selections.length > 200 && <p className="form-error" role="alert">한 번에 최대 200개를 선택할 수 있습니다.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button>
        <button type="submit" className="primary" disabled={busy || loading || (reviewing && !selections.length) || selections.length > 200}>
          {busy ? "처리 중…" : buttonLabel}
        </button>
      </div>
    </form>}
  </Dialog>;
}

function PathField({ label, value, autoFocus, disabled, onChange, onChoose }: {
  label: string; value: string; autoFocus?: boolean; disabled?: boolean;
  onChange: (value: string) => void; onChoose: () => void;
}) {
  const labelId = useId();
  return <label className="field">
    <span id={labelId}>{label}</span><span className="file-input">
      <input aria-labelledby={labelId} autoFocus={autoFocus} required disabled={disabled} maxLength={32768}
        value={value} onChange={event => onChange(event.target.value)} />
      <button type="button" className="secondary" aria-label={label + " 찾아보기"} disabled={disabled} onClick={onChoose}>찾아보기</button>
    </span>
  </label>;
}

function ProfileChoice({ item, engine, checked, onSelect }: {
  item: Summary; engine: Engine; checked: boolean; onSelect: (checked: boolean) => void;
}) {
  return <label className="exchange-item">
    <input type="checkbox" checked={checked} onChange={event => onSelect(event.target.checked)} />
    <span><strong>{item.name}</strong><span>{engineName[engine]} · {item.target} · {item.environment}</span></span>
  </label>;
}
