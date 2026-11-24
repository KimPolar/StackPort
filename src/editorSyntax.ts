export type EditorLanguage = "sqlite" | "postgres" | "json" | "xml";
type SyntaxKind = "comment" | "string" | "identifier" | "number" | "keyword" | "parameter" | "property" | "tag";
type SyntaxToken = { start: number; end: number; kind: SyntaxKind };
type SyntaxPart = { text: string; kind?: SyntaxKind };

const textLimit = 512 * 1024;
const tokenLimit = 40_000;
const lineTokenLimit = 240;

// SQLite keywords and boolean literals, grouped by common use.
const sqliteKeywords = new Set(`
  SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING AS DISTINCT ALL UNION INTERSECT EXCEPT
  WITH RECURSIVE MATERIALIZED VALUES INSERT INTO UPDATE SET DELETE RETURNING REPLACE CONFLICT DO NOTHING
  CREATE ALTER DROP TABLE VIEW INDEX TRIGGER VIRTUAL TEMP TEMPORARY COLUMN ADD RENAME TO GENERATED ALWAYS
  PRIMARY KEY FOREIGN REFERENCES CONSTRAINT CHECK UNIQUE DEFAULT COLLATE AUTOINCREMENT CASCADE RESTRICT
  ORDER BY GROUP HAVING LIMIT OFFSET ASC DESC NULLS FIRST LAST NULL TRUE FALSE AND OR NOT IS ISNULL NOTNULL
  IN EXISTS BETWEEN LIKE GLOB REGEXP MATCH ESCAPE CASE WHEN THEN ELSE END CAST FILTER
  BEGIN COMMIT ROLLBACK TRANSACTION SAVEPOINT RELEASE DEFERRED IMMEDIATE EXCLUSIVE EXPLAIN QUERY PLAN
  OVER WINDOW PARTITION ROW ROWS RANGE GROUPS PRECEDING FOLLOWING CURRENT UNBOUNDED EXCLUDE OTHERS TIES
  ABORT ACTION AFTER ANALYZE ATTACH BEFORE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFERRABLE
  DETACH EACH FAIL FOR IF IGNORE INDEXED INITIALLY INSTEAD NO OF PRAGMA RAISE REINDEX VACUUM WITHOUT
`.trim().split(/\s+/));

function syntaxGrammar(...rules: RegExp[]) {
  return new RegExp(rules.map(rule => rule.source).join("|"), "gu");
}

