import type { StructuredPreview, XmlPart } from "./structuredFilePreview";

const numbers = new Intl.NumberFormat("ko-KR");

function XmlPreviewPart({ node, root = false }: { node: XmlPart; root?: boolean }) {
  if (node.kind !== "element") {
    const value = node.kind === "comment" ? `<!--${node.value}-->` : node.kind === "cdata" ? `<![CDATA[${node.value}]]>` : node.value;
    return <li><code className="xml-part-text">{value}</code></li>;
  }
  if (!node.attributes.length && !node.children.length) return <li><code>{`<${node.name} />`}</code></li>;
  return <li><details open={root || undefined}>
    <summary><code>{`<${node.name}>`}</code></summary>
    {!!node.attributes.length && <dl className="xml-attributes">{node.attributes.map(([name, value]) => <div key={name}>
      <dt><code>{name}</code></dt><dd><code>{value}</code></dd>
    </div>)}</dl>}
    {!!node.children.length && <ul>{node.children.map((child, index) => <XmlPreviewPart key={index} node={child} />)}</ul>}
  </details></li>;
}

export function StructuredPreviewView({ preview }: { preview: Exclude<StructuredPreview, { error: string }> }) {
  if (preview.kind === "json") return <pre className="files-preview-content" aria-label="JSON 들여쓰기" tabIndex={0}>{preview.text}</pre>;
  if (preview.kind === "xml") return <div className="files-preview-content xml-preview" role="region" aria-label="XML 구조" tabIndex={0}>
    <ul><XmlPreviewPart node={preview.root} root /></ul>
  </div>;
  const { rows, rowCount, columnCount } = preview;
  const columns = Array.from({ length: rows.reduce((width, row) => Math.max(width, row.length), 0) }, (_, index) => index);
  return <>
    <p className="form-note">{numbers.format(rowCount)}행 · {numbers.format(columnCount)}열
      {(rows.length < rowCount || columns.length < columnCount) && <> · 앞 {numbers.format(rows.length)}행 × {numbers.format(columns.length)}열 표시</>}</p>
    <div className="csv-preview" role="region" aria-label="CSV 스크롤 영역" tabIndex={0}>
      <table className="files-table" aria-label="CSV 표">
        <thead><tr><th scope="col">행</th>{columns.map(column => <th key={column} scope="col">열 {numbers.format(column + 1)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          <th scope="row">{numbers.format(index + 1)}</th>
          {columns.map(column => <td key={column}>{row[column]}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}
