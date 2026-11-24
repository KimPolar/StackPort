import { formatDialect, sqlite } from "sql-formatter";
import { isSqliteKeyword, sqliteEditorTokens, type SqlEditorToken } from "./editorSyntax";

export type FormatOptions = { keywordCase: "preserve" | "upper" | "lower"; indent: "2" | "4" | "8" | "tabs"; blankLines: 0 | 1 | 2 };
export type FormatRequest = { source: string; start: number; end: number; mode: "pretty" | "compact"; options: FormatOptions };
export type FormatResult = { text: string } | { error: string };
const limit = 256 * 1024;
const unchanged = { error: "미리보기 결과가 SQL 토큰을 바꿀 수 있어 원본을 유지합니다." };
// SQLite also parses many unquoted keywords as names. Keep those spellings intact.
const reserved = new Set(`
  SELECT FROM WHERE JOIN ON USING AS DISTINCT ALL UNION INTERSECT EXCEPT VALUES INSERT INTO UPDATE SET DELETE
  RETURNING CREATE ALTER DROP TABLE INDEX ADD TO PRIMARY FOREIGN REFERENCES CONSTRAINT CHECK UNIQUE DEFAULT
  COLLATE AUTOINCREMENT ORDER GROUP HAVING LIMIT NULL AND OR NOT IS ISNULL NOTNULL IN EXISTS BETWEEN ESCAPE
  CASE WHEN THEN ELSE COMMIT TRANSACTION
`.trim().split(/\s+/));

function sameTokens(original: SqlEditorToken[], next: SqlEditorToken[], allowKeywordCase: boolean, compareComments = true) {
  return original.length === next.length && original.every((token, index) => {
    const other = next[index];
    if (token.kind !== other.kind) return false;
    if (token.text === other.text) return true;
    if (!compareComments && token.kind === "comment") {
      return token.text.startsWith("--") === other.text.startsWith("--");
    }
    return allowKeywordCase && token.kind === "word" && isSqliteKeyword(token.text)
      && token.text.toUpperCase() === other.text.toUpperCase();
  });
}

function compact(tokens: SqlEditorToken[]) {
  const pieces: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const before = tokens[index - 1];
    if (before && token.start > before.end) pieces.push(before.kind === "comment" && before.text.startsWith("--") ? "\n" : " ");
    pieces.push(token.text);
  }
  return pieces.join("");
}

function preserveSpellings(original: SqlEditorToken[], layout: string, arranged: SqlEditorToken[]) {
  const pieces: string[] = [];
  let offset = 0;
  for (const [index, token] of arranged.entries()) {
    const before = original[index];
    const text = token.kind === "comment" || (token.kind === "word" && !reserved.has(before.text.toUpperCase()))
      ? before.text : token.text;
    pieces.push(layout.slice(offset, token.start), text);
    offset = token.end;
  }
  return pieces.join("") + layout.slice(offset);
}

export function formatSql(request: FormatRequest): FormatResult {
  const { source, start, end, mode, options } = request;
  if (source.length > limit || new TextEncoder().encode(source).length > limit) {
    return { error: "SQL 서식 도구는 UTF-8로 256 KiB 이하의 문서를 지원합니다." };
  }
  if (source.includes("\0") || start < 0 || end > source.length || start >= end) return unchanged;
  const original = sqliteEditorTokens(source);
  if (original.some(token => (token.start < start && start < token.end) || (token.start < end && end < token.end))) {
    return { error: "선택 영역에 잘린 SQL 토큰이 있습니다. 토큰 전체를 선택하세요." };
  }
  const fragment = source.slice(start, end);
  const slice = original.filter(token => token.start >= start && token.end <= end);
  if (!slice.length) return { text: fragment };
  const first = slice[0].start;
  const last = slice[slice.length - 1].end;
  const leading = source.slice(start, first);
  const trailing = source.slice(last, end);
  const body = source.slice(first, last);
  const allowKeywordCase = mode === "pretty" && options.keywordCase !== "preserve";
  let formatted: string;
  try {
    if (mode === "compact") formatted = compact(slice);
    else {
      const layout = formatDialect(body, {
        dialect: sqlite, keywordCase: options.keywordCase,
        tabWidth: options.indent === "tabs" ? 4 : Number(options.indent), useTabs: options.indent === "tabs",
        linesBetweenQueries: options.blankLines,
      });
      const arranged = sqliteEditorTokens(layout);
      if (!sameTokens(slice, arranged, allowKeywordCase, false)) return unchanged;
      formatted = preserveSpellings(slice, layout, arranged);
    }
  } catch {
    return { error: "SQL 서식을 계산할 수 없습니다. 문법을 확인하거나 축약 모드를 사용하세요." };
  }
  const whole = start === 0 && end === source.length;
  const text = whole ? formatted + (trailing.includes("\n") ? "\n" : "") : leading + formatted + trailing;
  const candidate = source.slice(0, start) + text + source.slice(end);
  if (!sameTokens(original, sqliteEditorTokens(candidate), allowKeywordCase)) return unchanged;
  return { text };
}
