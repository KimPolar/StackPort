import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

type Part = { kind: "field"; name: string } | { kind: "index"; index: number };
type Path = Part[];
type Child = { part: Part; node: Node };
type Node = { bson_type: string; value: string | null; children: Child[] | null };
export type MongoDraftStructure = { text: string; root: Node };
export type MongoDraftChange =
  | { kind: "add_field"; parent: Path; name: string; input: string }
  | { kind: "append"; parent: Path; input: string }
  | { kind: "replace"; at: Path; input: string }
  | { kind: "rename"; at: Path; name: string }
  | { kind: "remove"; at: Path }
  | { kind: "move"; at: Path; direction: "up" | "down" };
type FieldForm = { kind: "add_field" | "append" | "replace" | "rename"; name: string; value: string };

const templates = [
  ["String", '""'], ["Int32", '{"$numberInt":"0"}'], ["Int64", '{"$numberLong":"0"}'],
  ["Double", '{"$numberDouble":"0.0"}'], ["Decimal128", '{"$numberDecimal":"0.00"}'],
  ["Boolean", "false"], ["Null", "null"], ["Document", "{}"], ["Array", "[]"],
  ["ObjectId", '{"$oid":"000000000000000000000000"}'], ["DateTime", '{"$date":{"$numberLong":"0"}}'],
  ["Binary", '{"$binary":{"base64":"","subType":"00"}}'],
] as const;

function partName(part: Part) {
  return part.kind === "index" ? `[${part.index}]` : part.name || '""';
}

function pathName(path: Path) {
  return path.reduce((name, part) => {
    if (part.kind === "index") return `${name}[${part.index}]`;
    if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(part.name)) return `${name}.${part.name}`;
    return `${name}[${JSON.stringify(part.name)}]`;
  }, "문서");
}

const pathKey = (path: Path) => JSON.stringify(path);

function nodeAt(root: Node, path: Path) {
  let node: Node | undefined = root;
  for (const part of path) node = node?.children?.find(child =>
    child.part.kind === "field" ? part.kind === "field" && child.part.name === part.name
      : part.kind === "index" && child.part.index === part.index)?.node;
  return node;
}

function valueText(node: Node): string {
  if (!node.children) return node.value ?? "null";
  if (node.bson_type === "Array") return `[${node.children.map(child => valueText(child.node)).join(", ")}]`;
  const fields = node.children.map(({ part, node: value }) => {
    const key = part.kind === "field" ? part.name : String(part.index);
    return `${JSON.stringify(key)}: ${valueText(value)}`;
  });
  return `{${fields.join(", ")}}`;
}

function preview(node: Node) {
  if (node.children) return `${node.bson_type === "Array" ? "항목" : "필드"} ${node.children.length}개`;
  const value = node.value ?? "";
  return value.length > 140 ? `${value.slice(0, 140)}…` : value;
}

