export type DatePattern = "year_first" | "day_first" | "month_first" | "korean";
export type CellFormat = { kind: "raw" } | { kind: "number"; digits: number | null } | { kind: "date"; pattern: DatePattern };
export type GridValueType = "number" | "date" | "boolean" | "binary" | "structured" | "null" | "text";

export const rawCellFormat: CellFormat = { kind: "raw" };
export const maximumFractionDigits = 20;
export const datePatterns: Record<DatePattern, string> = {
  year_first: "YYYY/MM/DD", day_first: "DD/MM/YYYY", month_first: "MM/DD/YYYY", korean: "YYYY년 MM월 DD일",
};
export const gridTypeLabels: Record<GridValueType, string> = {
  number: "숫자", date: "날짜·시간", boolean: "참·거짓", binary: "바이너리", structured: "구조 데이터", null: "NULL", text: "텍스트",
};

export function validFractionDigits(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= maximumFractionDigits;
}

export function readCellFormat(value: unknown): CellFormat {
  if (!value || typeof value !== "object" || !("kind" in value)) return rawCellFormat;
  if (value.kind === "number") {
    const digits = "digits" in value && typeof value.digits === "number" && validFractionDigits(value.digits) ? value.digits : null;
    return { kind: "number", digits };
  }
  if (value.kind === "date" && "pattern" in value && typeof value.pattern === "string" && Object.hasOwn(datePatterns, value.pattern)) {
    return { kind: "date", pattern: value.pattern as DatePattern };
  }
  return rawCellFormat;
}

function formatDecimal(source: string, digits: number | null) {
  const match = /^([+-]?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,4}))?$/.exec(source);
  if (!match) return source;
  const [, sign, integer, decimal = "", power = "0"] = match;
  const exponent = Number(power);
  if (Math.abs(exponent) > 1024) return source;
  const data = integer + decimal;
  const point = integer.length + exponent;
  let whole = point <= 0 ? "0" : data.slice(0, point).padEnd(point, "0");
  let fraction = point <= 0 ? "0".repeat(-point) + data : data.slice(point);
  whole = whole.replace(/^0+(?=\d)/, "");

  if (digits !== null && validFractionDigits(digits)) {
    const round = fraction.charAt(digits) >= "5";
    fraction = fraction.slice(0, digits).padEnd(digits, "0");
    if (round) {
      const incremented = (BigInt(whole + fraction) + 1n).toString().padStart(whole.length + digits, "0");
      const boundary = incremented.length - digits;
      whole = incremented.slice(0, boundary);
      fraction = incremented.slice(boundary);
    }
  }

  const firstGroup = whole.length % 3 || 3;
  const rest = whole.slice(firstGroup).match(/\d{3}/g) ?? [];
  return sign + [whole.slice(0, firstGroup), ...rest].join(",") + (fraction ? "." + fraction : "");
}

const isoDate = /^(\d{4,6})-(\d{2})-(\d{2})(?=$|[T ]\d{2}:\d{2})/;

function formatDate(source: string, pattern: DatePattern) {
  const match = isoDate.exec(source);
  if (!match) return source;
  const [prefix, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const maximumDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (!maximumDay || d < 1 || d > maximumDay) return source;
  const date = { year_first: `${year}/${month}/${day}`, day_first: `${day}/${month}/${year}`,
    month_first: `${month}/${day}/${year}`, korean: `${year}년 ${month}월 ${day}일` }[pattern];
  return date + source.slice(prefix.length);
}

export function gridDisplay(source: string, truncated: boolean, format: CellFormat = rawCellFormat) {
  if (truncated || format.kind === "raw") return source;
  if (format.kind === "number") return formatDecimal(source, format.digits);
  return formatDate(source, format.pattern);
}

export function postgresGridValueType(dataType: string, isNull: boolean): GridValueType {
  if (isNull) return "null";
  if (dataType.endsWith("[]") || /^(?:jsonb?|xml)$/.test(dataType)) return "structured";
  if (/^(?:smallint|integer|bigint|numeric|decimal|real|double precision)\b/.test(dataType)) return "number";
  if (/^(?:date|time|timestamp|interval)\b/.test(dataType)) return "date";
  if (dataType === "boolean") return "boolean";
  if (dataType === "bytea") return "binary";
  return "text";
}

export function sqliteGridValueType(kind: string, declared: string, source: string): GridValueType {
  if (kind === "null") return "null";
  if (kind === "blob") return "binary";
  if (kind === "integer" && /^(?:bool|boolean)\b/i.test(declared) && /^[01]$/.test(source)) return "boolean";
  if (kind === "integer" || kind === "real") return "number";
  if (/^(?:date|datetime|timestamp)\b/i.test(declared) && isoDate.test(source)) return "date";
  if (/^(?:jsonb?|xml)\b/i.test(declared)) return "structured";
  return "text";
}
