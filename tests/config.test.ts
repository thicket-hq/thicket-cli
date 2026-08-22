import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readFileToken,
  resolveSettings,
  saveConfigFile,
  updateProfile,
  writeFileToken,
} from "../src/lib/config.js";

function tempEnv(): NodeJS.ProcessEnv {
  return { THICKET_CONFIG_DIR: mkdtempSync(join(tmpdir(), "thicket-cli-test-")) };
}

describe("config resolution", () => {
  it("defaults with nothing configured", () => {
    const env = tempEnv();
    const settings = resolveSettings({ flags: {}, env });
    expect(settings.profile).toBe("default");
    expect(settings.baseUrl).toBe("https://www.thickethq.com");
    expect(settings.org).toBeUndefined();
    expect(settings.sources.baseUrl).toBe("default");
  });

  it("flags beat env beat profile", () => {
    const env = tempEnv();
    saveConfigFile(
      {
        default_profile: "work",
        profiles: { work: { org: "from-profile", base_url: "https://profile.example" } },
      },
      env,
    );
    let settings = resolveSettings({ flags: {}, env });
    expect(settings.profile).toBe("work");
    expect(settings.org).toBe("from-profile");
    expect(settings.baseUrl).toBe("https://profile.example");

    env.THICKET_ORG = "from-env";
    settings = resolveSettings({ flags: {}, env });
    expect(settings.org).toBe("from-env");
    expect(settings.sources.org).toBe("env");

    settings = resolveSettings({ flags: { org: "from-flag" }, env });
    expect(settings.org).toBe("from-flag");
    expect(settings.sources.org).toBe("flag");
  });

  it("THICKET_PROFILE selects the profile", () => {
    const env = tempEnv();
    updateProfile("agent", { org: "agent-org" }, env);
    env.THICKET_PROFILE = "agent";
    const settings = resolveSettings({ flags: {}, env });
    expect(settings.profile).toBe("agent");
    expect(settings.org).toBe("agent-org");
  });

  it("credentials file fallback is chmod 600 and per-profile", () => {
    const env = tempEnv();
    writeFileToken("a", "thicket_pat_aaa", env);
    writeFileToken("b", "thicket_pat_bbb", env);
    expect(readFileToken("a", env)).toBe("thicket_pat_aaa");
    expect(readFileToken("b", env)).toBe("thicket_pat_bbb");
    const mode = statSync(join(env.THICKET_CONFIG_DIR!, "credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    writeFileToken("a", null, env);
    expect(readFileToken("a", env)).toBeNull();
    expect(readFileToken("b", env)).toBe("thicket_pat_bbb");
  });

  it("config file round-trips profile updates", () => {
    const env = tempEnv();
    updateProfile("default", { org: "acme" }, env);
    updateProfile("default", { base_url: "http://localhost:3003" }, env);
    const raw = JSON.parse(
      readFileSync(join(env.THICKET_CONFIG_DIR!, "config.json"), "utf8"),
    );
    expect(raw.profiles.default).toEqual({
      org: "acme",
      base_url: "http://localhost:3003",
    });
  });
});
