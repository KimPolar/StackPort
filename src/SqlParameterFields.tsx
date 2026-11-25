import { useState } from "react";

export type SqlParameter = { index: number; name: string | null };
export type SqlParameterValue =
  | { kind: "null" }
  | { kind: "text" | "integer" | "real" | "blob"; value: string };
type SqliteParameterKind = SqlParameterValue["kind"];
type OracleParameterKind = SqliteParameterKind | "decimal";
type SqlServerParameterKind = OracleParameterKind | "boolean";
type Field<Kind extends SqlServerParameterKind> = { kind: Kind; value: string; masked: boolean };
type MaskedParameterValue<Kind extends SqlServerParameterKind> =
  | { kind: "null"; masked: false }
  | { kind: Exclude<Kind, "null">; value: string; masked: boolean };
export type SqlServerParameterValue = MaskedParameterValue<SqlServerParameterKind>;
export type OracleParameterValue = MaskedParameterValue<OracleParameterKind>;

const sqliteOptions: readonly (readonly [SqliteParameterKind, string])[] = [
  ["text", "텍스트"], ["integer", "정수"], ["real", "실수"], ["blob", "BLOB (16진수)"], ["null", "NULL"],
];
const sqlServerOptions: readonly (readonly [SqlServerParameterKind, string])[] = [
  ["text", "텍스트 (nvarchar)"], ["integer", "정수 (bigint)"], ["decimal", "소수 (decimal)"],
  ["real", "실수 (float)"], ["boolean", "참·거짓 (bit)"], ["blob", "바이너리 (16진수)"], ["null", "NULL"],
];
const oracleOptions: readonly (readonly [OracleParameterKind, string])[] = [
  ["text", "텍스트 (VARCHAR2)"], ["integer", "64비트 정수 (NUMBER)"], ["decimal", "십진수 (NUMBER)"],
  ["real", "실수 (BINARY_DOUBLE)"], ["blob", "RAW (16진수)"], ["null", "NULL"],
];
const encoder = new TextEncoder();

function maskedValues<Kind extends SqlServerParameterKind>(fields: Field<Kind>[]): MaskedParameterValue<Kind>[] {
  return fields.map(({ kind, value, masked }) => kind === "null"
    ? { kind: "null", masked: false } : { kind: kind as Exclude<Kind, "null">, value, masked });
}

function invalidValue(field: Field<SqlServerParameterKind>, allByteLimited: boolean): string | undefined {
  if (field.kind === "null") return;
  if ((allByteLimited || field.kind === "text") && encoder.encode(field.value).length > 16384) {
    return "값은 UTF-8 기준 16 KiB까지 입력할 수 있습니다.";
  }
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
  if (field.kind === "boolean" && !/^(?:true|false|1|0)$/.test(value)) return "true, false, 1 또는 0을 입력하세요.";
  if (field.kind === "decimal") {
    const parts = /^[+-]?(\d*)(?:\.(\d*))?$/.exec(value);
    const integer = parts?.[1] ?? "";
    const fraction = parts?.[2] ?? "";
    if (!parts || integer.length + fraction.length === 0 || integer.replace(/^0+/, "").length + fraction.length > 38) {
      return "소수는 지수 표기 없이 정수부와 소수부를 합해 최대 38자리로 입력하세요.";
    }
  }
}

export function SqlParameterFields({ parameters, submit, dismiss }: {
  parameters: SqlParameter[];
  submit: (values: SqlParameterValue[]) => void;
  dismiss: () => void;
}) {
  return <ParameterForm options={sqliteOptions} parameters={parameters} dismiss={dismiss}
    note="입력 값은 앱 실행 중 조회, 페이지 이동, 내보내기와 고정 쿼리 재실행에 사용합니다."
    submit={fields => submit(fields.map(({ kind, value }) => kind === "null" ? { kind } : { kind, value }))} />;
}

export function SqlServerParameterFields({ parameters, submit, dismiss }: {
  parameters: SqlParameter[];
  submit: (values: SqlServerParameterValue[]) => void;
  dismiss: () => void;
}) {
  return <ParameterForm options={sqlServerOptions} parameters={parameters} dismiss={dismiss} allByteLimited
    note="값을 SQL 본문과 분리해 서버로 전달합니다. 숨긴 값이 있으면 서버 오류 상세도 숨깁니다."
    submit={fields => submit(maskedValues(fields))} />;
}

export function OracleParameterFields({ parameters, submit, dismiss }: {
  parameters: SqlParameter[];
  submit: (values: OracleParameterValue[]) => void;
  dismiss: () => void;
}) {
  return <ParameterForm options={oracleOptions} parameters={parameters} dismiss={dismiss} allByteLimited
    note="같은 이름의 변수는 이 실행에서 같은 값을 사용합니다. 숨긴 값이 있으면 서버 오류 상세와 경고를 숨깁니다."
    submit={fields => submit(maskedValues(fields))} />;
}

function ParameterForm<Kind extends SqlServerParameterKind>({ parameters, options, note, allByteLimited = false, submit, dismiss }: {
  parameters: SqlParameter[];
  options: readonly (readonly [Kind, string])[];
  note: string;
  allByteLimited?: boolean;
  submit: (fields: Field<Kind>[]) => void;
  dismiss: () => void;
}) {
  const [fields, setFields] = useState<Field<Kind>[]>(() => parameters.map(() => ({ kind: options[0][0], value: "", masked: false })));
  const [error, setError] = useState("");

  function update(index: number, change: Partial<Field<Kind>>) {
    setError("");
    setFields(current => current.map((field, position) => position === index ? { ...field, ...change } : field));
  }

  return <form onSubmit={event => {
    event.preventDefault();
    for (let index = 0; index < fields.length; index++) {
      const reason = invalidValue(fields[index], allByteLimited);
      if (reason) {
        const parameter = parameters[index];
        setError(`${parameter.name ?? `?${parameter.index}`} · ${reason}`);
        return;
      }
    }
    submit(fields);
  }}>
    <p className="form-note">{note}</p>
    <div className="sql-parameters">
      {parameters.map((parameter, index) => {
        const field = fields[index];
        const label = parameter.name ?? `?${parameter.index}`;
        return <fieldset key={parameter.index}>
          <legend><code>{label}</code></legend>
          <div className="sql-parameter-row">
            <select aria-label={`${label} 형식`} value={field.kind} onChange={event => update(index, { kind: event.target.value as Kind })}>
              {options.map(([kind, description]) => <option value={kind} key={kind}>{description}</option>)}
            </select>
            {field.kind !== "null" && <>
              <input aria-label={`${label} 값`} autoComplete="off" spellCheck={false} type={field.masked ? "password" : "text"} maxLength={16384} value={field.value}
                required={field.kind !== "text" && field.kind !== "blob"} onChange={event => update(index, { value: event.target.value })} />
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
