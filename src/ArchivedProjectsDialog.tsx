import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCcw, X } from "lucide-react";

type ArchivedProject = { id: string; name: string; archived_at: string };

export function ArchivedProjectsDialog({ onClose, onRestored }: {
  onClose: () => void;
  onRestored: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [projects, setProjects] = useState<ArchivedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    invoke<ArchivedProject[]>("list_archived_projects")
      .then(items => { if (live) setProjects(items); })
      .catch(error => { if (live) setError(String(error)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  async function restore(id: string) {
    if (restoring) return;
    setRestoring(id); setError("");
    try {
      await invoke("unarchive_project", { id });
      onRestored(id);
    } catch (error) {
      setError(String(error));
    } finally {
      setRestoring("");
    }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby="archived-projects-title" onClose={onClose} onCancel={event => { if (restoring) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="archived-projects-title">보관된 프로젝트</h2>
      <button className="icon-button" aria-label="닫기" disabled={!!restoring} onClick={onClose}><X size={18} /></button>
    </div>
    <div className="archive-dialog-body" aria-busy={loading || !!restoring}>
      {loading && <p className="form-note" role="status">불러오는 중…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !error && !projects.length && <p className="form-note">보관된 프로젝트가 없습니다.</p>}
      <ul className="archived-projects-list">
        {projects.map(project => <li key={project.id}>
          <div><strong>{project.name}</strong><time dateTime={project.archived_at}>{new Date(project.archived_at).toLocaleString("ko-KR")}</time></div>
          <button className="secondary small" disabled={!!restoring} aria-label={`${project.name} 다시 활성화`} onClick={() => void restore(project.id)}>
            <RotateCcw size={14} /> {restoring === project.id ? "활성화 중…" : "다시 활성화"}
          </button>
        </li>)}
      </ul>
    </div>
  </dialog>;
}
