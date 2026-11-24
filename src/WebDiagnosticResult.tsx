type WebTls = { protocol: string | null; cipher_suite: string | null; cipher_bits: number | null };
type WebSample = { elapsed_ms: number } & (
  | { result: "received"; status_code: number; headers: { name: string; value: string }[]; tls: WebTls | null }
  | { result: "failed"; reason: keyof typeof failures; os_error: number }
);
export type WebDiagnostic = { origin: string; samples: WebSample[] };

const failures = {
  timeout: "요청 시간 초과",
  dns: "DNS 조회 실패",
  connection: "서버 연결 실패",
  certificate: "HTTPS 인증서 검증 실패",
  tls: "TLS 연결 실패",
  headers: "응답 헤더 한도 초과",
  other: "HTTP 요청 실패",
};

export function WebDiagnosticResult({ diagnostic }: { diagnostic: WebDiagnostic }) {
  const received = diagnostic.samples.filter(sample => sample.result === "received");
  const successful = received.filter(sample => sample.status_code >= 200 && sample.status_code < 300).length;
  return <section className="results-card web-result" aria-label="웹 상태 확인 결과">
    <div className="panel-heading" role="status">
      <div><strong>{diagnostic.origin}</strong><span>응답 {received.length}/{diagnostic.samples.length}회 · HTTP 2xx {successful}회</span></div>
    </div>
    <ol>
      {diagnostic.samples.map((sample, index) => <li key={index}>
        {sample.result === "failed"
          ? <div className="web-sample-heading"><strong>{failures[sample.reason]}</strong><span>{sample.elapsed_ms} ms · Windows {sample.os_error}</span></div>
          : <details open={diagnostic.samples.length === 1}>
              <summary><strong>HTTP {sample.status_code}</strong><span>{sample.elapsed_ms} ms</span></summary>
              {sample.tls && <p className="web-tls">
                {sample.tls.protocol ?? "TLS"} · 인증서 검증 통과
                {sample.tls.cipher_suite && ` · ${sample.tls.cipher_suite}`}
                {sample.tls.cipher_bits && ` · ${sample.tls.cipher_bits}비트`}
              </p>}
              {sample.headers.length > 0 && <dl className="web-headers">
                {sample.headers.map(({ name, value }, row) => <div key={row}><dt>{name}</dt><dd>{value}</dd></div>)}
              </dl>}
            </details>}
      </li>)}
    </ol>
  </section>;
}
