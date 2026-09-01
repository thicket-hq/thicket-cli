// Process plumbing for the long-running commands: NDJSON to stdout,
// diagnostics to stderr, a clean stop on SIGINT/SIGTERM.

export function makeAbort(): { signal: AbortSignal; stop: () => void; dispose: () => void } {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    signal: controller.signal,
    stop,
    dispose: () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    },
  };
}

export function ndjson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function diag(prefix: string): (line: string) => void {
  return (line) => {
    process.stderr.write(`[${prefix}] ${line}\n`);
  };
}
