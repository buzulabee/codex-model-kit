import { CatalogStore } from "../catalog/store.js";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { opendir, realpath } from "node:fs/promises";
import { catalogPathIssue, openRegularRead } from "../filesystem/safe-files.js";
import { failureContext, type FailureContext } from "../shared/diagnostics.js";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import type { CandidateSummary, DiscoverySummary } from "../shared/config.js";
import {
  displayAddress,
  maskCredential,
  normalizeBaseUrl,
  validCredential,
} from "./url.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROFILES = 16;
const MAX_CANDIDATES = 128;
const profileFile = /^[A-Za-z0-9_-]{1,64}\.config\.toml$/;
type Table = Record<string, unknown>;
function table(value: unknown): Table | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
    ? (value as Table)
    : undefined;
}
function has(object: Table, key: string): boolean {
  return Object.hasOwn(object, key);
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export class ConfigReadError extends Error {
  constructor(
    readonly code: "missing" | "read_error",
    readonly failure?: FailureContext,
  ) {
    super(code);
  }
}
export interface ConfigSource {
  readonly homeSource: "default" | "CODEX_HOME";
  read(filename: string): Promise<string>;
  readCatalog?(path: string): Promise<string>;
  resolveCatalogPath?(path: string): string;
  profileNames(): Promise<{ names: string[]; limited: boolean }>;
}
// Only a fixed file or a validated profile basename is allowed. No UI paths.
export class FileConfigSource implements ConfigSource {
  readonly homeSource: "default" | "CODEX_HOME";
  readonly #root: string;
  constructor(codeHome = process.env.CODEX_HOME, userHome = homedir()) {
    this.homeSource = codeHome?.trim() ? "CODEX_HOME" : "default";
    this.#root = resolve(
      codeHome?.trim() ? codeHome : join(userHome, ".codex"),
    );
  }
  resolveCatalogPath(path: string): string {
    // Main user config paths are relative to its parent (CODEX_HOME), never
    // the plugin process cwd. Leave invalid values for CatalogStore to reject.
    if (!path.trim() || path.length > 1024 || /[\x00-\x1f\x7f]/.test(path))
      return path;
    if (catalogPathIssue(path, process.platform, true)) return path;
    return resolve(this.#root, path);
  }
  async read(filename: string): Promise<string> {
    if (filename !== "config.toml" && !profileFile.test(filename))
      throw new ConfigReadError("read_error");
    let file;
    try {
      const root = await realpath(this.#root);
      const path = join(root, filename);
      file = await openRegularRead(path);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        throw new ConfigReadError("read_error");
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await file.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_FILE_BYTES) throw new ConfigReadError("read_error");
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      );
    } catch (error) {
      throw new ConfigReadError(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
          ? "missing"
          : "read_error",
        failureContext("read_config", error),
      );
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
  async profileNames(): Promise<{ names: string[]; limited: boolean }> {
    const names: string[] = [];
    let scanned = 0;
    try {
      const dir = await opendir(await realpath(this.#root));
      for await (const entry of dir) {
        scanned += 1;
        if (scanned > 1024) return { names: names.sort(), limited: true };
        if (profileFile.test(entry.name)) {
          if (names.length >= MAX_PROFILES)
            return { names: names.sort(), limited: true };
          names.push(entry.name);
        }
      }
      return { names: names.sort(), limited: false };
    } catch {
      throw new ConfigReadError("read_error");
    }
  }
}

// Backend-only material. Public projections never include the raw provider table.
export interface CandidateMaterial {
  readonly summary: CandidateSummary;
  readonly baseUrl: string | null;
  readonly credential: string | null;
  readonly credentialOrigin?: "config" | "env";
  readonly mainDefault?: boolean;
}
export class ConfigDiscovery {
  readonly #candidates: Map<string, CandidateMaterial>;
  readonly #summary: DiscoverySummary;
  readonly #catalogPath: unknown;
  readonly #secrets: readonly string[];
  constructor(
    summary: DiscoverySummary,
    candidates: CandidateMaterial[] = [],
    catalogPath: unknown = undefined,
    secrets: readonly string[] = [],
    readonly fingerprint: string | null = null,
  ) {
    this.#summary = structuredClone(summary);
    this.#catalogPath = catalogPath;
    this.#secrets = [...secrets];
    this.#candidates = new Map(
      candidates.map((item) => [item.summary.candidateId, item]),
    );
  }
  summary(): DiscoverySummary {
    return structuredClone(this.#summary);
  }
  get secrets(): readonly string[] {
    return [...this.#secrets];
  }
  defaultCandidate(): CandidateMaterial | undefined {
    return [...this.#candidates.values()].find((v) => v.mainDefault);
  }
  async loadCatalog(source: ConfigSource): Promise<CatalogStore> {
    const store = new CatalogStore();
    await store.load(
      typeof this.#catalogPath === "string" && source.resolveCatalogPath
        ? source.resolveCatalogPath(this.#catalogPath)
        : this.#catalogPath,
      this.#secrets,
      source.readCatalog?.bind(source),
    );
    return store;
  }
  resolveCandidate(id: string): CandidateMaterial | undefined {
    return this.#candidates.get(id);
  }
}
function parsed(raw: string): Table | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) return null;
  try {
    return table(parse(raw)) ?? null;
  } catch {
    return null;
  }
}
// For provider tables, v0.159.0's merge_toml_values recursively merges tables,
// replacing scalars. This is only a user/profile projection, NOT the host config stack.
function merge(base: Table, overlay: Table): Table {
  const result: Table = Object.fromEntries(Object.entries(base));
  for (const [key, value] of Object.entries(overlay)) {
    const a = table(result[key]);
    const b = table(value);
    Object.defineProperty(result, key, {
      value: a && b ? merge(a, b) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
function label(raw: string, fallback: string, secrets: string[]): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) &&
    !/^sk[-_]/i.test(raw) &&
    !secrets.some((secret) => secret && raw.includes(secret))
    ? raw
    : fallback;
}
function hasValues(value: unknown): boolean {
  if (value === undefined) return false;
  const t = table(value);
  return !t || Object.keys(t).length > 0;
}

function validEnvKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) &&
    !["__proto__", "prototype", "constructor"].includes(value)
  );
}
function unsupportedOptions(p: Table): boolean {
  const known = new Set([
    "name",
    "base_url",
    "experimental_bearer_token",
    "env_key",
    "env_key_instructions",
    "model_catalog_url",
    "supports_standalone_web_search",
    "requires_openai_auth",
    "auth",
    "wire_api",
    "http_headers",
    "env_http_headers",
    "query_params",
    "request_max_retries",
    "stream_max_retries",
    "stream_idle_timeout_ms",
    "websocket_connect_timeout_ms",
    "supports_websockets",
  ]);
  return (
    Object.keys(p).some((key) => !known.has(key)) ||
    ["http_headers", "env_http_headers", "query_params"].some((key) =>
      hasValues(p[key]),
    ) ||
    [
      "request_max_retries",
      "stream_max_retries",
      "stream_idle_timeout_ms",
      "websocket_connect_timeout_ms",
      "supports_websockets",
    ].some((key) => has(p, key)) ||
    (has(p, "requires_openai_auth") &&
      typeof p.requires_openai_auth !== "boolean")
  );
}

export async function discoverConfig(
  source: ConfigSource,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ConfigDiscovery> {
  const summary: DiscoverySummary = {
    status: "not_loaded",
    homeSource: source.homeSource,
    candidates: [],
    warnings: [],
    activityKnown: false,
  };
  const warnings = new Set<string>();
  let raw: string;
  try {
    raw = await source.read("config.toml");
  } catch (error) {
    summary.status =
      error instanceof ConfigReadError ? error.code : "read_error";
    if (summary.status === "read_error")
      summary.failure = failureContext("read_config", error);
    return new ConfigDiscovery(summary);
  }
  if (!raw.trim()) {
    summary.status = "empty";
    return new ConfigDiscovery(summary);
  }
  const base = parsed(raw);
  const fingerprint = createHash("sha256").update(raw).digest("hex");
  // Don't echo the parser error (it may contain an offending credential line).
  raw = "";
  if (!base) {
    summary.status = "invalid";
    summary.failure = { stage: "read_config", rule: "invalid_toml" };
    return new ConfigDiscovery(summary);
  }
  summary.status = "loaded";
  if (has(base, "profiles") || has(base, "profile"))
    warnings.add("legacy_profiles");
  const views: { config: Table; profile: string; conflict: boolean }[] = [
    { config: base, profile: "", conflict: false },
  ];
  try {
    const listing = await source.profileNames();
    if (listing.limited || listing.names.length > MAX_PROFILES)
      warnings.add("discovery_limit");
    for (const filename of listing.names.slice(0, MAX_PROFILES)) {
      if (!profileFile.test(filename) || isAbsolute(filename)) {
        warnings.add("profile_read_error");
        continue;
      }
      try {
        const overlay = parsed(await source.read(filename));
        if (!overlay) {
          warnings.add("profile_invalid");
          continue;
        }
        const name = filename.slice(0, -".config.toml".length);
        const legacy = table(base.profiles);
        const conflict =
          base.profile === name || !!(legacy && has(legacy, name));
        views.push({ config: merge(base, overlay), profile: name, conflict });
      } catch {
        warnings.add("profile_read_error");
      }
    }
  } catch {
    warnings.add("profile_read_error");
  }
  const secrets: string[] = [];
  const envCredentials = new Map<Table, string | undefined>();
  for (const { config, conflict } of views) {
    const providers = table(config.model_providers);
    if (providers)
      for (const [provider, value] of Object.entries(providers)) {
        const p = table(value);
        if (!p) continue;
        const token = p.experimental_bearer_token;
        if (typeof token === "string" && token) secrets.push(token);
        // Resolve only explicitly named, unambiguous provider credentials. Never
        // inspect the process environment for blocked candidates or enumerate it.
        if (
          validEnvKey(p.env_key) &&
          !["openai", "ollama", "lmstudio"].includes(provider) &&
          !conflict &&
          !has(p, "experimental_bearer_token") &&
          !has(p, "auth") &&
          p.requires_openai_auth !== true &&
          !unsupportedOptions(p)
        ) {
          const credential = Object.hasOwn(env, p.env_key)
            ? env[p.env_key]
            : undefined;
          envCredentials.set(p, credential);
          if (typeof credential === "string" && credential)
            secrets.push(credential);
        }
      }
  }
  const materials: CandidateMaterial[] = [];
  for (const view of views) {
    const providers = table(view.config.model_providers);
    if (!providers) {
      if (has(view.config, "model_providers"))
        warnings.add("incomplete_config");
      continue;
    }
    const defaultProvider = text(view.config.model_provider) ?? "openai";
    for (const [provider, rawProvider] of Object.entries(providers)) {
      if (materials.length >= MAX_CANDIDATES) {
        warnings.add("discovery_limit");
        break;
      }
      const p = table(rawProvider);
      if (!p) {
        warnings.add("incomplete_config");
        continue;
      }
      const issues: string[] = [];
      let reusable = true;
      if (["openai", "ollama", "lmstudio"].includes(provider)) {
        issues.push("reserved_provider");
        reusable = false;
      }
      if (view.conflict) {
        issues.push("legacy_profile_conflict");
        reusable = false;
      }
      let baseUrl: string | null = null;
      if (text(p.base_url)) {
        try {
          baseUrl = normalizeBaseUrl(p.base_url as string);
        } catch {
          issues.push("invalid_url");
        }
      } else issues.push("missing_url");
      const token = p.experimental_bearer_token;
      let credential: string | null = validCredential(token) ? token : null;
      let credentialOrigin: "config" | "env" = "config";
      let authSource: CandidateSummary["authSource"] = credential
        ? "config"
        : "missing";
      const hasEnv = has(p, "env_key");
      const otherAuth =
        has(p, "auth") ||
        p.requires_openai_auth === true ||
        (hasEnv && has(p, "experimental_bearer_token"));
      if (has(p, "auth")) issues.push("auth_command");
      if (p.requires_openai_auth === true) issues.push("account_auth");
      if (hasEnv) {
        credential = null;
        authSource = "unsupported";
        if (!validEnvKey(p.env_key)) {
          issues.push("invalid_env_key");
          reusable = false;
        } else if (
          !view.conflict &&
          !otherAuth &&
          !["openai", "ollama", "lmstudio"].includes(provider) &&
          !unsupportedOptions(p) &&
          envCredentials.has(p)
        ) {
          const value = envCredentials.get(p);
          credentialOrigin = "env";
          authSource = "env";
          if (
            value === undefined ||
            (typeof value === "string" && !value.trim())
          ) {
            issues.push("missing_env_credential");
            reusable = false;
          } else if (validCredential(value)) credential = value;
          else {
            issues.push("invalid_credential");
            reusable = false;
          }
        }
      } else if (!credential) {
        if ((typeof token === "string" && !token.trim()) || token === undefined)
          issues.push("missing_credential");
        else {
          issues.push("invalid_credential");
          reusable = false;
        }
      }
      if (otherAuth) {
        issues.push("unsupported_auth");
        authSource = "unsupported";
        reusable = false;
        // Retained only in the private projection; requires explicit bearer-only selection.
      }
      if (unsupportedOptions(p)) {
        issues.push("unsupported_options");
        reusable = false;
      }
      const protocol =
        p.wire_api === undefined || p.wire_api === "responses"
          ? "responses"
          : "unknown";
      if (protocol === "unknown") issues.push("unknown_protocol");
      const candidate: CandidateSummary = {
        candidateId: randomUUID(),
        providerLabel: label(
          provider,
          `Provider ${materials.length + 1}`,
          secrets,
        ),
        profileLabel: view.profile
          ? label(view.profile, "独立 profile（名称已隐藏）", secrets)
          : "配置文件默认值",
        configuredDefault: provider === defaultProvider,
        address: baseUrl ? displayAddress(baseUrl, secrets) : null,
        addressPresent: !!baseUrl,
        credentialPresent: !!credential && !otherAuth,
        credentialHint: maskCredential(credential),
        authSource,
        protocol,
        httpRisk: baseUrl?.startsWith("http:") ?? false,
        reusable,
        bearerOnlyAvailable:
          !!credential &&
          otherAuth &&
          p.requires_openai_auth === true &&
          !has(p, "env_key") &&
          !has(p, "auth") &&
          !issues.some(
            (issue) =>
              issue !== "unsupported_auth" &&
              issue !== "account_auth" &&
              issue !== "missing_url" &&
              issue !== "unknown_protocol",
          ),
        issues,
      };
      materials.push({
        summary: candidate,
        baseUrl,
        credential,
        credentialOrigin,
        mainDefault: !view.profile && provider === defaultProvider,
      });
    }
  }
  summary.candidates = materials.map((item) => item.summary);
  summary.warnings = [...warnings];
  return new ConfigDiscovery(
    summary,
    materials,
    base.model_catalog_json,
    secrets,
    fingerprint,
  );
}
