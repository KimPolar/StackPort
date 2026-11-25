import { useState } from "react";

type Step = {
  depth: number;
  operation: string;
  relation: string | null;
  index: string | null;
  cost: number | null;
  estimated_rows: number | null;
  actual_rows: number | null;
  loops: number | null;
  time_ms: number | null;
};

export type MysqlPlan = { analyzed: boolean; time_per_loop: boolean; steps: Step[]; truncated: boolean };

const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 });
const metric = (value: number | null) => value === null ? "—" : number.format(value);
const target = (step: Step) => [step.relation, step.index].filter(Boolean).join(" · ");

function slowestLeaf(plan: MysqlPlan) {
  let selected = -1;
  let longest = 0;
  plan.steps.forEach((step, index) => {
    const next = plan.steps[index + 1];
    if (step.time_ms === null || (next && next.depth > step.depth)) return;
    const time = step.time_ms * (plan.time_per_loop ? step.loops ?? 1 : 1);
    if (time > longest) {
      longest = time;
      selected = index;
    }
  });
  return selected;
}

export function MysqlQueryPlan({ plan }: { plan: MysqlPlan }) {
  const [view, setView] = useState<"tree" | "text">("tree");
  const slowest = plan.analyzed ? slowestLeaf(plan) : -1;
  const timeLabel = plan.time_per_loop ? "시간 / 회 (ms)" : "누적 시간 (ms)";
  const maxCost = Math.max(1, ...plan.steps.map(step => step.cost ?? 0));

  return <section className="mysql-plan" aria-label="MySQL 실행 계획">
    <div className="panel-heading">
      <strong>{plan.analyzed ? "실행 분석" : "예상 실행 계획"}</strong>
      <div className="mysql-plan-views" role="group" aria-label="계획 표시 방식">
        <button type="button" className="secondary small" aria-pressed={view === "tree"} onClick={() => setView("tree")}>단계 트리</button>
        <button type="button" className="secondary small" aria-pressed={view === "text"} onClick={() => setView("text")}>텍스트</button>
      </div>
    </div>
    <p className="form-note mysql-table-note">{plan.steps.length}단계{plan.truncated && " · 앞 200단계, 깊이 24까지 표시"}</p>
    {view === "tree" ? <div className="table-wrap" role="region" tabIndex={0} aria-label="MySQL 계획 스크롤">
      <table aria-label="MySQL 실행 단계"><thead><tr>
        <th scope="col">단계</th><th scope="col">예상 행 / 회</th><th scope="col">비용</th>
        {plan.analyzed && <><th scope="col">실제 행 / 회</th><th scope="col">루프</th><th scope="col">{timeLabel}</th></>}
      </tr></thead><tbody>
        {plan.steps.map((step, index) => <tr key={index} data-highlight={index === slowest}>
          <th scope="row" style={{ paddingInlineStart: 12 + 14 * Math.min(step.depth, 10) }}>
            {step.depth > 0 && <span aria-hidden>└ </span>}<strong>{step.operation}</strong>
            {target(step) && <small>{target(step)}</small>}
            {index === slowest && <small className="mysql-plan-mark">누적 시간이 가장 긴 리프 단계</small>}
          </th>
          <td>{metric(step.estimated_rows)}</td>
          <td>{metric(step.cost)}{step.cost !== null && <meter aria-label="다른 단계 대비 비용" min={0} max={maxCost} value={step.cost} />}</td>
          {plan.analyzed && <><td>{metric(step.actual_rows)}</td><td>{metric(step.loops)}</td><td>{metric(step.time_ms)}</td></>}
        </tr>)}
      </tbody></table>
    </div> : <pre tabIndex={0} aria-label="MySQL 계획 텍스트">
      {plan.steps.map(step => {
        const name = target(step);
        const actual = plan.analyzed ? ` · 실제 ${metric(step.actual_rows)}행 / 회 · 루프 ${metric(step.loops)} · ${timeLabel} ${metric(step.time_ms)}` : "";
        return `${"  ".repeat(step.depth)}${step.operation}${name ? ` (${name})` : ""} · 예상 ${metric(step.estimated_rows)}행 / 회 · 비용 ${metric(step.cost)}${actual}`;
      }).join("\n")}
    </pre>}
  </section>;
}
