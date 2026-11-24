import { useMemo, useState, type ReactNode } from "react";
import { PostgresPager } from "./PostgresPager";
import { SqlFileDialog } from "./SqlFileDialog";
import { emptySqlDocument } from "./SqlTabs";
import { usePostgresRead } from "./usePostgresRead";

export type PostgresObjectKind = "table" | "partitioned" | "view" | "materialized";
type RelatedObject = { id: number; schema_id: number; kind: PostgresObjectKind };
export type PostgresRelationLink = { schema: string; name: string; target: RelatedObject | null };
type Section = "overview" | "columns" | "constraints" | "indexes" | "triggers" | "partitions";
type Fragment = { text: string; truncated: boolean };
type Overview = { owner: string; persistence: string; access: string[]; row_security: boolean; force_row_security: boolean;
  populated: boolean | null; comment: Fragment | null; view_sql: Fragment | null; partition_key: Fragment | null; partition_bound: Fragment | null };
type Column = { position: number; name: string; data_type: string; not_null: boolean; identity: string; generated: string;
  expression: Fragment | null; collation: string | null; comment: Fragment | null };
type Constraint = { name: string; kind: string; validated: boolean; deferrable: boolean; initially_deferred: boolean; columns: string[];
  reference: (PostgresRelationLink & { columns: string[] }) | null; definition: Fragment | null };
type Index = { name: string; method: string; unique: boolean; primary: boolean; valid: boolean; ready: boolean; partial: boolean;
  size_bytes: number | null; definition: Fragment | null };
type Trigger = { name: string; enabled: string; definition: Fragment | null };
type Partition = PostgresRelationLink & { partitioned: boolean; bound: Fragment | null };
type Structure =
  | { section: "overview"; overview: Overview }
  | { section: "columns"; columns: Column[]; has_next: boolean }
  | { section: "constraints"; constraints: Constraint[]; has_next: boolean }
  | { section: "indexes"; indexes: Index[]; has_next: boolean }
  | { section: "triggers"; triggers: Trigger[]; has_next: boolean }
  | { section: "partitions"; partitions: Partition[]; has_next: boolean };

const label: Record<Section, string> = {
  overview: "개요", columns: "열", constraints: "제약조건", indexes: "인덱스", triggers: "트리거", partitions: "파티션",
};
const constraintNames: Record<string, string> = {
  p: "기본 키", f: "외래 키", u: "고유", c: "CHECK", x: "제외", n: "NOT NULL", t: "제약 트리거",
};
const triggerModes: Record<string, string> = { O: "기본 실행", D: "비활성", R: "복제 시 실행", A: "항상 실행" };
const persistence: Record<string, string> = { p: "영구", u: "비기록", t: "임시" };
const number = new Intl.NumberFormat("ko-KR");
type Save = (title: string, text: string) => void;

export function PostgresObjectStructure({ id, object, relation, kind, visible, revision, onFollow, onFileBusy }: {
  id: string; object: number; relation: string; kind: PostgresObjectKind; visible: boolean; revision: number;
  onFollow: (link: PostgresRelationLink) => void; onFileBusy: (busy: boolean) => void;
}) {
  const [section, setSection] = useState<Section>("overview");
  const [page, setPage] = useState(0);
  const [save, setSave] = useState<{ title: string; text: string } | null>(null);
  const [saved, setSaved] = useState("");
  const args = useMemo(() => visible ? { id, object, section, page } : null, [visible, id, object, section, page]);
  const read = usePostgresRead<Structure>("postgres_structure", args, revision);
  const sections: Section[] = ["overview", "columns"];
  if (kind === "table" || kind === "partitioned") sections.push("constraints", "indexes", "triggers");
  if (kind === "view") sections.push("triggers");
  if (kind === "materialized") sections.push("indexes");
  if (kind === "partitioned") sections.push("partitions");

  return <section className="postgres-structure" aria-label="PostgreSQL 객체 구조" aria-busy={read.loading} hidden={!visible}>
    <nav className="postgres-result-views" aria-label="구조 항목">
      {sections.map(item => <button type="button" className="secondary small" key={item} aria-pressed={item === section}
        onClick={() => { if (section !== item) { setSection(item); setPage(0); } }}>{label[item]}</button>)}
    </nav>
    {read.loading && <p className="result-empty" role="status">구조를 읽는 중…</p>}
    {read.error && <p className="error-banner" role="alert">{read.error}</p>}
    {read.data && <StructureContent data={read.data} onSave={(title, text) => setSave({ title, text })} onFollow={onFollow} />}
    {read.data && read.data.section !== "overview" &&
      <PostgresPager label={label[read.data.section]} page={page} next={read.data.has_next} change={setPage} />}
    {saved && <p className="form-note" role="status">SQL 파일 저장 완료 · {saved}</p>}
    {save && <SqlFileDialog mode="save" target={relation + " · " + save.title} document={{ ...emptySqlDocument, text: save.text }}
      onBusy={onFileBusy} onClose={() => setSave(null)} onDone={(_, path) => { setSaved(path); setSave(null); }} />}
  </section>;
}

