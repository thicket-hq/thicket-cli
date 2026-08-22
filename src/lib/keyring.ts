// Token storage: OS keyring first (macOS Keychain via `security`, Linux
// Secret Service via `secret-tool`), falling back to a chmod-600
// credentials.json in the config directory. No native modules — the keyring
// is reached by shelling out with execFile (never a shell), which keeps the
// package pure JS and installable everywhere.
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { readFileToken, writeFileToken } from "./config.js";

const run = promisify(execFile);

const SERVICE = "thicket-cli";

export type TokenStore = "keychain" | "secret-service" | "file" | "env";

async function darwinGet(profile: string): Promise<string | null> {
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      profile,
      "-w",
    ]);
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

async function darwinSet(profile: string, token: string): Promise<boolean> {
  try {
    await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      profile,
      "-w",
      token,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function darwinDelete(profile: string): Promise<void> {
  try {
    await run("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      profile,
    ]);
  } catch {
    // Nothing stored; nothing to do.
  }
}

async function linuxGet(profile: string): Promise<string | null> {
  try {
    const { stdout } = await run("secret-tool", [
      "lookup",
      "service",
      SERVICE,
      "profile",
      profile,
    ]);
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

async function linuxSet(profile: string, token: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "secret-tool",
        [
          "store",
          `--label=${SERVICE} (${profile})`,
          "service",
          SERVICE,
          "profile",
          profile,
        ],
        (err) => (err ? reject(err) : resolve()),
      );
      child.stdin?.end(token);
    });
    return true;
  } catch {
    return false;
  }
}

async function linuxDelete(profile: string): Promise<void> {
  try {
    await run("secret-tool", ["clear", "service", SERVICE, "profile", profile]);
  } catch {
    // Nothing stored; nothing to do.
  }
}

/**
 * Reads the stored token for a profile: keyring first, then the
 * credentials-file fallback. Returns where it was found so status output
 * can say so.
 */
export async function getStoredToken(
  profile: string,
): Promise<{ token: string; store: TokenStore } | null> {
  if (platform() === "darwin") {
    const token = await darwinGet(profile);
    if (token) return { token, store: "keychain" };
  } else if (platform() === "linux") {
    const token = await linuxGet(profile);
    if (token) return { token, store: "secret-service" };
  }
  const fileToken = readFileToken(profile);
  return fileToken ? { token: fileToken, store: "file" } : null;
}

/** Stores a token, preferring the OS keyring; reports which store took it. */
export async function storeToken(
  profile: string,
  token: string,
): Promise<TokenStore> {
  if (platform() === "darwin" && (await darwinSet(profile, token))) {
    // A stale file copy must not shadow later keyring updates.
    writeFileToken(profile, null);
    return "keychain";
  }
  if (platform() === "linux" && (await linuxSet(profile, token))) {
    writeFileToken(profile, null);
    return "secret-service";
  }
  writeFileToken(profile, token);
  return "file";
}

/** Removes the stored token from every store. */
export async function deleteStoredToken(profile: string): Promise<void> {
  if (platform() === "darwin") await darwinDelete(profile);
  if (platform() === "linux") await linuxDelete(profile);
  writeFileToken(profile, null);
}
