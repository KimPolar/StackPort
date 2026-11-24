import { sqliteNameKey } from "./sqlCompletion";
import type { ForeignKeyInfo } from "./SqlSchemaDetails";

export type DiagramTable = {
  name: string;
  columns: { name: string; declared_type: string; primary_key_position: number }[];
  foreign_keys: ForeignKeyInfo[];
};

export type DiagramRelationship = {
  id: number;
  source: string;
  target: string;
  issue: "missing_table" | "missing_columns" | null;
  fields: { source: string; target: string | null }[];
  onDelete: string;
  onUpdate: string;
};

export function indexSchemaDiagram(tables: DiagramTable[]) {
  const byName = new Map(tables.map(table => [sqliteNameKey(table.name), table]));
  const columns = new Map(tables.map(table => [table.name, new Map(table.columns.map(column => [sqliteNameKey(column.name), column.name]))]));
  const primaryKeys = new Map(tables.map(table => [table.name,
    new Map(table.columns.filter(column => column.primary_key_position > 0)
      .map(column => [column.primary_key_position, column.name]))]));
  const relationships = new Map<string, DiagramRelationship[]>(tables.map(table => [table.name, []]));
  for (const table of tables) {
    const groups = new Map<number, ForeignKeyInfo[]>();
    for (const key of table.foreign_keys) {
      const group = groups.get(key.id);
      if (group) group.push(key);
      else groups.set(key.id, [key]);
    }
    for (const [id, group] of groups) {
      const first = group[0];
      const target = byName.get(sqliteNameKey(first.target_table));
      const targetColumns = target && columns.get(target.name);
      const targetKey = target && primaryKeys.get(target.name);
      let unresolved = false;
      const fields = group.sort((a, b) => a.sequence - b.sequence).map(key => {
        const resolved = key.to_column === null
          ? targetKey?.size === group.length ? targetKey.get(key.sequence + 1) : undefined
          : targetColumns?.get(sqliteNameKey(key.to_column));
        unresolved ||= resolved === undefined;
        return { source: columns.get(table.name)?.get(sqliteNameKey(key.from_column)) ?? key.from_column,
          target: resolved ?? key.to_column };
      });
      const relationship: DiagramRelationship = {
        id, source: table.name, target: target?.name ?? first.target_table,
        issue: !target ? "missing_table" : unresolved ? "missing_columns" : null,
        fields, onDelete: first.on_delete, onUpdate: first.on_update,
      };
      relationships.get(table.name)?.push(relationship);
      if (target && target.name !== table.name) relationships.get(target.name)?.push(relationship);
    }
  }
  return { byName, relationships };
}

export const diagramCard = { width: 220, height: 150 };

export function layoutSchemaDiagram(selected: string, relationships: readonly DiagramRelationship[]) {
  const neighbors = new Map<string, { name: string; missing: boolean; incoming: boolean; outgoing: boolean }>();
  let self = false;
  for (const relationship of relationships) {
    if (relationship.source === selected && relationship.target === selected) {
      self = true;
      continue;
    }
    const outgoing = relationship.source === selected;
    const name = outgoing ? relationship.target : relationship.source;
    const key = sqliteNameKey(name);
    const neighbor = neighbors.get(key) ?? { name, missing: false, incoming: false, outgoing: false };
    neighbor.missing ||= relationship.issue === "missing_table" && outgoing;
    if (outgoing) neighbor.outgoing = true;
    else neighbor.incoming = true;
    neighbors.set(key, neighbor);
  }
  const sorted = [...neighbors.values()].sort((a, b) => a.name.localeCompare(b.name));
  const left = sorted.filter(neighbor => !neighbor.outgoing);
  const right = sorted.filter(neighbor => neighbor.outgoing);
  const margin = 18;
  const columnGap = 64;
  const top = self ? 38 : margin;
  const rowStep = diagramCard.height + 14;
  const rows = Math.max(1, left.length, right.length);
  const x = margin + (left.length ? diagramCard.width + columnGap : 0);
  const y = top + Math.floor((rows - 1) / 2) * rowStep;
  const neighborCard = (neighbor: typeof sorted[number], index: number, leftSide: boolean) => {
    const neighborX = x + (leftSide ? -1 : 1) * (diagramCard.width + columnGap);
    const neighborY = top + index * rowStep;
    const originX = leftSide ? neighborX + diagramCard.width : x + diagramCard.width;
    const endX = originX + columnGap;
    const fromY = (leftSide ? neighborY : y) + diagramCard.height / 2;
    const toY = (leftSide ? y : neighborY) + diagramCard.height / 2;
    const middleX = originX + columnGap / 2;
    return {
      ...neighbor, x: neighborX, y: neighborY, reverse: !leftSide && neighbor.incoming,
      path: `M ${originX} ${fromY} C ${middleX} ${fromY}, ${middleX} ${toY}, ${endX} ${toY}`,
    };
  };
  const loopFrom = x + diagramCard.width * .28;
  const loopTo = x + diagramCard.width * .72;
  return {
    center: { x, y },
    width: x + diagramCard.width + (right.length ? diagramCard.width + columnGap : 0) + margin,
    height: top + (rows - 1) * rowStep + diagramCard.height + margin,
    neighbors: [...left.map((node, i) => neighborCard(node, i, true)), ...right.map((node, i) => neighborCard(node, i, false))],
    loop: self ? `M ${loopFrom} ${y} C ${loopFrom} ${y - 35}, ${loopTo} ${y - 35}, ${loopTo} ${y}` : null,
  };
}
