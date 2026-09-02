// Token store selection: THICKET_TOKEN_STORE=file must keep every read,
// write, and delete inside the config directory's credentials.json and never
// consult the OS keyring, so sandboxed runs on a signed-in machine stay
// hermetic. The default ("auto") keeps the keyring-first behavior.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath } from "../src/lib/config.js";
import {
  deleteStoredToken,
  getStoredToken,
  storeToken,
  tokenStoreMode,
} from "../src/lib/keyring.js";
import { CliError } from "../src/lib/output.js";

function fileEnv(): NodeJS.ProcessEnv {
  return {
    THICKET_CONFIG_DIR: mkdtempSync(join(tmpdir(), "thicket-cli-keyring-")),
    THICKET_TOKEN_STORE: "file",
  };
}

describe("token store mode", () => {
  it("defaults to auto, accepts file case-insensitively, rejects anything else", () => {
    expect(tokenStoreMode({})).toBe("auto");
    expect(tokenStoreMode({ THICKET_TOKEN_STORE: "" })).toBe("auto");
    expect(tokenStoreMode({ THICKET_TOKEN_STORE: "auto" })).toBe("auto");
    expect(tokenStoreMode({ THICKET_TOKEN_STORE: "FILE" })).toBe("file");
    expect(() => tokenStoreMode({ THICKET_TOKEN_STORE: "keychain" })).toThrow(CliError);
    try {
      tokenStoreMode({ THICKET_TOKEN_STORE: "vault" });
    } catch (err) {
      expect((err as CliError).code).toBe("usage");
    }
  });
});

describe("file-only token store", () => {
  it("round-trips a token through credentials.json and reports the file store", async () => {
    const env = fileEnv();
    expect(await getStoredToken("default", env)).toBeNull();

    expect(await storeToken("default", "thicket_pat_file", env)).toBe("file");
    expect(await getStoredToken("default", env)).toEqual({
      token: "thicket_pat_file",
      store: "file",
    });
    const onDisk = JSON.parse(readFileSync(credentialsPath(env), "utf8"));
    expect(onDisk.profiles.default.token).toBe("thicket_pat_file");

    await deleteStoredToken("default", env);
    expect(await getStoredToken("default", env)).toBeNull();
    expect(existsSync(credentialsPath(env))).toBe(true);
  });

  it("keeps profiles apart and honors the injected config directory", async () => {
    const env = fileEnv();
    await storeToken("work", "thicket_pat_work", env);
    await storeToken("agent", "thicket_pat_agent", env);
    expect((await getStoredToken("work", env))?.token).toBe("thicket_pat_work");
    expect((await getStoredToken("agent", env))?.token).toBe("thicket_pat_agent");
    expect(credentialsPath(env).startsWith(env.THICKET_CONFIG_DIR as string)).toBe(true);
  });
});
