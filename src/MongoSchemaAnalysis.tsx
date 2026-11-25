import { useId, useState } from "react";
import { useNativeRead } from "./usePostgresRead";

type Segment = { kind: "field"; name: string } | { kind: "array_item" };
type Field = { path: Segment[]; documents: number; types: Record<string, number> };
type Sample = { documents: number; oversized: number; structure_limited: boolean; fields: Field[] };
type Target = { id: string; database: string; collection: string };
const number = new Intl.NumberFormat("ko-KR");
const percent = new Intl.NumberFormat("ko-KR", { style: "percent", maximumFractionDigits: 1 });

function fieldName(path: Segment[]) {
  return path.reduce((display, segment) => {
    if (segment.kind === "array_item") return `${display}[]`;
    if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(segment.name)) return display ? `${display}.${segment.name}` : segment.name;
    return `${display}[${JSON.stringify(segment.name)}]`;
  }, "");
}

export function MongoSchemaAnalysis({ target, revision }: { target: Target; revision: number }) {
  const sampleId = useId();
  const [sampleSize, setSampleSize] = useState(50);
  const [request, setRequest] = useState<(Target & { sampleSize: number }) | null>(null);
  const [search, setSearch] = useState("");
  const [mixedOnly, setMixedOnly] = useState(false);
  const { data, error, loading } = useNativeRead<Sample>("mongo_schema_sample", request, revision);
  const query = search.trim().toLocaleLowerCase();
  const fields = data?.fields.map(field => ({ ...field, name: fieldName(field.path), types: Object.entries(field.types) })) ?? [];
  const mixed = fields.filter(field => field.types.length > 1).length;
  const visible = fields.filter(field => (!mixedOnly || field.types.length > 1) && field.name.toLocaleLowerCase().includes(query));

  return <div className="mongo-schema" aria-busy={loading}>
    <form className="mongo-actions mongo-schema-controls" onSubmit={event => { event.preventDefault(); setRequest({ ...target, sampleSize }); }}>
      <label htmlFor={sampleId}>표본 크기</label>
      <select id={sampleId} value={sampleSize} onChange={event => setSampleSize(Number(event.target.value))} disabled={loading}>
        <option value={20}>20개</option><option value={50}>50개</option><option value={100}>100개</option>
      </select>
      <button type="submit" className="primary small" disabled={loading}>표본 분석</button>
    </form>
    {!request && <p className="form-note mongo-note">선택한 컬렉션이나 뷰에서 무작위로 문서를 뽑아 필드 구조를 집계합니다.</p>}
    {loading && <p className="result-empty" role="status">문서 표본 분석 중…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {data && <>
      <p className="mongo-schema-summary" role="status">분석 문서 {number.format(data.documents)}개 · 필드 경로 {number.format(fields.length)}개 · 혼합 유형 {number.format(mixed)}개</p>
      {data.oversized > 0 && <p className="form-note mongo-note">64 KiB를 넘은 문서 {number.format(data.oversized)}개를 집계에서 제외했습니다.</p>}
      {data.structure_limited && <p className="form-note mongo-note">최대 필드 512개, 경로 8단계, 필드 이름 256바이트 범위의 결과입니다.</p>}
      {!fields.length ? <p className="result-empty">분석할 필드가 없습니다.</p> : <>
        <div className="mongo-actions mongo-schema-controls">
          <input type="search" aria-label="필드 경로 검색" placeholder="필드 경로 검색" value={search} onChange={event => setSearch(event.target.value)} />
          <label><input type="checkbox" checked={mixedOnly} onChange={event => setMixedOnly(event.target.checked)} /> 혼합 유형만</label>
        </div>
        {visible.length === 0 ? <p className="result-empty" role="status">조건에 맞는 필드가 없습니다.</p> :
          <div className="table-wrap"><table aria-label="MongoDB 문서 스키마">
            <thead><tr><th scope="col">필드 경로</th><th scope="col">등장 비율</th><th scope="col">BSON 유형별 문서 수</th></tr></thead>
            <tbody>{visible.map(field => <tr key={field.name}>
              <th scope="row"><code>{field.name}</code></th>
              <td className="mongo-schema-presence"><meter min={0} max={data.documents} value={field.documents} aria-hidden="true" />
                <span>{percent.format(field.documents / data.documents)} ({number.format(field.documents)}/{number.format(data.documents)})</span></td>
              <td><ul className="mongo-schema-types" aria-label={`${field.name} BSON 유형`}>{field.types.map(([type, count]) =>
                <li key={type}><code>{type}</code> <span>{number.format(count)}개</span></li>)}</ul></td>
            </tr>)}</tbody>
          </table></div>}
        <p className="form-note mongo-note"><code>[]</code>는 배열 항목입니다. 항목에 여러 유형이 나오면 같은 문서가 유형별로 한 번씩 집계됩니다.</p>
      </>}
    </>}
  </div>;
}
