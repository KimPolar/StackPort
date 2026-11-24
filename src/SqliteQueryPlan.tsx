import { GitBranch, X } from "lucide-react";

type Step = { id: number; parent: number; detail: string; kind: "scan" | "search" | "temporary" | "other" };
export type QueryPlan = { steps: Step[]; truncated: boolean };

const stepNames = {
  scan: "스캔",
  search: "조건 검색",
  temporary: "임시 B-Tree",
  other: "실행 단계",
};

export function SqliteQueryPlan({ plan, dismiss }: { plan: QueryPlan; dismiss: () => void }) {
  const parents = new Map(plan.steps.map(step => [step.id, step.parent]));
  const counts = { scan: 0, search: 0, temporary: 0, other: 0 };
  const lines = plan.steps.map(step => {
    counts[step.kind]++;
    let parent = parents.get(step.id);
    let depth = 0;
    while (parent !== undefined && parent !== 0 && depth < 20) {
      const ancestor = parents.get(parent);
      if (ancestor === undefined) break;
      depth++;
      parent = ancestor;
    }
    return { step, depth };
  });

  return <section className="results-card sqlite-plan" aria-label="SQLite 실행 계획">
    <div className="panel-heading">
      <div><GitBranch size={16} /><strong>SQLite 실행 계획</strong></div>
      <button className="icon-button" aria-label="실행 계획 닫기" onClick={dismiss}><X size={16} /></button>
    </div>
    <p className="sqlite-plan-summary">스캔 {counts.scan}개 · 조건 검색 {counts.search}개 · 임시 B-Tree {counts.temporary}개</p>
    <ol className="sqlite-plan-steps">
      {lines.map(({ step, depth }) => <li key={step.id} style={{ paddingInlineStart: 12 + 16 * Math.min(depth, 8) }}>
        {depth > 0 && <span aria-hidden="true" className="sqlite-plan-branch">└</span>}
        <span className={`sqlite-plan-kind ${step.kind}`}>{stepNames[step.kind]}</span>
        <code>{step.detail}</code>
      </li>)}
    </ol>
    {plan.truncated && <p className="sqlite-plan-summary">처음 200개 단계만 표시합니다.</p>}
    <p className="sqlite-plan-summary">SQLite가 선택한 조회 계획입니다. 실행 시간과 실제 행 수는 측정하지 않았습니다.</p>
  </section>;
}
