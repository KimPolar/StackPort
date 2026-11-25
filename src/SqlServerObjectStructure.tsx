import { useMemo, useState } from "react";
import { ObjectStructureItem } from "./ObjectStructureItem";
import { PostgresPager } from "./PostgresPager";
import { useNativeRead } from "./usePostgresRead";

export type SqlServerRelatedTable = { id: number; schema: string; name: string };
type StructureSection = "indexes" | "constraints" | "foreign_keys";
type Expression = { text: string; truncated: boolean };
type KeyColumn = { name: string; key_position: number; descending: boolean | null };
type IndexColumn = KeyColumn & { included: boolean; partition_position: number };
type Index = {
  name: string; method: string; unique: boolean; primary_key: boolean; unique_constraint: boolean;
  disabled: boolean; hypothetical: boolean; has_filter: boolean; filter: Expression | null;
  partitions: number; estimated_rows: string | null; columns: IndexColumn[];
};
type Constraint = {
  name: string; kind: "PK" | "UQ" | "C" | "D"; column: string | null; expression: Expression | null;
  disabled: boolean; untrusted: boolean; columns: KeyColumn[];
};
type ForeignKey = {
  name: string; source: SqlServerRelatedTable; target: SqlServerRelatedTable | null;
  direction: "incoming" | "outgoing" | "self_reference"; on_update: string; on_delete: string;
  disabled: boolean; untrusted: boolean;
  columns: { source: string | null; target: string | null }[];
};
type Structure = { has_next: boolean } & (
  | { section: "indexes"; items: Index[] }
  | { section: "constraints"; items: Constraint[] }
  | { section: "foreign_keys"; items: ForeignKey[] }
);
type FollowTable = (table: SqlServerRelatedTable) => void;

const labels: Record<StructureSection, string> = {
  indexes: "인덱스", constraints: "제약조건", foreign_keys: "외래 키",
};
const constraintLabels = { PK: "기본 키", UQ: "고유 키", C: "CHECK", D: "DEFAULT" };
const directions = { incoming: "들어오는 외래 키", outgoing: "나가는 외래 키", self_reference: "자기 참조 외래 키" };
const sections = ["indexes", "constraints", "foreign_keys"] as const;

export function SqlServerObjectStructure({ id, object, table, revision, onFollow }: {
  id: string; object: number; table: boolean; revision: number; onFollow: FollowTable;
}) {
  const [section, setSection] = useState<StructureSection>("indexes");
  return <section aria-label="SQL Server 키와 인덱스">
    {table && <div className="mysql-views" role="group" aria-label="구조 종류">
      {sections.map(value => <button key={value} type="button" className="secondary small"
        aria-pressed={section === value} onClick={() => setSection(value)}>{labels[value]}</button>)}
    </div>}
    <StructurePage key={section} id={id} object={object} section={section} revision={revision} onFollow={onFollow} />
  </section>;
}

function StructurePage({ id, object, section, revision, onFollow }: {
  id: string; object: number; section: StructureSection; revision: number; onFollow: FollowTable;
}) {
  const [page, setPage] = useState(0);
  const args = useMemo(() => ({ id, object, section, page }), [id, object, section, page]);
  const { data, loading, error } = useNativeRead<Structure>("sql_server_structure", args, revision);

  return <section aria-label={labels[section] + " 목록"} aria-busy={loading}>
    {loading && <p className="result-empty" role="status">구조를 불러오는 중…</p>}
    {error && <p className="form-error mysql-table-note" role="alert">{error}</p>}
    {data && (data.items.length > 0 ? <StructureItems data={data} current={object} onFollow={onFollow} /> :
      <p className="result-empty" role="status">현재 계정에 표시되는 항목이 없습니다.</p>)}
    {!loading && <PostgresPager label={labels[section]} page={page} next={data?.has_next === true} change={setPage} />}
  </section>;
}