function StructureContent({ data, onSave, onFollow }: { data: Structure; onSave: Save; onFollow: (link: PostgresRelationLink) => void }) {
  switch (data.section) {
    case "overview": {
      const info = data.overview;
      return <div className="postgres-structure-overview">
        <dl>
          <div><dt>소유자</dt><dd>{info.owner}</dd></div>
          <div><dt>지속성</dt><dd>{persistence[info.persistence] ?? info.persistence}</dd></div>
          <div><dt>현재 역할 권한</dt><dd>{info.access.join(" · ")}</dd></div>
          <div><dt>행 수준 보안</dt><dd>{info.force_row_security ? "강제 적용" : info.row_security ? "활성" : "비활성"}</dd></div>
          {info.populated !== null && <div><dt>구체화 상태</dt><dd>{info.populated ? "데이터 있음" : "갱신 필요"}</dd></div>}
        </dl>
        {info.comment && <Comment fragment={info.comment} />}
        {info.view_sql && <Definition title="뷰 조회 정의" fragment={info.view_sql} onSave={onSave} />}
        {info.partition_key && <Definition title="파티션 키" fragment={info.partition_key} onSave={onSave} />}
        {info.partition_bound && <Definition title="파티션 범위" fragment={info.partition_bound} onSave={onSave} />}
      </div>;
    }
    case "columns": return data.columns.length ? <div className="table-wrap" tabIndex={0} role="region" aria-label="열 구조 스크롤">
      <table aria-label="PostgreSQL 열 구조"><thead><tr><th scope="col">열</th><th scope="col">타입</th>
        <th scope="col">NULL</th><th scope="col">기본값·생성·주석</th></tr></thead>
        <tbody>{data.columns.map(item => <tr key={item.position}>
          <th scope="row" className="postgres-structure-column">{item.name}<small>위치 {item.position}</small></th>
          <td>{item.data_type}</td><td>{item.not_null ? "NOT NULL" : "허용"}</td>
          <td>
            {item.identity && <div>{item.identity === "a" ? "IDENTITY ALWAYS" : "IDENTITY BY DEFAULT"}</div>}
            {item.generated && <div>{item.generated === "v" ? "VIRTUAL 생성 열" : "STORED 생성 열"}</div>}
            {(item.expression || item.collation || item.comment) && <details className="postgres-column-detail">
              <summary>{item.name} 세부 정보</summary>
              {item.collation && <p className="form-note">정렬 규칙 {item.collation}</p>}
              {item.comment && <Comment fragment={item.comment} />}
              {item.expression && <Definition title={item.generated ? "생성 식" : "기본값 SQL"} fragment={item.expression} onSave={onSave} />}
            </details>}
          </td>
        </tr>)}</tbody>
      </table>
    </div> : <Empty section={data.section} />;
    case "constraints": return data.constraints.length ? <div className="postgres-structure-list">
      {data.constraints.map(item => <Detail key={item.name + ":" + item.kind} title={item.name}
        meta={[constraintNames[item.kind] ?? item.kind, ...item.columns, !item.validated && "검증 대기"].filter(Boolean).join(" · ")}>
        {item.deferrable && <p className="form-note">{item.initially_deferred ? "지연 가능 · 기본 지연" : "지연 가능 · 기본 즉시"}</p>}
        {item.reference && <Relation link={item.reference} columns={item.reference.columns} openLabel="참조 객체 열기" onFollow={onFollow} />}
        {item.definition && <Definition title="제약조건 정의 SQL" fragment={item.definition} onSave={onSave} />}
      </Detail>)}
    </div> : <Empty section={data.section} />;
    case "indexes": return data.indexes.length ? <div className="postgres-structure-list">
      {data.indexes.map(item => <Detail key={item.name} title={item.name}
        meta={[item.method, item.primary && "기본 키", item.unique && "고유", item.partial && "부분", !item.valid && "유효하지 않음",
          !item.ready && "준비 중", item.size_bytes !== null && number.format(item.size_bytes) + " B"].filter(Boolean).join(" · ")}>
        {item.definition && <Definition title="인덱스 생성 SQL" fragment={item.definition} onSave={onSave} />}
      </Detail>)}
    </div> : <Empty section={data.section} />;
    case "triggers": return data.triggers.length ? <div className="postgres-structure-list">
      {data.triggers.map(item => <Detail key={item.name} title={item.name} meta={triggerModes[item.enabled] ?? item.enabled}>
        {item.definition && <Definition title="트리거 생성 SQL" fragment={item.definition} onSave={onSave} />}
      </Detail>)}
    </div> : <Empty section={data.section} />;
    case "partitions": return data.partitions.length ? <div className="postgres-structure-list">
      {data.partitions.map(item => <Detail key={JSON.stringify([item.schema, item.name])} title={item.schema + "." + item.name}
        meta={item.partitioned ? "하위 파티션 테이블" : "파티션"}>
        <Relation link={item} openLabel="파티션 구조 열기" onFollow={onFollow} />
        {item.bound && <Definition title="파티션 범위" fragment={item.bound} onSave={onSave} />}
      </Detail>)}
    </div> : <Empty section={data.section} />;
  }
}

