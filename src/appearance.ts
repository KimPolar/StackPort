export type ColorScheme = "light" | "dark";
export type ThemePreference = ColorScheme | "system";

const themeKey = "stackport.theme";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(themeKey);
    if (value === "light" || value === "dark") return value;
  } catch { /* The WebView may have storage disabled. */ }
  return "system";
}

export function saveThemePreference(preference: ThemePreference): boolean {
  try {
    window.localStorage.setItem(themeKey, preference);
    return true;
  } catch {
    return false;
  }
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
