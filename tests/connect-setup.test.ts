// thicket connect setup through run(): who may give a named agent work and
// which projects it serves, written to a private file on this computer. Every
// flag rule, the personal and shared operator, the refusals, and the promise
// that a failed run writes nothing.
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { settingsPath, type ConnectSettings } from "../src/lib/agent-trust.js";
import { storeToken } from "../src/lib/keyring.js";
import { EXIT_CODES } from "../src/lib/output.js";
import {
  AGENT, CLIENT, JANE, JASON, OTHER_AGENT, P1, P2, P3, SAM, STRANGER, agentThicket, capture, cleanup, connectedAgent, environment,
} from "./agent-fixtures.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function setup(env: NodeJS.ProcessEnv, args: string[], thicket = agentThicket()) {
  const io = capture();
  const code = await run(["connect", "setup", "--profile", "helper", "--json", ...args], { env, fetch: thicket.transport, isTty: false, write: io.write, writeErr: io.writeErr });
  return { code, ...io, calls: thicket.calls };
}
const written = (env: NodeJS.ProcessEnv): ConnectSettings => JSON.parse(readFileSync(settingsPath(env, "helper"), "utf8"));
const fileText = (env: NodeJS.ProcessEnv) => existsSync(settingsPath(env, "helper")) ? readFileSync(settingsPath(env, "helper"), "utf8") : null;

