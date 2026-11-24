import { useEffect, useRef, type KeyboardEvent } from "react";
import { FileCode2, Plus, X } from "lucide-react";

export type SqlDocument = { text: string; line_ending: "lf" | "crlf"; bom: boolean };
export type SqlTarget = { profileId: string; projectId: string; projectName: string; profileName: string };
export type SqlDraft = SqlTarget & {
  id: string;
  number: number;
  document: SqlDocument;
  savedText: string;
  savedPath: string;
  templateName?: string;
};
export type SqlTabSet = { tabs: SqlDraft[]; activeId: string; nextNumber: number };

export const emptySqlDocument: SqlDocument = { text: "", line_ending: "lf", bom: false };
export const emptySqlTabs: SqlTabSet = { tabs: [], activeId: "", nextNumber: 1 };

export function addSqlTab(group: SqlTabSet, target: SqlTarget, document = emptySqlDocument,
  { path = "", templateName }: { path?: string; templateName?: string } = {}): SqlTabSet {
  const number = group.nextNumber;
  const draft = {
    ...target, id: `${target.profileId}-${number}`, number,
    document, savedText: document.text, savedPath: path, templateName,
  };
  return { tabs: [...group.tabs, draft], activeId: draft.id, nextNumber: number + 1 };
}

export const sqlTabTitle = (draft: SqlDraft) => draft.savedPath.split(/[/\\]/).at(-1) || draft.templateName || `SQL ${draft.number}`;
export const isSqlDraftDirty = (draft: SqlDraft) => draft.document.text !== draft.savedText;
export const sqlTabButtonId = (id: string) => `sql-tab-${id}`;
export const sqlTabPanelId = (id: string) => `sql-panel-${id}`;

export function SqlTabStrip({ group, onSelect, onNew, onClose, closeDisabledFor }: {
  group: SqlTabSet;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (draft: SqlDraft) => void;
  closeDisabledFor?: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const { tabs } = group;
    if (event.key === "Delete") {
      event.preventDefault();
      if (tabs[index].id !== closeDisabledFor) onClose(tabs[index]);
      return;
    }
    const destination = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (destination < 0) return;
    event.preventDefault();
    const id = tabs[destination].id;
    onSelect(id);
    document.getElementById(sqlTabButtonId(id))?.focus();
  }

  return <div className="sql-tab-strip">
    {group.tabs.length > 0 && <div className="sql-tabs" role="tablist" aria-label="SQL 문서">
      {group.tabs.map((draft, index) => {
        const selected = draft.id === group.activeId;
        const dirty = isSqlDraftDirty(draft);
        const title = sqlTabTitle(draft);
        return <div className="sql-tab" data-active={selected} key={draft.id}>
          <button type="button" role="tab" id={sqlTabButtonId(draft.id)} aria-label={title}
            aria-controls={sqlTabPanelId(draft.id)} aria-selected={selected} tabIndex={selected ? 0 : -1}
            aria-description={[dirty && "저장하지 않은 변경", draft.savedPath].filter(Boolean).join(" · ") || undefined}
            title={draft.savedPath || title} onClick={() => onSelect(draft.id)} onKeyDown={event => onKeyDown(event, index)}>
            <FileCode2 size={14} aria-hidden /><span>{title}</span>{dirty && <span className="sql-tab-dirty" aria-hidden />}
          </button>
          <button type="button" className="sql-tab-close" aria-label={`${title} 탭 닫기`} tabIndex={selected ? 0 : -1} disabled={draft.id === closeDisabledFor}
            onClick={() => onClose(draft)}><X size={13} aria-hidden /></button>
        </div>;
      })}
    </div>}
    <button type="button" id="new-sql-tab" className="secondary small sql-tab-new" aria-label="새 SQL 탭"
      onClick={onNew}><Plus size={14} aria-hidden /> 새 탭</button>
  </div>;
}

export function CloseSqlTabDialog({ draft, onCancel, onDiscard, onSave }: {
  draft: SqlDraft;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="dialog" role="alertdialog" aria-labelledby="sql-tab-close-title"
    aria-describedby="sql-tab-close-description" onClose={onCancel}>
    <div className="dialog-heading">
      <h2 id="sql-tab-close-title">SQL 탭 닫기</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="workspace-exit-body">
      <p className="confirm-copy" id="sql-tab-close-description"><strong>{sqlTabTitle(draft)}</strong>에 저장하지 않은 변경이 있습니다.</p>
      <div className="dialog-actions">
        <button type="button" autoFocus className="secondary" onClick={() => dialog.current?.close()}>계속 편집</button>
        <button type="button" className="primary" onClick={onSave}>파일로 저장 후 닫기</button>
        <button type="button" className="danger" onClick={onDiscard}>변경 버리고 닫기</button>
      </div>
    </div>
  </dialog>;
}
