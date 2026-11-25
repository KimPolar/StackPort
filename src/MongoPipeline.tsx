import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Dialog } from "./Dialog";
import { MongoDocumentList, type MongoDocumentPage } from "./MongoDocumentList";
import { MongoPipelineLibrary } from "./MongoPipelineLibrary";
import {
  decodeMongoPipeline, encodeMongoPipeline, mongoPipelineOperators, mongoStageLimit, pipelineExchangeLimit,
  type MongoOperator, type MongoPipelineSummary, type MongoStage,
} from "./mongoPipelineFormat";
import { useNativeRead } from "./usePostgresRead";

type Target = { id: string; database: string; collection: string };
type DraftStage = MongoStage & { key: number };
type Preview = Target & { request: { through: number | null; stages: MongoStage[] } };
const operators = Object.keys(mongoPipelineOperators) as MongoOperator[];

export function MongoPipeline({ target, projectId }: { target: Target; projectId: string }) {
  const nextKey = useRef(0);
  const [stages, setStages] = useState<DraftStage[]>([]);
  const [operator, setOperator] = useState<MongoOperator>("$match");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saved, setSaved] = useState<MongoPipelineSummary | null>(null);
  const [library, setLibrary] = useState<"save" | "open" | null>(null);
  const [exchange, setExchange] = useState(false);
  const [notice, setNotice] = useState("");
  const { data, error, loading } = useNativeRead<MongoDocumentPage>("mongo_pipeline_preview", preview);
  const definition = stages.map(({ key: _key, ...stage }) => stage);

  function update(next: DraftStage[]) {
    setStages(next);
    setPreview(null);
    setNotice("");
  }

  function edit(index: number, patch: Partial<MongoStage>) {
    update(stages.map((stage, position) => position === index ? { ...stage, ...patch } : stage));
  }

  function move(index: number, offset: number) {
    const destination = index + offset;
    if (destination < 0 || destination >= stages.length) return;
    const next = [...stages];
    [next[index], next[destination]] = [next[destination], next[index]];
    update(next);
  }

  function replace(next: MongoStage[], identity: MongoPipelineSummary | null) {
    update(next.map(stage => ({ ...stage, key: ++nextKey.current })));
    setSaved(identity);
  }

  function run(through: number | null) {
    setPreview({ ...target, request: { stages: definition, through } });
  }

  return <section className="mongo-pipeline" aria-label="MongoDB 집계 파이프라인" aria-busy={loading}>
    <div className="mongo-actions mongo-schema-controls">
      <select aria-label="추가할 집계 연산자" value={operator} disabled={loading}
        onChange={event => setOperator(event.target.value as MongoOperator)}>
        {operators.map(name => <option key={name}>{name}</option>)}
      </select>
      <button type="button" className="secondary small" disabled={loading || stages.length >= mongoStageLimit}
        onClick={() => update([...stages, { key: ++nextKey.current, operator, expression: mongoPipelineOperators[operator], enabled: true }])}>
        <Plus size={14} aria-hidden /> 단계 추가</button>
      <button type="button" className="primary small" disabled={loading || !stages.some(stage => stage.enabled)} onClick={() => run(null)}>전체 미리보기</button>
    </div>
    <div className="mongo-actions mongo-pipeline-library-actions">
      {saved && <strong>{saved.name}</strong>}
      <button type="button" className="secondary small" disabled={loading || !stages.length} onClick={() => setLibrary("save")}>저장</button>
      <button type="button" className="secondary small" disabled={loading} onClick={() => setLibrary("open")}>저장된 파이프라인</button>
      <button type="button" className="secondary small" disabled={loading} onClick={() => setExchange(true)}>JSON 교환</button>
    </div>
    {notice && <p className="form-note mongo-note" role="status">{notice}</p>}
    {!stages.length && <p className="form-note mongo-note">단계를 추가하거나 프로젝트에 저장한 파이프라인을 불러오세요.</p>}
    {stages.length > 0 && <ol className="mongo-pipeline-stages" aria-label="집계 단계">
      {stages.map((stage, index) => <li key={stage.key}>
        <div className="mongo-pipeline-step">
          <strong>{index + 1}단계</strong>
          <select aria-label={`${index + 1}단계 연산자`} value={stage.operator} disabled={loading} onChange={event => {
            const next = event.target.value as MongoOperator;
            const expression = stage.expression === mongoPipelineOperators[stage.operator] ? mongoPipelineOperators[next] : stage.expression;
            edit(index, { operator: next, expression });
          }}>{operators.map(name => <option key={name}>{name}</option>)}</select>
          <label><input type="checkbox" aria-label={`${index + 1}단계 활성화`} checked={stage.enabled} disabled={loading}
            onChange={event => edit(index, { enabled: event.target.checked })} /> 활성화</label>
          <button type="button" className="icon-button" aria-label={`${index + 1}단계 위로 이동`} disabled={loading || index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} aria-hidden /></button>
          <button type="button" className="icon-button" aria-label={`${index + 1}단계 아래로 이동`} disabled={loading || index === stages.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} aria-hidden /></button>
          <button type="button" className="icon-button" aria-label={`${index + 1}단계 제거`} disabled={loading} onClick={() => update(stages.filter(item => item.key !== stage.key))}><Trash2 size={15} aria-hidden /></button>
          <button type="button" className="secondary small" aria-label={`${index + 1}단계까지 미리보기`} disabled={loading || !stage.enabled}
            onClick={() => run(index + 1)}>여기까지 미리보기</button>
        </div>
        <textarea aria-label={`${index + 1}단계 Extended JSON`} value={stage.expression} disabled={loading} rows={3}
          spellCheck={false} maxLength={16384} onChange={event => edit(index, { expression: event.target.value })} />
      </li>)}
    </ol>}
    {loading && <p className="result-empty" role="status">집계 결과 미리보기 중…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {data && <section aria-label="MongoDB 집계 미리보기 결과" className="mongo-pipeline-results">
      <div className="panel-heading"><h3>{preview?.request.through === null ? "전체 미리보기" : `${preview?.request.through}단계까지 미리보기`}</h3>
        <span role="status">문서 {data.items.length}개{data.has_next ? " 표시 · 결과 더 있음" : ""}</span></div>
      {data.items.length ? <MongoDocumentList items={data.items} heading="MongoDB 집계 문서"
        limitMessage="미리보기 크기 한도를 초과했습니다. $project 단계에서 필요한 필드를 선택하세요." />
        : <p className="result-empty">집계 결과가 없습니다.</p>}
    </section>}
    {library && <MongoPipelineLibrary mode={library} projectId={projectId} current={saved} stages={definition}
      onSave={entry => { setSaved({ id: entry.id, name: entry.name, revision: entry.revision }); setNotice(`${entry.name} 파이프라인을 저장했습니다.`); }}
      onOpen={entry => replace(entry.stages, { id: entry.id, name: entry.name, revision: entry.revision })}
      onDelete={id => { if (saved?.id === id) setSaved(null); }} onClose={() => setLibrary(null)} />}
    {exchange && <PipelineExchange stages={definition} onClose={() => setExchange(false)} onImport={items => replace(items, null)} />}
  </section>;
}