describe("connect setup: the file", () => {
  it("a personal agent's operator is its owner; writes a private file with no secrets and answers {ready, written, checks}", async () => {
    const env = environment(); await connectedAgent(env);
    const result = await setup(env, ["--serve", P1]);
    expect(result.code).toBe(0);
    const { data, summary } = result.envelope();
    expect(data).toMatchObject({ ready: true, written: true, agent_membership_id: AGENT, path: settingsPath(env, "helper") });
    expect(data.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual(expect.arrayContaining(["identity:ok", "access:ok", "operator:ok", "serve:ok"]));
    expect(summary).toContain("thicket connect --profile helper");
    const settings = written(env);
    expect(settings).toMatchObject({
      version: 1, profile: "helper", organization: "acme", agent_membership_id: AGENT, agent_name: "Helper", agent_type: "personal",
      operator_id: JASON, operator_name: "Jason Hanschell", operator_from: "owner", owner_id: JASON,
      trust: "operator", allow: [], allow_assignments_from_authorized: false, allow_agents: [],
      agent_caps: { per_thread: 3, per_agent_per_day: 20 }, serve: [{ id: P1, name: "Website" }], watch_completions: [],
    });
    expect(Number.isNaN(Date.parse(settings.saved_at))).toBe(false);
    expect(statSync(settingsPath(env, "helper")).mode & 0o777).toBe(0o600);
    expect(fileText(env)).not.toContain("private-client-secret");
    expect(fileText(env)).not.toContain("thicket_agt_");
  });

  it("prints what it wrote for a person at a terminal", async () => {
    const env = environment(); await connectedAgent(env);
    const io = capture();
    const code = await run(["connect", "setup", "--profile", "helper", "--serve", P1], { env, fetch: agentThicket().transport, isTty: true, write: io.write, writeErr: io.writeErr });
    expect(code).toBe(0);
    const text = io.out.join("\n");
    expect(text).toContain(settingsPath(env, "helper"));
    expect(text).toContain("only Jason Hanschell");
    expect(text).toContain("Website");
  });

  it("refuses an operator flag that isn't a personal agent's owner, and accepts the owner", async () => {
    const env = environment(); await connectedAgent(env);
    const other = await setup(env, ["--serve", P1, "--operator", JANE]);
    expect(other.code).toBe(EXIT_CODES.usage);
    expect(other.error().error).toContain("Jason Hanschell");
    expect(fileText(env)).toBeNull();
    expect((await setup(env, ["--serve", P1, "--operator", JASON])).code).toBe(0);
    expect(written(env).operator_from).toBe("owner");
  });

  it("a shared agent needs an operator, by membership id or by that person's own profile, and keeps it on later runs", async () => {
    const env = environment(); await connectedAgent(env);
    const shared = () => agentThicket({ boss: null });
    const none = await setup(env, ["--serve", P1], shared());
    expect(none.code).toBe(EXIT_CODES.usage);
    expect(none.error().hint).toContain("--operator-profile");
    expect(fileText(env)).toBeNull();

    await storeToken("jane", `thicket_pat_${JANE}`, env);
    const byProfile = await setup(env, ["--serve", P1, "--operator-profile", "jane"], shared());
    expect(byProfile.code).toBe(0);
    expect(written(env)).toMatchObject({ agent_type: "shared", operator_id: JANE, operator_name: "Jane Doe", operator_from: "profile", owner_id: JANE });
    expect(byProfile.calls.some((c) => c.path === "/api/v1/authorization" && c.bearer === `Bearer thicket_pat_${JANE}`)).toBe(true);
    expect(byProfile.out.join("")).not.toContain(`thicket_pat_${JANE}`);

    expect((await setup(env, ["--serve", P2], shared())).code).toBe(0);
    expect(written(env)).toMatchObject({ operator_id: JANE, serve: [{ id: P1, name: "Website" }, { id: P2, name: "Mobile" }] });

    expect((await setup(env, ["--operator", SAM], shared())).code).toBe(0);
    expect(written(env)).toMatchObject({ operator_id: SAM, operator_from: "membership_id", owner_id: SAM });
  });

  it("refuses --operator with --operator-profile, an agent's profile as the operator, and a profile signed in as an agent", async () => {
    const env = environment(); await connectedAgent(env); await connectedAgent(env, "scout");
    const shared = () => agentThicket({ boss: null });
    expect((await setup(env, ["--operator", JANE, "--operator-profile", "jane"], shared())).code).toBe(EXIT_CODES.usage);
    expect((await setup(env, ["--operator-profile", "helper"], shared())).code).toBe(EXIT_CODES.usage);
    const agentProfile = await setup(env, ["--serve", P1, "--operator-profile", "scout"], shared());
    expect(agentProfile.code).toBe(EXIT_CODES.usage);
    expect(agentProfile.error().error).toContain("agent");
    const missing = await setup(env, ["--serve", P1, "--operator-profile", "nobody"], shared());
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(fileText(env)).toBeNull();
  });

  it("refuses an operator who is a client, an agent, or someone the agent can't see", async () => {
    const env = environment(); await connectedAgent(env);
    for (const [id, words] of [[CLIENT, "client"], [OTHER_AGENT, "agent"], [STRANGER, "can't see"]]) {
      const result = await setup(env, ["--serve", P1, "--operator", id], agentThicket({ boss: null }));
      expect(result.code).toBe(EXIT_CODES.validation);
      expect(result.error().error).toContain(words);
      expect(result.error().error).toContain("nothing was written");
    }
    expect(fileText(env)).toBeNull();
  });
});

describe("connect setup: who may give it work", () => {
  it("--trust operator takes no --allow; allowlist replaces, keeps, and clears the list", async () => {
    const env = environment(); await connectedAgent(env);
    expect((await setup(env, ["--serve", P1, "--trust", "operator", "--allow", JANE])).code).toBe(EXIT_CODES.usage);
    expect(fileText(env)).toBeNull();

    expect((await setup(env, ["--serve", P1, "--trust", "allowlist", "--allow", JANE, "--allow", SAM])).code).toBe(0);
    expect(written(env).allow.map((p) => p.name)).toEqual(["Jane Doe", "Sam Lee"]);
    expect((await setup(env, [])).code).toBe(0);
    expect(written(env)).toMatchObject({ trust: "allowlist", allow: [{ membership_id: JANE }, { membership_id: SAM }] });
    expect((await setup(env, ["--allow", SAM])).code).toBe(0);
    expect(written(env).allow.map((p) => p.membership_id)).toEqual([SAM]);

    // Kept trust operator refuses an allowlist too.
    expect((await setup(env, ["--trust", "operator"])).code).toBe(0);
    expect(written(env)).toMatchObject({ trust: "operator", allow: [] });
    expect((await setup(env, ["--allow", JANE])).code).toBe(EXIT_CODES.usage);
  });

  it("drops the operator from their own allowlist and warns about an empty allowlist", async () => {
    const env = environment(); await connectedAgent(env);
    const result = await setup(env, ["--serve", P1, "--trust", "allowlist", "--allow", JASON]);
    expect(result.code).toBe(0);
    expect(written(env).allow).toEqual([]);
    expect(result.envelope().data.checks).toContainEqual(expect.objectContaining({ check: "allow", status: "warn" }));
  });

  it("refuses an allowlisted client, agent, or stranger, and keeps the earlier file as it was", async () => {
    const env = environment(); await connectedAgent(env);
    expect((await setup(env, ["--serve", P1, "--trust", "project"])).code).toBe(0);
    const before = fileText(env);
    for (const id of [CLIENT, OTHER_AGENT, STRANGER]) {
      const result = await setup(env, ["--allow", id]);
      expect(result.code).toBe(EXIT_CODES.validation);
    }
    expect(fileText(env)).toBe(before);
  });

  it("assignments from the allowlist need someone on it; a run with --allow turns them off unless passed again", async () => {
    const env = environment(); await connectedAgent(env);
    const empty = await setup(env, ["--serve", P1, "--allow-assignments-from-authorized"]);
    expect(empty.code).toBe(EXIT_CODES.usage);
    expect(fileText(env)).toBeNull();

    expect((await setup(env, ["--serve", P1, "--trust", "allowlist", "--allow", JANE, "--allow-assignments-from-authorized"])).code).toBe(0);
    expect(written(env).allow_assignments_from_authorized).toBe(true);
    expect((await setup(env, [])).code).toBe(0);
    expect(written(env).allow_assignments_from_authorized).toBe(true);
    expect((await setup(env, ["--allow", JANE])).code).toBe(0);
    expect(written(env).allow_assignments_from_authorized).toBe(false);
    expect((await setup(env, ["--allow-assignments-from-authorized=true"])).code).toBe(0);
    expect(written(env).allow_assignments_from_authorized).toBe(true);
    expect((await setup(env, ["--allow-assignments-from-authorized=false"])).code).toBe(0);
    expect(written(env).allow_assignments_from_authorized).toBe(false);
    expect((await setup(env, ["--allow-assignments-from-authorized=maybe"])).code).toBe(EXIT_CODES.usage);
    expect((await setup(env, ["--trust", "operator"])).code).toBe(0);
    expect(written(env)).toMatchObject({ allow: [], allow_assignments_from_authorized: false });
  });

  it("project trust keeps operators beside it", async () => {
    const env = environment(); await connectedAgent(env);
    expect((await setup(env, ["--serve", P1, "--trust", "project", "--allow", JANE])).code).toBe(0);
    expect(written(env)).toMatchObject({ trust: "project", allow: [{ membership_id: JANE, name: "Jane Doe" }] });
  });

  it("other agents are added and removed one by one, and must be agents", async () => {
    const env = environment(); await connectedAgent(env);
    expect((await setup(env, ["--serve", P1, "--allow-agent", OTHER_AGENT])).code).toBe(0);
    expect(written(env).allow_agents).toEqual([{ membership_id: OTHER_AGENT, name: "Scout" }]);
    expect((await setup(env, [])).code).toBe(0);
    expect(written(env).allow_agents).toHaveLength(1);
    expect((await setup(env, ["--allow-agent", JANE])).code).toBe(EXIT_CODES.validation);
    expect((await setup(env, ["--allow-agent", AGENT])).code).toBe(EXIT_CODES.validation);
    expect((await setup(env, ["--allow-agent", OTHER_AGENT, "--disallow-agent", OTHER_AGENT])).code).toBe(EXIT_CODES.usage);
    expect((await setup(env, ["--disallow-agent", OTHER_AGENT])).code).toBe(0);
    expect(written(env).allow_agents).toEqual([]);
  });
});

describe("connect setup: projects", () => {
  it("serves only projects the agent is on, adds and removes them, and keeps completions a subset", async () => {
    const env = environment(); await connectedAgent(env);
    const notOn = await setup(env, ["--serve", P3]);
    expect(notOn.code).toBe(EXIT_CODES.validation);
    expect(notOn.error().error).toContain("Admin > Manage agents");
    expect(fileText(env)).toBeNull();

    expect((await setup(env, ["--serve", P1, "--serve", P2, "--watch-completions", P2])).code).toBe(0);
    expect(written(env)).toMatchObject({ serve: [{ id: P1 }, { id: P2 }], watch_completions: [{ id: P2, name: "Mobile" }] });
    expect((await setup(env, ["--watch-completions", P3])).code).toBe(EXIT_CODES.usage);
    expect((await setup(env, ["--watch-completions", P1])).code).toBe(0);
    expect(written(env).watch_completions.map((p) => p.id)).toEqual([P1]);
    expect((await setup(env, ["--serve", P1, "--unserve", P1])).code).toBe(EXIT_CODES.usage);
    expect((await setup(env, ["--unserve", P1])).code).toBe(0);
    expect(written(env)).toMatchObject({ serve: [{ id: P2 }], watch_completions: [] });
    expect((await setup(env, ["--watch-completions", P2])).code).toBe(0);
    expect((await setup(env, ["--no-watch-completions"])).code).toBe(0);
    expect(written(env).watch_completions).toEqual([]);
  });

  it("explains where to add an agent that is on no projects, and warns when it serves none", async () => {
    const env = environment(); await connectedAgent(env);
    const empty = await setup(env, [], agentThicket({ projects: [] }));
    expect(empty.code).toBe(EXIT_CODES.validation);
    expect(empty.error().error).toContain("on no projects");
    expect(empty.error().error).toContain("My settings > My agent");
    expect(empty.error().error).not.toContain("can't see");
    expect(empty.calls.some((c) => c.path.endsWith(`/people/${JASON}`))).toBe(false);
    expect(fileText(env)).toBeNull();
    const unserved = await setup(env, []);
    expect(unserved.code).toBe(0);
    expect(unserved.envelope().data.checks).toContainEqual(expect.objectContaining({ check: "serve", status: "warn" }));
  });

  it("refuses a kept project the agent has since left, until it is unserved", async () => {
    const env = environment(); await connectedAgent(env);
    expect((await setup(env, ["--serve", P1, "--serve", P2])).code).toBe(0);
    const left = await setup(env, [], agentThicket({ projects: [{ id: P1, name: "Website" }] }));
    expect(left.code).toBe(EXIT_CODES.validation);
    expect(left.error().error).toContain(`--unserve ${P2}`);
    expect((await setup(env, ["--unserve", P2], agentThicket({ projects: [{ id: P1, name: "Website" }] }))).code).toBe(0);
  });
});

describe("connect setup: refusals", () => {
  it("refuses THICKET_TOKEN, the default profile, a person's credential, a read-only connection, and bad values, writing nothing", async () => {
    const env = environment(); await connectedAgent(env);
    expect((await setup({ ...env, THICKET_TOKEN: "thicket_pat_x" }, ["--serve", P1])).code).toBe(EXIT_CODES.usage);
    const io = capture();
    expect(await run(["connect", "setup", "--serve", P1], { env, fetch: agentThicket().transport, isTty: false, write: io.write, writeErr: io.writeErr })).toBe(EXIT_CODES.usage);
    expect(await run(["connect", "setup", "--profile", "default", "--serve", P1], { env, fetch: agentThicket().transport, isTty: false, write: io.write, writeErr: io.writeErr })).toBe(EXIT_CODES.usage);
    expect((await setup(env, ["--trust", "everyone"])).code).toBe(EXIT_CODES.usage);
    expect((await setup(env, ["--serve", "Website"])).code).toBe(EXIT_CODES.usage);
    const readOnly = await setup(env, ["--serve", P1], agentThicket({ scope: "read" }));
    expect(readOnly.code).toBe(EXIT_CODES.validation);
    expect(readOnly.error().error).toContain("Full access");
    expect(fileText(env)).toBeNull();

    const person = environment();
    await storeToken("helper", `thicket_pat_${JANE}`, person);
    expect((await setup(person, ["--serve", P1])).code).toBe(EXIT_CODES.auth);
    expect(existsSync(settingsPath(person, "helper"))).toBe(false);
  });

  it("starts fresh when the profile now belongs to another agent", async () => {
    const env = environment(); await connectedAgent(env);
    expect((await setup(env, ["--serve", P1, "--trust", "project"])).code).toBe(0);
    const settings = written(env);
    const { writeConnectSettings } = await import("../src/lib/agent-trust.js");
    writeConnectSettings(env, "helper", { ...settings, agent_membership_id: OTHER_AGENT });
    const fresh = await setup(env, ["--serve", P2]);
    expect(fresh.code).toBe(0);
    expect(written(env)).toMatchObject({ agent_membership_id: AGENT, trust: "operator", serve: [{ id: P2 }] });
    expect(fresh.envelope().data.checks).toContainEqual(expect.objectContaining({ check: "settings", status: "warn" }));
  });
});

describe("the catalog", () => {
  it("lists connect setup with its flags, and the connector, status and settle", async () => {
    const io = capture();
    expect(await run(["commands", "--json"], { env: environment(), isTty: false, write: io.write, writeErr: io.writeErr })).toBe(0);
    const entries = io.envelope().data.commands as { name: string; flags: { flag: string }[] }[];
    const names = entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["auth agent connect", "connect", "connect setup", "connect status", "connect settle"]));
    const flags = entries.find((e) => e.name === "connect setup")!.flags.map((f) => f.flag.split(" ")[0]);
    expect(flags).toEqual(["--trust", "--operator", "--operator-profile", "--allow", "--allow-assignments-from-authorized", "--allow-agent",
      "--disallow-agent", "--serve", "--unserve", "--watch-completions", "--no-watch-completions"]);
  });
});
