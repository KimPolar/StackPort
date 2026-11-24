export type StructuredFormat = "json" | "xml" | "csv";
export type XmlPart = { kind: "element"; name: string; attributes: [string, string][]; children: XmlPart[] }
  | { kind: "text" | "comment" | "cdata"; value: string };
export type StructuredPreview = { kind: "json"; text: string }
  | { kind: "xml"; root: XmlPart }
  | { kind: "csv"; rows: string[][]; rowCount: number; columnCount: number }
  | { error: string };

export function structuredFormat(name: string): StructuredFormat | null {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return name.includes(".") && (extension === "json" || extension === "xml" || extension === "csv") ? extension : null;
}

export function formatStructuredPreview(format: StructuredFormat, source: string): StructuredPreview {
  if (format === "csv") return parseCsv(source);
  if (format === "xml") return parseXml(source);
  return formatJson(source);
}

function formatJson(source: string): StructuredPreview {
  try {
    JSON.parse(source);
  } catch {
    return { error: "올바른 JSON 형식으로 읽을 수 없어 원문을 표시합니다." };
  }
  // Keep number, string and key tokens verbatim, including duplicate keys.
  const tokens = source.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g) ?? [];
  const output: string[] = [];
  let depth = 0;
  let length = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let part = token;
    if (token === "{" || token === "[") {
      const closing = token === "{" ? "}" : "]";
      if (tokens[index + 1] === closing) {
        part += tokens[++index];
      } else {
        depth++;
        part += `\n${"  ".repeat(depth)}`;
      }
    } else if (token === "}" || token === "]") {
      part = `\n${"  ".repeat(--depth)}${token}`;
    } else if (token === ",") {
      part += `\n${"  ".repeat(depth)}`;
    } else if (token === ":") {
      part += " ";
    }
    length += part.length;
    if (depth > 32 || length > 256 * 1024) return { error: "JSON 구조의 표시 한도를 넘어 원문을 표시합니다." };
    output.push(part);
  }
  return { kind: "json", text: output.join("") };
}

export function parseXmlDocument(source: string): Document | { error: string } {
  const invalid = { error: "올바른 XML 형식으로 읽을 수 없습니다." };
  // Inspect declarations before the parser sees them. Comments and CDATA are inert.
  const declarations = /<!--|<!\[CDATA\[|<!DOCTYPE\b|<\?/gi;
  for (let marker; (marker = declarations.exec(source));) {
    const value = marker[0];
    if (value === "<!--" || value === "<![CDATA[") {
      const closing = value === "<!--" ? "-->" : "]]>";
      const end = source.indexOf(closing, declarations.lastIndex);
      if (end < 0) return invalid;
      declarations.lastIndex = end + closing.length;
    } else if (value !== "<?" || !/^xml[ \t\r\n]/.test(source.slice(declarations.lastIndex, declarations.lastIndex + 4))) {
      return { error: "DTD 또는 처리 지시문이 있는 XML은 읽을 수 없습니다." };
    }
  }
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(source, "application/xml");
  } catch {
    return invalid;
  }
  const parseErrors = Array.from(doc.getElementsByTagNameNS("*", "parsererror"));
  if (!doc.documentElement || parseErrors.some(node => node.namespaceURI === "http://www.w3.org/1999/xhtml"
    || node.namespaceURI === "http://www.mozilla.org/newlayout/xml/parsererror.xml")) {
    return invalid;
  }
  return doc;
}

function parseXml(source: string): StructuredPreview {
  const doc = parseXmlDocument(source);
  if ("error" in doc) return { error: doc.error + " 원문을 표시합니다." };
  let parts = 0;
  function element(node: Element, depth: number): XmlPart {
    parts += node.attributes.length + 1;
    if (depth > 24 || parts > 500) throw new RangeError();
    const children: XmlPart[] = [];
    for (const child of node.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        children.push(element(child as Element, depth + 1));
        continue;
      }
      const value = child.nodeValue ?? "";
      if (child.nodeType === Node.TEXT_NODE && value.trim()) children.push({ kind: "text", value });
      else if (child.nodeType === Node.CDATA_SECTION_NODE) children.push({ kind: "cdata", value });
      else if (child.nodeType === Node.COMMENT_NODE) children.push({ kind: "comment", value });
      if (++parts > 500) throw new RangeError();
    }
    return { kind: "element", name: node.tagName, attributes: Array.from(node.attributes, attr => [attr.name, attr.value]), children };
  }
  try {
    return { kind: "xml", root: element(doc.documentElement, 0) };
  } catch {
    return { error: "XML 구조의 표시 한도를 넘어 원문을 표시합니다." };
  }
}

