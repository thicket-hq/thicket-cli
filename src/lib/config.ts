// Config resolution: flags > environment > profile (config file) > defaults.
// Every resolved value remembers where it came from so `auth status` and
// `doctor` can explain themselves. Config lives at
// ~/.config/thicket/config.json (XDG respected); secrets never do — they
// live in the OS keyring, falling back to a chmod-600 credentials.json.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://www.thickethq.com";
export const DEFAULT_PROFILE = "default";

export type Source = "flag" | "env" | "profile" | "default";

export type ProfileConfig = {
  org?: string;
  base_url?: string;
};

export type ConfigFile = {
  default_profile?: string;
  profiles?: Record<string, ProfileConfig>;
};

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.THICKET_CONFIG_DIR) return env.THICKET_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), ".config"), "thicket");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}

export function loadConfigFile(env: NodeJS.ProcessEnv = process.env): ConfigFile {
  try {
    return JSON.parse(readFileSync(configPath(env), "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

export function saveConfigFile(
  config: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(configPath(env), `${JSON.stringify(config, null, 2)}\n`);
}

export type ResolvedSettings = {
  profile: string;
  org?: string;
  baseUrl: string;
  sources: {
    profile: Source;
    org?: Source;
    baseUrl: Source;
  };
};

export type SettingsInput = {
  flags: { org?: string; profile?: string; baseUrl?: string };
  env?: NodeJS.ProcessEnv;
};

export function resolveSettings({
  flags,
  env = process.env,
}: SettingsInput): ResolvedSettings {
  const config = loadConfigFile(env);

  let profile = DEFAULT_PROFILE;
  let profileSource: Source = "default";
  if (flags.profile) {
    profile = flags.profile;
    profileSource = "flag";
  } else if (env.THICKET_PROFILE) {
    profile = env.THICKET_PROFILE;
    profileSource = "env";
  } else if (config.default_profile) {
    profile = config.default_profile;
    profileSource = "profile";
  }

  const stored = config.profiles?.[profile] ?? {};

  let org: string | undefined;
  let orgSource: Source | undefined;
  if (flags.org) {
    org = flags.org;
    orgSource = "flag";
  } else if (env.THICKET_ORG) {
    org = env.THICKET_ORG;
    orgSource = "env";
  } else if (stored.org) {
    org = stored.org;
    orgSource = "profile";
  }

  let baseUrl = DEFAULT_BASE_URL;
  let baseUrlSource: Source = "default";
  if (flags.baseUrl) {
    baseUrl = flags.baseUrl;
    baseUrlSource = "flag";
  } else if (env.THICKET_BASE_URL) {
    baseUrl = env.THICKET_BASE_URL;
    baseUrlSource = "env";
  } else if (stored.base_url) {
    baseUrl = stored.base_url;
    baseUrlSource = "profile";
  }

  return {
    profile,
    org,
    baseUrl: baseUrl.replace(/\/$/, ""),
    sources: {
      profile: profileSource,
      org: orgSource,
      baseUrl: baseUrlSource,
    },
  };
}

/** Persists one profile field (creating the profile as needed). */
export function updateProfile(
  profile: string,
  patch: ProfileConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const config = loadConfigFile(env);
  config.profiles ??= {};
  config.profiles[profile] = { ...config.profiles[profile], ...patch };
  saveConfigFile(config, env);
}

// --- credentials.json fallback store (used when no OS keyring works) -------

type CredentialsFile = { profiles?: Record<string, { token: string }> };

export function readFileToken(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(credentialsPath(env), "utf8"),
    ) as CredentialsFile;
    return parsed.profiles?.[profile]?.token ?? null;
  } catch {
    return null;
  }
}

export function writeFileToken(
  profile: string,
  token: string | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let parsed: CredentialsFile = {};
  try {
    parsed = JSON.parse(readFileSync(credentialsPath(env), "utf8"));
  } catch {
    // Fresh file.
  }
  parsed.profiles ??= {};
  if (token === null) {
    delete parsed.profiles[profile];
  } else {
    parsed.profiles[profile] = { token };
  }
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(credentialsPath(env), `${JSON.stringify(parsed, null, 2)}\n`);
  chmodSync(credentialsPath(env), 0o600);
}
