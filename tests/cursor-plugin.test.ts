// Guard: the Cursor marketplace entry and its one plugin, Thicket's hosted
// MCP server for Cursor and Grok Bot. Grok Bot connects only to an MCP server
// placed on the server, so "placement": "server" is load-bearing. The names
// and versions agree as Cursor's own validator requires, and the listing
// shows a 1024 px opaque logo, the license and the README.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

describe("the Cursor plugin", () => {
  const marketplace = json(".cursor-plugin/marketplace.json");
  const [entry] = marketplace.plugins;
  const plugin = json(join(entry.source, ".cursor-plugin", "plugin.json"));
  const mcp = json(join(entry.source, "mcp.json"));

  it("is the one listed plugin, and the listing and the manifest agree", () => {
    expect(marketplace.plugins).toHaveLength(1);
    expect(entry.name).toBe("thicket");
    expect(plugin.name).toBe(entry.name);
    expect(plugin.description).toBe(entry.description);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("points at Thicket's hosted MCP server, placed on the server for Grok Bot", () => {
    expect(plugin.mcpServers).toBe("./mcp.json");
    expect(mcp).toEqual({
      mcpServers: {
        thicket: { type: "http", url: "https://www.thickethq.com/api/mcp", placement: "server" },
      },
    });
  });

  it("carries a square opaque logo, the license and a README without an em dash", () => {
    const png = readFileSync(join(ROOT, entry.source, plugin.logo));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1024, 1024]);
    expect(png[25]).toBe(2); // IHDR colour type 2: truecolour, no alpha
    expect(readFileSync(join(ROOT, entry.source, "LICENSE"), "utf8")).toMatch(/^MIT License/);
    expect(readFileSync(join(ROOT, entry.source, "README.md"), "utf8")).not.toContain("—");
  });

  it("stays out of the npm package", () => {
    const { files } = json("package.json");
    expect(files).not.toContain("plugins");
    expect(files).not.toContain(".cursor-plugin");
  });
});
