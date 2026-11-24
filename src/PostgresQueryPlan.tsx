import { useState } from "react";

type Step = {
  depth: number; leaf: boolean; operation: string; parent_role: string | null;
  relation: string | null; schema: string | null; index: string | null;
  join_type: string | null; sort_method: string | null; sort_space: string | null;
  startup_cost: number | null; total_cost: number | null; estimated_rows: number | null;
  actual_rows: number | null; loops: number | null; actual_ms: number | null;
  shared_hits: number | null; shared_reads: number | null; temp_reads: number | null; temp_writes: number | null;
};

export type PostgresPlan = {
  analyzed: boolean;
  planning_ms: number | null;
  execution_ms: number | null;
  steps: Step[];
  truncated: boolean;
};

const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 });
const metric = (value: number | null) => value === null ? "—" : number.format(value);
const millis = (value: number | null) => value === null ? "—" : `${number.format(value)} ms`;

function relationName(step: Step) {
  return step.relation && [step.schema, step.relation].filter(Boolean).join(".");
}

function descriptions(step: Step) {
  return [relationName(step), step.index && `인덱스 ${step.index}`, step.join_type && `조인 ${step.join_type}`,
    step.sort_method && [step.sort_method, step.sort_space].filter(Boolean).join(" · "), step.parent_role].filter(Boolean);
}

function bufferCounts(step: Step) {
  return [step.shared_hits === null ? null : `공유 캐시 ${metric(step.shared_hits)}`,
    step.shared_reads === null ? null : `공유 읽기 ${metric(step.shared_reads)}`,
    step.temp_reads === null ? null : `임시 읽기 ${metric(step.temp_reads)}`,
    step.temp_writes === null ? null : `임시 쓰기 ${metric(step.temp_writes)}`].filter(Boolean).join(" · ");
}

function slowestLeaf(steps: Step[]) {
  let index = -1;
  let duration = 0;
  steps.forEach((step, position) => {
    const elapsed = (step.actual_ms ?? 0) * (step.loops ?? 0);
    if (step.leaf && elapsed > duration) { index = position; duration = elapsed; }
  });
  return index;
}

function noteworthyEstimate(step: Step) {
  return !!step.loops && step.actual_rows !== null && step.estimated_rows !== null
    && Math.max(step.actual_rows, step.estimated_rows) >= 10 * Math.max(1, Math.min(step.actual_rows, step.estimated_rows));
}

export function PostgresQueryPlan({ plan }: { plan: PostgresPlan }) {
  const [view, setView] = useState<"steps" | "text">("steps");
  const longest = slowestLeaf(plan.steps);
  const maxCost = Math.max(1, ...plan.steps.map(step => step.total_cost ?? 0));

  return <section className="results-card postgres-plan" aria-label="PostgreSQL 실행 계획">
    <div className="panel-heading">
      <strong>{plan.analyzed ? "실행 분석" : "예상 실행 계획"}</strong>
      <div className="postgres-result-views" role="group" aria-label="계획 표시 방식">
        <button type="button" className="secondary small" aria-pressed={view === "steps"} onClick={() => setView("steps")}>단계</button>
        <button type="button" className="secondary small" aria-pressed={view === "text"} onClick={() => setView("text")}>텍스트</button>
      </div>
    </div>
    <p className="form-note postgres-page-note">
      {plan.steps.length}단계 · 계획 수립 {millis(plan.planning_ms)}{plan.analyzed && ` · 서버 실행 ${millis(plan.execution_ms)}`}
    </p>
    {view === "steps" ? <div className="table-wrap" role="region" tabIndex={0} aria-label="PostgreSQL 계획 스크롤">
      <table aria-label="PostgreSQL 실행 단계"><thead><tr>
        <th scope="col">단계</th>
        <th scope="col">예상 행</th>
        <th scope="col">시작 / 총 비용</th>
        {plan.analyzed && <><th scope="col">실제 행 / 회</th><th scope="col">루프</th><th scope="col">시간 / 회</th><th scope="col">버퍼 블록</th></>}
      </tr></thead><tbody>
        {plan.steps.map((step, index) => <tr key={index} data-highlight={index === longest}>
          <th scope="row" style={{ paddingInlineStart: 12 + 14 * Math.min(step.depth, 10) }}>
            {step.depth > 0 && <span className="postgres-plan-branch" aria-hidden>└ </span>}
            <strong>{step.operation}</strong>
            {descriptions(step).length > 0 && <small>{descriptions(step).join(" · ")}</small>}
            {index === longest && <small className="postgres-plan-mark">가장 오래 걸린 리프 단계</small>}
            {noteworthyEstimate(step) && <small className="postgres-plan-mark">예상과 실제 행 수 차이</small>}
          </th>
          <td>{metric(step.estimated_rows)}</td>
          <td>{metric(step.startup_cost)} / {metric(step.total_cost)}
            {step.total_cost !== null && <meter aria-label="다른 단계 대비 총 비용" min={0} max={maxCost} value={step.total_cost} />}</td>
          {plan.analyzed && <><td>{metric(step.actual_rows)}</td><td>{metric(step.loops)}</td><td>{millis(step.actual_ms)}</td><td>{bufferCounts(step) || "—"}</td></>}
        </tr>)}
      </tbody></table>
    </div> : <pre className="postgres-plan-text" tabIndex={0} aria-label="PostgreSQL 계획 텍스트">
      {plan.steps.map(step => {
        const target = descriptions(step).join(" · ");
        const actual = plan.analyzed ? ` · 실제 ${metric(step.actual_rows)}행 / 회 · 루프 ${metric(step.loops)} · ${millis(step.actual_ms)} / 회` : "";
        const buffers = bufferCounts(step);
        return `${"  ".repeat(step.depth)}${step.operation}${target ? ` (${target})` : ""} · 예상 ${metric(step.estimated_rows)}행 · 비용 ${metric(step.startup_cost)} / ${metric(step.total_cost)}${actual}${buffers ? ` · ${buffers}` : ""}`;
      }).join("\n")}
    </pre>}
    {plan.truncated && <p className="form-note postgres-page-note">계획의 앞부분을 표시합니다. 최대 200단계와 24단계 깊이까지 표시할 수 있습니다.</p>}
  </section>;
}
