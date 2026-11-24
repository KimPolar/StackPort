import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, Pin, PinOff, X } from "lucide-react";

export function TerminalTabDialog({ name, pinned, canMoveLeft, canMoveRight, onPin, onMove, onClose }: {
  name: string;
  pinned: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onPin: () => void;
  onMove: (offset: -1 | 1) => void;
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
      <p><strong>{name}</strong></p>
      <div className="terminal-tab-settings-actions">
        <button type="button" className="secondary small" onClick={onPin}>
          {pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />} {pinned ? "고정 해제" : "탭 고정"}
        </button>
        <button type="button" className="secondary small" disabled={!canMoveLeft} onClick={() => onMove(-1)}>
          <ArrowLeft size={14} aria-hidden /> 왼쪽으로 이동
        </button>
        <button type="button" className="secondary small" disabled={!canMoveRight} onClick={() => onMove(1)}>
          <ArrowRight size={14} aria-hidden /> 오른쪽으로 이동
        </button>
      </div>
    </div>
  </dialog>;
}
