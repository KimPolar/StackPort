import { useState } from "react";

export type SqlParameter = { index: number; name: string | null };
export type SqlParameterValue =
  | { kind: "null" }
  | { kind: "text" | "integer" | "real" | "blob"; value: string };
type Field = { kind: SqlParameterValue["kind"]; value: string; masked: boolean };

function invalidValue(field: Field): string | undefined {
  const value = field.value.trim();
  if (field.kind === "integer") {
    if (!/^[+-]?\d+$/.test(value)) return "정수를 입력하세요.";
    const number = BigInt(value);
    if (number < -(1n << 63n) || number >= 1n << 63n) return "64비트 정수 범위를 확인하세요.";
  }
  if (field.kind === "real" && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)))) {
    return "유한한 실수를 입력하세요.";
  }
  if (field.kind === "blob" && !/^(?:[a-f\d]{2})*$/i.test(value)) return "짝수 자리의 16진수를 입력하세요.";
  if (field.kind === "text" && new TextEncoder().encode(field.value).length > 16384) return "텍스트 값은 16 KiB까지 입력할 수 있습니다.";
}

export function SqlParameterFields({ parameters, submit, dismiss }: {
  parameters: SqlParameter[];
  submit: (values: SqlParameterValue[]) => void;
  dismiss: () => void;
}) {
  const [fields, setFields] = useState<Field[]>(() => parameters.map(() => ({ kind: "text", value: "", masked: false })));
  const [error, setError] = useState("");

  function update(index: number, change: Partial<Field>) {
    setError("");
    setFields(current => current.map((field, position) => position === index ? { ...field, ...change } : field));
  }

  return <form onSubmit={event => {
    event.preventDefault();
    for (let index = 0; index < fields.length; index++) {
      const reason = invalidValue(fields[index]);
      if (reason) {
        const parameter = parameters[index];
        setError(`${parameter.name ?? `?${parameter.index}`} · ${reason}`);
        return;
      }
    }
    submit(fields.map(({ kind, value }) => kind === "null" ? { kind } : { kind, value }));
  }}>
    <p className="form-note">입력 값은 현재 조회와 페이지 이동에만 사용합니다.</p>
    <div className="sql-parameters">
      {parameters.map((parameter, index) => {
        const field = fields[index];
        const label = parameter.name ?? `?${parameter.index}`;
        return <fieldset key={parameter.index}>
          <legend><code>{label}</code></legend>
          <div className="sql-parameter-row">
            <select aria-label={`${label} 형식`} value={field.kind} onChange={event => update(index, { kind: event.target.value as Field["kind"] })}>
              <option value="text">텍스트</option>
              <option value="integer">정수</option>
              <option value="real">실수</option>
              <option value="blob">BLOB (16진수)</option>
              <option value="null">NULL</option>
            </select>
            {field.kind !== "null" && <>
              <input aria-label={`${label} 값`} autoComplete="off" spellCheck={false} type={field.masked ? "password" : "text"} maxLength={16384} value={field.value} required={field.kind === "integer" || field.kind === "real"} onChange={event => update(index, { value: event.target.value })} />
              <label><input aria-label={`${label} 값 숨기기`} type="checkbox" checked={field.masked} onChange={event => update(index, { masked: event.target.checked })} /> 숨기기</label>
            </>}
          </div>
        </fieldset>;
      })}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="secondary" onClick={dismiss}>취소</button>
      <button type="submit" className="primary">매개변수로 실행</button>
    </div>
  </form>;
}
