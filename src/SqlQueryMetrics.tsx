import type { QueryMetrics } from "./sqlResults";

const metricLabels = {
  elapsed_micros: "페이지 조회 시간",
  rows_read: "읽은 결과 행",
  fullscan_steps: "전체 스캔 단계",
  sort_operations: "정렬 작업",
  autoindex_rows: "자동 인덱스에 추가한 행",
  vm_steps: "가상 머신 단계",
} satisfies Record<keyof QueryMetrics, string>;

const metricKeys = Object.keys(metricLabels) as (keyof QueryMetrics)[];
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 });
const signedNumber = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3, signDisplay: "exceptZero" });

function formatMetric(key: keyof QueryMetrics, value: number | null, signed = false) {
  if (value === null) return "—";
  const formatter = signed ? signedNumber : number;
  return key === "elapsed_micros" ? `${formatter.format(value / 1000)} ms` : formatter.format(value);
}

export function SqlQueryMetrics({ metrics }: { metrics: QueryMetrics }) {
  return <details className="sql-query-metrics">
    <summary>실행 통계 <span>{formatMetric("elapsed_micros", metrics.elapsed_micros)}</span></summary>
    <dl aria-label="SQLite 실행 통계">{metricKeys.map(key => <div key={key}>
      <dt>{metricLabels[key]}</dt><dd>{formatMetric(key, metrics[key])}</dd>
    </div>)}</dl>
    <p>SQLite가 이 페이지를 조회하고 결과를 구성하는 데 걸린 시간입니다. 읽은 행에는 다음 페이지 확인용 행이 포함됩니다.</p>
  </details>;
}

export function SqlQueryMetricsComparison({ before, after }: { before: QueryMetrics; after: QueryMetrics }) {
  return <details className="sql-query-metrics-comparison">
    <summary>실행 통계 비교</summary>
    <div className="table-wrap sql-result-differences">
      <table aria-label="SQLite 실행 통계 비교">
        <thead><tr><th scope="col">항목</th><th scope="col">기준</th><th scope="col">비교</th><th scope="col">차이</th></tr></thead>
        <tbody>{metricKeys.map(key => {
          const baseline = before[key];
          const measured = after[key];
          const difference = baseline === null || measured === null ? null : measured - baseline;
          return <tr key={key}><th scope="row">{metricLabels[key]}</th>
            <td>{formatMetric(key, baseline)}</td><td>{formatMetric(key, measured)}</td>
            <td>{formatMetric(key, difference, true)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </details>;
}