function StructureItems({ data, current, onFollow }: { data: Structure; current: number; onFollow: FollowTable }) {
  return <div className="mysql-inspection-list">
    {data.section === "indexes" && data.items.map(index => <ObjectStructureItem key={index.name} title={index.name}
      meta={[index.method, index.primary_key ? "기본 키" : index.unique_constraint ? "고유 키" : index.unique && "고유",
        index.disabled && "비활성", index.hypothetical && "가상 인덱스", index.has_filter && "필터"].filter(Boolean).join(" · ")}>
      {!!index.columns.length && <div className="mysql-table" role="region" tabIndex={0} aria-label={index.name + " 구성 스크롤"}>
        <table aria-label={index.name + " 구성"}><thead><tr>
          <th scope="col">열</th><th scope="col">키 순서</th><th scope="col">정렬</th><th scope="col">역할</th>
        </tr></thead><tbody>{index.columns.map(column => <tr key={column.name}>
          <th scope="row"><code>{column.name}</code></th>
          <td>{column.key_position || "—"}</td>
          <td>{orderLabel(column) ?? "—"}</td>
          <td>{[column.included && "포함 열", column.partition_position > 0 && `파티션 ${column.partition_position}`]
            .filter(Boolean).join(" · ") || "—"}</td>
        </tr>)}</tbody></table>
      </div>}
      {index.has_filter && <Definition expression={index.filter} label="인덱스 필터" />}
      {index.estimated_rows !== null && <p className="form-note">추정 행 수 {index.estimated_rows} · 파티션 {index.partitions}개</p>}
    </ObjectStructureItem>)}
    {data.section === "constraints" && data.items.map(item => <ObjectStructureItem key={item.name} title={item.name}
      meta={[constraintLabels[item.kind], item.disabled && "비활성", item.untrusted && "기존 행 미검증"].filter(Boolean).join(" · ")}>
      {item.column !== null && <p className="form-note">적용 열 <code>{item.column}</code></p>}
      {!!item.columns.length && <ol className="mysql-key-columns" aria-label="키 열 순서">
        {item.columns.map(column => <li key={column.name}><code>{column.name}</code>
          {column.descending !== null && <> · {orderLabel(column)}</>}</li>)}
      </ol>}
      {(item.kind === "C" || item.kind === "D") && <Definition expression={item.expression} label={constraintLabels[item.kind] + " 식"} />}
    </ObjectStructureItem>)}
    {data.section === "foreign_keys" && data.items.map(item => <ObjectStructureItem key={item.source.id + ":" + item.name} title={item.name}
      meta={[directions[item.direction], item.disabled && "비활성", item.untrusted && "기존 행 미검증"].filter(Boolean).join(" · ")}>
      <Related label="참조하는 테이블" table={item.source} current={current} onFollow={onFollow} />
      <Related label="참조 대상 테이블" table={item.target} current={current} onFollow={onFollow} />
      {!!item.columns.length && <ol className="mysql-key-columns" aria-label="외래 키 열 순서">
        {item.columns.map((column, index) => <li key={index}><code>{column.source ?? "비공개"}</code> → <code>{column.target ?? "비공개"}</code></li>)}
      </ol>}
      <p className="form-note">ON UPDATE {item.on_update.replaceAll("_", " ")} · ON DELETE {item.on_delete.replaceAll("_", " ")}</p>
    </ObjectStructureItem>)}
  </div>;
}

function orderLabel(column: KeyColumn) {
  return column.descending === null ? null : column.descending ? "내림차순" : "오름차순";
}

function Definition({ expression, label }: { expression: Expression | null; label: string }) {
  return expression ? <pre className="mysql-inspection-expression" tabIndex={0} aria-label={label}>
    {expression.text}{expression.truncated ? "…" : ""}
  </pre> : <p className="form-note">{label}은 현재 계정에 공개되지 않았습니다.</p>;
}

function Related({ label, table, current, onFollow }: {
  label: string; table: SqlServerRelatedTable | null; current: number; onFollow: FollowTable;
}) {
  const name = table ? `${table.schema}.${table.name}` : "현재 계정에 비공개";
  return <div className="mysql-related">
    <span>{label} <strong>{name}</strong></span>
    {table && table.id !== current && <button type="button" className="secondary small"
      aria-label={name + " 구조 열기"} onClick={() => onFollow(table)}>구조 열기</button>}
  </div>;
}
