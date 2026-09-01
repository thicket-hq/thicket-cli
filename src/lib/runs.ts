// The run registry for long-running watches: ~/.config/thicket/runs/<pid>.json
// says what each live `thicket agent watch` covers, so a second watch on the
// same agent and projects is refused (it would ack and dispatch every
// directive twice) and `--status` can answer "what is running?".
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";

export type RunRecord = {
  pid: number;
  started_at: string;
  org: string;
  agent: { membership_id: string; name: string };
  /** Watched project ids; empty means every project. */
  projects: { id: string; name: string }[];
  trust: { mode: string; allow: string[] };
  source: "sse" | "poll";
  argv: string[];
};

export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "runs");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Live runs; entries whose process is gone are pruned on the way. */
export function listRuns(env: NodeJS.ProcessEnv = process.env): RunRecord[] {
  const dir = runsDir(env);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let record: RunRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    } catch {
      rmSync(path, { force: true });
      continue;
    }
    if (!record.pid || !alive(record.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    runs.push(record);
  }
  return runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export function registerRun(record: RunRecord, env: NodeJS.ProcessEnv = process.env): string {
  const dir = runsDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.pid}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function unregisterRun(pid: number, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(join(runsDir(env), `${pid}.json`), { force: true });
}

/** A live run that already covers this agent and any of these projects. */
export function overlappingRun(
  agentMembershipId: string,
  projectIds: string[],
  env: NodeJS.ProcessEnv = process.env,
): RunRecord | null {
  for (const run of listRuns(env)) {
    if (run.agent.membership_id !== agentMembershipId) continue;
    if (run.projects.length === 0 || projectIds.length === 0) return run;
    if (run.projects.some((p) => projectIds.includes(p.id))) return run;
  }
  return null;
}