const CSV_ROWS = 100;
const CSV_COLUMNS = 32;

function parseCsv(source: string): StructuredPreview {
  const parsed = parseDelimitedText(source, ",", CSV_ROWS, CSV_COLUMNS);
  return "invalidRecord" in parsed ? { error: "CSV 따옴표 또는 구분자 형식이 올바르지 않아 원문을 표시합니다." }
    : { kind: "csv", rows: parsed.rows, rowCount: parsed.rowCount, columnCount: parsed.columnCount };
}

export const clipboardPasteLimits = { rows: 100, columns: 64, bytes: 256 * 1024 };
export const fileImportLimits = { rows: 1000, columns: 64, bytes: 4 * 1024 * 1024 };
export const clipboardNull = "\\N";

export type ClipboardCell = { value: string | null; textual: boolean };
export type Delimiter = "," | "\t" | ";" | "|";
export type FileEncoding = "utf-8" | "utf-16le" | "utf-16be" | "euc-kr" | "windows-1252";
type InputTable = { headers: string[] | null; rows: (string | null)[][]; columnCount: number; quotedEmpty?: Set<number>[] };

export const fileEncodings: Record<FileEncoding, string> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "euc-kr": "한국어 Windows-949 (EUC-KR)",
  "windows-1252": "서유럽 Windows-1252",
};

export const delimiterNames: Record<Delimiter, string> = { ",": "쉼표", "\t": "탭", ";": "세미콜론", "|": "세로줄" };

