import { invoke } from "@tauri-apps/api/core";
import { ResultFileDialog, type ExportDriver, type ExportOutcome, type ExportReport } from "./ResultExportDialog";
import type { TableQueryClauses } from "./TableQueryControls";

export type MysqlSqlBinding = { kind: "text" | "integer" | "real"; value: string } | { kind: "null" };
export type MysqlExportTarget =
  | { kind: "table"; database: string; table: string; clauses: TableQueryClauses }
  | { kind: "sql"; database: string | null; sql: string; parameters: MysqlSqlBinding[] };

export function MysqlResultExport({ id, profile, target, onClose, onExported }: {
  id: string;
  profile: { name: string; environment: string };
  target: MysqlExportTarget;
  onClose: () => void;
  onExported: (report: ExportReport) => void;
}) {
  const driver: ExportDriver = {
    prepare: async () => crypto.randomUUID(),
    run: (requestId, options) => invoke<ExportOutcome>("export_mysql", {
      id, requestId, source: target, options: { ...options, format: options.format.toLowerCase() },
    }),
    progress: requestId => invoke<number | null>("mysql_export_progress", { id, requestId }),
    cancel: requestId => invoke<boolean>("cancel_mysql_sql", { id, requestId }),
  };
  const source = target.kind === "table"
    ? `${target.database}.${target.table}에 적용한 필터와 정렬`
    : "마지막으로 실행한 SQL과 입력한 매개변수";
  return <ResultFileDialog profile={profile} source={source} driver={driver} onClose={onClose} onExported={onExported} />;
}
