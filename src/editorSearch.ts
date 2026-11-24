export function firstAtOrAfter(offsets: number[], position: number) {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function findEditorMatches(value: string, query: string, matchCase: boolean) {
  const matches: number[] = [];
  if (!query) return matches;
  if (matchCase) {
    for (let start = value.indexOf(query); start !== -1; start = value.indexOf(query, start + query.length)) {
      matches.push(start);
    }
  } else {
    const syntax = ".*+?^$\\{}()|[]";
    const literal = Array.from(query, character => syntax.includes(character) ? "\\" + character : character).join("");
    for (const match of value.matchAll(new RegExp(literal, "giu"))) matches.push(match.index);
  }
  return matches;
}

export function revealEditorMatch(editor: HTMLTextAreaElement, line: number, lineStart: number, start: number, length: number, lineHeight: number) {
  const style = getComputedStyle(editor);
  const rowTop = line * lineHeight + parseFloat(style.paddingTop);
  if (rowTop < editor.scrollTop || rowTop + lineHeight > editor.scrollTop + editor.clientHeight) {
    editor.scrollTop = Math.max(0, rowTop - (editor.clientHeight - lineHeight) / 2);
  }
  if (editor.scrollWidth <= editor.clientWidth) return;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const tabWidth = parseFloat(style.tabSize) * context.measureText(" ").width;
  const measure = (end: number) => {
    let width = 0;
    const pieces = editor.value.slice(lineStart, end).split("\t");
    for (const [index, piece] of pieces.entries()) {
      if (index && tabWidth > 0) width = (Math.floor(width / tabWidth) + 1) * tabWidth;
      width += context.measureText(piece).width;
    }
    return width + parseFloat(style.paddingLeft);
  };
  const left = measure(start);
  if (left < editor.scrollLeft || measure(start + length) > editor.scrollLeft + editor.clientWidth) {
    editor.scrollLeft = Math.max(0, left - 16);
  }
}