export function MongoDocumentStructure({ root, mode, keepId, busy, onChange, onEditing }: {
  root: Node; mode: "tree" | "grid"; keepId: boolean; busy: boolean;
  onChange: (operation: MongoDraftChange) => Promise<boolean>; onEditing: (editing: boolean) => void;
}) {
  const [chosen, setChosen] = useState<Path>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<FieldForm | null>(null);
  const nameId = useId();
  const valueId = useId();
  const path = nodeAt(root, chosen) ? chosen : [];
  const node = nodeAt(root, path) ?? root;
  const tail = path.at(-1);
  const parent = path.slice(0, -1);
  const parentSize = nodeAt(root, parent)?.children?.length ?? 0;
  const scope = node.children ? path : parent;
  const scopeNode = nodeAt(root, scope) ?? root;
  const selected = pathKey(path);
  const locked = busy || !!form;
  const readOnly = keepId && path[0]?.kind === "field" && path[0].name === "_id";

  function choose(next: Path) { setChosen(next); }

  function showForm(next: FieldForm | null) {
    setForm(next);
    onEditing(!!next);
  }

  async function apply(operation: MongoDraftChange, next: Path) {
    if (await onChange(operation)) {
      setChosen(next);
      const ancestors = next.map((_, index) => pathKey(next.slice(0, index)));
      setExpanded(current => new Set([...current, ...ancestors]));
      showForm(null);
    }
  }

  function submitField() {
    if (!form) return;
    if (form.kind === "add_field") void apply({ kind: "add_field", parent: path, name: form.name, input: form.value }, [...path, { kind: "field", name: form.name }]);
    if (form.kind === "append") void apply({ kind: "append", parent: path, input: form.value }, [...path, { kind: "index", index: node.children?.length ?? 0 }]);
    if (form.kind === "replace") void apply({ kind: "replace", at: path, input: form.value }, path);
    if (form.kind === "rename") void apply({ kind: "rename", at: path, name: form.name }, [...parent, { kind: "field", name: form.name }]);
  }

  function move(direction: "up" | "down") {
    if (tail?.kind !== "index") return;
    const index = tail.index + (direction === "up" ? -1 : 1);
    void apply({ kind: "move", at: path, direction }, [...parent, { kind: "index", index }]);
  }

  function tree(children: Child[], at: Path) {
    return <ul className="mongo-structure-tree">{children.map(({ part, node }) => {
      const next = [...at, part];
      const key = pathKey(next);
      const open = expanded.has(key);
      const name = pathName(next);
      return <li key={key}>
        <div className="mongo-structure-branch">
          {node.children?.length ? <button type="button" className="icon-button" aria-label={`${name} ${open ? "접기" : "펼치기"}`}
            aria-expanded={open} disabled={locked} onClick={() => setExpanded(current => {
              const next = new Set(current);
              if (open) next.delete(key); else next.add(key);
              return next;
            })}>{open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}</button> : <span className="mongo-structure-indent" />}
          <button type="button" className="object-row" aria-pressed={key === selected} aria-label={`${name} 선택`} disabled={locked} onClick={() => choose(next)}>
            <strong>{partName(part)}</strong><small>{node.bson_type}</small><code>{preview(node)}</code>
          </button>
        </div>
        {open && node.children && tree(node.children, next)}
      </li>;
    })}</ul>;
  }

  return <div className="mongo-structure">
    {mode === "tree" ? <div className="mongo-structure-browser" role="group" aria-label="문서 트리">
      <button type="button" className="object-row mongo-structure-root" aria-pressed={!path.length} disabled={locked} onClick={() => choose([])}>문서</button>
      {root.children && tree(root.children, [])}
    </div> : <>
      <nav className="mongo-structure-breadcrumb" aria-label="문서 경로">
        <button type="button" className="secondary small" disabled={locked || !path.length} onClick={() => choose([])}>문서</button>
        {scope.map((part, index) => <button type="button" className="secondary small" key={pathKey(scope.slice(0, index + 1))}
          aria-label={`${pathName(scope.slice(0, index + 1))} 열기`} disabled={locked || index === path.length - 1}
          onClick={() => choose(scope.slice(0, index + 1))}>{partName(part)}</button>)}
      </nav>
      <div className="table-wrap mongo-structure-browser"><table aria-label="문서 그리드">
        <thead><tr><th scope="col">필드</th><th scope="col">BSON 유형</th><th scope="col">값</th></tr></thead>
        <tbody>{scopeNode.children?.map(({ part, node }) => {
          const next = [...scope, part];
          const key = pathKey(next);
          const immutable = keepId && next[0]?.kind === "field" && next[0].name === "_id";
          return <tr key={key}>
            <th scope="row"><button type="button" className="object-row" disabled={locked} aria-pressed={key === selected} onClick={() => choose(next)}>{partName(part)}</button></th>
            <td>{node.bson_type}</td>
            <td><button type="button" className="object-row" disabled={locked} aria-label={`${pathName(next)} ${node.children ? "열기" : immutable ? "보기" : "값 편집"}`} onClick={() => {
              choose(next);
              if (!node.children && !immutable) showForm({ kind: "replace", name: "", value: valueText(node) });
            }}><code>{preview(node)}</code></button></td>
          </tr>;
        })}</tbody>
      </table></div>
    </>}
    <div className="mongo-structure-actions">
      <strong>{pathName(path)}</strong><small>{node.bson_type}</small>
      {readOnly ? <span className="form-note">_id 유지</span> : <>
        {node.bson_type === "Document" && <button type="button" className="secondary small" disabled={locked}
          onClick={() => showForm({ kind: "add_field", name: "", value: "null" })}>필드 추가</button>}
        {node.bson_type === "Array" && <button type="button" className="secondary small" disabled={locked}
          onClick={() => showForm({ kind: "append", name: "", value: "null" })}>항목 추가</button>}
        {tail && <button type="button" className="secondary small" disabled={locked}
          onClick={() => showForm({ kind: "replace", name: "", value: valueText(node) })}>값 바꾸기</button>}
        {tail?.kind === "field" && <button type="button" className="secondary small" disabled={locked}
          onClick={() => showForm({ kind: "rename", name: tail.name, value: "" })}>이름 변경</button>}
        {tail?.kind === "index" && <>
          <button type="button" className="secondary small" disabled={locked || tail.index === 0} onClick={() => move("up")}>위로 이동</button>
          <button type="button" className="secondary small" disabled={locked || tail.index + 1 >= parentSize} onClick={() => move("down")}>아래로 이동</button>
        </>}
        {tail && <button type="button" className="secondary small" disabled={locked}
          onClick={() => void apply({ kind: "remove", at: path }, parent)}>{tail.kind === "field" ? "필드 제거" : "항목 제거"}</button>}
      </>}
    </div>
    {form && <fieldset className="mongo-structure-form" disabled={busy} onKeyDown={event => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
    }}>
      <legend>{form.kind === "add_field" ? "새 필드" : form.kind === "append" ? "새 배열 항목" : form.kind === "rename" ? "필드 이름 변경" : "값 바꾸기"}</legend>
      {(form.kind === "rename" || form.kind === "add_field") && <div className="field">
        <label htmlFor={nameId}>필드 이름</label>
        <input id={nameId} value={form.name} autoFocus onChange={event => setForm({ ...form, name: event.target.value })} />
      </div>}
      {form.kind !== "rename" && <div className="field">
        <div className="mongo-structure-value-heading"><label htmlFor={valueId}>값 Extended JSON</label>
          <select aria-label="BSON 값 예시" value="" onChange={event => setForm({ ...form, value: event.target.value })}>
            <option value="" disabled>BSON 유형 예시</option>
            {templates.map(([name, input]) => <option value={input} key={name}>{name}</option>)}
          </select>
        </div>
        <textarea id={valueId} className="mongo-edit-input" rows={3} spellCheck={false} maxLength={65536}
          autoFocus={form.kind !== "add_field"} value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} />
      </div>}
      <div className="mongo-structure-controls">
        <button type="button" className="secondary small" onClick={() => showForm(null)}>필드 편집 취소</button>
        <button type="button" className="primary small" disabled={form.kind !== "rename" && !form.value.trim()} onClick={submitField}>초안에 반영</button>
      </div>
    </fieldset>}
  </div>;
}
