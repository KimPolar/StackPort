import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { sqliteEditorTokens } from "./editorSyntax";

export type EditorHoverInfo = {
  heading: string;
  detail: string;
  openDefinition: () => void;
};
export type EditorHoverProvider = (source: string, position: number) => Promise<EditorHoverInfo | null>;
type Point = { x: number; y: number };
type SymbolHit = { position: number; bounds: DOMRect };
type Card = SymbolHit & EditorHoverInfo;

function contains(bounds: DOMRect, { x, y }: Point) {
  return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
}

export function sqliteSymbolAtPoint(lines: HTMLElement, source: string, lineStarts: number[], first: number, point: Point): SymbolHit | null {
  const top = lines.firstElementChild?.getBoundingClientRect();
  if (!top?.height) return null;
  const rowIndex = Math.floor((point.y - top.top) / top.height);
  const row = lines.children.item(rowIndex);
  if (!row) return null;
  const lineIndex = first + rowIndex;
  const start = lineStarts[lineIndex];
  const end = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] - 1 : source.length;
  const line = source.slice(start, end);
  if (!line || line.length > 8192) return null;

  // The highlight layer uses the same font, tab stops and bidi layout as the textarea.
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let offset = 0;
  const range = document.createRange();
  for (const token of sqliteEditorTokens(line)) {
    if (token.kind !== "word" && token.kind !== "identifier") continue;
    while (node && offset + node.textContent!.length <= token.start) {
      offset += node.textContent!.length;
      node = walker.nextNode();
    }
    if (!node) return null;
    range.setStart(node, token.start - offset);
    while (node && offset + node.textContent!.length < token.end) {
      offset += node.textContent!.length;
      node = walker.nextNode();
    }
    if (!node) return null;
    range.setEnd(node, token.end - offset);
    const bounds = [...range.getClientRects()].find(rect => contains(rect, point));
    if (bounds) return { position: start + token.start + 1, bounds };
  }
  return null;
}

export function useEditorHover(source: string, context: string | undefined, editor: RefObject<HTMLTextAreaElement | null>, provider?: EditorHoverProvider) {
  const [card, setCard] = useState<Card | null>(null);
  const cardElement = useRef<HTMLElement>(null);
  const active = useRef<Card | null>(null);
  const request = useRef<{ timer: number } | null>(null);
  const dismissTimer = useRef<number | undefined>(undefined);

  function hold() {
    window.clearTimeout(request.current?.timer);
    window.clearTimeout(dismissTimer.current);
    request.current = null;
    dismissTimer.current = undefined;
  }

  function close() {
    hold();
    if (!active.current) return;
    active.current = null;
    setCard(null);
  }

  function leave() {
    window.clearTimeout(request.current?.timer);
    request.current = null;
    if (active.current && dismissTimer.current === undefined && !cardElement.current?.contains(document.activeElement)) {
      dismissTimer.current = window.setTimeout(() => {
        dismissTimer.current = undefined;
        active.current = null;
        setCard(null);
      }, 220);
    }
  }

  useLayoutEffect(() => {
    if (context === undefined) return;
    const previous = active.current;
    hold();
    active.current = null;
    if (previous) setCard(null);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      hold();
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [source, context]);

  function move(point: Point, locate: () => SymbolHit | null) {
    if (!provider || cardElement.current?.contains(document.activeElement)) return;
    if (active.current && contains(active.current.bounds, point)) { hold(); return; }
    leave();
    const pending = { timer: window.setTimeout(async () => {
      try {
        const hit = locate();
        const info = hit && await provider(source, hit.position);
        if (request.current !== pending || !hit || !info) return;
        const card = { ...info, ...hit };
        active.current = card;
        setCard(card);
      } catch {
        // A transient schema lookup failure leaves the editor and its F12 action available.
      } finally {
        if (request.current === pending) request.current = null;
      }
    }, 370) };
    request.current = pending;
  }

  const popup = card && createPortal(<section ref={cardElement} className="editor-hover" aria-label="SQL 객체 정보"
    style={{
      left: Math.max(8, Math.min(card.bounds.left, window.innerWidth - 308)),
      ...(window.innerHeight - card.bounds.bottom >= 128 ? { top: card.bounds.bottom + 4 }
        : { bottom: window.innerHeight - card.bounds.top + 4 }),
    }} onPointerEnter={hold} onPointerLeave={leave} onFocus={hold}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        editor.current?.focus({ preventScroll: true });
      }
    }}>
    <strong>{card.heading}</strong>
    <span>{card.detail}</span>
    <button type="button" className="secondary small" onClick={() => {
      close();
      editor.current?.focus({ preventScroll: true });
      card.openDefinition();
    }}>정의 보기</button>
  </section>, document.body);

  return { popup, open: !!card, move, leave, close };
}
