import { useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "./Dialog";

const operators = {
  eq: "같음", ne: "다름", gt: "초과", gte: "이상", lt: "미만", lte: "이하",
  in: "목록에 있음", nin: "목록에 없음", exists: "필드 존재 여부",
};
type Operator = keyof typeof operators;
type Mode = "all" | "any";
type Format = "text" | "json";
type Predicate = { key: number; kind: "predicate"; field: string; operator: Operator; format: Format; value: string; present: boolean };
type Group = { key: number; kind: "group"; mode: Mode; children: Node[] };
type Node = Group | Predicate;
export type MongoFindState = { root: Group; base: string; combine: boolean; compiled: string };

const maxDepth = 4;
const maxNodes = 64;
const condition = (key: number): Predicate => ({ key, kind: "predicate", field: "", operator: "eq", format: "text", value: "", present: true });
const initialGroup: Group = { key: 0, kind: "group", mode: "all", children: [condition(1)] };

function highestKey(node: Node): number {
  return node.kind === "group" ? Math.max(node.key, ...node.children.map(highestKey)) : node.key;
}

function nodeCount(node: Node): number {
  return node.kind === "group" ? 1 + node.children.reduce((total, child) => total + nodeCount(child), 0) : 1;
}

function listOperator(operator: Operator) {
  return operator === "in" || operator === "nin";
}

type WireNode = { kind: "group"; mode: Mode; children: WireNode[] }
  | { kind: "predicate"; field: string; operator: Operator; value: { format: Format; value: string } | { format: "boolean"; value: boolean } };

function wireNode(node: Node): WireNode {
  if (node.kind === "group") return { kind: node.kind, mode: node.mode, children: node.children.map(wireNode) };
  const { kind, field, operator } = node;
  return { kind, field, operator, value: operator === "exists" ? { format: "boolean", value: node.present }
    : { format: listOperator(operator) ? "json" : node.format, value: node.value } };
}

export function MongoFindBuilder({ filter, saved, onClose, onApply }: {
  filter: string; saved?: MongoFindState; onClose: () => void; onApply: (built: MongoFindState) => void;
}) {
  const starting = saved?.compiled === filter ? saved : undefined;
  const [root, setRoot] = useState(starting?.root ?? initialGroup);
  const base = starting?.base ?? filter;
  const hasBase = Boolean(base.trim() && base.trim() !== "{}");
  const [combine, setCombine] = useState(starting?.combine ?? hasBase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const nextKey = useRef(highestKey(starting?.root ?? initialGroup) + 1);

  async function apply(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const compiled = await invoke<string>("build_mongo_find_filter", { node: wireNode(root), base: combine ? base : "" });
      onApply({ root, base, combine, compiled });
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false; setBusy(false);
    }
  }

  return <Dialog title="MongoDB 찾기 빌더" className="restore-dialog mongo-find-dialog" onClose={onClose} busy={busy}>
    <form onSubmit={event => void apply(event)}>
      <fieldset className="mongo-find-fields" disabled={busy}>
        <GroupEditor group={root} depth={0} available={maxNodes - nodeCount(root)} allocate={() => nextKey.current++} onChange={setRoot} />
        {hasBase && <label className="mongo-find-combine"><input type="checkbox" checked={combine}
          onChange={event => setCombine(event.target.checked)} /> 기존 필터도 함께 적용</label>}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>취소</button>
        <button type="submit" className="primary" disabled={busy}>조회 적용</button>
      </div>
    </form>
  </Dialog>;
}

function GroupEditor({ group, depth, available, allocate, onChange }: {
  group: Group; depth: number; available: number; allocate: () => number; onChange: (group: Group) => void;
}) {
  function replace(key: number, node: Node) {
    onChange({ ...group, children: group.children.map(child => child.key === key ? node : child) });
  }
  function remove(key: number) {
    onChange({ ...group, children: group.children.filter(child => child.key !== key) });
  }
  return <fieldset className="mongo-find-group">
    <legend>{depth === 0 ? "검색 조건" : "하위 그룹"}</legend>
    <label className="field mongo-find-mode">일치 방식<select value={group.mode}
      onChange={event => onChange({ ...group, mode: event.target.value as Mode })}>
      <option value="all">모두 일치 (AND)</option><option value="any">하나 이상 일치 (OR)</option>
    </select></label>
    <ol className="mongo-find-children">{group.children.map(child => <li key={child.key}>
      {child.kind === "group" ? <GroupEditor group={child} depth={depth + 1} available={available} allocate={allocate}
        onChange={next => replace(child.key, next)} />
        : <ConditionEditor predicate={child} onChange={next => replace(child.key, next)} />}
      {group.children.length > 1 && <button type="button" className="secondary small" onClick={() => remove(child.key)}>
        {child.kind === "group" ? "그룹 제거" : "조건 제거"}</button>}
    </li>)}</ol>
    <div className="mongo-find-actions">
      <button type="button" className="secondary small" disabled={available < 1}
        onClick={() => onChange({ ...group, children: [...group.children, condition(allocate())] })}>조건 추가</button>
      {depth < maxDepth - 1 && <button type="button" className="secondary small" disabled={available < 2}
        onClick={() => onChange({ ...group, children: [...group.children, { key: allocate(), kind: "group", mode: "all", children: [condition(allocate())] }] })}>하위 그룹 추가</button>}
    </div>
  </fieldset>;
}

function ConditionEditor({ predicate, onChange }: { predicate: Predicate; onChange: (predicate: Predicate) => void }) {
  const list = listOperator(predicate.operator);
  const json = list || predicate.format === "json";
  return <div className="mongo-find-predicate">
    <div className="mongo-find-condition">
      <label className="field">필드<input value={predicate.field} required maxLength={256} placeholder="profile.city"
        onChange={event => onChange({ ...predicate, field: event.target.value })} /></label>
      <label className="field">연산자<select value={predicate.operator} onChange={event => onChange({ ...predicate, operator: event.target.value as Operator })}>
        {Object.entries(operators).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
    </div>
    {predicate.operator === "exists" ? <label className="field">값<select value={String(predicate.present)}
      onChange={event => onChange({ ...predicate, present: event.target.value === "true" })}>
      <option value="true">있음</option><option value="false">없음</option>
    </select></label> : <div className="mongo-find-operand">
      {!list && <label className="field">값 형식<select value={predicate.format}
        onChange={event => onChange({ ...predicate, format: event.target.value as Format })}>
        <option value="text">문자열</option><option value="json">Extended JSON</option>
      </select></label>}
      <label className="field">{list ? "목록 (Extended JSON)" : "값"}{json
        ? <textarea className="edit-value" rows={2} value={predicate.value} maxLength={32768} required
          placeholder={list ? '["서울", "부산"]' : '{"$numberLong":"9007199254740993"}'}
          onChange={event => onChange({ ...predicate, value: event.target.value })} />
        : <input value={predicate.value} maxLength={32768} onChange={event => onChange({ ...predicate, value: event.target.value })} />}</label>
    </div>}
  </div>;
}
