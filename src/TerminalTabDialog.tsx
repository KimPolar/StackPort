import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, Copy, Pin, PinOff, RotateCcw, X } from "lucide-react";

export function TerminalTabDialog({
  name, pinned, canMoveLeft, canMoveRight, recent, unpinnedCount, opening, onPin, onMove, onDuplicate, onReopen, onCloseUnpinned, onClose,
}: {
  name: string | undefined;
  pinned: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  recent: { number: number; name: string }[];
  unpinnedCount: number;
  opening: boolean;
  onPin: () => void;
  onMove: (offset: -1 | 1) => void;
  onDuplicate: () => void;
  onReopen: (number: number) => void;
  onCloseUnpinned: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="dialog" aria-labelledby="terminal-tabs-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="terminal-tabs-title">터미널 탭 관리</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="terminal-tab-settings">
      {name && <><p><strong>{name}</strong></p>
      <div className="terminal-tab-settings-actions" role="group" aria-label="현재 탭">
        <button type="button" className="secondary small" onClick={onPin}>
          {pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />} {pinned ? "고정 해제" : "탭 고정"}
        </button>
        <button type="button" className="secondary small" disabled={!canMoveLeft} onClick={() => onMove(-1)}>
          <ArrowLeft size={14} aria-hidden /> 왼쪽으로 이동
        </button>
        <button type="button" className="secondary small" disabled={!canMoveRight} onClick={() => onMove(1)}>
          <ArrowRight size={14} aria-hidden /> 오른쪽으로 이동
        </button>
        <button type="button" className="secondary small" disabled={opening} onClick={onDuplicate}>
          <Copy size={14} aria-hidden /> 탭 복제
        </button>
      </div></>}
      {unpinnedCount > 0 && <button type="button" className="secondary small terminal-close-group" onClick={onCloseUnpinned}>
        고정하지 않은 탭 닫기 ({unpinnedCount})
      </button>}
      {recent.length > 0 && <section className="terminal-tab-history" aria-labelledby="recent-terminal-tabs-title">
        <h3 id="recent-terminal-tabs-title">최근 닫은 탭</h3>
        <ul>{recent.map(tab => <li key={tab.number}><span title={tab.name}>{tab.name}</span>
          <button type="button" className="secondary small" aria-label={`${tab.name} 다시 열기`} disabled={opening} onClick={() => onReopen(tab.number)}>
            <RotateCcw size={14} aria-hidden /> 다시 열기
          </button>
        </li>)}</ul>
      </section>}
    </div>
  </dialog>;
}
