import type { ReactNode } from "react";

export type DatabasePreviewValue = { text: string; encoding: "utf8" | "hex"; bytes: number | null; truncated: boolean };

export function DatabasePreviewGrid({ columns, rows, label, rowAction }: {
  columns: { name: string; data_type: string }[]; rows: (DatabasePreviewValue | null)[][]; label: string;
  rowAction?: (row: number) => ReactNode;
}) {
  return <div className="mysql-table" tabIndex={0} role="region" aria-label={`${label} 스크롤`}>
    <table aria-label={label}>
      <thead><tr>{columns.map((column, index) => <th scope="col" key={index} title={column.data_type}>{column.name || `열 ${index + 1}`}</th>)}
        {rowAction && <th scope="col">편집</th>}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, position) => <td key={position}>{cell ? <>
        {cell.encoding === "hex" && <small>HEX </small>}<code>{cell.text || "(빈 값)"}{cell.truncated && "…"}</code>
        {cell.truncated && cell.bytes !== null && <small> {cell.bytes} B</small>}
      </> : <span className="cell-null">NULL</span>}</td>)}{rowAction && <td>{rowAction(index)}</td>}</tr>)}</tbody>
    </table>
  </div>;
}