export function encodeClipboardRows(rows: ClipboardCell[][], headers: string[] | null, spreadsheetSafe: boolean) {
  let protectedFields = 0;
  function encode({ value, textual }: ClipboardCell) {
    if (value === null) return clipboardNull;
    if (spreadsheetSafe && textual && (/^[\t\r\n]/.test(value) || /^[=+\-@＝＋－＠]/.test(value.trimStart()))) {
      value = "'" + value;
      protectedFields++;
    }
    const quote = value === "" || value === clipboardNull || value.startsWith("\uFEFF") || /[\t\r\n"]/.test(value);
    return quote ? `"${value.replaceAll('"', '""')}"` : value;
  }
  const records = rows.map(row => row.map(encode).join("\t"));
  if (headers) records.unshift(headers.map(value => encode({ value, textual: true })).join("\t"));
  return { text: records.join("\n"), protectedFields };
}

export function parseClipboardRows(source: string, header: boolean, preserveBlanks = false): InputTable | { error: string } {
  if (source.length > clipboardPasteLimits.bytes || new TextEncoder().encode(source).length > clipboardPasteLimits.bytes) {
    return { error: "붙여넣을 값의 전체 크기를 256 KiB 이하로 줄이세요." };
  }
  if (source.includes("\0")) return { error: "NUL 문자가 들어 있는 셀을 제거하세요." };
  const { rows: maximum, columns: width } = clipboardPasteLimits;
  const parsed = parseDelimitedText(source.replace(/^\uFEFF/, ""), "\t", maximum + Number(header), width, preserveBlanks);
  if ("invalidRecord" in parsed) return { error: "따옴표로 묶인 셀의 시작과 끝을 확인하세요." };
  if (parsed.rowCount <= Number(header)) return { error: "붙여넣을 데이터 행을 입력하세요." };
  if (parsed.rowCount > maximum + Number(header) || parsed.columnCount > width) {
    return { error: `붙여넣을 범위를 1~${maximum}행, 1~${width}열로 선택하세요.` };
  }
  const headers = header ? parsed.rows[0] : null;
  const rows = header ? parsed.rows.slice(1) : parsed.rows;
  const columnCount = (headers ?? rows[0]).length;
  const mismatch = rows.findIndex(row => row.length !== columnCount);
  if (mismatch !== -1) return { error: `붙여넣기 ${mismatch + 1}행의 열 수가 다릅니다. 사각형 범위를 복사하세요.` };
  return inputTable(parsed, header, columnCount, preserveBlanks);
}

export function decodeImportFile(bytes: ArrayBuffer, choice: FileEncoding | "auto"):
  { text: string; encoding: FileEncoding } | { error: string } {
  if (bytes.byteLength > fileImportLimits.bytes) return { error: "4 MiB 이하의 파일을 선택하세요." };
  const [a, b, c, d] = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
  if ((a === 0xff && b === 0xfe && c === 0 && d === 0) || (a === 0 && b === 0 && c === 0xfe && d === 0xff)) {
    return { error: "UTF-32 파일은 UTF-8 또는 UTF-16으로 변환한 뒤 가져오세요." };
  }
  const bom = a === 0xef && b === 0xbb && c === 0xbf ? "utf-8"
    : a === 0xff && b === 0xfe ? "utf-16le" : a === 0xfe && b === 0xff ? "utf-16be" : null;
  const encoding = choice === "auto" ? bom ?? "utf-8" : choice;
  if (bom && bom !== encoding) return { error: `파일의 BOM은 ${fileEncodings[bom]}입니다. 인코딩을 확인하세요.` };
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return { error: `${fileEncodings[encoding]}로 읽을 수 없습니다. 파일의 인코딩을 선택하세요.` };
  }
  if (text.includes("\0")) return { error: "NUL 문자가 발견됐습니다. 파일 인코딩과 내용을 확인하세요." };
  if (new TextEncoder().encode(text).byteLength > fileImportLimits.bytes) return { error: "UTF-8로 변환한 텍스트를 4 MiB 이하로 줄이세요." };
  return { text, encoding };
}

export function parseDelimitedImport(bytes: ArrayBuffer, filename: string, options: {
  encoding: FileEncoding | "auto"; delimiter: Delimiter | "auto"; header: boolean; preserveBlanks: boolean;
}): { source: InputTable; encoding: FileEncoding; delimiter: Delimiter } | { error: string } {
  const decoded = decodeImportFile(bytes, options.encoding);
  if ("error" in decoded) return decoded;
  const { text, encoding } = decoded;
  const limits = fileImportLimits;
  const headerSize = Number(options.header);
  const parse = (delimiter: Delimiter) => {
    const parsed = parseDelimitedText(text, delimiter, limits.rows + headerSize, limits.columns, options.preserveBlanks);
    if ("invalidRecord" in parsed) return { error: `파일 ${parsed.invalidRecord}번째 레코드의 따옴표를 확인하세요.`, columns: 0 };
    const columns = parsed.columnCount;
    if (parsed.rowCount <= headerSize) return { error: "가져올 데이터 행이 없습니다.", columns };
    if (parsed.rowCount > limits.rows + headerSize || columns > limits.columns) {
      return { error: `파일을 데이터 ${limits.rows}행, ${limits.columns}열 이내로 나누세요.`, columns };
    }
    const mismatch = parsed.rows.findIndex(row => row.length !== parsed.rows[0].length);
    if (mismatch !== -1) return { error: `파일 ${mismatch + 1}번째 레코드의 열 수가 첫 레코드와 다릅니다.`, columns };
    return { source: inputTable(parsed, options.header, columns, options.preserveBlanks), encoding, delimiter, columns };
  };
  if (options.delimiter !== "auto") return parse(options.delimiter);

  const preferred = filename.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const guesses: Delimiter[] = [preferred, ...([",", "\t", ";", "|"] as const).filter(item => item !== preferred)];
  const attempts = guesses.map(parse);
  const matches = attempts.filter(item => "source" in item && item.columns > 1);
  if (matches.length > 1) return { error: "여러 구분자로 읽을 수 있습니다. 파일의 구분자를 직접 선택하세요." };
  return matches[0] ?? attempts.find(item => item.columns > 1) ?? attempts[0];
}

