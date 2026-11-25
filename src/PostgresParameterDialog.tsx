import { useState } from "react";
import { Dialog } from "./Dialog";
import { SqlParameterSets, type ParameterInput, type ParameterSetScope } from "./SqlParameterSets";

export type PostgresParameter = { index: number; oid: number; data_type: string };
type ParameterValue = { kind: "null" } | { kind: "text"; value: string };
export type PostgresBindings = { types: number[]; values: ParameterValue[] };
type Input = ParameterInput<"text" | "null">;
const limit = 16 * 1024;
const encoder = new TextEncoder();

export function PostgresParameterDialog({ parameters, title, error, running, cancelStatus, setScope, onSubmit, onClose, onCancelQuery }: {
  parameters: PostgresParameter[];
  title: string;
  error: string | null;
  running: boolean;
  cancelStatus: string;
  setScope?: ParameterSetScope;
  onSubmit: (bindings: PostgresBindings) => void;
  onClose: () => void;
  onCancelQuery: () => void;
}) {
  const [fields, setFields] = useState<Input[]>(() => parameters.map(() => ({ kind: "text", value: "", masked: false })));
  const [localError, setLocalError] = useState("");
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const cannotSubmit = running || Boolean(setScope && readyKey !== setScope.key) || fields.some(field => field.needsValue);

  function update(index: number, change: Partial<Input>) {
    setLocalError("");
    setFields(current => current.map((field, offset) => offset === index ? { ...field, ...change } : field));
  }

  return <Dialog title="PostgreSQL 매개변수" onClose={onClose} busy={running}>
    <form aria-busy={running} onSubmit={event => {
      event.preventDefault();
      if (cannotSubmit) return;
      const invalid = fields.findIndex(field => field.kind === "text" &&
        (field.value.includes("\0") || encoder.encode(field.value).length > limit));
      if (invalid !== -1) {
        setLocalError(`$${parameters[invalid].index} 값은 NUL 문자 없이 16 KiB 이하여야 합니다.`);
        return;
      }
      setLocalError("");
      onSubmit({
        types: parameters.map(parameter => parameter.oid),
        values: fields.map(({ kind, value }) => kind === "null" ? { kind } : { kind, value }),
      });
    }}>
      <p className="form-note"><strong>{title}</strong> · 값을 SQL 본문과 분리해 서버로 전달합니다.</p>
      {setScope && <SqlParameterSets scope={setScope} fields={fields} allowedKinds={["text", "null"]} disabled={running}
        onReady={() => setReadyKey(setScope.key)}
        apply={values => { setFields(values); setLocalError(""); }} />}
      <div className="sql-parameters">
        {parameters.map((parameter, index) => {
          const label = `$${parameter.index}`;
          const field = fields[index];
          const valueProps = {
            "aria-label": `${label} 값`, value: field.value, maxLength: limit,
            spellCheck: false, autoComplete: "off",
          };
          return <fieldset key={parameter.index} disabled={running}>
            <legend><code>{label}</code> · {parameter.data_type}</legend>
            <div className="sql-parameter-row postgres-param-controls">
              <select aria-label={`${label} 형식`} value={field.kind}
                onChange={event => update(index, { kind: event.target.value as Input["kind"], needsValue: false })}>
                <option value="text">값 입력</option><option value="null">NULL</option>
              </select>
              {field.kind !== "null" && <>
                {field.masked
                  ? <input type="password" {...valueProps} onChange={event => update(index, { value: event.target.value, needsValue: false })} />
                  : <textarea rows={1} autoFocus={index === 0} {...valueProps}
                      onChange={event => update(index, { value: event.target.value, needsValue: false })} />}
                <label><input type="checkbox" aria-label={`${label} 값 숨기기`} checked={field.masked}
                  onChange={event => update(index, { masked: event.target.checked })} /> 숨기기</label>
              </>}
            </div>
          </fieldset>;
        })}
      </div>
      {!running && (localError || error) && <p className="form-error" role="alert">{localError || error}</p>}
      {running && <p className="form-note" role="status">{cancelStatus || "매개변수로 쿼리 실행 중…"}</p>}
      <div className="dialog-actions">
        {running ? <button type="button" className="secondary" disabled={cancelStatus === "취소 요청 중…"}
          onClick={onCancelQuery}>쿼리 취소</button> : <button type="button" className="secondary" onClick={onClose}>취소</button>}
        <button type="submit" className="primary" disabled={cannotSubmit}>매개변수로 실행</button>
      </div>
    </form>
  </Dialog>;
}