const sqliteRules = [
  /(?<comment>--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/,
  /(?<string>[xX]?'(?:''|[^'])*(?:'|$))/,
  /(?<identifier>"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$))/u,
  /(?<parameter>\?[0-9]*|[:@$#](?:[A-Za-z0-9_$\u0080-\u{10ffff}]|::)+(?:\([^ \t\r\n\f)]*\)?)?)/u,
  /(?<number>(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[A-Za-z0-9_$\u0080-\u{10ffff}]*)/u,
  /(?<word>[A-Za-z_\u0080-\u{10ffff}][A-Za-z0-9_$\u0080-\u{10ffff}]*)/u,
];
const sqlite = syntaxGrammar(...sqliteRules);
const sqliteLex = syntaxGrammar(...sqliteRules, /(?<punctuation>->>|->|<=|>=|<>|!=|==|<<|>>|\|\||[^ \t\r\n\f])/);
const postgres = syntaxGrammar(
  /(?<comment>--[^\r\n]*|\/\*)/,
  /(?<string>(?<pgDollar>\$(?:[A-Za-z_\u0080-\u{10ffff}][A-Za-z_\d\u0080-\u{10ffff}]*)?\$)[\s\S]*?(?:\k<pgDollar>|$)|[eE]'(?:''|\\[\s\S]|[^'\\])*(?:'|$)|(?:[uU]&|[bBxX])?'(?:''|[^'])*(?:'|$))/u,
  /(?<identifier>(?:[uU]&)?"(?:""|[^"])*(?:"|$))/,
  /(?<parameter>\$\d+)/,
  sqliteRules[4], sqliteRules[5],
);
const postgresKeywords = new Set([
  "SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING AS DISTINCT ALL UNION INTERSECT EXCEPT",
  "WITH RECURSIVE MATERIALIZED VALUES TABLE LATERAL ONLY TABLESAMPLE INSERT INTO UPDATE DELETE MERGE RETURNING",
  "CREATE ALTER DROP VIEW SCHEMA INDEX TRIGGER FUNCTION PROCEDURE EXTENSION TEMP TEMPORARY SET SHOW RESET",
  "PRIMARY KEY FOREIGN REFERENCES CONSTRAINT CHECK UNIQUE DEFAULT GENERATED ALWAYS COLLATE COPY",
  "ORDER BY GROUP GROUPING SETS ROLLUP CUBE HAVING LIMIT OFFSET FETCH NEXT ROWS ROW FIRST LAST ASC DESC NULLS",
  "NULL TRUE FALSE UNKNOWN AND OR NOT IS IN EXISTS BETWEEN LIKE ILIKE SIMILAR ESCAPE CASE WHEN THEN ELSE END",
  "CAST FILTER OVER WINDOW PARTITION RANGE GROUPS PRECEDING FOLLOWING CURRENT UNBOUNDED EXCLUDE TIES",
  "BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE TRANSACTION READ WRITE EXPLAIN ANALYZE FOR OF SHARE SKIP LOCKED",
  "CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER SESSION_USER LOCALTIME LOCALTIMESTAMP",
].flatMap(line => line.split(" ")));

export type SqlEditorToken = { kind: "word" | "identifier" | "comment" | "string" | "parameter" | "number" | "punctuation"; text: string; start: number; end: number };

export function sqliteEditorTokens(value: string): SqlEditorToken[] {
  return Array.from(value.matchAll(sqliteLex), match => ({
    kind: Object.keys(match.groups!).find(name => match.groups?.[name] !== undefined) as SqlEditorToken["kind"],
    text: match[0], start: match.index, end: match.index + match[0].length,
  }));
}

export function isSqliteKeyword(word: string) {
  return /^[A-Za-z_]+$/.test(word) && sqliteKeywords.has(word.toUpperCase());
}

export function sqliteKeywordsStartingWith(prefix: string) {
  const normalized = prefix.toUpperCase();
  return [...sqliteKeywords].filter(keyword => keyword.startsWith(normalized));
}
const json = syntaxGrammar(
  /(?<string>"(?:\\[^\n]|[^"\\\n])*(?:"|(?=\n|$)))/,
  /(?<number>-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
  /(?<word>[\p{L}_][\p{L}\p{M}\p{N}_]*)/u,
);
const xml = syntaxGrammar(
  /(?<comment><!--[\s\S]*?(?:-->|$))/,
  /(?<string><!\[CDATA\[[\s\S]*?(?:\]\]>|$)|&(?:#\d+|#x[0-9a-fA-F]+|[\p{L}_:][\p{L}\p{N}_.:-]*);)/u,
  /(?<tag><[!?/]?[\p{L}_:][\p{L}\p{N}_.:-]*(?:[^"'>]|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$))/u,
);

export function editorLanguageForFile(filename: string): EditorLanguage | undefined {
  const extension = filename.match(/\.(sql|json|xml)$/i)?.[1].toLowerCase();
  return extension === "sql" ? "sqlite" : extension === "json" || extension === "xml" ? extension : undefined;
}

export function editorSyntaxTokens(value: string, language: EditorLanguage): SyntaxToken[] | null {
  if (value.length > textLimit) return null;
  const tokens: SyntaxToken[] = [];
  const grammar = new RegExp({ sqlite, postgres, json, xml }[language]);
  for (let match = grammar.exec(value); match; match = grammar.exec(value)) {
    const groups = match.groups!;
    const start = match.index;
    let end = start + match[0].length;
    if (language === "postgres" && groups.comment === "/*") {
      end = postgresCommentEnd(value, end);
      grammar.lastIndex = end;
    }
    let kind: SyntaxKind;
    if (groups.word) {
      const marked = language === "sqlite" ? isSqliteKeyword(groups.word) : language === "postgres"
        ? postgresKeywords.has(groups.word.toUpperCase()) : /^(?:true|false|null)$/.test(groups.word);
      if (!marked) continue;
      kind = "keyword";
    } else if (groups.string && language === "json") {
      let next = end;
      while (value[next] === " " || value[next] === "\t" || value[next] === "\r" || value[next] === "\n") next++;
      kind = value[next] === ":" ? "property" : "string";
    } else {
      kind = Object.keys(groups).find(name => groups[name] !== undefined) as SyntaxKind;
    }
    if (tokens.length === tokenLimit) return null;
    tokens.push({ start, end, kind });
  }
  return tokens;
}

function postgresCommentEnd(value: string, start: number) {
  let depth = 1;
  for (let index = start; index < value.length; index++) {
    if (value.startsWith("/*", index)) { depth++; index++; }
    else if (value.startsWith("*/", index)) {
      if (--depth === 0) return index + 2;
      index++;
    }
  }
  return value.length;
}

export function editorSyntaxLine(value: string, tokens: SyntaxToken[], start: number, end: number): SyntaxPart[] {
  let left = 0;
  let right = tokens.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (tokens[middle].end <= start) left = middle + 1;
    else right = middle;
  }
  const parts: SyntaxPart[] = [];
  let offset = start;
  for (let index = left; index < tokens.length && index - left < lineTokenLimit; index++) {
    const token = tokens[index];
    if (token.start >= end) break;
    if (token.start > offset) parts.push({ text: value.slice(offset, token.start) });
    const stop = Math.min(end, token.end);
    if (stop > offset) parts.push({ text: value.slice(Math.max(offset, token.start), stop), kind: token.kind });
    offset = stop;
  }
  if (offset < end) parts.push({ text: value.slice(offset, end) });
  return parts;
}
