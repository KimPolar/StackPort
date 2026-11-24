import { isSqliteKeyword, sqliteEditorTokens, sqliteKeywordsStartingWith, type SqlEditorToken } from "./editorSyntax";

export type SqlCompletionCatalog = {
  relations: { name: string; kind: "table" | "view" }[];
  columns: { relation: string; names: string[] }[];
  functions: string[];
};

export type EditorCompletion = {
  label: string;
  detail: string;
  insert: string;
  caret?: number;
};

type Source = { name: string; qualifier: string };
type DeclaredSource = Source & { relation: SqlEditorToken; alias?: SqlEditorToken };
export type SqlReferenceRange = { start: number; end: number };
export type SqlDefinitionReference = {
  column: string | null;
  sources: { name: string; uses: SqlReferenceRange[] }[];
};
export type SqlAliasRenameTarget = {
  alias: string;
  declaration: SqlReferenceRange;
  occurrences: SqlReferenceRange[];
  statement: SqlReferenceRange;
  unavailable: Set<string>;
};
export type SqlAliasRenameEdit = { text: string; spelling: string; first: number };
type CompletionContext = {
  start: number;
  end: number;
  prefix: string;
  quoted: boolean;
  withParens: boolean;
  mode: "relation" | "column" | "expression";
  schemaQualified: boolean;
  sources: Source[];
  localRelations: string[];
};

const relationWords = new Set(["FROM", "JOIN", "UPDATE", "INTO"]);
const fromEnd = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "RETURNING", "WINDOW", "SET", "VALUES"]);
const fallbackKeywords = ["SELECT", "FROM", "WHERE", "JOIN", "GROUP", "ORDER", "LIMIT", "WITH", "EXPLAIN"];
const sqlEditorLimit = 256 * 1024;
export const sqliteNameKey = (name: string) => name.replace(/[A-Z]/g, letter => letter.toLowerCase());
const caseFold = sqliteNameKey;
const word = (token?: SqlEditorToken) => token?.kind === "word" ? token.text.toUpperCase() : "";
const punctuation = (token: SqlEditorToken | undefined, value: string) => token?.kind === "punctuation" && token.text === value;

function unquoteIdentifier(value: string) {
  const open = value[0];
  if (open !== '"' && open !== '`' && open !== '[') return value;
  const close = open === '[' ? ']' : open;
  const body = value.slice(1, value.length > 1 && value.endsWith(close) ? -1 : undefined);
  return open === '[' ? body : body.replaceAll(open + open, open);
}

function name(token?: SqlEditorToken) {
  return token?.kind === "identifier" || token?.kind === "word" ? unquoteIdentifier(token.text) : "";
}

function identifier(value: string, forceQuote = false) {
  return !forceQuote && /^[\p{L}_][\p{L}\p{M}\p{N}_$]*$/u.test(value) && !isSqliteKeyword(value)
    ? value : `"${value.replaceAll('"', '""')}"`;
}

function queryScopes(tokens: SqlEditorToken[], caret: number) {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  const scopes = [{ first: 0, last: tokens.length }];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (punctuation(token, "(")) stack.push(index);
    if (punctuation(token, ")")) {
      const open = stack.pop();
      if (open === undefined) continue;
      pairs.set(open, index);
      if (tokens[open].end <= caret && caret <= token.start && ["SELECT", "WITH", "VALUES"].includes(word(tokens[open + 1]))) {
        scopes.push({ first: open + 1, last: index });
      }
    }
  }
  for (const open of stack) {
    if (tokens[open].end <= caret && ["SELECT", "WITH", "VALUES"].includes(word(tokens[open + 1]))) {
      scopes.push({ first: open + 1, last: tokens.length });
    }
  }
  scopes.sort((a, b) => a.first - b.first);
  const direct = scopes.map(scope => {
    const direct: SqlEditorToken[] = [];
    for (let index = scope.first; index < scope.last; index++) {
      const token = tokens[index];
      direct.push(token);
      if (!punctuation(token, "(")) continue;
      const close = pairs.get(index);
      if (close === undefined || close >= scope.last) break;
      direct.push(tokens[close]);
      index = close;
    }
    return direct;
  });
  return { scopes, direct, pairs };
}

