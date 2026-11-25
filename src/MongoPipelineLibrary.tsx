import { useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";
import type { MongoPipelineSummary, MongoStage, SavedMongoPipeline } from "./mongoPipelineFormat";
import { useNativeRead } from "./usePostgresRead";

export function MongoPipelineLibrary({ mode, projectId, current, stages, onSave, onOpen, onDelete, onClose }: {
  mode: "save" | "open";
  projectId: string;
  current: MongoPipelineSummary | null;
  stages: MongoStage[];
  onSave: (saved: SavedMongoPipeline) => void;
  onOpen: (saved: SavedMongoPipeline) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(current?.name ?? "");
  const [copy, setCopy] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [deleting, setDeleting] = useState<MongoPipelineSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const args = useMemo(() => mode === "open" ? { projectId } : null, [mode, projectId]);
  const catalog = useNativeRead<MongoPipelineSummary[]>("list_mongo_pipelines", args, revision);
  const selected = catalog.data?.find(item => item.id === selectedId) ?? catalog.data?.[0];

  async function act(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    void act(async () => {
      const replaces = current && !copy ? { id: current.id, revision: current.revision } : null;
      const saved = await invoke<SavedMongoPipeline>("save_mongo_pipeline", { projectId, write: { name, stages, replaces } });
      onSave(saved);
      onClose();
    });
  }

  return <Dialog title={mode === "save" ? "파이프라인 저장" : "저장된 파이프라인"} busy={busy} onClose={onClose}>
    {mode === "save" ? <form onSubmit={save} aria-busy={busy}>
      <label className="field">파이프라인 이름<input value={name} autoFocus maxLength={100} required disabled={busy}
        onChange={event => setName(event.target.value)} /></label>
      {current && <label><input type="checkbox" disabled={busy} checked={copy} onChange={event => setCopy(event.target.checked)} /> 새 항목으로 저장</label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="submit" className="primary" disabled={busy || !name.trim()}>프로젝트에 저장</button></div>
    </form> : <div className="mongo-pipeline-dialog" aria-busy={busy || catalog.loading}>
      {catalog.loading && <p className="form-note" role="status">저장된 파이프라인을 불러오는 중…</p>}
      {(error || catalog.error) && <p className="form-error" role="alert">{error || catalog.error}</p>}
      {catalog.data?.length === 0 && <p className="form-note">이 프로젝트에 저장된 파이프라인이 없습니다.</p>}
      {selected && (deleting ? <>
        <p className="confirm-copy"><strong>{deleting.name}</strong> 파이프라인을 프로젝트에서 삭제합니다.</p>
        <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { setDeleting(null); setError(""); }}>취소</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void act(async () => {
            await invoke("delete_mongo_pipeline", { projectId, id: deleting.id, revision: deleting.revision });
            onDelete(deleting.id); setDeleting(null); setSelectedId(""); setRevision(value => value + 1);
          })}>삭제 확인</button></div>
      </> : <>
        <label className="field">저장 항목<select aria-label="저장 항목" value={selected.id} disabled={busy} onChange={event => setSelectedId(event.target.value)}>
          {catalog.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {stages.length > 0 && <p className="form-note">불러오면 현재 편집 중인 단계가 선택한 항목으로 바뀝니다.</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => { setDeleting(selected); setError(""); }}>저장 항목 삭제</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void act(async () => {
            const saved = await invoke<SavedMongoPipeline>("read_mongo_pipeline", { projectId, id: selected.id });
            onOpen(saved);
            onClose();
          })}>편집기에 불러오기</button>
        </div>
      </>)}
    </div>}
  </Dialog>;
}
