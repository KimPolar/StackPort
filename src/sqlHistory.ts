import { editorSyntaxTokens, isSqliteKeyword, sqliteEditorTokens, type EditorLanguage } from "./editorSyntax";

export type SqlHistoryScope = "document" | "selection" | "statement" | "batch" | "plan" | "replay";
export type SqlHistoryLanguage = Exclude<EditorLanguage, "xml" | "json">;
export type SqlSourceRange = { start: number; end: number };
type HistoryStatus = "completed" | "planned" | "error" | "cancelled" | "timed_out" | "parameters_required";
export type SqlHistoryOutcome = {
  status: HistoryStatus;
  elapsedMs?: number;
  database?: string | null;
  displayedRows?: number;
  affectedRows?: number;
  batch?: { finished: number; total: number };
};
export type SqlHistoryEntry = {
  id: number;
  profileId: string;
  startedAt: number;
  scope: SqlHistoryScope;
  masked: string;
  sql: string | null;
  withheld?: "masked_only" | "too_long" | "scope_unknown";
  outcome: SqlHistoryOutcome;
};
export type StartSqlHistory = (scope: SqlHistoryScope, sql?: string) =>
  (outcome: SqlHistoryOutcome | null, resolvedSql?: string) => void;
export type SqlHistorySubmission = { scope: SqlHistoryScope; sql?: string };

export const sqlHistoryScopeLabels: Record<SqlHistoryScope, string> = {
  document: "문서 전체", selection: "선택 영역", statement: "현재 문장", batch: "현재 배치", plan: "실행 계획", replay: "고정 쿼리 재실행",
};
export const sqlHistoryStatusLabels: Record<HistoryStatus, string> = {
  completed: "완료", planned: "계획 완료", error: "오류",
  cancelled: "중단", timed_out: "시간 초과", parameters_required: "매개변수에서 중단",
};
const maxPerConnection = 30;
const maxEntries = 120;
const maxStatementUnits = 64 * 1024;
const maxTotalUnits = 1024 * 1024;
const maxMaskInput = 4096;
const maxPreview = 160;
const visibleOperators = new Set(["(", ")", ".", ",", ";", "*", "=", "<", ">", "<=", ">=", "<>", "!=", "==", "+", "-", "/", "%", "||", "&", "|", "~", "<<", ">>", "->", "->>"]);

export function maskHistorySql(sql: string, language: SqlHistoryLanguage = "sqlite") {
  if (language !== "sqlite") {
    const input = sql.slice(0, maxMaskInput);
    const tokens = editorSyntaxTokens(input, language) ?? [];
    const parts: string[] = [];
    let cursor = 0;
    let length = 0;
    for (const token of tokens) {
      if (token.kind !== "keyword") continue;
      const keyword = input.slice(token.start, token.end).toUpperCase();
      const part = input.slice(cursor, token.start).trim() ? "… " + keyword : keyword;
      if (length + part.length > maxPreview) break;
      parts.push(part);
      length += part.length + 1;
      cursor = token.end;
    }
    if (input.slice(cursor).trim() || input.length < sql.length || !parts.length) parts.push("…");
    return parts.join(" ");
  }
  const parts: string[] = [];
  let length = 0;
  for (const token of sqliteEditorTokens(sql.slice(0, maxMaskInput))) {
    if (token.kind === "comment") continue;
    // Identifiers and parameter names may carry values, including SQLite double-quoted literals.
    const part = token.kind === "word" && isSqliteKeyword(token.text) ? token.text.toUpperCase()
      : token.kind === "punctuation" && visibleOperators.has(token.text) ? token.text : "…";
    if (length + part.length > maxPreview) return parts.join(" ") + " …";
    parts.push(part);
    length += part.length + 1;
  }
  const masked = parts.join(" ");
  return sql.length > maxMaskInput ? (masked ? masked + " …" : "…") : masked || "…";
}

export function createSqlHistoryEntry(id: number, profileId: string, scope: SqlHistoryScope, sql: string | undefined, startedAt: number,
  outcome: SqlHistoryOutcome, language: SqlHistoryLanguage = "sqlite", keepSource = true): SqlHistoryEntry {
  const withheld = sql === undefined ? "scope_unknown" : !keepSource ? "masked_only"
    : sql.length > maxStatementUnits ? "too_long" : undefined;
  return { id, profileId, scope, startedAt, masked: sql === undefined ? "…" : maskHistorySql(sql, language),
    sql: withheld ? null : sql ?? null, withheld, outcome };
}

export function sqlHistorySource(source: string, range?: SqlSourceRange): string | undefined {
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.start >= range.end) return;
  const bytes = new TextEncoder().encode(source);
  if (range.end > bytes.length) return;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(range.start, range.end)); }
  catch { return undefined; }
}

export function sqlHistoryStatus(status: "succeeded" | "failed" | "cancelled" | "timed_out"): HistoryStatus {
  return status === "succeeded" ? "completed" : status === "failed" ? "error" : status;
}

export function sumHistoryCounts(values: Iterable<number | null | undefined>) {
  let total: number | undefined;
  for (const value of values) {
    if (value != null && Number.isSafeInteger(value) && value >= 0) total = (total ?? 0) + value;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

export function addSqlHistoryEntry(entries: SqlHistoryEntry[], entry: SqlHistoryEntry) {
  const next: SqlHistoryEntry[] = [];
  const count = new Map<string, number>();
  let units = 0;
  for (const item of [entry, ...entries].sort((left, right) => right.id - left.id)) {
    const used = count.get(item.profileId) ?? 0;
    if (used >= maxPerConnection) continue;
    const cost = item.sql?.length ?? 0;
    if (next.length >= maxEntries || units + cost > maxTotalUnits) break;
    units += cost;
    count.set(item.profileId, used + 1);
    next.push(item);
  }
  return next;
}
