export const normalizeWorkspaceSearch = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ko-KR");

export function workspaceSearchTerms(query: string) {
  const normalized = normalizeWorkspaceSearch(query.trim());
  return normalized ? normalized.split(/\s+/) : [];
}

export function matchesWorkspaceSearch(terms: string[], ...fields: (string | number | undefined)[]) {
  if (!terms.length) return true;
  const source = normalizeWorkspaceSearch(fields.join(" "));
  return terms.every(term => source.includes(term));
}
