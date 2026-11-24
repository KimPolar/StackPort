import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({ title, children, onClose, busy }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} aria-hidden /></button>
    </div>
    {children}
  </dialog>;
}
