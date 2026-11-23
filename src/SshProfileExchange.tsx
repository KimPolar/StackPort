import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { SshProfile } from "./ssh-profile-types";

type ProfileDefinition = Pick<SshProfile, "name" | "host" | "port" | "username" | "environment">;
type Preview = { digest: string; profiles: ProfileDefinition[] };
type ExportReport = { path: string; count: number; audit_warning: string | null };
type ResultReport = { message: string; path?: string; warning?: string | null };

const call = <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);
const errorText = (error: unknown) => typeof error === "string" ? error : String(error);

export function SshProfileExchange({ mode, projectId, profiles, onClose, onImported }: {
  mode: "import" | "export";
  projectId: string;
  profiles: SshProfile[];
  onClose: () => void;
  onImported: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ResultReport | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  function updatePath(value: string) {
    setPath(value);
    if (mode === "import") { setPreview(null); setSelected([]); }
    setError("");
  }

  async function choosePath() {
    setBusy(true); setError("");
    try {
      const chosen = await call<string | null>(mode === "import" ? "choose_ssh_profile_import_file" : "choose_ssh_profile_export_directory");
      if (chosen) updatePath(mode === "import" ? chosen : `${chosen}${chosen.endsWith("\\") || chosen.endsWith("/") ? "" : chosen.includes("\\") ? "\\" : "/"}stackport-ssh-profiles.json`);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || report) return;
    setBusy(true); setError("");
    try {
      if (mode === "import" && !preview) {
        setPreview(await call<Preview>("preview_ssh_profile_import", { path }));
        setSelected([]);
      } else if (mode === "import" && preview) {
        const imported = await call<SshProfile[]>("import_ssh_profiles", { projectId, path, digest: preview.digest, selected });
        setReport({ message: `SSH 연결 ${imported.length}개를 가져왔습니다.` });
        onImported();
      } else {
        const expected = selected.map(index => profiles[index]);
        const result = await call<ExportReport>("export_ssh_profiles", { projectId, expected, destination: path });
        setReport({ message: `SSH 연결 ${result.count}개를 내보냈습니다.`, path: result.path, warning: result.audit_warning });
      }
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  const definitions: ProfileDefinition[] = mode === "export" ? profiles : preview?.profiles ?? [];
  const title = mode === "import" ? "SSH 연결 가져오기" : "SSH 연결 내보내기";
  return <dialog ref={dialog} className="dialog ssh-exchange-dialog" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    {report ? <><div className="exchange-result" role="status"><strong>{report.message}</strong>{report.path && <span>{report.path}</span>}{report.warning && <span className="audit-warning">{report.warning}</span>}</div><div className="dialog-actions"><button className="primary" onClick={onClose}>완료</button></div></> : <form onSubmit={submit} aria-busy={busy}>
      <p className="form-note">파일에는 호스트와 사용자 이름이 포함됩니다. 암호·개인 키·호스트 키 신뢰 기록은 포함하지 않습니다.</p>
      <label className="field">{mode === "import" ? "가져올 JSON 파일 경로" : "새 JSON 파일 경로"}<span className="file-input"><input autoFocus required disabled={busy} value={path} onChange={event => updatePath(event.target.value)} placeholder="절대 경로를 입력하세요" /><button type="button" className="secondary" disabled={busy} onClick={() => void choosePath()}>찾아보기</button></span></label>
      {mode === "import" && preview && <p className="form-note">미리 확인한 파일만 가져옵니다. 같은 이름이 있어도 새 연결로 추가하며 기존 연결은 변경하지 않습니다.</p>}
      {(mode === "export" || preview) && <fieldset className="exchange-list" disabled={busy}><legend>{mode === "export" ? "내보낼 연결 선택" : "가져올 연결 선택"}</legend>{definitions.length ? definitions.map((item, index) => <label className="exchange-item" key={mode === "export" ? profiles[index].id : index}><input type="checkbox" checked={selected.includes(index)} onChange={event => { const checked = event.target.checked; setSelected(current => checked ? [...current, index] : current.filter(value => value !== index)); }} /><span><strong>{item.name}</strong><span>{item.username}@{item.host.includes(":") ? `[${item.host}]` : item.host}:{item.port} · {item.environment}</span></span></label>) : <p className="form-note">선택할 SSH 연결이 없습니다.</p>}</fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button><button type="submit" className="primary" disabled={busy || ((mode === "export" || Boolean(preview)) && !selected.length)}>{busy ? "처리 중…" : mode === "import" && !preview ? "파일 확인" : mode === "import" ? "선택한 연결 가져오기" : "선택한 연결 내보내기"}</button></div>
    </form>}
  </dialog>;
}
