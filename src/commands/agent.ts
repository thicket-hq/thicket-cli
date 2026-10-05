// Browser-connected agents use the same CLI commands as their user.
import { userAgent, type CliContext } from "../lib/context.js";
import type { CommandResult } from "../lib/output.js";
import type { CommandSpec } from "../lib/registry.js";

/** The plugin's SessionStart hook: one line, never a failure. */
async function sessionStart(ctx: CliContext): Promise<CommandResult> {
  let line: string;
  try {
    const creds = await ctx.credentials();
    if (!creds) {
      line = "Thicket CLI: not signed in; run `thicket auth login` (a browser approval) before using thicket commands.";
    } else {
      const response = await ctx.fetch(`${ctx.settings.baseUrl}/api/v1/authorization`, {
        headers: { authorization: `Bearer ${creds.token}`, "user-agent": userAgent() },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) {
        line = `Thicket CLI: the stored token was refused (HTTP ${response.status}); run \`thicket auth login\`.`;
      } else {
        const doc = (await response.json()) as {
          scope: string;
          organizations: { slug: string; name: string; membership_id: string; membership_kind?: string; role: string }[];
        };
        const acting = ctx.settings.org ?? (doc.organizations.length === 1 ? doc.organizations[0].slug : null);
        const org = doc.organizations.find((o) => o.slug === acting) ?? doc.organizations[0];
        let who = org ? `membership ${org.membership_id}` : "no organization";
        if (org) {
          try {
            const people = await ctx.fetch(`${ctx.settings.baseUrl}/api/v1/${org.slug}/people`, {
              headers: { authorization: `Bearer ${creds.token}`, "user-agent": userAgent() },
              signal: AbortSignal.timeout(4000),
            });
            if (people.ok) {
              const rows = (await people.json()) as { membership_id: string; name: string }[];
              const mine = rows.find((p) => p.membership_id === org.membership_id);
              if (mine) who = `${mine.name} (${org.membership_kind ?? "person"}, ${org.role})`;
            }
          } catch {
            // Best effort; the membership id already says who.
          }
        }
        line = `Thicket CLI: signed in as ${who} in ${doc.organizations.map((o) => o.slug).join(", ") || "no orgs"}${acting ? ` (acting in ${acting})` : doc.organizations.length > 1 ? " (no default org: pass --org or run thicket orgs use <slug>)" : ""}, ${doc.scope} scope. Skill: /thicket-cli; catalog: thicket commands --json.`;
      }
    }
  } catch (err) {
    line = `Thicket CLI: could not reach ${ctx.settings.baseUrl} (${err instanceof Error ? err.message : String(err)}); thicket commands may fail until it is back.`;
  }
  process.stdout.write(`${line}\n`);
  return { data: { line }, silent: true };
}

export const agentCommands: CommandSpec[] = [
  {
    path: ["agent-hook", "session-start"],
    category: "Meta",
    summary: "Claude Code SessionStart hook: connection status",
    handler: sessionStart,
  },
];
