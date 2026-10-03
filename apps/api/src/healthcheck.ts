// Container HEALTHCHECK for the web/API command (liveness only; readiness belongs to the LB).
const port = process.env.HTTP_PORT ?? '3000';
fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) })
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
