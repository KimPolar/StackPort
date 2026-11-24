import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Dialog } from "./Dialog";
import { maximumColumnWidth, mergeColumns, minimumColumnWidth, validColumnWidth, type ColumnChoice, type GridLayout } from "./GridColumnLayout";
import { datePatterns, gridTypeLabels, maximumFractionDigits, rawCellFormat, validFractionDigits, type CellFormat, type DatePattern } from "./gridValuePresentation";
import "./gridColumnLayout.css";

const coloredTypes = ["number", "date", "boolean", "binary", "structured"] as const;

export function GridColumnLayoutDialog({ title, columns, layout, pinLimit, onApply, onProfiles, onClose }: {
  title: string; columns: string[]; layout: GridLayout; pinLimit?: number; onApply: (value: GridLayout) => void;
  onProfiles: (profiles: GridLayout["profiles"]) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => mergeColumns(columns, layout.active));
  const [typeColors, setTypeColors] = useState(layout.typeColors);
  const [profiles, setProfiles] = useState(layout.profiles);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const shown = draft.filter(column => !column.hidden).length;
  const pinned = draft.filter(column => column.pinned && !column.hidden).length;

  function update(index: number, changes: Partial<ColumnChoice>) {
    setError("");
    setDraft(value => value.map((column, position) => position === index ? { ...column, ...changes } : column));
  }

  function move(index: number, direction: -1 | 1) {
    setDraft(value => {
      const next = [...value];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
  }

  function checked() {
    const invalid = draft.find(column => column.width !== null && !validColumnWidth(column.width));
    if (invalid) {
      setError(`${invalid.name} 열 폭을 ${minimumColumnWidth}–${maximumColumnWidth}px 사이의 정수로 입력하세요.`);
      return false;
    }
    const digits = draft.find(column => column.format.kind === "number" && column.format.digits !== null && !validFractionDigits(column.format.digits));
    if (digits) {
      setError(`${digits.name} 소수 자릿수를 0–${maximumFractionDigits} 사이의 정수로 입력하세요.`);
      return false;
    }
    return true;
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    if (checked()) onApply({ active: draft, typeColors, profiles });
  }

  function saveProfile() {
    if (!name.trim() || !checked()) return;
    const key = name.trim();
    const saved = [...profiles.filter(profile => profile.name !== key), { name: key, columns: draft, typeColors }];
    setProfiles(saved); onProfiles(saved);
    setSelected(key); setError("");
  }

  return <Dialog title="열 설정" className="grid-column-layout-dialog" onClose={onClose} busy={false}>
    <form onSubmit={apply} noValidate>
      <p className="confirm-copy"><strong>{title}</strong> · {shown}/{draft.length}열 표시</p>
      <div className="grid-layout-profiles">
        <label className="field">보기 프로필<select value={selected} onChange={event => {
          const key = event.target.value;
          setSelected(key); setError("");
          const profile = profiles.find(item => item.name === key);
          if (profile) { setDraft(mergeColumns(columns, profile.columns)); setTypeColors(profile.typeColors); setName(profile.name); }
        }}>
          <option value="">프로필 선택</option>{profiles.map(profile => <option key={profile.name}>{profile.name}</option>)}
        </select></label>
        <button type="button" className="secondary small" disabled={!selected} onClick={() => {
          const kept = profiles.filter(profile => profile.name !== selected);
          setProfiles(kept); onProfiles(kept); setSelected(""); setName("");
        }}>프로필 제거</button>
        <label className="field">프로필 이름<input value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label>
        <button type="button" className="secondary small" disabled={!name.trim()} onClick={saveProfile}>프로필 저장</button>
      </div>
      <div className="grid-layout-colors">
        <label><input type="checkbox" checked={typeColors} onChange={event => setTypeColors(event.target.checked)} /> 타입별 색상</label>
        {typeColors && <ul aria-label="타입 색상">{coloredTypes.map(type => <li key={type} data-grid-value-type={type}>{gridTypeLabels[type]}</li>)}</ul>}
      </div>
      <div className="table-wrap grid-layout-columns" role="region" tabIndex={0} aria-label="열 설정 목록">
        <table><thead><tr><th scope="col">열</th><th scope="col">표시</th><th scope="col">고정</th><th scope="col">폭(px)</th><th scope="col">표시 형식</th><th scope="col">순서</th></tr></thead>
          <tbody>{draft.map((column, index) => <tr key={column.name}>
            <th scope="row" title={column.name}>{column.name}</th>
            <td><input type="checkbox" aria-label={`${column.name} 표시`} checked={!column.hidden} disabled={!column.hidden && shown === 1}
              onChange={event => update(index, { hidden: !event.target.checked, pinned: false })} /></td>
            <td><input type="checkbox" aria-label={`${column.name} 고정`} checked={column.pinned} disabled={column.hidden || (!column.pinned && pinned >= (pinLimit ?? Infinity))}
              onChange={event => update(index, { pinned: event.target.checked })} /></td>
            <td><input type="number" aria-label={`${column.name} 폭`} value={column.width ?? ""} placeholder="자동"
              min={minimumColumnWidth} max={maximumColumnWidth} step={1}
              onChange={event => update(index, { width: event.target.value === "" ? null : Number(event.target.value) })} /></td>
            <td><ColumnFormat column={column} onChange={format => update(index, { format })} /></td>
            <td><div className="grid-layout-order">
              <button type="button" className="icon-button" aria-label={`${column.name} 위로`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} aria-hidden /></button>
              <button type="button" className="icon-button" aria-label={`${column.name} 아래로`} disabled={index === draft.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} aria-hidden /></button>
            </div></td>
          </tr>)}</tbody></table>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => { setDraft(mergeColumns(columns, [])); setTypeColors(false); setSelected(""); setError(""); }}>기본 배치</button>
        <button type="button" className="secondary" onClick={onClose}>취소</button>
        <button type="submit" className="primary">적용</button>
      </div>
    </form>
  </Dialog>;
}

function ColumnFormat({ column, onChange }: { column: ColumnChoice; onChange: (format: CellFormat) => void }) {
  const { name, format } = column;
  return <div className="grid-layout-format">
    <select aria-label={`${name} 표시 형식`} value={format.kind} onChange={event => {
      const kind = event.target.value;
      onChange(kind === "number" ? { kind: "number", digits: null } : kind === "date" ? { kind: "date", pattern: "year_first" } : rawCellFormat);
    }}>
      <option value="raw">원본</option><option value="number">숫자 · 천 단위</option><option value="date">날짜 · ISO</option>
    </select>
    {format.kind === "number" && <label>소수 자릿수<input type="number" aria-label={`${name} 소수 자릿수`} value={format.digits ?? ""}
      placeholder="원본" min={0} max={maximumFractionDigits} step={1}
      onChange={event => onChange({ kind: "number", digits: event.target.value === "" ? null : Number(event.target.value) })} /></label>}
    {format.kind === "date" && <select aria-label={`${name} 날짜 형식`} value={format.pattern}
      onChange={event => onChange({ kind: "date", pattern: event.target.value as DatePattern })}>
      {Object.entries(datePatterns).map(([pattern, label]) => <option key={pattern} value={pattern}>{label}</option>)}
    </select>}
  </div>;
}
