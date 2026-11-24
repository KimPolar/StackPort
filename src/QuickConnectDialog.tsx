import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Database, Monitor, TerminalSquare } from "lucide-react";
import { Dialog } from "./Dialog";
import { networkAddressText, parseQuickTarget, type QuickTarget } from "./quickConnect";

type SavedTarget = { id: string; name: string; environment: string; open: () => void };
const tools = {
  ssh: { label: "SSH", Icon: TerminalSquare, action: "SSH 연결 준비" },
  rdp: { label: "원격 데스크톱", Icon: Monitor, action: "원격 화면에서 열기" },
  postgres: { label: "PostgreSQL", Icon: Database, action: "PostgreSQL 연결 등록" },
  sqlite: { label: "SQLite", Icon: Database, action: "SQLite 연결 등록" },
};

export function QuickConnectDialog({ project, findSaved, onProceed, onCreateProject, onClose }: {
  project: string | undefined;
  findSaved: (target: QuickTarget) => SavedTarget[];
  onProceed: (target: QuickTarget, saveSsh: boolean) => void;
  onCreateProject: () => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const hint = useId();
  const issue = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  let target: QuickTarget | undefined;
  let validation = "";
  try {
    target = parseQuickTarget(address);
  } catch (error) {
    validation = error instanceof Error ? error.message : "연결 주소를 확인하세요.";
  }
  const saved = target ? findSaved(target) : [];
  const tool = target && tools[target.kind];
  const needsProject = target && (target.kind === "sqlite" || target.kind === "postgres") && !project;
  const error = submitted && validation;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!target || needsProject || saved.length > 1) return;
    if (saved.length === 1) saved[0].open();
    else onProceed(target, false);
  }

  return <Dialog title="빠른 연결" className="quick-connect-dialog" busy={false} onClose={onClose}>
    <form onSubmit={submit}>
      <label className="field">연결 주소<input ref={input} autoComplete="off" spellCheck={false} maxLength={4096}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${hint} ${issue}` : hint}
        value={address} onChange={event => { setAddress(event.target.value); setSubmitted(false); }}
        placeholder="예: ssh://user@server.example.com" /></label>
      <p className="form-note" id={hint}>호스트와 포트, SSH·PostgreSQL·RDP URL 또는 SQLite 파일의 절대 경로를 입력하세요. 암호는 연결 화면에서 입력합니다.</p>
      {error && <p className="form-error" role="alert" id={issue}>{error}</p>}
      {target && tool && <div className="quick-connect-target">
        <span className="quick-connect-icon"><tool.Icon size={18} aria-hidden /></span>
        <div><strong>{tool.label}</strong><p>{target.kind === "sqlite" ? target.path :
          [target.username && `${target.username}@`, networkAddressText(target), target.kind === "postgres" && target.database && `/${target.database}`].filter(Boolean).join("")}</p></div>
      </div>}
      {saved.length > 0 && <div className="quick-connect-saved">
        <p className="form-note">현재 프로젝트의 저장된 연결</p>
        <ul>{saved.map(item => <li key={item.id}><button type={saved.length === 1 ? "submit" : "button"} className="quick-connect-match"
          onClick={saved.length === 1 ? undefined : item.open}>
          <span>{item.name}</span><span className={`environment ${item.environment.toLowerCase()}`}>{item.environment}</span>
          <ArrowRight size={14} aria-hidden /></button></li>)}</ul>
      </div>}
      {needsProject && <p className="form-note">연결을 등록하려면 프로젝트가 필요합니다.</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>취소</button>
        {target?.kind === "ssh" && project && !saved.length && <button type="button" className="secondary" onClick={() => onProceed(target, true)}>SSH 연결 등록</button>}
        {needsProject ? <button type="button" className="primary" onClick={onCreateProject}>새 프로젝트</button> :
          saved.length === 0 && <button type="submit" className="primary">{tool?.action ?? "주소 확인"}<ArrowRight size={14} aria-hidden /></button>}
      </div>
    </form>
  </Dialog>;
}
