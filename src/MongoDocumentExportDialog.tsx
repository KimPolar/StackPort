import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ResultFileDialog, type ExportDriver, type ExportOutcome, type ExportReport } from "./ResultExportDialog";

export type MongoDocumentQuery = {
  filter: string;
  projection: string;
  sort_field: string;
  descending: boolean;
  page: number;
};

function projectedFields(projection: string): string {
  try {
    const entries = Object.entries(JSON.parse(projection.trim() || "{}"));
    const fields = entries.filter(([field, value]) => field !== "_id" && (value === true || value === 1))
      .map(([field]) => field);
    if (!entries.some(([field, value]) => field === "_id" && (value === false || value === 0))) fields.unshift("_id");
    return fields.join("\n");
  } catch {
    return "_id";
  }
}

export function MongoDocumentExportDialog({ profile, target, query, onBusy, onClose, onExported }: {
  profile: { name: string; environment: string };
  target: { id: string; database: string; collection: string };
  query: MongoDocumentQuery;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onExported: (report: ExportReport) => void;
}) {
  const [fields, setFields] = useState(() => projectedFields(query.projection));
  const driver: ExportDriver = {
    prepare: () => invoke<string>("prepare_query"),
    run: (token, options) => invoke<ExportOutcome>("export_mongo_documents", {
      ...target, token,
      input: {
        query,
        options: { ...options, format: options.format.toLowerCase() },
        fields: options.format === "CSV" ? fields.split(/\r?\n/).map(field => field.trim()).filter(Boolean) : [],
      },
    }),
    progress: token => invoke<number | null>("result_export_progress", { token }),
    cancel: token => invoke<boolean>("cancel_query", { token }),
  };
  return <ResultFileDialog profile={profile} source={target.database + "." + target.collection + "의 적용된 필터, 표시 필드, 정렬"}
    driver={driver} onClose={onClose} onExported={onExported} onBusy={onBusy} initialFormat="JSON"
    formatOptions={(format, busy) => format === "JSON" ? <p className="form-note">Canonical Extended JSON 배열로 BSON 타입을 보존합니다.</p> : <>
      <label className="field">CSV 필드 경로<textarea required disabled={busy} rows={4} value={fields} maxLength={16448}
        onChange={event => setFields(event.target.value)} /></label>
      <p className="form-note">한 줄에 한 필드 경로를 입력하세요. 점으로 하위 필드와 배열 위치를 지정합니다. CSV에서는 BSON 타입 정보가 일부 손실됩니다.</p>
    </>} />;
}
