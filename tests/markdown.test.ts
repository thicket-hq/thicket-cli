import { describe, expect, it } from "vitest";
import { CliError } from "../src/lib/output.js";
import { markdownToHtml, mentionIdsIn, mentionToken, peopleResolver, plainToHtml } from "../src/lib/markdown.js";

const JANE = "1e6b3cbb-0000-4000-8000-0000000000aa";
const JOHN = "1e6b3cbb-0000-4000-8000-0000000000bb";
const JAN = "1e6b3cbb-0000-4000-8000-0000000000cc";

const people = [
  { membership_id: JANE, name: "Jane Doe" },
  { membership_id: JOHN, name: "John Smith" },
  { membership_id: JAN, name: "Jan Novak" },
];

describe("markdownToHtml", () => {
  it("renders the GFM subset the server accepts", async () => {
    const html = await markdownToHtml(
      "# Title\n\n**bold** _it_ `code` [link](https://x.test)\n\n- a\n- b\n\n> quote\n\n```js\nlet x = 1;\n```\n\n| a | b |\n|---|--:|\n| 1 | 2 |",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://x.test">link</a>');
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain("<table>");
    expect(html).toContain('align="right"');
  });

  it("escapes raw HTML instead of passing it through", async () => {
    const html = await markdownToHtml("hello <script>alert(1)</script> <b>x</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("turns explicit mention tokens into mention spans", async () => {
    const html = await markdownToHtml(`Hey [@Jane Doe](member:${JANE}), see this.`);
    expect(html).toBe(`<p>Hey <span data-mention-id="${JANE}">@Jane Doe</span>, see this.</p>`);
    expect(mentionIdsIn(html)).toEqual([JANE]);
    expect(mentionToken(JANE, "Jane Doe")).toBe(`[@Jane Doe](member:${JANE})`);
  });

  it("resolves bare @Name and @First.Last against people, leaving misses and emails alone", async () => {
    const resolve = peopleResolver(people);
    const html = await markdownToHtml("@Jane and @John.Smith please; @Nobody stays text; mail bob@acme.com.", resolve);
    expect(html).toContain(`<span data-mention-id="${JANE}">@Jane Doe</span>`);
    expect(html).toContain(`<span data-mention-id="${JOHN}">@John Smith</span>`);
    expect(html).toContain("@Nobody stays text");
    expect(html).toContain("bob@acme.com");
    expect(html).not.toContain('data-mention-id="undefined"');
  });

  it("does not touch mentions inside code", async () => {
    const html = await markdownToHtml("`@Jane` and\n\n```\n@Jane\n```", peopleResolver(people));
    expect(html).not.toContain("data-mention-id");
  });

  it("ambiguous bare mentions are an error listing candidates with tokens", async () => {
    const resolve = peopleResolver([...people, { membership_id: JAN, name: "Jane Roe" }]);
    await expect(markdownToHtml("@Jane look", resolve)).rejects.toMatchObject({
      code: "ambiguous",
      message: expect.stringContaining(`[@Jane Doe](member:${JANE})`),
    });
    try {
      await markdownToHtml("@Jane look", resolve);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
    }
  });

  it("plain text becomes paragraphs with escaped markup", () => {
    expect(plainToHtml("a <b>\n\nc")).toBe("<p>a &lt;b&gt;</p>\n<p>c</p>");
  });
});
