import { useEffect, useRef, useState } from "react";
import { encodeClipboardRows, type ClipboardCell } from "./structuredFilePreview";
import { postgresGridValueType } from "./gridValuePresentation";
import type { Cell } from "./sqlResults";

// Row positions belong to one result snapshot. They may identify different data after a refresh.
const noRows: ReadonlySet<number> = new Set();
export const selectionColumnWidth = 64;

export function useGridRowSelection(snapshot: object | null, count: number) {
  const [active, setActive] = useState(false);
  const [checked, setChecked] = useState<{ snapshot: object; rows: ReadonlySet<number> } | null>(null);
  const rows = checked?.snapshot === snapshot ? checked?.rows ?? noRows : noRows;

  useEffect(() => { setChecked(previous => previous?.snapshot === snapshot ? previous : null); }, [snapshot]);

  function toggleMode() {
    setActive(!active);
    setChecked(null);
  }

  function toggleRow(index: number, selected: boolean) {
    if (!snapshot) return;
    setChecked(previous => {
      const next = new Set(previous?.snapshot === snapshot ? previous.rows : noRows);
      if (selected) next.add(index);
      else next.delete(index);
      return { snapshot, rows: next };
    });
  }

  function togglePage(selected: boolean) {
    if (!snapshot || !selected) { setChecked(null); return; }
    setChecked({ snapshot, rows: new Set(Array.from({ length: count }, (_, index) => index)) });
  }

  return { active, count, rows, toggleMode, toggleRow, togglePage };
}

type Selection = ReturnType<typeof useGridRowSelection>;

export function GridSelectionButton({ selection, disabled }: { selection: Selection; disabled?: boolean }) {
  return <button type="button" className="secondary small" aria-pressed={selection.active} disabled={disabled}
    onClick={selection.toggleMode}>행 선택</button>;
}

export function GridSelectPage({ selection, disabled }: { selection: Selection; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const checked = selection.count > 0 && selection.rows.size === selection.count;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !checked && selection.rows.size > 0;
  }, [checked, selection.rows.size]);
  return <input type="checkbox" ref={ref} aria-label="이 페이지의 행 모두 선택" checked={checked}
    disabled={disabled || selection.count === 0} onChange={event => selection.togglePage(event.target.checked)} />;
}

export function GridSelectRow({ selection, index, rowNumber, disabled }: {
  selection: Selection; index: number; rowNumber: number; disabled?: boolean;
}) {
  return <input type="checkbox" aria-label={`${rowNumber}행 선택`} checked={selection.rows.has(index)} disabled={disabled}
    onChange={event => selection.toggleRow(index, event.target.checked)} />;
}

type CopyCell = ClipboardCell | null;

export function sqliteCopyCell(cell: Cell): CopyCell {
  if (cell.truncated || cell.lossy_text || cell.kind === "blob") return null;
  return { value: cell.kind === "null" ? null : cell.display, textual: cell.kind === "text" };
}

export function postgresCopyCell(cell: { value: string | null; truncated: boolean }, dataType: string): CopyCell {
  if (cell.truncated) return null;
  const type = postgresGridValueType(dataType, cell.value === null);
  return { value: cell.value, textual: type === "text" };
}

export function GridCopyControls({ selection, columns, readCell, startRow, disabled }: {
  selection: Selection; columns: string[]; readCell: (row: number, column: number) => CopyCell; startRow: number; disabled?: boolean;
}) {
  const [headers, setHeaders] = useState(true);
  const [protectedCopy, setProtectedCopy] = useState(true);
  const [feedback, setFeedback] = useState<{ rows: ReadonlySet<number>; message: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const currentFeedback = feedback?.rows === selection.rows ? feedback : null;

  async function copy() {
    const selected = selection.rows;
    if (disabled || busy || !selected.size || !columns.length) return;
    const rows: ClipboardCell[][] = [];
    for (const index of [...selected].sort((first, second) => first - second)) {
      const row = [];
      for (const [position, name] of columns.entries()) {
        const cell = readCell(index, position);
        if (!cell || cell.value?.includes("\0")) {
          setFeedback({ rows: selected, error: true, message: `${startRow + index}행 · ${name} 열의 값은 이 화면에서 복사할 수 없습니다.` });
          return;
        }
        row.push(cell);
      }
      rows.push(row);
    }
    const { text, protectedFields } = encodeClipboardRows(rows, headers ? columns : null, protectedCopy);
    setBusy(true);
    try {
      await navigator.clipboard.writeText(text);
      setFeedback({ rows: selected, error: false, message: `행 ${rows.length}개 복사 완료${protectedFields ? ` · 수식처럼 보이는 값 ${protectedFields}개 보호` : ""}` });
    } catch {
      setFeedback({ rows: selected, error: true, message: "클립보드에 복사하지 못했습니다. 앱 창에서 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  }

  return <div className="grid-copy-controls">
    <div className="grid-copy-actions" role="group" aria-label="선택한 행 복사 옵션">
      <span>{selection.rows.size}행 선택됨</span>
      <label><input type="checkbox" checked={headers} onChange={event => { setHeaders(event.target.checked); setFeedback(null); }} />열 이름 포함</label>
      <label><input type="checkbox" checked={protectedCopy} onChange={event => { setProtectedCopy(event.target.checked); setFeedback(null); }} />스프레드시트 수식 보호</label>
      <button type="button" className="secondary small" disabled={disabled || busy || selection.rows.size === 0}
        onClick={() => void copy()}>선택한 행 복사</button>
    </div>
    {currentFeedback && <p role={currentFeedback.error ? "alert" : "status"} className={currentFeedback.error ? "form-error" : "form-note"}>
      {currentFeedback.message}
    </p>}
  </div>;
}
