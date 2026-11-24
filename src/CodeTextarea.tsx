import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { findEditorMatches, firstAtOrAfter, replaceEditorMatches, revealEditorMatch } from "./editorSearch";
import { editorSyntaxLine, editorSyntaxTokens, type EditorLanguage } from "./editorSyntax";
import { sqliteSymbolAtPoint, useEditorHover, type EditorHoverProvider } from "./editorHover";
import { useEditorCompletion, type EditorCompletionProvider } from "./useEditorCompletion";

const lineHeight = 21;
const formatNumber = new Intl.NumberFormat("ko-KR");
const searchLimit = 512;
const replaceGrowthLimit = 16 * 1024 * 1024;

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "wrap"> & {
  editorRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  footer: ReactNode;
  language?: EditorLanguage;
  complete?: EditorCompletionProvider;
  inspect?: EditorHoverProvider;
  inspectContext?: string;
};

export function CodeTextarea({ editorRef, value, footer, language, complete, inspect, inspectContext, onChange, onSelect, onFocus, onScroll,
  onCompositionStart, onCompositionEnd, onKeyDown, onBlur, ...props }: Props) {
  const [selection, setSelection] = useState({ start: 0, end: 0, backward: false });
  const [viewport, setViewport] = useState({ top: 0, left: 0, height: 0, width: 0 });
  const [composing, setComposing] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [replaceReport, setReplaceReport] = useState<{ error: boolean; text: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const highlightLines = useRef<HTMLDivElement>(null);
  const findId = `${props.id}-find`;
  const replaceId = `${props.id}-replace`;
  const completionId = `${props.id}-completions`;
  const completion = useEditorCompletion(editorRef, complete);
  const hover = useEditorHover(value, inspectContext, editorRef, inspect);
  const completionItemId = completion.items.length ? `${completionId}-${completion.selected}` : undefined;
  const editable = !props.readOnly && !props.disabled;
  const showingReplace = replaceOpen && editable;
  const lineStarts = useMemo(() => {
    const starts = [0];
    for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1)) {
      starts.push(index + 1);
    }
    return starts;
  }, [value]);
  const matches = useMemo(() => findEditorMatches(value, query, matchCase), [value, query, matchCase]);
  const syntax = useMemo(() => language && !composing ? editorSyntaxTokens(value, language) : null, [value, language, composing]);

  useLayoutEffect(() => {
    if (completionItemId) document.getElementById(completionItemId)?.scrollIntoView({ block: "nearest" });
  }, [completionItemId]);

  function syncViewport(editor: HTMLTextAreaElement) {
    const { scrollTop: top, scrollLeft: left, clientHeight: height, clientWidth: width } = editor;
    setViewport(previous => previous.top === top && previous.left === left && previous.height === height && previous.width === width
      ? previous : { top, left, height, width });
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

  function openFind(showReplace = false) {
    const editor = editorRef.current;
    const selected = editor && value.slice(editor.selectionStart, editor.selectionEnd);
    const seed = selected && selected.length <= searchLimit && !selected.includes("\n") ? selected : "";
    if (!findOpen) {
      setQuery(seed);
      setFindOpen(true);
    }
    if (showReplace && editable) setReplaceOpen(true);
    requestAnimationFrame(() => {
      const field = showReplace && editable && (findOpen ? query : seed) ? replacementInput : searchInput;
      field.current?.focus();
      field.current?.select();
    });
  }

  function closeFind() {
    setFindOpen(false);
    setQuery("");
    setReplaceOpen(false);
    setReplacement("");
    setReplaceReport(null);
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

  function replaceMatches(all: boolean) {
    const editor = editorRef.current;
    if (!editor || editor.readOnly || editor.disabled || !matches.length) return;
    const position = editor.selectionStart;
    const boundary = firstAtOrAfter(matches, position);
    const before = matches[boundary - 1];
    const current = before !== undefined && before + query.length > position ? boundary - 1 : boundary % matches.length;
    const start = matches[all ? 0 : current];
    const end = matches[all ? matches.length - 1 : current] + query.length;
    const count = all ? matches.length : 1;
    const length = value.length + count * (replacement.length - query.length);
    if (length > Math.max(value.length, replaceGrowthLimit)) {
      setReplaceReport({ error: true, text: "바꾼 내용이 편집기에서 처리할 수 있는 크기를 초과합니다." });
      return;
    }
    const original = value.slice(start, end);
    const { text, changes } = all ? replaceEditorMatches(original, query, replacement, matchCase) : {
      text: replacement, changes: original === replacement ? 0 : 1,
    };
    if (!changes) {
      setReplaceReport({ error: false, text: "변경할 내용이 없습니다." });
      return;
    }
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(start, end);
    // Use WebView2's native editing history for both a single edit and a bulk edit.
    const applied = text.length ? document.execCommand("insertText", false, text) : document.execCommand("delete");
    if (!applied) {
      setReplaceReport({ error: true, text: "편집기에 바꾼 내용을 적용할 수 없습니다." });
      return;
    }
    syncCaret(editor);
    syncViewport(editor);
    setReplaceReport({ error: false, text: `${formatNumber.format(changes)}개 위치를 바꿨습니다.` });
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
  const highlightedLines = useMemo(() => syntax?.length ? Array.from({ length: visible }, (_, row) => {
    const index = first + row;
    const start = lineStarts[index];
    const end = index + 1 < lineStarts.length ? lineStarts[index + 1] - 1 : value.length;
    return <div key={index}>{editorSyntaxLine(value, syntax, start, end).map((part, column) => part.kind
      ? <span key={column} data-syntax={part.kind}>{part.text}</span> : part.text)}</div>;
  }) : null, [first, lineStarts, syntax, value, visible]);
  const showHighlight = !!highlightedLines && viewport.height > 0 && viewport.width > 0;
  const style = {
    "--code-line-height": `${lineHeight}px`,
    "--code-gutter-digits": Math.max(2, String(lineStarts.length).length),
  } as CSSProperties;

  return <div className="code-editor" style={style} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (key === "f" || key === "h")) {
      event.preventDefault();
      completion.close();
      openFind(key === "h");
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
        onChange={event => { setQuery(event.target.value); setReplaceReport(null); }} onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            moveMatch(event.shiftKey);
          }
        }} />
      <label className="code-find-case"><input type="checkbox" checked={matchCase}
        onChange={event => { setMatchCase(event.target.checked); setReplaceReport(null); }} /> 대소문자 구분</label>
      {query && <output className="code-find-count">{matches.length === 0 ? "일치 항목 없음"
        : matchSelected ? `${formatNumber.format(matchIndex + 1)} / ${formatNumber.format(matches.length)}`
          : `${formatNumber.format(matches.length)}개 일치`}</output>}
      <div className="code-find-actions">
        <button type="button" className="icon-button" aria-label="이전 일치 항목" title="Shift+F3"
          disabled={!matches.length} onClick={() => moveMatch(true)}><ChevronUp size={15} aria-hidden /></button>
        <button type="button" className="icon-button" aria-label="다음 일치 항목" title="F3"
          disabled={!matches.length} onClick={() => moveMatch(false)}><ChevronDown size={15} aria-hidden /></button>
        {editable && <button type="button" className="secondary small" aria-label="바꾸기 옵션" title="Ctrl+H"
          aria-expanded={showingReplace} aria-controls={replaceId} onClick={() => {
            if (showingReplace) setReplaceOpen(false);
            else openFind(true);
          }}>바꾸기</button>}
        <button type="button" className="icon-button" aria-label="찾기 닫기" onClick={closeFind}><X size={15} aria-hidden /></button>
      </div>
      {showingReplace && <div id={replaceId} className="code-replace" role="group" aria-label="편집기 바꾸기">
        <input ref={replacementInput} type="text" aria-label="바꿀 내용" placeholder="바꿀 내용"
          maxLength={searchLimit} spellCheck={false} autoComplete="off" value={replacement}
          onChange={event => { setReplacement(event.target.value); setReplaceReport(null); }}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              replaceMatches(false);
            }
          }} />
        <button type="button" className="secondary small" disabled={!matches.length} onClick={() => replaceMatches(false)}>한 건 바꾸기</button>
        <button type="button" className="secondary small" disabled={!matches.length} onClick={() => replaceMatches(true)}>모두 바꾸기</button>
        {replaceReport && <span className={replaceReport.error ? "form-error" : "code-replace-report"}
          role={replaceReport.error ? "alert" : "status"}>{replaceReport.text}</span>}
      </div>}
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
      <div className="code-editor-surface" data-highlight={showHighlight}>
        {showHighlight && <div className="code-highlight" aria-hidden="true" style={{ height: viewport.height, width: viewport.width }}>
          <div ref={highlightLines} className="code-highlight-lines" style={{ transform: `translate(${-viewport.left}px, ${shift}px)` }}>{highlightedLines}</div>
        </div>}
        <textarea {...props} ref={editorRef} wrap="off" value={value}
          aria-autocomplete={complete ? "list" : props["aria-autocomplete"]}
          aria-controls={completion.items.length ? completionId : props["aria-controls"]}
          aria-activedescendant={completionItemId ?? props["aria-activedescendant"]}
          onChange={event => {
            hover.close();
            syncCaret(event.currentTarget); syncViewport(event.currentTarget); setReplaceReport(null);
            completion.handleInput(event.currentTarget, event.nativeEvent as InputEvent);
            onChange?.(event);
          }}
          onSelect={event => { syncCaret(event.currentTarget); completion.handleSelection(event.currentTarget); onSelect?.(event); }}
          onFocus={event => { syncCaret(event.currentTarget); onFocus?.(event); }}
          onBlur={event => { completion.close(); hover.leave(); onBlur?.(event); }}
          onKeyDown={event => {
            const dismiss = hover.open && event.key === "Escape";
            hover.close();
            if (dismiss) { event.preventDefault(); event.stopPropagation(); return; }
            completion.handleKey(event);
            if (!event.defaultPrevented) onKeyDown?.(event);
          }}
          onPointerMove={event => {
            props.onPointerMove?.(event);
            if (!inspect || !showHighlight || composing || completion.status !== "closed" || event.buttons || event.pointerType !== "mouse") return;
            const point = { x: event.clientX, y: event.clientY };
            const editor = event.currentTarget;
            hover.move(point, () => highlightLines.current && editor.value === value
              ? sqliteSymbolAtPoint(highlightLines.current, value, lineStarts, first, point) : null);
          }}
          onPointerDown={event => { hover.close(); props.onPointerDown?.(event); }}
          onPointerLeave={event => { hover.leave(); props.onPointerLeave?.(event); }}
          onScroll={event => { syncViewport(event.currentTarget); onScroll?.(event); }}
          onCompositionStart={event => { setComposing(true); completion.close(); hover.close(); onCompositionStart?.(event); }}
          onCompositionEnd={event => { setComposing(false); onCompositionEnd?.(event); }} />
      </div>
    </div>
    {hover.popup}
    {completion.status !== "closed" && <div className="code-completion">
      {completion.items.length ? <ul id={completionId} role="listbox" aria-label="SQL 자동완성 후보">
        {completion.items.map((item, index) => <li key={item.insert} id={`${completionId}-${index}`} role="option"
          aria-selected={completion.selected === index} onPointerDown={event => event.preventDefault()} onClick={() => completion.choose(index)}>
          <span title={item.label}>{item.label}</span><small>{item.detail}</small>
        </li>)}
      </ul> : <p role="status">{completion.status === "pending" ? "자동완성 후보를 읽는 중…" : completion.status === "error"
        ? "이 연결의 자동완성 후보를 읽지 못했습니다." : "일치하는 자동완성 후보가 없습니다."}</p>}
    </div>}
    <div className="editor-footer">
      {footer}
      <div className="code-editor-nav">
        {complete && <button type="button" className="secondary small" title="Ctrl+Space" disabled={!editable}
          onClick={() => { const editor = editorRef.current; if (editor) { editor.focus({ preventScroll: true }); completion.open(editor); } }}>자동완성</button>}
        <button type="button" className="secondary small" aria-expanded={findOpen} aria-controls={findId} title="Ctrl+F"
          onClick={findOpen ? closeFind : () => openFind()}><Search size={14} aria-hidden /> 찾기</button>
        <span className="code-position">{formatNumber.format(activeLine)}줄 · {formatNumber.format(column)}열</span>
      </div>
    </div>
  </div>;
}
