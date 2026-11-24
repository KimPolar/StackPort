import { ArrowLeft, ArrowRight } from "lucide-react";

export function PostgresPager({ label, page, next, change }: { label: string; page: number; next: boolean; change: (page: number) => void }) {
  if (!page && !next) return null;
  return <div className="pagination" role="group" aria-label={label + " 페이지 이동"}>
    <span>{label} {page + 1}페이지</span><div>
      <button type="button" className="icon-button" aria-label={"이전 " + label + " 페이지"} disabled={!page} onClick={() => change(page - 1)}><ArrowLeft size={15} aria-hidden /></button>
      <button type="button" className="icon-button" aria-label={"다음 " + label + " 페이지"} disabled={!next} onClick={() => change(page + 1)}><ArrowRight size={15} aria-hidden /></button>
    </div>
  </div>;
}
