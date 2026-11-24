export type ColorScheme = "light" | "dark";
export type ThemePreference = ColorScheme | "system";
export type WorkspaceDensity = "default" | "compact";

const themeKey = "stackport.theme";
const densityKey = "stackport.density";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePreference(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readThemePreference(): ThemePreference {
  const value = readPreference(themeKey);
  return value === "light" || value === "dark" ? value : "system";
}

export function saveThemePreference(preference: ThemePreference): boolean {
  return savePreference(themeKey, preference);
}

export function readDensityPreference(): WorkspaceDensity {
  return readPreference(densityKey) === "compact" ? "compact" : "default";
}

export function saveDensityPreference(preference: WorkspaceDensity): boolean {
  return savePreference(densityKey, preference);
}

export function subscribeSystemTheme(notify: () => void) {
  systemDark.addEventListener("change", notify);
  return () => systemDark.removeEventListener("change", notify);
}

export function systemTheme(): ColorScheme {
  return systemDark.matches ? "dark" : "light";
}

export function applyColorScheme(scheme: ColorScheme) {
  document.documentElement.dataset.colorScheme = scheme;
}