function cteNames(tokens: SqlEditorToken[]) {
  if (word(tokens[0]) !== "WITH") return [];
  const names: string[] = [];
  let index = word(tokens[1]) === "RECURSIVE" ? 2 : 1;
  for (let relation; (relation = name(tokens[index++]));) {
    if (punctuation(tokens[index], "(") && punctuation(tokens[index + 1], ")")) index += 2;
    if (word(tokens[index++]) !== "AS") break;
    names.push(relation);
    if (word(tokens[index]) === "NOT") index++;
    if (word(tokens[index]) === "MATERIALIZED") index++;
    if (!punctuation(tokens[index], "(") || !punctuation(tokens[index + 1], ")")) break;
    index += 2;
    if (!punctuation(tokens[index++], ",")) break;
  }
  return names;
}

function sourcesFor(tokens: SqlEditorToken[], ctes: string[]) {
  const sources: DeclaredSource[] = [];
  let unresolved = false;
  let inFrom = false;
  for (let index = 0; index < tokens.length; index++) {
    const label = word(tokens[index]);
    if (fromEnd.has(label)) inFrom = false;
    if (!relationWords.has(label) && !(inFrom && punctuation(tokens[index], ","))) continue;
    if (label === "FROM" || label === "JOIN") inFrom = true;
    let next = index + 1;
    let relation = name(tokens[next++]);
    if (!relation) { unresolved = true; continue; }
    let schemaQualified = false;
    if (punctuation(tokens[next], ".")) {
      if (caseFold(relation) !== "main") { unresolved = true; continue; }
      schemaQualified = true;
      relation = name(tokens[++next]);
      next++;
    }
    if (!relation || (!schemaQualified && ctes.some(cte => caseFold(cte) === caseFold(relation))) ||
      ((label === "FROM" || label === "JOIN" || !label) && punctuation(tokens[next], "("))) {
      unresolved = true;
      continue;
    }
    const alias = word(tokens[next]) === "AS" ? tokens[next + 1] : !isSqliteKeyword(word(tokens[next])) ? tokens[next] : undefined;
    sources.push({ name: relation, qualifier: name(alias) || relation, relation: tokens[next - 1], alias: name(alias) ? alias : undefined });
  }
  return { sources, unresolved };
}

function statementContext(value: string, caret: number, allowQuotedName = false) {
  if (value.length > sqlEditorLimit || caret < 0 || caret > value.length) return null;
  const tokens = sqliteEditorTokens(value);
  const current = tokens.find(token => token.start < caret && token.end >= caret);
  if (current && ["comment", "string", "parameter", "number"].includes(current.kind) &&
    !(allowQuotedName && current.kind === "string" && current.text.startsWith("'"))) return null;
  const replace = tokens.find(token => token.start <= caret && token.end >= caret && (token.kind === "word" || token.kind === "identifier"));
  const start = replace?.start ?? caret;
  const end = replace?.end ?? caret;
  let boundary = -1;
  for (let index = 0; index < tokens.length && tokens[index].end <= start; index++) {
    if (punctuation(tokens[index], ";")) boundary = index;
  }
  const after = tokens.findIndex(token => punctuation(token, ";") && token.start >= end);
  const statement = tokens.slice(boundary + 1, after < 0 ? undefined : after).filter(token => token.kind !== "comment");
  const scopes = queryScopes(statement, caret);
  const scope = scopes.direct.at(-1)!;
  const ctes = scopes.direct.flatMap(cteNames);
  return { replace, start, end, statement, scopes, scope, ctes };
}

