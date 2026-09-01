// Rich text authoring: every body flag takes Markdown and ships HTML
// (`content_html`, sanitized server-side). Mentions are the one non-Markdown
// construct: `[@Name](member:<uuid>)` pins a membership id, and a bare
// `@Name` / `@First.Last` is resolved against the org's people (exact, then
// fuzzy; ambiguity is an error naming the candidates, a miss stays text).
import { Marked, type Token, type Tokens } from "marked";
import type { CliContext } from "./context.js";
import { CliError } from "./output.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXPLICIT = new RegExp(`^\\[@([^\\]\\n]+)\\]\\(member:(${UUID})\\)`, "i");
const BARE = /^@([A-Za-z][A-Za-z0-9_'-]*(?:\.[A-Za-z][A-Za-z0-9_'-]*)*)/;

export type MentionResolver = (name: string) => Promise<{ id: string; name: string } | null>;

type MentionToken = Tokens.Generic & {
  type: "mention";
  raw: string;
  name: string;
  id: string | null;
  explicit: boolean;
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function mentionSpan(id: string, name: string): string {
  return `<span data-mention-id="${id}">@${escapeHtml(name)}</span>`;
}

/** The paste-ready mention token for a person. */
export function mentionToken(id: string, name: string): string {
  return `[@${name}](member:${id})`;
}

function buildMarked(resolve?: MentionResolver): Marked {
  const marked = new Marked({ gfm: true, breaks: false, async: true });
  marked.use({
    extensions: [
      {
        name: "mention",
        level: "inline",
        start(src: string) {
          // A bare @ counts only at a word boundary, so emails stay emails.
          const m = src.match(/(?<![\w.])(?:\[@|@[A-Za-z])/);
          return m?.index ?? -1;
        },
        tokenizer(src: string): MentionToken | undefined {
          const explicit = src.match(EXPLICIT);
          if (explicit) {
            return {
              type: "mention",
              raw: explicit[0],
              name: explicit[1].trim(),
              id: explicit[2].toLowerCase(),
              explicit: true,
            };
          }
          const bare = src.match(BARE);
          if (bare) {
            return { type: "mention", raw: bare[0], name: bare[1], id: null, explicit: false };
          }
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          const t = token as MentionToken;
          return t.id ? mentionSpan(t.id, t.name) : escapeHtml(t.raw);
        },
      },
    ],
    async walkTokens(token: Token) {
      if (token.type !== "mention") return;
      const t = token as MentionToken;
      if (t.id || !resolve) return;
      const person = await resolve(t.name);
      if (person) {
        t.id = person.id;
        t.name = person.name;
      }
    },
    renderer: {
      // Raw HTML in Markdown lands as visible text; --content-html is the
      // deliberate escape hatch, never a stray tag in prose.
      html(token: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(token.text);
      },
    },
  });
  return marked;
}

/** Markdown (with mentions) to HTML. */
export async function markdownToHtml(
  markdown: string,
  resolve?: MentionResolver,
): Promise<string> {
  const html = await buildMarked(resolve).parse(markdown);
  return html.trim();
}

/** Plain text to safe HTML paragraphs, with mentions still honoured. */
export function plainToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

type Person = { membership_id: string; name: string; email?: string; kind?: string };

/** A resolver over the org's people: exact, First.Last, first name, substring. */
export function peopleResolver(people: Person[]): MentionResolver {
  return async (raw) => {
    const name = raw.replace(/\./g, " ").trim().toLowerCase();
    const candidates = people.map((p) => ({ id: p.membership_id, name: p.name }));
    const exact = candidates.filter((c) => c.name.toLowerCase() === name);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return ambiguous(raw, exact);
    const first = candidates.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === name);
    if (first.length === 1) return first[0];
    if (first.length > 1) return ambiguous(raw, first);
    const collapsed = name.replace(/\s+/g, "");
    const loose = candidates.filter((c) => {
      const cn = c.name.toLowerCase();
      return cn.replace(/\s+/g, "").startsWith(collapsed) || cn.includes(name);
    });
    if (loose.length === 1) return loose[0];
    if (loose.length > 1) return ambiguous(raw, loose);
    return null;
  };
}

function ambiguous(raw: string, matches: { id: string; name: string }[]): never {
  throw new CliError(
    "ambiguous",
    `@${raw} matches ${matches.length} people: ${matches
      .slice(0, 6)
      .map((m) => `${m.name} (${mentionToken(m.id, m.name)})`)
      .join(", ")}`,
    "Pin the person with [@Name](member:<membership id>)",
  );
}

export type BodyOptions = {
  /** Markdown or plain text (the default input). */
  content?: string;
  /** Raw HTML, the escape hatch; wins over content. */
  contentHtml?: string;
  /** Send content as plain text instead of converting Markdown. */
  plain?: boolean;
};

/**
 * The `content`/`content_html` fields for a request body. Markdown by
 * default (mentions resolved against the org's people), `--plain` sends
 * plain text for the server to paragraph, `--content-html` sends raw HTML.
 */
export async function bodyFields(
  ctx: CliContext,
  options: BodyOptions,
): Promise<{ content?: string; content_html?: string }> {
  if (options.contentHtml !== undefined) return { content_html: options.contentHtml };
  if (options.content === undefined) return {};
  if (options.plain) return { content: options.content };
  const needsPeople = /(^|[^\w.])@[A-Za-z]/.test(options.content);
  const resolve = needsPeople ? peopleResolver(await ctx.people()) : undefined;
  return { content_html: await markdownToHtml(options.content, resolve) };
}

/** Membership ids mentioned in stored (sanitized) HTML. */
export function mentionIdsIn(html: string | null | undefined): string[] {
  if (!html) return [];
  const ids = new Set<string>();
  for (const m of html.matchAll(new RegExp(`data-mention-id="(${UUID})"`, "gi"))) {
    ids.add(m[1].toLowerCase());
  }
  return [...ids];
}