function Empty({ section }: { section: Section }) {
  return <p className="result-empty">{label[section]} 항목이 없습니다.</p>;
}

function Detail({ title, meta, children }: { title: string; meta: string; children: ReactNode }) {
  return <details className="postgres-structure-detail">
    <summary><strong>{title}</strong><small>{meta}</small></summary>
    <div>{children}</div>
  </details>;
}

function Relation({ link, columns, openLabel, onFollow }: {
  link: PostgresRelationLink; columns?: string[]; openLabel: string; onFollow: (link: PostgresRelationLink) => void;
}) {
  return <div className="postgres-structure-reference">
    <span>{link.schema}.{link.name}{columns?.length ? " (" + columns.join(", ") + ")" : ""}</span>
    {link.target ? <button type="button" className="secondary small" onClick={() => onFollow(link)}>{openLabel}</button> :
      <small>직접 조회 권한 없음</small>}
  </div>;
}

function Comment({ fragment }: { fragment: Fragment }) {
  return <p className="postgres-structure-comment">{fragment.text}{fragment.truncated && "…"}</p>;
}

function Definition({ title, fragment, onSave }: { title: string; fragment: Fragment; onSave: Save }) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  return <section className="postgres-definition" aria-label={title}>
    <div><strong>{title}</strong>
      {!fragment.truncated && <div className="sql-editor-actions">
        <button type="button" className="secondary small" onClick={async () => {
          setError(""); setNotice("");
          try { await navigator.clipboard.writeText(fragment.text); setNotice("정의 SQL을 복사했습니다."); }
          catch { setError("정의 SQL을 복사할 수 없습니다."); }
        }}>SQL 복사</button>
        <button type="button" className="secondary small" onClick={() => onSave(title, fragment.text)}>정의 파일 저장</button>
      </div>}
    </div>
    <pre tabIndex={0} aria-label={title + " 원문"}>{fragment.text}</pre>
    {fragment.truncated && <p className="form-note">정의의 처음 16,384자까지 표시합니다.</p>}
    {notice && <p className="form-note" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
