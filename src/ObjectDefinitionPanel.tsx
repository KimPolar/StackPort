import { useState } from "react";
import { SqlFileDialog } from "./SqlFileDialog";

export function ObjectDefinitionPanel({ text, truncated = false, target, engine, title = "정의 SQL" }: {
  text: string; truncated?: boolean; target: string; engine: string; title?: string;
}) {
  const [save, setSave] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function copy() {
    setNotice("");
    setError("");
    try {
      await navigator.clipboard.writeText(text);
      setNotice(title + "을 복사했습니다.");
    } catch {
      setError(title + "을 복사할 수 없습니다.");
    }
  }

  return <section className="mysql-definition" aria-label={engine + " " + title}>
    {!truncated && <div className="mysql-views">
      <button type="button" className="secondary small" onClick={() => void copy()}>SQL 복사</button>
      <button type="button" className="secondary small" onClick={() => setSave(true)}>정의 파일 저장</button>
    </div>}
    <pre className="mysql-inspection-expression" tabIndex={0} aria-label={title + " 원문"}><code>{text}</code></pre>
    {truncated && <p className="form-note">생성 SQL의 앞 262,144자까지 표시합니다.</p>}
    {notice && <p className="form-note" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {save && <SqlFileDialog mode="save_definition" target={target} definition={text} onClose={() => setSave(false)}
      onDone={path => { setSave(false); setNotice(`SQL 파일 저장 완료 · ${path}`); }} />}
  </section>;
}
