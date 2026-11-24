import { useEffect, useMemo, useState } from "react";
import { rawCellFormat, readCellFormat, type CellFormat } from "./gridValuePresentation";

export const minimumColumnWidth = 64;
export const maximumColumnWidth = 720;
export const postgresPinLimit = 23;
const defaultColumnWidth = 144;

export type ColumnChoice = { name: string; hidden: boolean; pinned: boolean; width: number | null; format: CellFormat };
export type GridLayout = { active: ColumnChoice[]; typeColors: boolean; profiles: { name: string; columns: ColumnChoice[]; typeColors: boolean }[] };
type Target = { engine: "sqlite" | "postgres"; profile: string; object: string; schema?: string };
const emptyLayout: GridLayout = { active: [], typeColors: false, profiles: [] };

function readLayout(key: string | null): GridLayout {
  if (!key) return emptyLayout;
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!stored || !Array.isArray(stored.active) || !Array.isArray(stored.profiles)) return emptyLayout;
    return {
      active: readChoices(stored.active),
      typeColors: stored.typeColors === true,
      profiles: stored.profiles.filter((profile: unknown) => profile && typeof profile === "object" && "name" in profile
        && typeof profile.name === "string" && profile.name.trim() && profile.name.length <= 60 && "columns" in profile && Array.isArray(profile.columns))
        .map((profile: { name: string; columns: unknown[]; typeColors?: boolean }) => ({
          name: profile.name, columns: readChoices(profile.columns), typeColors: profile.typeColors === true,
        })),
    };
  } catch { return emptyLayout; }
}

function readChoices(values: unknown[]): ColumnChoice[] {
  return values.flatMap(value => {
    if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string") return [];
    return [{ name: value.name, hidden: "hidden" in value && value.hidden === true, pinned: "pinned" in value && value.pinned === true,
      width: "width" in value && typeof value.width === "number" && validColumnWidth(value.width) ? value.width : null,
      format: readCellFormat("format" in value ? value.format : undefined) }];
  });
}

export function validColumnWidth(width: number) {
  return Number.isInteger(width) && width >= minimumColumnWidth && width <= maximumColumnWidth;
}

export function useGridLayout(target: Target | null) {
  const key = target ? `stackport.grid.columns.v1:${JSON.stringify([target.engine, target.profile, target.schema ?? "", target.object])}` : null;
  const stored = useMemo(() => readLayout(key), [key]);
  const [current, setCurrent] = useState<{ key: string; value: GridLayout; error: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    const storageKey = key;
    function receive(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) setCurrent({ key: storageKey, value: readLayout(storageKey), error: "" });
    }
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, [key]);

  function apply(value: GridLayout) {
    if (!key) return;
    let error = "";
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { error = "열 설정을 저장할 수 없어 현재 창에 적용했습니다."; }
    setCurrent({ key, value, error });
  }

  return { layout: current?.key === key ? current.value : stored, error: current?.key === key ? current.error : "", apply };
}

export function mergeColumns(columns: string[], choices: ColumnChoice[]): ColumnChoice[] {
  const remaining = new Set(columns);
  const merged = choices.filter(column => remaining.delete(column.name));
  for (const name of remaining) merged.push({ name, hidden: false, pinned: false, width: null, format: rawCellFormat });
  if (merged.length > 0 && merged.every(column => column.hidden)) merged[0] = { ...merged[0], hidden: false };
  return merged;
}

export function visibleColumns(columns: string[], choices: ColumnChoice[]) {
  const visible = mergeColumns(columns, choices).filter(column => !column.hidden);
  return [...visible.filter(column => column.pinned), ...visible.filter(column => !column.pinned)];
}

export function postgresProjection(choices: ColumnChoice[]) {
  return { order: choices.map(column => column.name), hidden: choices.filter(column => column.hidden).map(column => column.name),
    pinned: choices.filter(column => column.pinned && !column.hidden).map(column => column.name) };
}

export function gridGeometry(columns: string[], choices: ColumnChoice[], pinnedCount: number, extraWidth = 0) {
  const widths = new Map(choices.map(column => [column.name, column.width]));
  if (!pinnedCount && !columns.some(name => widths.get(name) != null)) return null;
  const columnsWidths = columns.map(name => widths.get(name) ?? defaultColumnWidth);
  let start = 0;
  const pins = columnsWidths.slice(0, pinnedCount).map(width => {
    const offset = start;
    start += width;
    return offset;
  });
  return { widths: columnsWidths, pins, total: columnsWidths.reduce((total, width) => total + width, extraWidth) };
}