function PipelineExchange({ stages, onImport, onClose }: { stages: MongoStage[]; onImport: (stages: MongoStage[]) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"export" | "import">(stages.length ? "export" : "import");
  const [incoming, setIncoming] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const encoded = encodeMongoPipeline(stages);
  return <Dialog title="파이프라인 JSON 교환" busy={false} onClose={onClose} className="mongo-pipeline-exchange">
    <div className="mongo-pipeline-dialog">
      <div className="mongo-pipeline-step" role="group" aria-label="교환 방식">
        <button type="button" className="secondary small" disabled={!stages.length} aria-pressed={mode === "export"}
          onClick={() => { setMode("export"); setError(""); }}>내보내기</button>
        <button type="button" className="secondary small" aria-pressed={mode === "import"}
          onClick={() => { setMode("import"); setError(""); setStatus(""); }}>가져오기</button>
      </div>
      {mode === "export" ? <>
        <textarea aria-label="내보낼 파이프라인 JSON" readOnly rows={10} spellCheck={false} value={encoded} />
        <div className="dialog-actions"><button type="button" className="primary" onClick={async () => {
          setError("");
          try { await navigator.clipboard.writeText(encoded); setStatus("파이프라인 JSON을 복사했습니다."); }
          catch { setError("클립보드에 복사할 수 없습니다. JSON을 선택해 복사하세요."); }
        }}>JSON 복사</button></div>
      </> : <>
        <textarea aria-label="가져올 파이프라인 JSON" rows={10} spellCheck={false} value={incoming}
          maxLength={pipelineExchangeLimit} onChange={event => setIncoming(event.target.value)} />
        {stages.length > 0 && <p className="form-note">가져온 JSON으로 현재 편집 중인 단계를 바꿉니다.</p>}
        <div className="dialog-actions"><button type="button" className="primary" disabled={!incoming.trim()} onClick={() => {
          try { onImport(decodeMongoPipeline(incoming)); onClose(); }
          catch (reason) { setError(String(reason)); }
        }}>편집기에 가져오기</button></div>
      </>}
      {status && <p role="status" className="form-note">{status}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  </Dialog>;
}
