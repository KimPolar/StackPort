import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { EditorCompletion } from "./sqlCompletion";

export type EditorCompletionProvider = (value: string, position: number) => Promise<{
  start: number;
  end: number;
  items: EditorCompletion[];
} | null>;

export function useEditorCompletion(editorRef: RefObject<HTMLTextAreaElement | null>, provider?: EditorCompletionProvider) {
  const [items, setItems] = useState<EditorCompletion[]>([]);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState<"closed" | "pending" | "ready" | "error">("closed");
  const request = useRef<{ value: string; position: number; timer: number; start?: number; end?: number } | null>(null);

  useEffect(() => () => {
    window.clearTimeout(request.current?.timer);
    request.current = null;
  }, []);

  function close() {
    if (!request.current) return;
    window.clearTimeout(request.current.timer);
    request.current = null;
    setStatus("closed");
    setItems([]);
  }

  function open(editor: HTMLTextAreaElement, delay = 0) {
    if (!provider || editor.readOnly || editor.disabled || editor.selectionStart !== editor.selectionEnd) {
      close();
      return;
    }
    window.clearTimeout(request.current?.timer);
    const current: NonNullable<typeof request.current> = { value: editor.value, position: editor.selectionStart, timer: 0 };
    request.current = current;
    setStatus("pending");
    setItems([]);
    setSelected(0);
    current.timer = window.setTimeout(() => {
      void provider(current.value, current.position).then(result => {
        if (request.current !== current) return;
        if (!result) { close(); return; }
        current.start = result.start;
        current.end = result.end;
        setItems(result.items);
        setStatus("ready");
      }, () => { if (request.current === current) setStatus("error"); });
    }, delay);
  }

  function choose(index: number) {
    const editor = editorRef.current;
    const item = items[index];
    const current = request.current;
    if (!editor || !item || current?.start === undefined || current.end === undefined || editor.value !== current.value ||
      editor.selectionStart !== current.position || editor.selectionEnd !== current.position) {
      close();
      return;
    }
    close();
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(current.start, current.end);
    if (document.execCommand("insertText", false, item.insert) && item.caret !== undefined) {
      const position = current.start + item.caret;
      editor.setSelectionRange(position, position);
    }
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!provider || event.nativeEvent.isComposing || event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === "Space") {
      event.preventDefault();
      open(event.currentTarget);
    } else if (request.current && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (items.length && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(index => (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      } else if (!event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        choose(selected);
      }
    }
  }

  function handleSelection(editor: HTMLTextAreaElement) {
    if (request.current && (editor.selectionStart !== request.current.position || editor.selectionEnd !== request.current.position)) close();
  }

  function handleInput(editor: HTMLTextAreaElement, event: InputEvent) {
    if (!provider) return;
    if (event.isComposing) close();
    else if (request.current || event.data === ".") open(editor, 130);
  }

  return { items, selected, status, close, open, choose, handleKey, handleInput, handleSelection };
}
