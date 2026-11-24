import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const executableKey = "stackport.sftp.externalEditor";

function rememberedExecutable() {
  try {
    return localStorage.getItem(executableKey) ?? "";
  } catch {
    return "";
  }
}

export function SftpExternalEditor({ id, token, text, locked, oversized, onLockChange, onImport }: {
  id: string;
  token: string;
  text: string;
  locked: boolean;
  oversized: boolean;
  onLockChange: (locked: boolean) => void;
  onImport: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [executable, setExecutable] = useState(rememberedExecutable);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const [changed, setChanged] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState("");
  const [watchError, setWatchError] = useState("");

  useEffect(() => {
    if (!active || busy) return;
    let stopped = false;
    let timer: number;
    async function poll() {
      try {
        const result = await invoke<boolean>("sftp_external_editor_changed", { id, token });
        if (stopped) return;
        setChanged(result);
        setWatchError("");
      } catch (error) {
        if (stopped) return;
        setWatchError(String(error));
      }
      timer = window.setTimeout(poll, 700);
    }
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, busy, id, token]);

  async function chooseExecutable() {
    setBusy(true);
    onLockChange(true);
    setError("");
    try {
      const path = await invoke<string | null>("choose_sftp_external_editor");
      if (path) setExecutable(path);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
      onLockChange(false);
    }
  }

  async function start() {
    const path = executable.trim();
    if (!path || oversized || busy || locked) return;
    setBusy(true);
    onLockChange(true);
    setError("");
    setWatchError("");
    setChanged(false);
    try {
      await invoke("start_sftp_external_editor", { id, token, executable: path, text });
      setActive(true);
    } catch (error) {
      setError(String(error));
      onLockChange(false);
      return;
    } finally {
      setBusy(false);
    }
    try {
      localStorage.setItem(executableKey, path);
    } catch {
      // Remembering the executable is optional once the editor is running.
    }
  }

  async function finish(discard: boolean) {
    setBusy(true);
    setError("");
    try {
      const draft = await invoke<string | null>("finish_sftp_external_editor", { id, token, discard });
      if (draft !== null) onImport(draft);
      setActive(false);
      setDiscarding(false);
      setExpanded(false);
      onLockChange(false);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return <div className="sftp-external-editor">
    {!active && <div>
      <button type="button" className="secondary" aria-expanded={expanded} aria-controls="sftp-external-editor-path"
        disabled={locked || busy} onClick={() => setExpanded(!expanded)}>외부 편집기</button>
    </div>}
    <div className="field" id="sftp-external-editor-path" hidden={!expanded || active}>
      <label htmlFor="sftp-external-editor-exe">편집기 실행 파일</label>
      <div className="file-input">
        <input id="sftp-external-editor-exe" value={executable} disabled={locked || busy}
          placeholder="편집기 .exe의 전체 경로" onChange={event => { setExecutable(event.target.value); setError(""); }}
          onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />
        <button type="button" className="secondary" disabled={locked || busy} onClick={() => void chooseExecutable()}>파일 선택</button>
      </div>
      <div><button type="button" className="secondary" disabled={!executable.trim() || oversized || locked || busy}
        onClick={() => void start()}>외부 편집기에서 열기</button></div>
    </div>
    {active && <>
      <p className="form-note" role="status">{watchError ? "외부 편집 파일을 다시 확인하는 중입니다."
        : changed ? "외부 편집기에서 저장한 변경을 감지했습니다."
        : "외부 편집기에서 임시 파일을 열었습니다."}</p>
      <p className="form-note">외부 편집기에서 파일을 저장하고 닫은 뒤 변경을 가져오세요. 원격 반영은 저장 버튼으로 진행합니다.</p>
      {watchError && <p className="form-error" role="alert">{watchError}</p>}
      {discarding && <p className="form-note">임시 파일을 삭제하면 외부 편집기에서 저장한 변경이 사라집니다.</p>}
      <div className="sftp-external-editor-actions">
        {discarding ? <>
          <button type="button" className="secondary" disabled={busy} onClick={() => setDiscarding(false)}>계속 감시</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void finish(true)}>임시 파일 삭제</button>
        </> : <>
          <button type="button" className="secondary" disabled={busy || !changed || !!watchError}
            onClick={() => void finish(false)}>변경 가져오기</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setDiscarding(true)}>외부 편집 취소</button>
        </>}
      </div>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
