import { type RefObject } from "react";
import { Table2 } from "lucide-react";

export type DatabaseObject = { name: string; kind: string; ddl: string | null };
type ColumnInfo = { position: number; name: string; declared_type: string; not_null: boolean; default_value: string | null; primary_key_position: number; hidden: number };
type IndexInfo = { name: string; unique: boolean; origin: string; partial: boolean; columns: { position: number; name: string | null; descending: boolean; collation: string | null }[] };
export type ForeignKeyInfo = { id: number; sequence: number; target_table: string; from_column: string; to_column: string | null; on_update: string; on_delete: string };
export type ObjectDetails = { object: DatabaseObject; columns: ColumnInfo[]; indexes: IndexInfo[]; foreign_keys: ForeignKeyInfo[] };

export function SqlSchemaContents({ details, selectedColumn, ddlRef }: {
  details: ObjectDetails;
  selectedColumn?: string | null;
  ddlRef?: RefObject<HTMLPreElement | null>;
}) {
  return <>
    <h2>열</h2>
    <div className="table-wrap"><table aria-label={`${details.object.name} 열 구조`}>
      <thead><tr><th scope="col">이름</th><th scope="col">형식</th><th scope="col">NULL 허용</th><th scope="col">기본값</th><th scope="col">키 / 특성</th></tr></thead>
      <tbody>{details.columns.map(column => <tr key={column.position} aria-current={column.name === selectedColumn ? "true" : undefined}>
        <td>{column.name}</td><td>{column.declared_type || "지정 없음"}</td><td>{column.not_null ? "아니요" : "명시 안 됨"}</td>
        <td>{column.default_value ?? "없음"}</td><td>{column.primary_key_position ? `PK ${column.primary_key_position}`
          : column.hidden === 2 ? "가상 생성 열" : column.hidden === 3 ? "저장 생성 열" : column.hidden ? "숨김 열" : "—"}</td>
      </tr>)}</tbody>
    </table></div>
    <h2>인덱스</h2>
    {details.indexes.length ? <ul className="schema-list">{details.indexes.map(index => <li key={index.name}>
      <strong>{index.name}</strong><span>{index.unique ? "UNIQUE · " : ""}{index.partial ? "부분 인덱스 · " : ""}
        {index.columns.map(column => `${column.name ?? "(표현식)"}${column.descending ? " DESC" : ""}${column.collation ? ` COLLATE ${column.collation}` : ""}`).join(", ")}</span>
    </li>)}</ul> : <p className="form-note">인덱스가 없습니다.</p>}
    <h2>외래 키</h2>
    {details.foreign_keys.length ? <ul className="schema-list">{details.foreign_keys.map(key => <li key={`${key.id}-${key.sequence}`}>
      <strong>{key.from_column} → {key.target_table}.{key.to_column ?? "(기본 키)"}</strong>
      <span>그룹 {key.id} · 순서 {key.sequence + 1} · 삭제 {key.on_delete} · 수정 {key.on_update}</span>
    </li>)}</ul> : <p className="form-note">외래 키가 없습니다.</p>}
    <h2>생성 SQL</h2>
    <pre ref={ddlRef} className="schema-ddl" aria-label="생성 SQL" tabIndex={ddlRef ? -1 : undefined}>{details.object.ddl ?? "생성 SQL을 사용할 수 없습니다."}</pre>
  </>;
}

export function SchemaDetails({ object, details, loading, error, open, onToggle }: {
  object: DatabaseObject; details: ObjectDetails | null; loading: boolean; error: string;
  open: boolean; onToggle: (value: boolean) => void;
}) {
  return <details className="schema-card" open={open} onToggle={event => onToggle(event.currentTarget.open)}><summary><span><Table2 size={15} /> <strong>{object.name}</strong> 구조</span>
    <span className="subtle">{loading ? "불러오는 중…" : details ? `열 ${details.columns.length} · 인덱스 ${details.indexes.length} · 외래 키 ${details.foreign_keys.length}` : "상세 보기"}</span>
    </summary>
    <div className="schema-content" aria-busy={loading}>
      {error && <p className="form-error" role="alert">구조를 불러오지 못했습니다: {error}</p>}
      {details && <><p className="form-note">조회 시점의 구조입니다. 지원되는 테이블은 행에서 단일 셀 변경을 미리보고 승인할 수 있습니다.</p>
        <SqlSchemaContents details={details} />
      </>}
    </div>
  </details>;
}
