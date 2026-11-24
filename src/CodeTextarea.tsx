import { useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";

const lineHeight = 21;
const formatNumber = new Intl.NumberFormat("ko-KR");

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "wrap"> & {
  editorRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  footer: ReactNode;
};

export function CodeTextarea({ editorRef, value, footer, onChange, onSelect, onFocus, onScroll, ...props }: Props) {
  const [position, setPosition] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const lineStarts = useMemo(() => {
    const starts = [0];
    for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1)) {
      starts.push(index + 1);
    }
    return starts;
  }, [value]);

  function syncViewport(editor: HTMLTextAreaElement) {
    const top = editor.scrollTop;
    const height = editor.clientHeight;
    setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
  }

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const observer = new ResizeObserver(() => syncViewport(editor));
    observer.observe(editor);
    syncViewport(editor);
    return () => observer.disconnect();
  }, [editorRef]);

  function syncCaret(editor: HTMLTextAreaElement) {
    setPosition(editor.selectionDirection === "backward" ? editor.selectionStart : editor.selectionEnd);
  }

  const caret = Math.min(position, value.length);
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= caret) low = middle;
    else high = middle;
  }
  const activeLine = low + 1;
  let column = 1;
  for (const _ of value.slice(lineStarts[low], caret)) column++;
  const first = Math.max(0, Math.min(lineStarts.length - 1, Math.floor(viewport.top / lineHeight) - 1));
  const visible = Math.min(lineStarts.length - first, Math.ceil(viewport.height / lineHeight) + 3);
  const shift = first * lineHeight - viewport.top;
  const style = {
    "--code-line-height": `${lineHeight}px`,
    "--code-gutter-digits": Math.max(2, String(lineStarts.length).length),
  } as CSSProperties;

  return <div className="code-editor" style={style}>
    <div className="code-editor-input">
      <div className="code-gutter" aria-hidden="true">
        <div className="code-gutter-window" style={{ height: viewport.height }}>
          <div className="code-gutter-lines" style={{ transform: `translateY(${shift}px)` }}>
            {Array.from({ length: visible }, (_, index) => {
              const line = first + index + 1;
              return <div key={line} data-active={line === activeLine}>{line}</div>;
            })}
          </div>
        </div>
      </div>
      <textarea {...props} ref={editorRef} wrap="off" value={value}
        onChange={event => { syncCaret(event.currentTarget); onChange?.(event); }}
        onSelect={event => { syncCaret(event.currentTarget); onSelect?.(event); }}
        onFocus={event => { syncCaret(event.currentTarget); onFocus?.(event); }}
        onScroll={event => { syncViewport(event.currentTarget); onScroll?.(event); }} />
    </div>
    <div className="editor-footer">
      {footer}
      <span className="code-position">{formatNumber.format(activeLine)}줄 · {formatNumber.format(column)}열</span>
    </div>
  </div>;
}
