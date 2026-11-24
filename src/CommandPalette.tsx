import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Search, X, type LucideIcon } from "lucide-react";

export type WorkspaceCommand = {
  id: string;
  title: string;
  group: string;
  detail?: string;
  keywords?: string;
  Icon: LucideIcon;
  run: () => void;
};

const searchText = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ko-KR");
const resultLimit = 50;

export function CommandPalette({ commands, recent, onClose, onRun }: {
  commands: WorkspaceCommand[];
  recent: string[];
  onClose: () => void;
  onRun: (command: WorkspaceCommand) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const activeOption = useRef<HTMLLIElement>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const needle = searchText(query.trim());
  const terms = needle ? needle.split(/\s+/) : [];
  const ranked = commands.flatMap(command => {
    const title = searchText(command.title);
    const termsSource = searchText([command.title, command.group, command.detail, command.keywords].filter(Boolean).join(" "));
    if (!terms.every(term => termsSource.includes(term))) return [];
    const match = !needle ? 0 : title === needle ? 3 : title.startsWith(needle) ? 2 : title.includes(needle) ? 1 : 0;
    const recentIndex = recent.indexOf(command.id);
    return [{ command, match, recency: recentIndex >= 0 ? recent.length - recentIndex : 0 }];
  }).sort((left, right) => right.match - left.match || right.recency - left.recency);
  const results = ranked.slice(0, resultLimit);
  const activeIndex = Math.max(0, results.findIndex(result => result.command.id === activeId));
  const activeCommand = results[activeIndex]?.command;

  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);

  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [activeCommand?.id, activeIndex]);

  function run(command: WorkspaceCommand) {
    dialog.current?.close();
    onRun(command);
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !results.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setActiveId(results[(activeIndex + offset + results.length) % results.length].command.id);
    } else if (event.key === "Enter" && activeCommand) {
      event.preventDefault();
      run(activeCommand);
    }
  }

  return <dialog ref={dialog} className="dialog command-palette" aria-labelledby="command-palette-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="command-palette-title">명령 팔레트</h2>
      <button type="button" className="icon-button" aria-label="명령 팔레트 닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="command-search">
      <Search size={16} aria-hidden />
      <input ref={input} role="combobox" aria-label="명령 검색" aria-controls="command-results" aria-expanded="true"
        aria-autocomplete="list" aria-activedescendant={activeCommand ? `command-option-${activeIndex}` : undefined}
        placeholder="도구, 프로젝트, 연결, 테이블 검색" autoComplete="off" spellCheck={false}
        value={query} onChange={event => { setQuery(event.target.value); setActiveId(null); }} onKeyDown={navigate} />
    </div>
    {results.length > 0 && <div className="command-group">
      <span>{!needle && results[0].recency > 0 ? "최근 명령부터 표시" : needle ? "검색 결과" : "사용 가능한 명령"}</span>
      <span role="status">{ranked.length > resultLimit ? `${ranked.length}개 중 ${resultLimit}개` : `${ranked.length}개`}</span>
    </div>}
    <ul id="command-results" className="command-results" role="listbox" aria-label="검색 결과">
      {results.map(({ command }, index) => <li key={command.id} id={`command-option-${index}`} role="option"
        ref={index === activeIndex ? activeOption : undefined} aria-selected={index === activeIndex}
        className="command-option" onMouseDown={event => event.preventDefault()} onClick={() => run(command)}>
        <command.Icon size={16} aria-hidden />
        <div><strong>{command.title}</strong>{command.detail && <small>{command.detail}</small>}</div>
        <span>{command.group}</span>
        {index === activeIndex && <ArrowUpRight className="command-return" size={14} aria-hidden />}
      </li>)}
    </ul>
    {!results.length && <p className="command-empty" role="status">일치하는 명령이 없습니다. 다른 검색어를 입력해 보세요.</p>}
    <div className="command-hints"><span><kbd>↑</kbd> <kbd>↓</kbd> 이동</span><span><kbd>Enter</kbd> 열기</span><span><kbd>Esc</kbd> 닫기</span></div>
  </dialog>;
}