export function sqlCompletionContext(value: string, caret: number): CompletionContext | null {
  const context = statementContext(value, caret);
  if (!context) return null;
  const { replace, start, end, statement, scope, ctes } = context;
  const prefix = unquoteIdentifier(value.slice(start, caret));
  if (prefix.length > 1024) return null;
  const preceding = statement.filter(token => token.end <= start);
  const dotted = punctuation(preceding.at(-1), ".");
  const qualifier = dotted ? name(preceding.at(-2)) : "";
  const anchor = preceding.at(dotted ? -3 : -1);
  const previousClause = scope.filter(token => token.end <= (anchor?.start ?? start) &&
    (relationWords.has(word(token)) || fromEnd.has(word(token)))).at(-1);
  const takingRelation = relationWords.has(word(anchor)) || (punctuation(anchor, ",") && ["FROM", "JOIN"].includes(word(previousClause)));
  const schemaQualified = dotted && takingRelation && caseFold(qualifier) === "main";
  const mode = (!dotted && takingRelation) || schemaQualified ? "relation" : dotted ? "column" : "expression";
  const sources = mode === "relation" ? [] : sourcesFor(scope, ctes).sources
    .filter(source => !dotted || caseFold(source.qualifier) === caseFold(qualifier)).map(({ name, qualifier }) => ({ name, qualifier }));
  const withParens = !/^\s*\(/.test(value.slice(end));
  return { start, end, prefix, quoted: replace?.kind === "identifier", withParens, mode, schemaQualified, sources, localRelations: ctes };
}

export function sqlDefinitionReference(value: string, caret: number): SqlDefinitionReference | null {
  const context = statementContext(value, caret);
  if (!context?.replace) return null;
  const { replace, statement, scope, scopes, ctes } = context;
  const target = name(replace);
  if (!target || target.length > 1024) return null;
  const { sources, unresolved } = sourcesFor(scope, ctes);
  const active = scopes.scopes.at(-1)!;
  const visible: SqlEditorToken[] = [];
  for (let index = active.first; index < active.last; index++) {
    const token = statement[index];
    if (punctuation(token, "(") && ["SELECT", "WITH", "VALUES"].includes(word(statement[index + 1]))) {
      index = scopes.pairs.get(index) ?? active.last;
    } else visible.push(token);
  }
  const location = visible.indexOf(replace);
  if (location < 0) return null;
  const qualifier = punctuation(visible[location - 1], ".") ? name(visible[location - 2]) : "";
  const usesQualifier = punctuation(visible[location + 1], ".");
  const same = (left: string, right: string) => caseFold(left) === caseFold(right);
  const declared = sources.find(source => source.relation === replace || source.alias === replace);
  const selected = declared ? [declared] : usesQualifier ? sources.filter(source => same(source.qualifier, target)) : null;
  const column = selected ? null : target;
  const from = scope.findIndex(token => word(token) === "FROM");
  const projectionAlias = from >= 0 && scope.slice(0, from).some((token, index) =>
    word(token) === "AS" && same(name(scope[index + 1]), target));
  if (!selected && (word(visible[location - 1]) === "AS" || punctuation(visible[location + 1], "(") ||
    (replace.kind === "word" && isSqliteKeyword(target)) ||
    (!qualifier && (unresolved || (projectionAlias && replace.start > scope[from].start))))) return null;
  const candidates = selected ?? sources.filter(source => !qualifier || same(source.qualifier, qualifier));
  if (!candidates.length || (qualifier && candidates.length !== 1)) return null;
  return {
    column,
    sources: candidates.map(source => {
      const uses = new Set<SqlEditorToken>([replace]);
      if (column === null) {
        if (source.relation) uses.add(source.relation);
        if (source.alias) uses.add(source.alias);
      }
      for (let index = 0; index < visible.length && uses.size < 40; index++) {
        const token = visible[index];
        if (same(name(token), source.qualifier) && punctuation(visible[index + 1], ".")) {
          if (column === null) uses.add(token);
          else if (same(name(visible[index + 2]), column)) uses.add(visible[index + 2]);
        } else if (column && sources.length === 1 && !unresolved && !projectionAlias && same(name(token), column) &&
          token !== source.relation && token !== source.alias && word(visible[index - 1]) !== "AS" &&
          !punctuation(visible[index - 1], ".") && !punctuation(visible[index + 1], "(")) {
          uses.add(token);
        }
      }
      return { name: source.name, uses: [...uses].sort((a, b) => a.start - b.start).map(({ start, end }) => ({ start, end })) };
    }),
  };
}

type AliasScope = { parent: AliasScope | null; bindings: AliasBinding[]; references: SqlEditorToken[] };
type AliasBinding = { key: string; declaration?: SqlEditorToken };
const queryStarts = new Set(["SELECT", "WITH", "VALUES"]);
const compound = new Set(["UNION", "INTERSECT", "EXCEPT"]);
const joinModifiers = new Set(["LEFT", "RIGHT", "FULL", "OUTER", "INNER", "CROSS", "NATURAL", "JOIN", "ON", "USING", "INDEXED", "NOT"]);

function aliasName(token?: SqlEditorToken) {
  return token?.kind === "string" && token.text.startsWith("'")
    ? token.text.slice(1, -1).replaceAll("''", "'") : name(token);
}

function aliasScopes(tokens: SqlEditorToken[], pairs: Map<number, number>) {
  const scopes: AliasScope[] = [];
  const visit = (first: number, last: number, parent: AliasScope | null, depth: number): boolean => {
    if (depth > 32 || scopes.length === 200 || !queryStarts.has(word(tokens[first]))) return false;
    const scope: AliasScope = { parent, bindings: [], references: [] };
    scopes.push(scope);
    const direct: SqlEditorToken[] = [];
    const children: number[] = [];
    const visible: SqlEditorToken[] = [];
    const boundaries: number[] = [];
    for (let index = first; index < last; index++) {
      const token = tokens[index];
      if (punctuation(token, ")") && boundaries.pop() !== index) return false;
      if (!boundaries.length) direct.push(token);
      visible.push(token);
      if (!punctuation(token, "(")) continue;
      const end = pairs.get(index);
      if (end === undefined || end >= last) return false;
      if (queryStarts.has(word(tokens[index + 1]))) {
        children.push(index);
        if (!boundaries.length) direct.push(tokens[end]);
        visible.push(tokens[end]);
        index = end;
      } else boundaries.push(end);
    }
    if (direct.some(token => compound.has(word(token)))) return false;
    const select = direct.findIndex(token => word(token) === "SELECT");
    const tableNames = new Set<SqlEditorToken>();
    const derived = new Set<SqlEditorToken>();
    let inFrom = false;
    for (let index = select + 1; select >= 0 && index < direct.length; index++) {
      const label = word(direct[index]);
      if (fromEnd.has(label)) inFrom = false;
      if (label === "FROM" && word(direct[index - 1]) === "DISTINCT") continue;
      if (label !== "FROM" && label !== "JOIN" && !(inFrom && punctuation(direct[index], ","))) continue;
      inFrom = true;
      let next = index + 1;
      const relation = direct[next++];
      let key = aliasName(relation);
      if (punctuation(relation, "(")) {
        if (!children.some(open => tokens[open] === relation) || !punctuation(direct[next++], ")")) return false;
        derived.add(relation);
      } else {
        if (!key) return false;
        tableNames.add(relation);
        if (punctuation(direct[next], ".")) {
          const qualified = direct[next + 1];
          key = aliasName(qualified);
          if (!key) return false;
          tableNames.add(qualified);
          next += 2;
        }
        if (punctuation(direct[next], "(") && punctuation(direct[next + 1], ")")) next += 2;
      }
      const following = word(direct[next]);
      const declaration = following === "AS" ? direct[next + 1]
        : !fromEnd.has(following) && !joinModifiers.has(following) && aliasName(direct[next]) ? direct[next] : undefined;
      const qualifier = aliasName(declaration) || key;
      if (qualifier) scope.bindings.push({ key: caseFold(qualifier), declaration });
      if (declaration) tableNames.add(declaration);
      // Do not reinterpret a contextual keyword used as a table or alias.
      index = declaration ? next + Number(following === "AS") : next - 1;
    }
    scope.references = visible.filter((token, index) => aliasName(token) && !tableNames.has(token)
      && punctuation(visible[index + 1], ".") && !punctuation(visible[index + 3], "."));
    // A FROM subquery can see outer queries but not its own query's sibling sources.
    return children.every(open => visit(open + 1, pairs.get(open)!, derived.has(tokens[open]) ? parent : scope, depth + 1));
  };
  return visit(0, tokens.length, null, 0) ? scopes : null;
}

function aliasOwner(scope: AliasScope | null, key: string): AliasBinding | undefined {
  while (scope) {
    const binding = scope.bindings.find(binding => binding.key === key);
    if (binding) return binding;
    scope = scope.parent;
  }
}

export function sqlAliasRenameTarget(value: string, caret: number): SqlAliasRenameTarget | null {
  const context = statementContext(value, caret, true);
  if (!context?.statement.length) return null;
  const { statement, scopes: { pairs } } = context;
  const scopes = aliasScopes(statement, pairs);
  if (!scopes) return null;
  const at = (token: SqlEditorToken | undefined) => token && token.start <= caret && caret <= token.end;
  for (const scope of scopes) {
    const reference = scope.references.find(at);
    const binding = scope.bindings.find(binding => at(binding.declaration))
      ?? (reference && aliasOwner(scope, caseFold(aliasName(reference))));
    if (!binding?.declaration) continue;
    const { declaration } = binding;
    const owner = scopes.find(other => other.bindings.includes(binding))!;
    if (owner.bindings.filter(other => other.key === binding.key).length !== 1) return null;
    const unavailable = new Set(owner.bindings.filter(other => other !== binding).map(other => other.key));
    const occurrences = [declaration];
    for (const useScope of scopes) {
      const shadow = new Set<string>();
      let ancestor: AliasScope | null = useScope;
      for (; ancestor && ancestor !== owner; ancestor = ancestor.parent) {
        ancestor.bindings.forEach(other => shadow.add(other.key));
      }
      if (!ancestor) continue;
      for (const token of useScope.references) {
        const key = caseFold(aliasName(token));
        if (shadow.has(key)) continue;
        if (key === binding.key) {
          occurrences.push(token);
          shadow.forEach(other => unavailable.add(other));
        } else unavailable.add(key);
      }
    }
    return { alias: aliasName(declaration), declaration, occurrences: occurrences.sort((a, b) => a.start - b.start),
      statement: { start: statement[0].start, end: statement.at(-1)!.end }, unavailable };
  }
  return null;
}

export function proposeSqlAliasRename(source: string, target: SqlAliasRenameTarget, next: string): SqlAliasRenameEdit | { error: string } | null {
  const proposed = next.trim();
  if (!proposed || proposed.length > 256 || /[\x00-\x1f\x7f]/.test(proposed)) {
    return { error: "제어 문자 없이 1~256자의 별칭을 입력하세요." };
  }
  if (target.unavailable.has(caseFold(proposed))) return { error: "같은 이름을 사용하면 다른 테이블이나 별칭의 참조가 바뀝니다." };
  if (proposed === target.alias) return null;
  const spelling = identifier(proposed);
  const length = target.occurrences.reduce((length, range) => length + spelling.length - (range.end - range.start),
    target.statement.end - target.statement.start);
  const tooLarge = { error: "변경한 SQL은 UTF-8로 256 KiB 이하여야 합니다." };
  if (length > sqlEditorLimit) return tooLarge;
  const parts: string[] = [];
  let offset = target.statement.start;
  for (const range of target.occurrences) {
    parts.push(source.slice(offset, range.start), spelling);
    offset = range.end;
  }
  const text = parts.join("") + source.slice(offset, target.statement.end);
  if (new TextEncoder().encode(text).length > sqlEditorLimit) return tooLarge;
  const first = target.occurrences[0].start;
  return { text, spelling, first };
}

export function sqlCompletionSuggestions(context: CompletionContext, catalog: SqlCompletionCatalog): EditorCompletion[] {
  const { mode, prefix, quoted, sources, localRelations, schemaQualified, withParens } = context;
  const matches = (value: string) => caseFold(value).startsWith(caseFold(prefix));
  const items: EditorCompletion[] = [];
  if (mode === "relation") {
    if (!schemaQualified && matches("main")) items.push({ label: "main", detail: "스키마", insert: `${identifier("main", quoted)}.` });
    const ctes = new Set(schemaQualified ? [] : localRelations.filter(matches).map(caseFold));
    for (const cte of localRelations) if (!schemaQualified && matches(cte)) {
      items.push({ label: cte, detail: "공통 테이블 식", insert: identifier(cte, quoted) });
    }
    for (const relation of catalog.relations) if (!ctes.has(caseFold(relation.name))) {
      items.push({ label: relation.name, detail: relation.kind === "view" ? "뷰" : "테이블", insert: identifier(relation.name, quoted) });
    }
  } else {
    const columns = new Map(catalog.columns.map(group => [caseFold(group.relation), group.names]));
    const fields = sources.flatMap(source => (columns.get(caseFold(source.name)) ?? []).map(column => ({ source, column })));
    const counts = new Map<string, number>();
    for (const { column } of fields) counts.set(caseFold(column), (counts.get(caseFold(column)) ?? 0) + 1);
    for (const { source, column } of fields) {
      const needsAlias = mode === "expression" && (counts.get(caseFold(column)) ?? 0) > 1;
      items.push({ label: column, detail: `${source.qualifier} · 열`,
        insert: `${needsAlias ? identifier(source.qualifier) + "." : ""}${identifier(column, quoted)}` });
    }
    if (mode === "expression") {
      for (const source of sources) if (matches(source.qualifier)) {
        items.push({ label: source.qualifier, detail: `${source.name} · 참조`, insert: `${identifier(source.qualifier, quoted)}.` });
      }
      if (!quoted) {
        const keywords = prefix ? sqliteKeywordsStartingWith(prefix) : fallbackKeywords;
        for (const keyword of keywords) items.push({ label: keyword, detail: "키워드", insert: keyword });
        if (prefix) for (const value of catalog.functions) {
          items.push({ label: value, detail: "함수", insert: withParens ? `${value}()` : value, caret: withParens ? value.length + 1 : undefined });
        }
      }
    }
  }
  const unique = new Map(items.map(item => [item.insert, item]));
  return [...unique.values()].slice(0, 24);
}
