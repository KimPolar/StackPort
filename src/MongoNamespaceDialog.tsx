import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

type Kind = "collection" | "view";
type Review = { token: string; definition: string; previous_definition: string | null; removes_validator: boolean; expires_seconds: number };
export type MongoValidationSettings = { validator: string; level: string; action: string };
export type MongoNamespaceReport = { database: string; name: string; kind: Kind; audit_warning: boolean };

export function MongoNamespaceDialog({ id, initialDatabase, initialSource, validation, environment, onBusy, onClose, onDone }: {
  id: string; initialDatabase: string; initialSource: string; environment: string;
  validation?: { collection: string; settings: MongoValidationSettings };
  onBusy: (busy: boolean) => void; onClose: () => void; onDone: (report: MongoNamespaceReport) => void;
}) {
  const [kind, setKind] = useState<Kind>("collection");
  const [database, setDatabase] = useState(initialDatabase);
  const [name, setName] = useState(validation?.collection ?? "");
  const [source, setSource] = useState(initialSource);
  const [pipeline, setPipeline] = useState("[]");
  const [validator, setValidator] = useState(validation?.settings.validator ?? "");
  const [level, setLevel] = useState(validation?.settings.level ?? "strict");
  const [action, setAction] = useState(validation?.settings.action ?? "error");
  const [review, setReview] = useState<Review | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const token = useRef<string | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const awaitingConfirmation = Boolean(review && environment === "PROD" && confirmation !== "PROD");
  const operation = validation ? "변경" : "생성";

  useEffect(() => () => {
    if (token.current) void invoke("discard_mongo_namespace_review", { id, token: token.current }).catch(() => {});
  }, [id]);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);

  function edit() {
    if (token.current) void invoke("discard_mongo_namespace_review", { id, token: token.current }).catch(() => {});
    token.current = null;
    setReview(null);
    setConfirmation("");
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || awaitingConfirmation) return;
    pending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      if (review) {
        const command = validation ? "apply_mongo_namespace_validation" : "apply_mongo_namespace_create";
        const result = await invoke<MongoNamespaceReport>(command, { id, token: review.token, confirmation });
        token.current = null;
        onDone(result);
      } else {
        const options = { validator, level, action };
        const input = validation ? options : kind === "collection" ? { kind, ...options } : { kind, source, pipeline };
        const command = validation ? "review_mongo_namespace_validation" : "review_mongo_namespace_create";
        const result = await invoke<Review>(command, { id, database, name, input });
        token.current = result.token;
        setReview(result);
      }
    } catch (cause) {
      if (review) edit();
      setError(String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  return <Dialog title={validation ? "MongoDB 유효성 규칙 편집" : "MongoDB 컬렉션·뷰 만들기"}
    busy={busy} className="restore-dialog mongo-namespace-dialog" onClose={onClose}>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      {review ? <>
        <h3 ref={reviewHeading} tabIndex={-1}>{operation} 검토</h3>
        <p className="confirm-copy"><strong>{environment}</strong> · {database}.{name}</p>
        {review.previous_definition === null
          ? <pre className="mongo-command-definition" aria-label="생성 명령" tabIndex={0}>{review.definition}</pre>
          : <div className="mongo-edit-compare">
            <section><h4>변경 전</h4><pre aria-label="변경 전 유효성 설정" tabIndex={0}>{review.previous_definition}</pre></section>
            <section><h4>변경 후</h4><pre aria-label="변경 후 유효성 설정" tabIndex={0}>{review.definition}</pre></section>
          </div>}
        {review.removes_validator && <p className="form-note">유효성 규칙이 제거됩니다.</p>}
        <p className="form-note">검토는 {review.expires_seconds / 60}분 동안 유효합니다.</p>
        {environment === "PROD" && <label className="field">운영 환경 확인<input required placeholder="PROD"
          autoComplete="off" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      </> : <fieldset className="mongo-namespace-fields" disabled={busy}>
        {validation ? <p className="confirm-copy"><strong>{environment}</strong> · {database}.{name}</p> : <>
          <label className="field">생성 유형<select aria-label="생성 유형" value={kind} onChange={event => setKind(event.target.value as Kind)}>
            <option value="collection">컬렉션</option>
            <option value="view">뷰</option>
          </select></label>
          <div className="mongo-sort">
            <label className="field">데이터베이스 이름<input required value={database} maxLength={63}
              onChange={event => setDatabase(event.target.value)} /></label>
            <label className="field">{kind === "view" ? "뷰 이름" : "컬렉션 이름"}<input required value={name} maxLength={256}
              onChange={event => setName(event.target.value)} /></label>
          </div>
        </>}
        {kind === "collection" ? <>
          <p className="form-note">{validation ? "규칙을 제거하려면 입력을 비우세요." : "새 데이터베이스 이름을 입력하면 첫 컬렉션과 함께 생성됩니다."}</p>
          <label className="field">유효성 규칙 (선택, Extended JSON)<textarea className="mongo-edit-input" spellCheck={false}
            rows={5} maxLength={65536} placeholder={'{"$jsonSchema":{"required":["name"]}}'} value={validator}
            onChange={event => setValidator(event.target.value)} /></label>
          {(validation || validator.trim()) && <div className="mongo-sort">
            <label className="field">검사 범위<select value={level} onChange={event => setLevel(event.target.value)}>
              <option value="strict">모든 삽입과 수정</option>
              <option value="moderate">삽입과 유효한 기존 문서의 수정</option>
              {validation && <option value="off">검사 안 함</option>}
              {validation?.settings.level === "constraint" && <option value="constraint">모든 문서가 규칙을 충족해야 함</option>}
            </select></label>
            <label className="field">규칙 위반 시<select value={action} onChange={event => setAction(event.target.value)}>
              <option value="error">쓰기 거부</option>
              <option value="warn">서버 로그에 경고</option>
              {validation?.settings.action === "errorAndLog" && <option value="errorAndLog">쓰기 거부 및 서버 로그에 경고</option>}
            </select></label>
          </div>}
        </> : <>
          <label className="field">원본 컬렉션 또는 뷰 이름<input required value={source} maxLength={256}
            onChange={event => setSource(event.target.value)} /></label>
          <label className="field">뷰 파이프라인 (Extended JSON 배열)<textarea required className="mongo-edit-input" spellCheck={false}
            rows={5} maxLength={65536} value={pipeline} onChange={event => setPipeline(event.target.value)} /></label>
          <p className="form-note">같은 데이터베이스의 원본을 사용합니다. 뷰 정의를 조회할 수 있는 계정에 파이프라인 내용이 표시됩니다.</p>
        </>}
      </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {review && <button type="button" className="secondary" disabled={busy} onClick={edit}>입력 수정</button>}
        <button type="submit" className="primary" disabled={busy || awaitingConfirmation}>
          {busy ? "처리 중…" : `${operation} ${review ? "적용" : "검토"}`}
        </button>
      </div>
    </form>
  </Dialog>;
}
