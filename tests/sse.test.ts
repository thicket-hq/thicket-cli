import { describe, expect, it } from "vitest";
import { parseSse } from "../src/lib/sse.js";

async function* chunks(parts: string[]) {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe("parseSse", () => {
  it("parses events split across chunks, ignores comments, honours retry and id", async () => {
    const text =
      "retry: 3000\nevent: ready\ndata: {\"cursor\":{\"since\":\"t0\",\"after\":null}}\n\n" +
      ": ping\n\n" +
      "id: n1\nevent: notification\ndata: {\"id\":\"n1\",\n" +
      "data: \"action\":\"mentioned\"}\n\n" +
      "event: reconnect\r\ndata: {\"reason\":\"max_lifetime\"}\r\n\r\n";
    const parts = [text.slice(0, 17), text.slice(17, 60), text.slice(60)];
    const seen = [];
    for await (const m of parseSse(chunks(parts))) seen.push(m);
    expect(seen.map((m) => m.event)).toEqual(["ready", "notification", "reconnect"]);
    expect(seen[0].retry).toBe(3000);
    expect(seen[1].id).toBe("n1");
    expect(JSON.parse(seen[1].data)).toEqual({ id: "n1", action: "mentioned" });
    expect(JSON.parse(seen[2].data).reason).toBe("max_lifetime");
  });

  it("flushes a final message without a trailing blank line", async () => {
    const seen = [];
    for await (const m of parseSse(chunks(["event: x\ndata: 1"]))) seen.push(m);
    expect(seen).toHaveLength(1);
    expect(seen[0].data).toBe("1");
  });
});
