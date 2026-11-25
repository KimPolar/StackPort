import type { ReactNode } from "react";

export type MongoDocument = { id: string | null; bson_bytes: number; json: string | null };
export type MongoDocumentPage = { items: MongoDocument[]; has_next: boolean };
const displayNumber = new Intl.NumberFormat("ko-KR");

export function MongoDocumentList({ items, heading, offset = 0, limitMessage, actions }: {
  items: MongoDocument[]; heading: string; offset?: number; limitMessage: string;
  actions?: (documentId: string, row: number) => ReactNode;
}) {
  return <ul className="mongo-document-list" aria-label={heading}>
    {items.map((item, index) => <li key={index}><details open={index === 0}>
      <summary><span>{offset + index + 1}행</span>{item.id && <code title={item.id}>{item.id}</code>}
        <small>{displayNumber.format(item.bson_bytes)} B</small></summary>
      {item.json === null ? <p className="form-note">{limitMessage}</p>
        : <pre aria-label="Canonical Extended JSON" tabIndex={0}><code>{item.json}</code></pre>}
      {item.id && actions?.(item.id, offset + index + 1)}
    </details></li>)}
  </ul>;
}
