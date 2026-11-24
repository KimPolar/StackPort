import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { displayFilePath } from "./fileBrowse";
import { syncDirectionLabels, type SyncDirection } from "./folderSyncPlan";

export type SyncProfileOptions = { direction: SyncDirection; recursive: boolean; mirror_deletes: boolean; pattern_text: string };
export type SavedSyncProfile = {
  id: string;
  name: string;
  local_root: string;
  remote_root: string;
  remote_path: string;
  options: SyncProfileOptions;
  available: boolean;
};

export function FolderSyncProfilesDialog({ id, target, onOpen, onClose }: {
  id: string;
  target: string;
  onOpen: (profile: SavedSyncProfile) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [profiles, setProfiles] = useState<SavedSyncProfile[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    void invoke<SavedSyncProfile[]>("list_sftp_sync_profiles", { id }).then(items => {
      if (live) setProfiles(items);
    }, error => {
      if (live) setError(String(error));
    });
    return () => { live = false; };
  }, [id]);

  async function removeProfile(profileId: string) {
    setBusy(true);
    setError("");
    try {
      await invoke("remove_sftp_sync_profile", { id, profileId });
      setProfiles(current => current?.filter(profile => profile.id !== profileId) ?? null);
      setRemoving(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="dialog files-compare" aria-labelledby="sync-profiles-title" onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="sync-profiles-title">동기화 프로필</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="files-compare-body" aria-busy={busy || (!profiles && !error)}>
      <p className="form-note">{target}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!profiles && !error && <p className="form-note" role="status">프로필을 불러오는 중…</p>}
      {profiles?.length === 0 && <p className="form-note">동기화 계획에서 프로필을 저장할 수 있습니다.</p>}
      {!!profiles?.length && <ul className="sync-profile-list">
        {profiles.map(profile => <li key={profile.id}>
          <div className="sync-profile-title"><strong>{profile.name}</strong><span>{syncDirectionLabels[profile.options.direction]} · {profile.options.recursive ? "하위 폴더 포함" : "현재 폴더"}</span></div>
          <dl className="files-compare-paths">
            <div><dt>로컬 폴더</dt><dd>{displayFilePath(profile.local_root)}</dd></div>
            <div><dt>원격 폴더</dt><dd>{profile.remote_path}</dd></div>
          </dl>
          {!profile.available && <p className="form-note">SSH 연결 설정이 바뀌었습니다. 이 연결에서 새 프로필을 저장하세요.</p>}
          <div className="folder-sync-run">
            {removing === profile.id ? <>
              <button type="button" className="secondary small" disabled={busy} onClick={() => setRemoving(null)}>취소</button>
              <button type="button" className="danger small" disabled={busy} onClick={() => void removeProfile(profile.id)}>프로필 삭제 확인</button>
            </> : <>
              <button type="button" className="secondary small" disabled={busy || removing !== null} onClick={() => setRemoving(profile.id)}>프로필 삭제</button>
              <button type="button" className="primary small" disabled={!profile.available || busy || removing !== null}
                onClick={() => onOpen(profile)}>계획 새로 만들기</button>
            </>}
          </div>
        </li>)}
      </ul>}
    </div>
  </dialog>;
}
