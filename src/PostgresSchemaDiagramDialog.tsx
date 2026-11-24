import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SchemaDiagramDialog } from "./SqlSchemaDiagramDialog";
import type { PostgresSearchHit } from "./PostgresSearchDialog";
import type { DiagramTable } from "./sqlSchemaDiagram";
import type { ForeignKeyInfo } from "./SqlSchemaDetails";

export type PostgresDiagramTable = Pick<PostgresSearchHit, "id" | "schema_id" | "schema" | "name" | "kind">;
type Diagram = {
  tables: (PostgresDiagramTable & Pick<DiagramTable, "columns" | "label">)[];
  foreign_keys: (Omit<ForeignKeyInfo, "target_table"> & { source: number; target: number })[];
};

const identifierKey = (identifier: string) => identifier;

export function PostgresSchemaDiagramDialog({ id, schema, connection, initialObject, onOpen, onClose }: {
  id: string;
  schema: { id: number; name: string };
  connection: string;
  initialObject: number | null;
  onOpen: (table: PostgresDiagramTable) => void;
  onClose: () => void;
}) {
  const load = useCallback(async () => {
    const response = await invoke<Diagram>("postgres_schema_diagram", { id, schema: schema.id });
    const tables = new Map(response.tables.map(table => [table.id, {
      name: String(table.id), displayTable: table, label: table.label, columns: table.columns, foreign_keys: [] as ForeignKeyInfo[],
    }]));
    for (const { source, target, ...key } of response.foreign_keys) {
      tables.get(source)?.foreign_keys.push({ ...key, target_table: String(target) });
    }
    return [...tables.values()];
  }, [id, schema.id]);

  return <SchemaDiagramDialog title="PostgreSQL 관계도" connection={`${connection} · ${schema.name}`}
    initialTable={initialObject === null ? null : String(initialObject)} identifierKey={identifierKey}
    scopeNote="선택한 스키마와 직접 연결된 다른 스키마의 테이블 중 조회 권한이 있는 테이블을 표시합니다."
    load={load} onOpen={table => onOpen(table.displayTable)} onClose={onClose} />;
}
