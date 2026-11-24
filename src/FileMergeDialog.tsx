import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { mergedText, prepareTextMerge, type MergeSide } from "./fileDifference";

const numbers = new Intl.NumberFormat("ko-KR");
const utf8 = new TextEncoder();

function ChangeSource({ label, firstLine, lines }: { label: string; firstLine: number | null; lines: string[] }) {
  const endings = Array.from(new Set(lines.map(line => line.endsWith("\r\n") ? "CRLF" :
    line.endsWith("\n") ? "LF" : line.endsWith("\r") ? "CR" : "줄바꿈 없음")));
  return <div className="file-merge-source">
    <h3>{label}{firstLine !== null && ` · ${numbers.format(firstLine)}행부터 ${numbers.format(lines.length)}줄`}</h3>
    {endings.length > 0 && <p className="form-note">{endings.join(" · ")}</p>}
    {lines.length > 0
      ? <pre className="files-preview-content" aria-label={`${label} 변경 내용`} tabIndex={0}>{lines.join("")}</pre>
      : <p className="form-note">이쪽에는 줄이 없습니다.</p>}
  </div>;
}

export function FileMergeDialog({ name, local, remote, onClose }: { name: string; local: string; remote: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const plan = useMemo(() => prepareTextMerge(local, remote), [local, remote]);
  const [index, setIndex] = useState(0);
  const [choices, setChoices] = useState(new Map<number, MergeSide>());
  const [bom, setBom] = useState(plan.initialBom);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ path: string; bytes: number } | null>(null);
  const change = plan.changes[index];
  const choice = choices.get(index) ?? "local";
  const output = useMemo(() => mergedText(plan.parts, choices, bom), [plan.parts, choices, bom]);
  const bytes = useMemo(() => utf8.encode(output).length, [output]);

  useEffect(() => { dialog.current?.showModal(); }, []);

  function choose(side: MergeSide) {
    setChoices(current => new Map(current).set(index, side));
    setSaved(null);
  }

  async function choosePath() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const dot = name.lastIndexOf(".");
      const suggested = dot > 0 ? `${name.slice(0, dot)}.merged${name.slice(dot)}` : `${name}.merged`;
      const value = await invoke<string | null>("choose_merged_file_path", { name: suggested });
      if (value) {
        setPath(value);
        setSaved(null);
      }
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const destination = path.trim();
    if (pending.current || !destination || saved) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const bytes = await invoke<number>("save_merged_file", { destination, text: output });
      setSaved({ path: destination, bytes });
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="dialog files-compare file-merge" aria-labelledby="file-merge-title"
    onClose={onClose} onCancel={event => { if (pending.current) event.preventDefault(); }}>
    <div className="dialog-heading">
      <h2 id="file-merge-title">텍스트 병합</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="files-compare-body">
      <p className="file-difference-name"><strong>{name}</strong></p>
      {plan.alignmentLimited && <p className="form-note">줄 정렬 한도를 넘은 부분은 한 변경 구간으로 표시합니다.</p>}
      {change ? <>
        <div className="file-merge-navigation">
          <button type="button" className="secondary small" disabled={busy || index === 0} onClick={() => setIndex(index - 1)}>이전 구간</button>
          <span role="status">{numbers.format(index + 1)} / {numbers.format(plan.changes.length)}개 변경 구간</span>
          <button type="button" className="secondary small" disabled={busy || index + 1 === plan.changes.length} onClick={() => setIndex(index + 1)}>다음 구간</button>
        </div>
        <fieldset className="file-merge-choices" disabled={busy}>
          <legend>이 구간에 남길 내용</legend>
          <label><input type="radio" name="merge-side" checked={choice === "local"} onChange={() => choose("local")} /> 로컬 사용</label>
          <label><input type="radio" name="merge-side" checked={choice === "remote"} onChange={() => choose("remote")} /> 원격 사용</label>
        </fieldset>
        <div className="file-merge-sources" key={change.index}>
          <ChangeSource label="로컬" firstLine={change.firstLocal} lines={change.local} />
          <ChangeSource label="원격" firstLine={change.firstRemote} lines={change.remote} />
        </div>
      </> : <p className="form-note">텍스트는 같으며 UTF-8 BOM만 다릅니다.</p>}
      <label className="file-merge-bom">
        <input type="checkbox" checked={bom} disabled={busy} onChange={event => { setBom(event.target.checked); setSaved(null); }} />
        UTF-8 BOM 포함
      </label>
      <details className="file-merge-preview">
        <summary>병합 결과 미리보기 · {numbers.format(bytes)} B</summary>
        {output ? <pre className="files-preview-content" aria-label="병합 결과" tabIndex={0}>{output}</pre>
          : <p className="form-note">빈 파일입니다.</p>}
      </details>
      <form onSubmit={event => void save(event)}>
        <label className="field">새 파일의 절대 경로
          <input value={path} disabled={busy} onChange={event => { setPath(event.target.value); setSaved(null); }} />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        {saved && <p role="status" className="form-note file-merge-saved">저장했습니다 · {numbers.format(saved.bytes)} B<br />{saved.path}</p>}
        <div className="file-merge-actions">
          <button type="button" className="secondary small" disabled={busy} onClick={() => void choosePath()}>경로 선택</button>
          <button type="submit" className="primary small" disabled={!path.trim() || busy || saved !== null}>새 파일로 저장</button>
        </div>
      </form>
    </div>
  </dialog>;
}
