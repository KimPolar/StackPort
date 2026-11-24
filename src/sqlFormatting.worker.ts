import { formatSql, type FormatRequest } from "./sqlFormatting";

self.addEventListener("message", (event: MessageEvent<{ id: number; request: FormatRequest }>) => {
  self.postMessage({ id: event.data.id, answer: formatSql(event.data.request) });
});
