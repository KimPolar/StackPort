export type Cell = { kind: string; display: string; truncated: boolean };
export type QueryMetrics = {
  elapsed_micros: number;
  rows_read: number;
  fullscan_steps: number | null;
  sort_operations: number | null;
  autoindex_rows: number | null;
  vm_steps: number | null;
};
export type QueryPage = { columns: string[]; rows: Cell[][]; page: number; has_more: boolean; generated_sql?: string; metrics?: QueryMetrics };

type ResultDifference =
  | { kind: "cell"; row: number; column: number; before: Cell; after: Cell; uncertain: boolean }
  | { kind: "row"; row: number; before?: Cell[]; after?: Cell[] };

const differenceLimit = 200;

export function resultPageBytes(page: QueryPage) {
  let bytes = page.columns.reduce((total, name) => total + name.length * 2 + 24, 0);
  for (const row of page.rows) {
    for (const cell of row) bytes += cell.display.length * 2 + 48;
  }
  return bytes;
}

export function compareResultPages(before: QueryPage, after: QueryPage) {
  if (before.page !== after.page) return { kind: "different_page" as const };
  const columns = Array.from({ length: Math.max(before.columns.length, after.columns.length) }, (_, index) => ({
    index, before: before.columns[index], after: after.columns[index],
  })).filter(column => column.before !== column.after);
  if (columns.length) return { kind: "columns" as const, columns: columns.slice(0, differenceLimit), total: columns.length };

  let changed = 0;
  let uncertain = 0;
  let added = 0;
  let removed = 0;
  const differences: ResultDifference[] = [];
  const uncertainCells: ResultDifference[] = [];
  for (let row = 0; row < Math.max(before.rows.length, after.rows.length); row++) {
    const previous = before.rows[row];
    const next = after.rows[row];
    if (!previous || !next) {
      if (next) added++;
      else removed++;
      if (differences.length < differenceLimit) differences.push({ kind: "row", row, before: previous, after: next });
      continue;
    }
    for (const [column, oldCell] of previous.entries()) {
      const newCell = next[column];
      const differs = oldCell.kind !== newCell.kind || oldCell.display !== newCell.display || oldCell.truncated !== newCell.truncated;
      // The grid stores BLOB sizes, text previews and lossy text displays.
      const unknown = !differs && (oldCell.kind === "blob" || oldCell.truncated || oldCell.display.includes("\uFFFD"));
      if (!differs && !unknown) continue;
      const output = differs ? differences : uncertainCells;
      if (differs) changed++;
      else uncertain++;
      if (output.length < differenceLimit) {
        output.push({ kind: "cell", row, column, before: oldCell, after: newCell, uncertain: unknown });
      }
    }
  }
  return {
    kind: "rows" as const, changed, uncertain, added, removed,
    differences: [...differences, ...uncertainCells.slice(0, differenceLimit - differences.length)],
  };
}
