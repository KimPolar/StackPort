import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { formatStructuredPreview, structuredFormat } from "./structuredFilePreview";
import { StructuredPreviewView } from "./StructuredPreviewView";

export type FilePreview = { total_bytes: string; shown_bytes: number } & (
  | { kind: "text" | "hex"; value: string }
  | { kind: "png"; base64: string }
);
export type PreviewSelection = {
  name: string;
  source: string;
  result: Promise<{ preview: FilePreview } | { error: string }>;
};
const numbers = new Intl.NumberFormat("ko-KR");
const viewLabels = { json: "JSON 들여쓰기", xml: "XML 구조", csv: "CSV 표" };

export function FilePreviewDialog({ selection, onClose }: { selection: PreviewSelection; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<Awaited<PreviewSelection["result"]> | null>(null);
  const [imageError, setImageError] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let mounted = true;
    void selection.result.then(value => { if (mounted) setResult(value); });
    return () => { mounted = false; };
  }, [selection.result]);

  const preview = result && "preview" in result ? result.preview : null;
  const error = result && "error" in result ? result.error : null;
  const format = preview?.kind === "png" ? "PNG" : preview?.kind === "hex" ? "HEX" : "UTF-8 원문";
  const structure = structuredFormat(selection.name);
  const truncated = preview !== null && BigInt(preview.shown_bytes) < BigInt(preview.total_bytes);
  const formatted = useMemo(() => structure && preview?.kind === "text" && preview.value
    && !truncated ? formatStructuredPreview(structure, preview.value) : null, [structure, preview, truncated]);
  const formattedView = formatted && "kind" in formatted ? formatted : null;
  const activeFormat = formattedView && !showSource ? viewLabels[formattedView.kind] : format;

  return <dialog className="dialog files-preview" ref={dialog} aria-labelledby="file-preview-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="file-preview-title">파일 미리보기</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} /></button>
    </div>
    <div className="files-preview-body">
      <p className="confirm-copy files-preview-name"><strong>{selection.name}</strong><br />{selection.source}</p>
      {!result && <p role="status" className="form-note">파일을 읽는 중…</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {preview && <>
        <p className="form-note files-preview-format">
          {activeFormat} · {numbers.format(BigInt(preview.total_bytes))} B
          {truncated && <> · 처음 {numbers.format(preview.shown_bytes)} B 표시</>}
        </p>
        {formattedView && <div className="files-preview-modes" role="group" aria-label="미리보기 방식">
          <button type="button" className="secondary small" aria-pressed={!showSource} onClick={() => setShowSource(false)}>{viewLabels[formattedView.kind]}</button>
          <button type="button" className="secondary small" aria-pressed={showSource} onClick={() => setShowSource(true)}>원문</button>
        </div>}
        {formatted && "error" in formatted && <p className="form-note" role="status">{formatted.error}</p>}
        {structure && preview.kind === "text" && truncated && <p className="form-note" role="status">파일의 일부를 읽어 원문으로 표시합니다.</p>}
        {preview.kind === "png" ? (
          imageError ? <p role="alert" className="form-error">PNG 이미지를 표시할 수 없습니다.</p>
            : <img className="files-preview-image" src={`data:image/png;base64,${preview.base64}`} alt={selection.name} onError={() => setImageError(true)} />
        ) : formattedView && !showSource ? <StructuredPreviewView preview={formattedView} /> : preview.value ? (
          <pre className="files-preview-content" aria-label={format} tabIndex={0}>{preview.value}</pre>
        ) : <p className="form-note">빈 파일입니다.</p>}
      </>}
    </div>
  </dialog>;
}
