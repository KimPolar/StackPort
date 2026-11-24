import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { compareResultPages, type Cell, type QueryPage } from "./sqlResults";
import { SqlQueryMetricsComparison } from "./SqlQueryMetrics";

export type ResultComparisonSource = { id: number; label: string; page: QueryPage };

function showCell(cell?: Cell) {
  return cell ? <><code>{cell.display}{cell.truncated && "…"}</code><small>{cell.kind.toUpperCase()}</small></> : "—";
}

function showRow(cells?: Cell[]) {
  return cells ? <code>{cells.slice(0, 3).map(cell => cell.display.length > 80
    ? cell.display.slice(0, 80) + "…" : cell.display + (cell.truncated ? "…" : "")).join(" · ")}{cells.length > 3 && " · …"}</code> : "—";
}

export function SqlResultComparison({ sources, initial, onClose }: {
  sources: ResultComparisonSource[];
  initial: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [left, setLeft] = useState(sources.some(source => source.id === initial) ? initial : sources[0].id);
  const [right, setRight] = useState(sources.find(source => source.id !== left)!.id);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const before = sources.find(source => source.id === left)!.page;
  const after = sources.find(source => source.id === right)!.page;
  const comparison = useMemo(() => compareResultPages(before, after), [before, after]);

  return <dialog ref={dialog} className="dialog sql-result-comparison" aria-labelledby="result-comparison-title" onClose={onClose}>
    <div className="dialog-heading">
      <h2 id="result-comparison-title">SQL 결과 비교</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={18} aria-hidden /></button>
    </div>
    <div className="sql-result-comparison-body">
      <div className="sql-result-comparison-options">
        <label className="field">기준 결과<select value={left} onChange={event => {
          const id = Number(event.target.value);
          if (id === right) setRight(left);
          setLeft(id);
        }}>{sources.map(source => <option key={source.id} value={source.id}>{source.label} · {source.page.page + 1}페이지</option>)}</select></label>
        <label className="field">비교 결과<select value={right} onChange={event => {
          const id = Number(event.target.value);
          if (id === left) setLeft(right);
          setRight(id);
        }}>{sources.map(source => <option key={source.id} value={source.id}>{source.label} · {source.page.page + 1}페이지</option>)}</select></label>
      </div>
      {comparison.kind === "different_page" ? <p role="status" className="form-note">같은 페이지 번호를 선택하면 결과를 비교할 수 있습니다.</p> : <>
        <p className="form-note">{before.page + 1}페이지의 행·열 순서로 비교합니다. 행 순서는 <code>ORDER BY</code>로 고정할 수 있습니다.</p>
        {before.metrics && after.metrics && <SqlQueryMetricsComparison before={before.metrics} after={after.metrics} />}
        {before.has_more !== after.has_more && <p className="form-note">두 결과의 다음 페이지 유무가 다릅니다.</p>}
        {comparison.kind === "columns" ? <>
          <p role="status">열 순서 또는 이름 {comparison.total}곳이 다릅니다.</p>
          <div className="table-wrap sql-result-differences" role="region" aria-label="열 차이 스크롤 영역" tabIndex={0}>
            <table aria-label="결과 열 차이"><thead><tr><th scope="col">열 번호</th><th scope="col">기준 이름</th><th scope="col">비교 이름</th></tr></thead>
              <tbody>{comparison.columns.map(column => <tr key={column.index}>
                <th scope="row">{column.index + 1}</th><td>{column.before ?? "—"}</td><td>{column.after ?? "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {comparison.columns.length < comparison.total && <p className="form-note">처음 {comparison.columns.length}곳을 표시합니다.</p>}
        </> : <>
          <p role="status">{comparison.changed || comparison.added || comparison.removed || comparison.uncertain
            ? `셀 ${comparison.changed}개 변경 · 행 ${comparison.added}개 추가 · 행 ${comparison.removed}개 감소 · 셀 ${comparison.uncertain}개 확인 불가`
            : "표시된 페이지에서 차이를 찾지 못했습니다."}</p>
          {!!comparison.uncertain && <p className="form-note">BLOB, 잘린 텍스트, 치환 문자가 있는 텍스트는 화면 정보만으로 일치 여부를 확인할 수 없습니다.</p>}
          {!!comparison.differences.length && <div className="table-wrap sql-result-differences" role="region" aria-label="값 차이 스크롤 영역" tabIndex={0}>
            <table aria-label="결과 값 차이"><thead><tr><th scope="col">행</th><th scope="col">열</th><th scope="col">상태</th><th scope="col">기준 값</th><th scope="col">비교 값</th></tr></thead>
              <tbody>{comparison.differences.map(item => <tr key={`${item.row}:${item.kind === "cell" ? item.column : "row"}`}>
                <th scope="row">{before.page * 100 + item.row + 1}</th>
                {item.kind === "cell" ? <><td>{item.column + 1}. {before.columns[item.column]}</td>
                  <td>{item.uncertain ? "확인 불가" : "변경"}</td><td>{showCell(item.before)}</td><td>{showCell(item.after)}</td></>
                  : <><td>행 전체</td><td>{item.after ? "추가" : "감소"}</td><td>{showRow(item.before)}</td><td>{showRow(item.after)}</td></>}
              </tr>)}</tbody>
            </table>
          </div>}
          {comparison.differences.length < comparison.changed + comparison.added + comparison.removed + comparison.uncertain &&
            <p className="form-note">처음 {comparison.differences.length}곳을 표시합니다.</p>}
        </>}
      </>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => dialog.current?.close()}>비교 닫기</button></div>
    </div>
  </dialog>;
}
