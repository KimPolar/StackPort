export type ProfileAction<Profile extends { settings: unknown }> =
  | { kind: "create"; initial?: Partial<Profile["settings"]> }
  | { kind: "duplicate"; initial: Profile["settings"] }
  | { kind: "edit" | "delete"; profile: Profile };

export const profileActionVerb = {
  create: "추가", duplicate: "복제", edit: "수정", delete: "삭제",
};

export const profileSubmitVerb = {
  create: "저장", duplicate: "복제", edit: "저장", delete: "삭제",
};

export function duplicateConnectionName(sourceName: string, existingNames: Iterable<string>) {
  const maxLength = 80;
  const existing = new Set(Array.from(existingNames, name => name.trim().toLowerCase()));
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? " 복사본" : " 복사본 " + number;
    const stem = sourceName.slice(0, maxLength - suffix.length).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
    const candidate = stem + suffix;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
}

export function duplicateProfileAction<Settings extends { name: string }>(
  source: { project_id: string; settings: Settings },
  profiles: readonly { project_id: string; settings: { name: string } }[],
): { kind: "duplicate"; initial: Settings } {
  const names = profiles.filter(profile => profile.project_id === source.project_id).map(profile => profile.settings.name);
  return { kind: "duplicate", initial: { ...source.settings, name: duplicateConnectionName(source.settings.name, names) } };
}
