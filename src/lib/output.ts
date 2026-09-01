// The output contract, shared by humans and agents:
// success is `{ok: true, data, summary?, notice?, breadcrumbs?}`, failure is
// `{ok: false, error, code, hint?}`, and every code maps to a stable exit
// code. A TTY gets styled output by default; a pipe gets the JSON envelope.
import pc from "picocolors";
import { ThicketError } from "thicket-sdk";

export type OutputMode = "auto" | "json" | "quiet" | "agent" | "ids" | "count";

export type Breadcrumb = {
  action: string;
  cmd: string;
  description?: string;
};

export type CommandResult = {
  data: unknown;
  /** One-line human summary ("5 projects"). */
  summary?: string;
  /** Non-error information, e.g. truncation. */
  notice?: string;
  /** Suggested next commands — the agent-navigation primitive. */
  breadcrumbs?: Breadcrumb[];
  /** Styled lines for human (TTY) rendering; JSON modes ignore it. */
  human?: string[];
  /** For --ids-only: how to pull ids out of `data` (default: data[].id). */
  ids?: string[];
  /** The command already wrote its output (a long-running stream); render nothing. */
  silent?: boolean;
};

export type CliErrorCode =
  | "usage"
  | "validation"
  | "auth"
  | "forbidden"
  | "plan_limit"
  | "not_found"
  | "rate_limit"
  | "network"
  | "api"
  | "ambiguous";

export const EXIT_CODES: Record<CliErrorCode, number> = {
  api: 1,
  usage: 2,
  validation: 3,
  auth: 4,
  forbidden: 5,
  not_found: 6,
  rate_limit: 7,
  network: 8,
  ambiguous: 9,
  plan_limit: 10,
};

/**
 * Codes a caller may retry blindly: the request never reached a verdict
 * (network, timeout), or the server asked for a retry (429, 5xx). Every
 * other code is a verdict and a retry would repeat the same answer.
 */
const RETRYABLE_CODES = new Set<CliErrorCode>(["network", "rate_limit"]);

export class CliError extends Error {
  /** Whether the same call may be retried as-is (network, 429, 5xx). */
  public retryable: boolean;
  /** Seconds to wait before retrying, when the server said. */
  public retryAfter?: number;

  constructor(
    public code: CliErrorCode,
    message: string,
    public hint?: string,
    options: { retryable?: boolean; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.retryAfter = options.retryAfter;
  }
}

/** Maps an SDK transport error onto the CLI's error contract. */
export function fromSdkError(err: ThicketError): CliError {
  const map: Record<string, CliErrorCode> = {
    usage: "usage",
    validation: "validation",
    auth_required: "auth",
    forbidden: "forbidden",
    plan_limit: "plan_limit",
    not_found: "not_found",
    rate_limit: "rate_limit",
    network: "network",
    api_error: "api",
  };
  const code = map[err.code] ?? "api";
  let hint: string | undefined;
  if (code === "auth") {
    hint = "Run: thicket auth login";
  } else if (code === "rate_limit" && err.retryAfter) {
    hint = `Retry after ${err.retryAfter}s`;
  } else if (err.apiCode === "read_only_token") {
    hint = "Re-authenticate with write access: thicket auth login --scope full";
  } else if (err.apiCode === "session_required") {
    hint = "This route needs a signed-in browser session, not a token; use the web app";
  }
  // The SDK stamps retryable on network errors, 429 and 5xx; a 5xx without
  // the stamp is still worth a retry, a 4xx never is.
  const retryable =
    err.retryable ||
    code === "network" ||
    code === "rate_limit" ||
    (err.status !== undefined && err.status >= 500);
  return new CliError(code, err.message, hint, {
    retryable,
    retryAfter: err.retryAfter,
  });
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof ThicketError) return fromSdkError(err);
  if (err instanceof Error && err.name === "AbortError") {
    return new CliError("network", "The request timed out", undefined, {
      retryable: true,
    });
  }
  return new CliError(
    "api",
    err instanceof Error ? err.message : String(err),
  );
}

