// --jq: filter the JSON envelope with real jq (jq-wasm, jq 1.8 compiled to
// WebAssembly; no native dependency). Loaded lazily so invocations without
// --jq never pay for the wasm compile.
import { CliError } from "./output.js";

export async function applyJq(input: unknown, filter: string): Promise<unknown[]> {
  const { json, JqError } = await import("jq-wasm");
  try {
    return await json(input as object, filter);
  } catch (err) {
    if (err instanceof JqError) {
      const detail = err.stderr.trim().split("\n")[0] || err.message;
      throw new CliError("usage", `jq: ${detail}`, "Check the --jq filter");
    }
    throw err;
  }
}
