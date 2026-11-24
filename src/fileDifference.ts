export type HexRow = { offset: number; local: number[]; remote: number[] };
export type FileDifference =
  | { kind: "text"; local: string; remote: string }
  | { kind: "binary"; differing_bytes: number; changed_rows: number; rows: HexRow[] }
  | { kind: "too_large" };

type Line = { text: string; local: number | null; remote: number | null };
type VisibleLine = Line | { skipped: number };
const MAX_ALIGNMENT_CELLS = 1_000_000;
const MAX_VISIBLE_LINES = 240;
const CONTEXT_LINES = 2;

export function compareTextLines(local: string, remote: string) {
  const left = local.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) ?? [];
  const right = remote.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) ?? [];
  const lines: Line[] = [];
  let prefix = 0;
  let leftEnd = left.length;
  let rightEnd = right.length;
  let removed = 0;
  let inserted = 0;

  function same(before: number, after: number) {
    lines.push({ text: left[before], local: before + 1, remote: after + 1 });
  }
  function remove(before: number) {
    lines.push({ text: left[before], local: before + 1, remote: null });
    removed++;
  }
  function insert(after: number) {
    lines.push({ text: right[after], local: null, remote: after + 1 });
    inserted++;
  }

  while (prefix < leftEnd && prefix < rightEnd && left[prefix] === right[prefix]) {
    same(prefix, prefix);
    prefix++;
  }
  while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd--;
    rightEnd--;
  }

  let before = prefix;
  let after = prefix;
  const width = rightEnd - prefix + 1;
  const cells = (leftEnd - prefix + 1) * width;
  const alignmentLimited = before < leftEnd && after < rightEnd && cells > MAX_ALIGNMENT_CELLS;
  if (before < leftEnd && after < rightEnd && !alignmentLimited) {
    const lengths = new Uint16Array(cells);
    // Longest common suffix lengths for each pair of remaining line sequences.
    for (let i = leftEnd - 1; i >= prefix; i--) {
      for (let j = rightEnd - 1; j >= prefix; j--) {
        const index = (i - prefix) * width + j - prefix;
        lengths[index] = left[i] === right[j]
          ? 1 + lengths[index + width + 1]
          : Math.max(lengths[index + width], lengths[index + 1]);
      }
    }
    while (before < leftEnd && after < rightEnd) {
      const index = (before - prefix) * width + after - prefix;
      if (left[before] === right[after]) same(before++, after++);
      else if (lengths[index + width] >= lengths[index + 1]) remove(before++);
      else insert(after++);
    }
  }
  while (before < leftEnd) remove(before++);
  while (after < rightEnd) insert(after++);
  while (before < left.length) same(before++, after++);

  const nearby = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.local === null || line.remote === null) {
      nearby.fill(1, Math.max(0, index - CONTEXT_LINES), index + CONTEXT_LINES + 1);
    }
  });
  const shown: VisibleLine[] = [];
  let skipped = 0;
  let count = 0;
  let truncated = false;
  lines.forEach((line, index) => {
    if (!nearby[index] || count === MAX_VISIBLE_LINES) {
      if (nearby[index]) truncated = true;
      skipped++;
      return;
    }
    if (skipped) shown.push({ skipped });
    skipped = 0;
    count++;
    shown.push(line);
  });
  if (skipped) shown.push({ skipped });
  return { shown, removed, inserted, truncated, alignmentLimited };
}