export function inferSourceColumn(rows: InputTable["rows"], column: number) {
  const values = rows.map(row => row[column]).filter((value): value is string => Boolean(value));
  if (!values.length) return null;
  const integer = /^-?(?:0|[1-9]\d*)$/;
  const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  const validInteger = (value: string) => value.length <= 20 && integer.test(value)
    && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;
  if (values.every(validInteger)) return "정수";
  if (values.every(value => integer.test(value) ? validInteger(value) : decimal.test(value) && Number.isFinite(Number(value)))) return "실수";
  if (values.every(value => /^(true|false)$/i.test(value))) return "불리언";
  if (values.every(value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  })) return "날짜";
  return "문자열";
}

function inputTable(parsed: { rows: string[][]; blanks: Map<number, "null" | "empty">[] }, header: boolean, columnCount: number, preserveBlanks: boolean): InputTable {
  const headers = header ? parsed.rows[0] : null;
  const rows = header ? parsed.rows.slice(1) : parsed.rows;
  if (preserveBlanks) {
    const flags = parsed.blanks.slice(Number(header));
    return { headers, columnCount, rows: rows.map((row, index) => row.map((value, column) =>
      flags[index]?.get(column) === "null" ? null : value)), quotedEmpty: flags.map(row => new Set([...row].flatMap(([column, kind]) =>
      kind === "empty" ? [column] : []))) };
  }
  return { headers, rows, columnCount };
}

function parseDelimitedText(source: string, delimiter: Delimiter, maxRows: number, maxColumns: number, preserveBlanks = false):
  { rows: string[][]; rowCount: number; columnCount: number; blanks: Map<number, "null" | "empty">[] } | { invalidRecord: number } {
  const rows: string[][] = [];
  const blanks: Map<number, "null" | "empty">[] = [];
  let row: string[] = [];
  let rowBlanks = new Map<number, "null" | "empty">();
  let value = "";
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let columns = 0;
  let columnCount = 0;
  let rowCount = 0;

  function field() {
    if (rowCount < maxRows && columns < maxColumns) {
      row.push(value);
      if (preserveBlanks && state === "plain" && value === clipboardNull) rowBlanks.set(columns, "null");
      if (preserveBlanks && state === "closed" && value === "") rowBlanks.set(columns, "empty");
    }
    columns++;
    value = "";
    state = "start";
  }

  function record() {
    field();
    if (rowCount < maxRows) rows.push(row);
    if (preserveBlanks && rowCount < maxRows) { blanks.push(rowBlanks); rowBlanks = new Map(); }
    row = [];
    rowCount++;
    columnCount = Math.max(columns, columnCount);
    columns = 0;
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (state === "quoted") {
      if (char !== '"') value += char;
      else if (source[i + 1] === '"') { value += char; i++; }
      else state = "closed";
    } else if (char === delimiter) {
      field();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      record();
    } else if (state === "closed") {
      return { invalidRecord: rowCount + 1 };
    } else if (char === '"') {
      if (state !== "start") return { invalidRecord: rowCount + 1 };
      state = "quoted";
    } else {
      state = "plain";
      value += char;
    }
  }
  if (state === "quoted") return { invalidRecord: rowCount + 1 };
  if (state !== "start" || columns) record();
  return { rows, rowCount, columnCount, blanks };
}
