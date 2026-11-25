import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

export type GridEditExitGuard = (after: () => void) => void;

export function Dialog({ title, children, onClose, busy, interceptEscape = false, className = "", initialFocus }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
  interceptEscape?: boolean;
  className?: string;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
    initialFocus?.current?.focus();
  }, [initialFocus]);
  return <dialog ref={ref} className={`dialog ${className}`} aria-labelledby={titleId} onClose={onClose}
    onCancel={event => {
      if (busy || interceptEscape) event.preventDefault();
      if (!busy && interceptEscape) onClose();
    }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={18} aria-hidden /></button>
    </div>
    {children}
  </dialog>;
}