function collectIds(result: CommandResult): string[] {
  if (result.ids) return result.ids;
  const rows = Array.isArray(result.data) ? result.data : [result.data];
  return rows
    .map((row) =>
      row && typeof row === "object" && "id" in (row as Record<string, unknown>)
        ? String((row as Record<string, unknown>).id)
        : null,
    )
    .filter((id): id is string => id !== null);
}

function countOf(result: CommandResult): number {
  return Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1;
}

export type RenderTarget = {
  mode: OutputMode;
  isTty: boolean;
  write: (line: string) => void;
  writeErr: (line: string) => void;
  /** A jq filter applied to the success envelope (implies JSON mode). */
  jq?: string;
};

/** The success envelope as `--json` prints it. */
export function successEnvelope(result: CommandResult): Record<string, unknown> {
  const envelope: Record<string, unknown> = { ok: true, data: result.data };
  if (result.summary) envelope.summary = result.summary;
  if (result.notice) envelope.notice = result.notice;
  if (result.breadcrumbs?.length) envelope.breadcrumbs = result.breadcrumbs;
  return envelope;
}

/** Renders a success and returns the process exit code (always 0). */
export async function renderSuccess(
  result: CommandResult,
  target: RenderTarget,
): Promise<number> {
  const { mode, isTty } = target;
  if (result.silent) return 0;
  if (target.jq) {
    // --jq filters the envelope; each jq output is one line, strings raw
    // (gh's convention), everything else compact JSON.
    const { applyJq } = await import("./jq.js");
    const outputs = await applyJq(successEnvelope(result), target.jq);
    for (const value of outputs) {
      target.write(typeof value === "string" ? value : JSON.stringify(value));
    }
    return 0;
  }
  const effective = mode === "auto" ? (isTty ? "styled" : "json") : mode;
  switch (effective) {
    case "ids":
      for (const id of collectIds(result)) target.write(id);
      return 0;
    case "count":
      target.write(String(countOf(result)));
      return 0;
    case "quiet":
    case "agent":
      target.write(JSON.stringify(result.data ?? null, null, 2));
      if (result.notice) target.writeErr(result.notice);
      return 0;
    case "json": {
      target.write(JSON.stringify(successEnvelope(result), null, 2));
      return 0;
    }
    default: {
      // Styled, for humans.
      const lines = result.human ?? [
        JSON.stringify(result.data ?? null, null, 2),
      ];
      for (const line of lines) target.write(line);
      if (result.summary) target.write(pc.dim(result.summary));
      if (result.notice) target.write(pc.yellow(result.notice));
      if (result.breadcrumbs?.length) {
        target.write("");
        target.write(pc.dim("Next:"));
        for (const crumb of result.breadcrumbs) {
          target.write(
            `  ${pc.cyan(crumb.cmd)}${crumb.description ? pc.dim(`  ${crumb.description}`) : ""}`,
          );
        }
      }
      return 0;
    }
  }
}

/** The error envelope as every non-TTY mode prints it. */
export function errorEnvelope(err: CliError): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    ok: false,
    error: err.message,
    code: err.code,
    retryable: err.retryable,
  };
  if (err.hint) envelope.hint = err.hint;
  if (err.retryAfter !== undefined) envelope.retry_after = err.retryAfter;
  return envelope;
}

/** Renders a failure and returns its exit code. Errors are always structured. */
export function renderError(err: CliError, target: RenderTarget): number {
  const { mode, isTty } = target;
  const styled = mode === "auto" && isTty && !target.jq;
  if (styled) {
    target.writeErr(`${pc.red("error:")} ${err.message}`);
    if (err.hint) target.writeErr(pc.dim(err.hint));
  } else {
    target.writeErr(JSON.stringify(errorEnvelope(err), null, 2));
  }
  return EXIT_CODES[err.code] ?? 1;
}

/** Minimal column table for styled output. */
export function table(
  headers: string[],
  rows: string[][],
): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const render = (cells: string[], dim: boolean) =>
    cells
      .map((cell, i) => (cell ?? "").padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [
    pc.dim(render(headers, true)),
    ...rows.map((r) => render(r, false)),
  ];
}

/** Truncates a string for table cells. */
export function clip(value: string | null | undefined, max = 50): string {
  const s = (value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Formats an ISO date(-time) for humans, date part only. */
export function day(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
