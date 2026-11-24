import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { sqlHistoryScopeLabels, sqlHistoryStatusLabels, type SqlHistoryEntry } from "./sqlHistory";

const time = new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const number = new Intl.NumberFormat("ko-KR");

export function SqlHistoryDialog({ connection, entries, onOpen, onClear, onClose }: {
  connection: string;
  entries: SqlHistoryEntry[];
  onOpen: (sql: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [revealedId, setRevealedId] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const selected = entries.find(entry => entry.id === selectedId) ?? entries[0];
  const revealed = selected?.id === revealedId && selected.sql !== null;

  useEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="dialog sql-history" aria-labelledby="sql-history-title"
    role={confirmClear ? "alertdialog" : undefined} aria-describedby={confirmClear ? "sql-history-clear-description" : undefined} onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="sql-history-title">최근 SQL</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="sql-history-body">
      {confirmClear ? <>
        <p className="confirm-copy" id="sql-history-clear-description"><strong>{connection}</strong> 연결의 이번 세션 실행 기록을 지웁니다.</p>
        <div className="dialog-actions">
          <button autoFocus type="button" className="secondary" onClick={() => setConfirmClear(false)}>취소</button>
          <button type="button" className="danger" onClick={() => {
            onClear(); setSelectedId(null); setRevealedId(null); setConfirmClear(false);
          }}>기록 지우기</button>
        </div>
      </> : <>
        <div className="sql-history-controls">
          <strong>{connection}</strong>
          {!!entries.length && <button type="button" className="secondary small" onClick={() => setConfirmClear(true)}>이 연결 기록 지우기</button>}
        </div>
        <p className="form-note">기록은 앱을 실행하는 동안 메모리에 보관합니다. SQL 값과 이름은 기본 화면에서 가립니다.</p>
        {!selected ? <p role="status" className="form-note">이 연결의 최근 실행 기록이 없습니다.</p> :
          <div className="sql-history-layout">
            <ul className="sql-history-list" aria-label="실행 기록 목록">{entries.map(entry => <li key={entry.id}>
              <button type="button" aria-pressed={entry.id === selected.id} onClick={() => {
                setSelectedId(entry.id); setRevealedId(null);
              }}>
                <strong>{sqlHistoryScopeLabels[entry.scope]} · {sqlHistoryStatusLabels[entry.outcome.status]}</strong>
                <time dateTime={new Date(entry.startedAt).toISOString()}>{time.format(entry.startedAt)}</time>
                <code>{entry.masked}</code>
              </button>
            </li>)}</ul>
            <div className="sql-history-detail">
              <strong>{sqlHistoryScopeLabels[selected.scope]} · {sqlHistoryStatusLabels[selected.outcome.status]}</strong>
              <p className="form-note">
                {time.format(selected.startedAt)}
                {selected.outcome.elapsedMs !== undefined && ` · ${number.format(selected.outcome.elapsedMs)} ms`}
                {selected.outcome.displayedRows !== undefined && ` · 화면에 ${number.format(selected.outcome.displayedRows)}개 행`}
                {selected.outcome.batch && ` · ${selected.outcome.batch.total}개 문장 중 ${selected.outcome.batch.finished}개 완료`}
              </p>
              <pre aria-label={revealed ? "실행한 SQL 원문" : "값을 가린 SQL"} tabIndex={0}>{revealed ? selected.sql : selected.masked}</pre>
              {selected.sql === null ? <p className="form-note">긴 SQL은 가린 미리보기와 실행 정보를 보관했습니다.</p> :
                <div className="sql-history-controls">
                  <button type="button" className="secondary small" aria-pressed={revealed}
                    onClick={() => setRevealedId(revealed ? null : selected.id)}>SQL 원문 표시</button>
                  <button type="button" className="primary small" onClick={() => onOpen(selected.sql!)}>새 탭에서 열기</button>
                </div>}
            </div>
          </div>}
      </>}
    </div>
  </dialog>;
}
