import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { findEditorMatches, firstAtOrAfter, revealEditorMatch } from "./editorSearch";

const lineHeight = 21;
const formatNumber = new Intl.NumberFormat("ko-KR");
const searchLimit = 512;

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "wrap"> & {
  editorRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  footer: ReactNode;
};

export function CodeTextarea({ editorRef, value, footer, onChange, onSelect, onFocus, onScroll, ...props }: Props) {
  const [selection, setSelection] = useState({ start: 0, end: 0, backward: false });
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const findId = `${props.id}-find`;
  const lineStarts = useMemo(() => {
    const starts = [0];
    for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1)) {
      starts.push(index + 1);
    }
    return starts;
  }, [value]);
  const matches = useMemo(() => findEditorMatches(value, query, matchCase), [value, query, matchCase]);

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
    const { selectionStart: start, selectionEnd: end, selectionDirection } = editor;
    const backward = selectionDirection === "backward";
    setSelection(previous => previous.start === start && previous.end === end && previous.backward === backward
      ? previous : { start, end, backward });
  }

  function lineIndex(position: number) {
    return firstAtOrAfter(lineStarts, position + 1) - 1;
  }

  function openFind() {
    if (!findOpen) {
      const editor = editorRef.current;
      const selected = editor && value.slice(editor.selectionStart, editor.selectionEnd);
      if (selected && selected.length <= searchLimit && !selected.includes("\n")) setQuery(selected);
      setFindOpen(true);
    }
    requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
  }

  function closeFind() {
    setFindOpen(false);
    setQuery("");
    editorRef.current?.focus({ preventScroll: true });
  }

  function moveMatch(backward: boolean) {
    const editor = editorRef.current;
    if (!editor || !matches.length) return;
    const anchor = backward ? editor.selectionStart : editor.selectionEnd;
    const boundary = firstAtOrAfter(matches, anchor);
    const index = backward ? (boundary + matches.length - 1) % matches.length : boundary % matches.length;
    const start = matches[index];
    const line = lineIndex(start);
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(start, start + query.length);
    revealEditorMatch(editor, line, lineStarts[line], start, query.length, lineHeight);
    syncCaret(editor);
    syncViewport(editor);
  }

  const caret = Math.min(selection.backward ? selection.start : selection.end, value.length);
  const cursorLine = lineIndex(caret);
  const activeLine = cursorLine + 1;
  const matchIndex = firstAtOrAfter(matches, selection.start);
  const matchSelected = matches[matchIndex] === selection.start && selection.end === selection.start + query.length;
  let column = 1;
  for (const _ of value.slice(lineStarts[cursorLine], caret)) column++;
  const first = Math.max(0, Math.min(lineStarts.length - 1, Math.floor(viewport.top / lineHeight) - 1));
  const visible = Math.min(lineStarts.length - first, Math.ceil(viewport.height / lineHeight) + 3);
  const shift = first * lineHeight - viewport.top;
  const style = {
    "--code-line-height": `${lineHeight}px`,
    "--code-gutter-digits": Math.max(2, String(lineStarts.length).length),
  } as CSSProperties;

  return <div className="code-editor" style={style} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    } else if (findOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    } else if (findOpen && event.key === "F3") {
      event.preventDefault();
      moveMatch(event.shiftKey);
    }
  }}>
    {findOpen && <div id={findId} role="group" aria-label="편집기 찾기" className="code-find">
      <input ref={searchInput} type="search" aria-label="찾을 텍스트" placeholder="찾을 텍스트"
        maxLength={searchLimit} spellCheck={false} autoComplete="off" value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            moveMatch(event.shiftKey);
          }
        }} />
      <label className="code-find-case"><input type="checkbox" checked={matchCase}
        onChange={event => setMatchCase(event.target.checked)} /> 대소문자 구분</label>
      {query && <output className="code-find-count">{matches.length === 0 ? "일치 항목 없음"
        : matchSelected ? `${formatNumber.format(matchIndex + 1)} / ${formatNumber.format(matches.length)}`
          : `${formatNumber.format(matches.length)}개 일치`}</output>}
      <div className="code-find-actions">
        <button type="button" className="icon-button" aria-label="이전 일치 항목" title="Shift+F3"
          disabled={!matches.length} onClick={() => moveMatch(true)}><ChevronUp size={15} aria-hidden /></button>
        <button type="button" className="icon-button" aria-label="다음 일치 항목" title="F3"
          disabled={!matches.length} onClick={() => moveMatch(false)}><ChevronDown size={15} aria-hidden /></button>
        <button type="button" className="icon-button" aria-label="찾기 닫기" onClick={closeFind}><X size={15} aria-hidden /></button>
      </div>
    </div>}
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
      <div className="code-editor-nav">
        <button type="button" className="secondary small" aria-expanded={findOpen} aria-controls={findId} title="Ctrl+F"
          onClick={findOpen ? closeFind : openFind}><Search size={14} aria-hidden /> 찾기</button>
        <span className="code-position">{formatNumber.format(activeLine)}줄 · {formatNumber.format(column)}열</span>
      </div>
    </div>
  </div>;
}
