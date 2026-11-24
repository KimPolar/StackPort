import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { compareTextLines, type FileDifference, type HexRow } from "./fileDifference";
import { FileMergeDialog } from "./FileMergeDialog";

const numbers = new Intl.NumberFormat("ko-KR");

function TextDifference({ local, remote }: { local: string; remote: string }) {
  const [showWhitespace, setShowWhitespace] = useState(false);
  const { shown, removed, inserted, truncated, alignmentLimited } = useMemo(
    () => compareTextLines(local, remote), [local, remote],
  );

  return <>
    <div className="files-compare-tools">
      <span>UTF-8 · {numbers.format(removed)}줄 삭제 · {numbers.format(inserted)}줄 추가</span>
      <label><input type="checkbox" checked={showWhitespace} onChange={event => setShowWhitespace(event.target.checked)} /> 공백 표시</label>
    </div>
    {alignmentLimited && <p className="form-note">변경 범위가 커서 가운데 부분을 줄 정렬 없이 표시합니다.</p>}
    {truncated && <p className="form-note">차이와 주변 문맥 중 처음 240줄을 표시합니다.</p>}
    <div className="file-difference-scroll" role="region" aria-label="텍스트 차이 스크롤 영역" tabIndex={0}>
      <table className="files-table file-difference-table file-difference-lines" aria-label="텍스트 줄 비교">
        <thead><tr><th scope="col">로컬 줄</th><th scope="col">원격 줄</th><th scope="col">내용</th></tr></thead>
        <tbody>{shown.map((line, index) => {
          if ("skipped" in line) return <tr key={index} className="file-difference-gap">
            <td colSpan={3}>{numbers.format(line.skipped)}줄 생략</td>
          </tr>;
          const changed = line.local === null || line.remote === null;
          const ending = line.text.endsWith("\r\n") ? "CRLF" : line.text.endsWith("\n") ? "LF" : line.text.endsWith("\r") ? "CR" : "줄바꿈 없음";
          const code = line.text.replace(/(?:\r\n|\r|\n)$/, "");
          const bom = (line.local ?? line.remote) === 1 && code.startsWith("\uFEFF");
          const text = bom ? code.slice(1) : code;
          return <tr key={index} className={changed ? line.local === null ? "file-difference-added" : "file-difference-removed" : undefined}>
            <td>{line.local ?? "—"}</td><td>{line.remote ?? "—"}</td>
            <td>
              {changed && <span className="file-difference-marker" aria-label={line.local === null ? "추가" : "삭제"}>{line.local === null ? "+" : "−"}</span>}
              {bom && <span className="file-difference-ending">BOM</span>}
              <code>{showWhitespace ? text.replaceAll(" ", "·").replaceAll("\t", "→\t") : text}</code>
              {changed && <span className="file-difference-ending">{ending}</span>}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </>;
}

function hex(value: number, digits: number) {
  return value.toString(16).toUpperCase().padStart(digits, "0");
}

function HexBytes({ bytes, other }: { bytes: number[]; other: number[] }) {
  return <code className="file-difference-hex">{Array.from({ length: Math.max(bytes.length, other.length) }, (_, index) => {
    const byte = bytes[index];
    const value = byte === undefined ? "──" : hex(byte, 2);
    return byte === other[index] ? <span key={index}>{value}</span> : <mark key={index}>{value}</mark>;
  })}</code>;
}

function BinaryDifference({ rows, changedRows, differingBytes }: { rows: HexRow[]; changedRows: number; differingBytes: number }) {
  return <>
    <p className="form-note">바이너리 · 같은 오프셋에서 {numbers.format(differingBytes)}바이트 차이</p>
    {rows.length < changedRows && <p className="form-note">차이가 있는 {numbers.format(changedRows)}개 구간 중 처음 {numbers.format(rows.length)}개를 표시합니다.</p>}
    <div className="file-difference-scroll" role="region" aria-label="바이트 차이 스크롤 영역" tabIndex={0}>
      <table className="files-table file-difference-table" aria-label="바이너리 바이트 비교">
        <thead><tr><th scope="col">오프셋</th><th scope="col">로컬 HEX</th><th scope="col">원격 HEX</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.offset}>
          <th scope="row"><code>{hex(row.offset, 8)}</code></th>
          <td><HexBytes bytes={row.local} other={row.remote} /></td>
          <td><HexBytes bytes={row.remote} other={row.local} /></td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

export type ViewableDifference = Exclude<FileDifference, { kind: "too_large" }>;

export function FileDifferenceDialog({ name, difference, onClose }: { name: string; difference: ViewableDifference; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [merging, setMerging] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);

  return <><dialog ref={dialog} className="dialog files-compare" aria-labelledby="file-difference-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="file-difference-title">파일 차이</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="files-compare-body">
      <div className="file-difference-file">
        <p className="file-difference-name"><strong>{name}</strong></p>
        {difference.kind === "text" && <button type="button" className="secondary small" onClick={() => setMerging(true)}>텍스트 병합</button>}
      </div>
      {difference.kind === "text" && <TextDifference local={difference.local} remote={difference.remote} />}
      {difference.kind === "binary" && <BinaryDifference rows={difference.rows} changedRows={difference.changed_rows} differingBytes={difference.differing_bytes} />}
    </div>
  </dialog>
    {merging && difference.kind === "text" && <FileMergeDialog name={name} local={difference.local} remote={difference.remote} onClose={() => setMerging(false)} />}
  </>;
}
