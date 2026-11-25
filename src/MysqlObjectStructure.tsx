import { ObjectDefinitionPanel } from "./ObjectDefinitionPanel";
import { ObjectStructureItem } from "./ObjectStructureItem";

export type MysqlObjectInfo = { name: string; kind: string; engine: string | null };
export type MysqlStructureSection = "indexes" | "constraints" | "references" | "definition";
type Relation = { database: string; name: string; object: MysqlObjectInfo | null };
type Fragment = { text: string; truncated: boolean };
type KeyColumn = { local: string; referenced: string | null };
type IndexPart = { column: string | null; expression: Fragment | null; order: string | null; prefix: number | null; cardinality: string | null };
type Index = { name: string; method: string; unique: boolean; visible: boolean | null; parts: IndexPart[] };
type KeyRules = { columns: KeyColumn[]; on_update: string | null; on_delete: string | null };
type Constraint = KeyRules & { name: string; kind: string; expression: Fragment | null; enforced: boolean | null; reference: Relation | null };
type Incoming = KeyRules & { name: string; source: Relation };
export type MysqlStructure =
  | { section: "indexes"; items: Index[]; has_next: boolean }
  | { section: "constraints"; items: Constraint[]; has_next: boolean }
  | { section: "references"; items: Incoming[]; has_next: boolean }
  | { section: "definition"; definition: Fragment };

export const mysqlStructureLabels: Record<MysqlStructureSection, string> = {
  indexes: "인덱스", constraints: "제약조건", references: "들어오는 외래 키", definition: "생성 SQL",
};
const constraintLabels: Record<string, string> = {
  "PRIMARY KEY": "기본 키", "UNIQUE": "고유 키", "FOREIGN KEY": "외래 키", "CHECK": "CHECK",
};
type Follow = (database: string, object: MysqlObjectInfo) => void;

export function MysqlObjectStructure({ data, target, onFollow }: { data: MysqlStructure; target: string; onFollow: Follow }) {
  if (data.section === "definition") return <ObjectDefinitionPanel {...data.definition} target={target} engine="MySQL" title="생성 SQL" />;
  if (data.items.length === 0) return <p className="result-empty">현재 계정에 표시된 항목이 없습니다.</p>;
  return <div className="mysql-inspection-list">
    {data.section === "indexes" && data.items.map(index => <ObjectStructureItem key={index.name} title={index.name}
      meta={[index.method, index.name === "PRIMARY" ? "기본 키" : index.unique && "고유", index.visible === false && "옵티마이저에서 제외"].filter(Boolean).join(" · ")}>
      <div className="mysql-table" tabIndex={0} role="region" aria-label={`${index.name} 인덱스 구성 스크롤`}>
        <table aria-label={`${index.name} 인덱스 구성`}><thead><tr>
          <th scope="col">열 또는 식</th><th scope="col">순서</th><th scope="col">접두 길이</th><th scope="col">고유값 추정</th>
        </tr></thead><tbody>{index.parts.map((part, position) => <tr key={position}>
          <th scope="row"><code>{part.column ?? (part.expression ? fragmentText(part.expression) : "—")}</code></th>
          <td>{part.order === "A" ? "오름차순" : part.order === "D" ? "내림차순" : "—"}</td>
          <td>{part.prefix ?? "—"}</td><td>{part.cardinality ?? "—"}</td>
        </tr>)}</tbody></table>
      </div>
    </ObjectStructureItem>)}
    {data.section === "constraints" && data.items.map(item => <ObjectStructureItem key={JSON.stringify([item.kind, item.name])} title={item.name}
      meta={[constraintLabels[item.kind] ?? item.kind, item.enforced === false && "검사 비활성"].filter(Boolean).join(" · ")}>
      {item.reference && <Related relation={item.reference} label="참조 대상" onFollow={onFollow} />}
      <KeyDetails data={item} />
      {item.expression && <pre className="mysql-inspection-expression" tabIndex={0} aria-label="CHECK 조건 식">{fragmentText(item.expression)}</pre>}
    </ObjectStructureItem>)}
    {data.section === "references" && data.items.map(item => <ObjectStructureItem key={JSON.stringify([item.source.database, item.source.name, item.name])}
      title={item.name} meta={`${item.source.database}.${item.source.name}`}>
      <Related relation={item.source} label="참조하는 객체" onFollow={onFollow} />
      <KeyDetails data={item} />
    </ObjectStructureItem>)}
  </div>;
}

function KeyDetails({ data }: { data: KeyRules }) {
  return <>
    {data.columns.length > 0 && <ol className="mysql-key-columns" aria-label="키 열 순서">{data.columns.map((column, index) => <li key={index}>
      <code>{column.local}</code>{column.referenced !== null && <> → <code>{column.referenced}</code></>}
    </li>)}</ol>}
    {(data.on_update || data.on_delete) && <p className="form-note">
      {data.on_update && `ON UPDATE ${data.on_update}`}
      {data.on_update && data.on_delete && " · "}
      {data.on_delete && `ON DELETE ${data.on_delete}`}
    </p>}
    {!data.on_update && !data.on_delete && data.columns.some(column => column.referenced !== null) &&
      <p className="form-note">현재 계정에 공개된 갱신·삭제 규칙이 없습니다.</p>}
  </>;
}

function Related({ relation, label, onFollow }: { relation: Relation; label: string; onFollow: Follow }) {
  const object = relation.object;
  return <div className="mysql-related">
    <span>{label} <strong>{relation.database}.{relation.name}</strong></span>
    {object ? <button type="button" className="secondary small" onClick={() => onFollow(relation.database, object)}>구조 열기</button>
      : <small>현재 계정에서 구조를 열 수 없습니다.</small>}
  </div>;
}

function fragmentText(fragment: Fragment) {
  return fragment.text + (fragment.truncated ? "…" : "");
}
