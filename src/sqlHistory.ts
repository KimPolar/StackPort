import { isSqliteKeyword, sqliteEditorTokens } from "./editorSyntax";

export type SqlHistoryScope = "document" | "selection" | "statement" | "plan" | "replay";
type HistoryStatus = "completed" | "planned" | "error" | "cancelled" | "timed_out" | "parameters_required";
export type SqlHistoryOutcome = {
  status: HistoryStatus;
  elapsedMs?: number;
  displayedRows?: number;
  batch?: { finished: number; total: number };
};
export type SqlHistoryEntry = {
  id: number;
  profileId: string;
  startedAt: number;
  scope: SqlHistoryScope;
  masked: string;
  sql: string | null;
  outcome: SqlHistoryOutcome;
};

export const sqlHistoryScopeLabels: Record<SqlHistoryScope, string> = {
  document: "문서 전체", selection: "선택 영역", statement: "현재 문장", plan: "실행 계획", replay: "고정 쿼리 재실행",
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

export function maskHistorySql(sql: string) {
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

export function createSqlHistoryEntry(id: number, profileId: string, scope: SqlHistoryScope, sql: string, startedAt: number,
  outcome: SqlHistoryOutcome): SqlHistoryEntry {
  return { id, profileId, scope, startedAt, masked: maskHistorySql(sql),
    sql: sql.length <= maxStatementUnits ? sql : null, outcome };
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
