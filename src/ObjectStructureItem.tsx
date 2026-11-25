import type { ReactNode } from "react";

export function ObjectStructureItem({ title, meta, children }: {
  title: string; meta: string; children: ReactNode;
}) {
  return <details className="mysql-inspection-item">
    <summary><strong>{title}</strong><small>{meta}</small></summary>
    <div>{children}</div>
  </details>;
}
