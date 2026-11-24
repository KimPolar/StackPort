import { fileImportLimits, parseXmlDocument } from "./structuredFilePreview";

const xmlns = "http://www.w3.org/2000/xmlns/";
const xsi = "http://www.w3.org/2001/XMLSchema-instance";
const maxDepth = 48;
const maxPaths = 256;
const nonWhitespace = /[^ \t\r\n]/;

type XmlCell = { kind: "text" | "null" | "xml"; value: string };
type XmlColumn = { label: string; localName: string; namespace: string };
export type XmlRecordPath = { label: string; records: Element[] };
export type XmlImportTable = {
  format: "XML";
  headers: string[];
  matchNames: string[];
  columnCount: number;
  columnTypes: (string | null)[];
  rows: (XmlCell | null)[][];
};

function expandedNames() {
  const namespaces = new Map<string | null, number>();
  return (node: Element | Attr) => {
    const uri = node.namespaceURI;
    if (!namespaces.has(uri)) namespaces.set(uri, namespaces.size);
    return `${namespaces.get(uri)}:${node.localName}`;
  };
}

function labeledName(label: string, namespace: string | null) {
  const short = (part: string) => part.length > 96 ? part.slice(0, 96) + "…" : part;
  return namespace ? `${short(label)} {${short(namespace)}}` : short(label);
}

function dataAttribute(attr: Attr) {
  return attr.namespaceURI !== xmlns && !(attr.namespaceURI === xsi && attr.localName === "nil");
}

export function inspectXmlRecordPaths(source: string) {
  const document = parseXmlDocument(source);
  if ("error" in document) throw new Error(document.error);
  const paths: XmlRecordPath[] = [];
  const expandedName = expandedNames();
  let count = 0;

  function visit(records: Element[], parent: string, depth: number) {
    count += records.length;
    if (depth > maxDepth || count > 80_000) throw new Error("XML 문서의 구조가 가져오기 한도를 넘었습니다.");
    const first = records[0];
    const name = labeledName(first.tagName, first.namespaceURI);
    const label = `${parent}/${name}`;
    if (depth === 1 || records.length > 1 || records.some(row => row.childElementCount || Array.from(row.attributes).some(dataAttribute))) {
      if (paths.length >= maxPaths) throw new Error(`XML 레코드 경로는 최대 ${maxPaths}개까지 읽을 수 있습니다.`);
      paths.push({ label, records });
    }
    const children = new Map<string, Element[]>();
    for (const row of records) {
      for (const child of row.children) {
        const key = expandedName(child);
        const group = children.get(key);
        if (group) group.push(child);
        else children.set(key, [child]);
      }
    }
    for (const group of children.values()) visit(group, label, depth + 1);
  }

  visit([document.documentElement], "", 1);
  return paths;
}

function isNil(element: Element, location: string) {
  const nil = element.getAttributeNS(xsi, "nil")?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (nil === "true" || nil === "1") {
    if (element.childElementCount || nonWhitespace.test(element.textContent ?? "")) {
      throw new Error(`${location} · xsi:nil 요소에 내용이 있습니다.`);
    }
    return true;
  }
  if (nil !== undefined && nil !== "false" && nil !== "0") {
    throw new Error(`${location} · xsi:nil에는 true, false, 1, 0을 사용하세요.`);
  }
  return false;
}

function content(element: Element, serializer: XMLSerializer, location: string): XmlCell {
  if (isNil(element, location)) return { kind: "null", value: "" };
  if (element.childElementCount || Array.from(element.attributes).some(dataAttribute)) {
    return { kind: "xml", value: serializer.serializeToString(element) };
  }
  return { kind: "text", value: element.textContent ?? "" };
}

export function readXmlRecords(path: XmlRecordPath): XmlImportTable {
  const { rows: rowLimit, columns: columnLimit, bytes: byteLimit } = fileImportLimits;
  if (path.records.length > rowLimit) throw new Error(`XML 경로마다 최대 ${rowLimit}행을 가져올 수 있습니다.`);
  const columns = new Map<string, XmlColumn>();
  const expandedName = expandedNames();
  const serializer = new XMLSerializer();
  const encoder = new TextEncoder();
  let bytes = 0;
  const records = path.records.map((record, index) => {
    const cells = new Map<string, XmlCell>();
    const location = `${index + 1}번째 XML 레코드`;
    const nil = isNil(record, location);
    function append(key: string, column: XmlColumn, cell: XmlCell) {
      if (cells.has(key)) throw new Error(`${location} · ${column.label} 요소가 반복됩니다. 레코드 경로를 확인하세요.`);
      if (!columns.has(key)) {
        if (columns.size >= columnLimit) throw new Error(`XML은 최대 ${columnLimit}열을 가져올 수 있습니다.`);
        columns.set(key, column);
      }
      bytes += encoder.encode(cell.value).byteLength;
      if (bytes > byteLimit) throw new Error("XML 셀로 펼친 데이터가 4 MiB를 넘었습니다.");
      cells.set(key, cell);
    }
    for (const attr of record.attributes) {
      if (dataAttribute(attr)) append("@" + expandedName(attr),
        { label: "@" + attr.name, localName: attr.localName, namespace: attr.namespaceURI ?? "" },
        { kind: "text", value: attr.value });
    }
    if (record.childElementCount) {
      if ([...record.childNodes].some(node => (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE)
        && nonWhitespace.test(node.nodeValue ?? ""))) {
        throw new Error(`${location} · 레코드 요소에는 하위 요소와 행 자체의 값이 함께 올 수 없습니다.`);
      }
      for (const child of record.children) {
        append(expandedName(child), { label: child.tagName, localName: child.localName, namespace: child.namespaceURI ?? "" },
          content(child, serializer, `${location} · ${child.tagName}`));
      }
    } else if (cells.size === 0 || nil || record.textContent !== "") {
      append("#text", { label: "#text", localName: "#text", namespace: "" },
        { kind: nil ? "null" : "text", value: nil ? "" : record.textContent ?? "" });
    }
    return cells;
  });
  const keys = [...columns.keys()];
  const fields = [...columns.values()];
  return {
    format: "XML",
    headers: fields.map(column => labeledName(column.label, column.namespace)),
    matchNames: fields.map(column => column.localName),
    columnCount: fields.length,
    columnTypes: fields.map(() => null),
    rows: records.map(row => keys.map(key => row.get(key) ?? null)),
  };
}
