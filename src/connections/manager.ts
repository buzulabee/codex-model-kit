import { CatalogStore } from "../catalog/store.js";
import { CatalogWriter } from "../catalog/writer.js";
import type {
  CatalogWritePlan,
  CatalogWriteReceipt,
} from "../shared/catalog.js";
import {
  ConfigDiscovery,
  discoverConfig,
  FileConfigSource,
  type ConfigSource,
} from "../config/discovery.js";
import {
  displayAddress,
  maskCredential,
  normalizeBaseUrl,
  validCredential,
} from "../config/url.js";
import type { ConnectionSummary, DiscoverySummary } from "../shared/config.js";
import {
  referenceOf,
  type Envelope,
  type PublicChallenge,
  type Reference,
  type Snapshot,
} from "../shared/security.js";
import { SafeError, SecuritySession } from "./envelopes.js";
import { failureContext } from "../shared/diagnostics.js";

export class ConnectionManager {
  readonly security: SecuritySession;
  readonly #source: ConfigSource;
  readonly #env: Readonly<NodeJS.ProcessEnv>;
  #discovery: ConfigDiscovery;
  #catalog = new CatalogStore();
  readonly #writer = new CatalogWriter();
  #configAtLoad: string | null = null;
  #baseUrl: string | null = null;
  #credential: string | null = null;
  #connection: ConnectionSummary = this.emptyConnection();
  constructor(
    security = new SecuritySession(),
    source: ConfigSource = new FileConfigSource(),
    env: Readonly<NodeJS.ProcessEnv> = process.env,
  ) {
    this.security = security;
    this.#source = source;
    this.#env = env;
    const initial: DiscoverySummary = {
      status: "not_loaded",
      homeSource: source.homeSource,
      candidates: [],
      warnings: [],
      activityKnown: false,
    };
    this.#discovery = new ConfigDiscovery(initial);
  }
  private emptyConnection(): ConnectionSummary {
    return {
      source: "manual",
      providerLabel: "手动连接",
      profileLabel: "仅本实例",
      address: null,
      addressPresent: false,
      credentialPresent: false,
      credentialHint: null,
      credentialSource: "missing",
      httpRisk: false,
      httpConfirmed: false,
      protocol: "responses",
      ready: false,
    };
  }
  snapshot(): Snapshot {
    return {
      ...this.security.snapshot(),
      stage: "M1",
      realCredentialsEnabled: true,
      config: this.#discovery.summary(),
      connection: structuredClone(this.#connection),
      localCatalog: this.#catalog.summary(),
      catalogWrite: this.#writer.receipt(this.#catalog.summary().path),
    };
  }
  readonly #changeListeners = new Set<() => void>();
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }
  touch(): void {
    this.security.touch();
  }
  private change(reference: Reference): void {
    this.security.reset(reference);
    this.#writer.invalidate();
    for (const listener of this.#changeListeners) listener();
  }
  async useConnection<T>(
    reference: Reference,
    work: (material: { baseUrl: string; credential: string }) => Promise<T>,
  ): Promise<T> {
    this.security.assertReference(reference);
    if (!this.#connection.ready || !this.#baseUrl || !this.#credential)
      throw new SafeError("connection_not_ready");
    const result = await work({
      baseUrl: this.#baseUrl,
      credential: this.#credential,
    });
    this.security.assertReference(reference);
    return result;
  }
  assertReady(reference: Reference): void {
    this.security.assertReference(reference);
    if (!this.#connection.ready) throw new SafeError("connection_not_ready");
  }
  containsSecret(value: string): boolean {
    return (
      (!!this.#credential && value.includes(this.#credential)) ||
      this.#discovery.secrets.some((s) => value.includes(s))
    );
  }

  reset(reference: Reference): Snapshot {
    this.change(reference);
    this.#baseUrl = null;
    this.#credential = null;
    this.#connection = this.emptyConnection();
    return this.snapshot();
  }
  async reload(reference: Reference): Promise<Snapshot> {
    this.security.assertReference(reference);
    const discovery = await discoverConfig(this.#source, this.#env);
    // Another UI selection/reload may have changed the revision while IO awaited.
    this.security.assertReference(reference);
    this.reset(reference);
    this.#discovery = discovery;
    this.#catalog = new CatalogStore();
    this.#configAtLoad = null;
    return this.snapshot();
  }
  async loadSync(reference: Reference): Promise<Snapshot> {
    const configBefore = await this.#source
      .read("config.toml")
      .catch(() => null);
    await this.reload(reference);
    const material = this.#discovery.defaultCandidate();
    if (
      material &&
      (material.summary.reusable || material.summary.bearerOnlyAvailable) &&
      !material.summary.httpRisk
    ) {
      this.select(
        this.reference(),
        material.summary.candidateId,
        false,
        !!material.summary.bearerOnlyAvailable,
      );
    }
    const current = this.reference();
    const catalog = await this.#discovery.loadCatalog(this.#source);
    this.security.assertReference(current);
    this.#catalog = catalog;
    const configAfter = await this.#source
      .read("config.toml")
      .catch(() => null);
    this.#configAtLoad = configBefore === configAfter ? configAfter : null;
    this.touch();
    return this.snapshot();
  }
  previewCatalog(
    reference: Reference,
    rows: unknown,
    allowed: ReadonlySet<string>,
  ): string {
    this.security.assertReference(reference);
    return this.#catalog.preview(rows, allowed, this.#discovery.secrets);
  }
  private async writeGuard(reference: Reference, path: string): Promise<void> {
    this.security.assertReference(reference);
    if (this.#catalog.summary().path !== path || !this.#configAtLoad)
      throw new SafeError("catalog_conflict");
    const currentConfig = await this.#source
      .read("config.toml")
      .catch((error) => {
        throw new SafeError(
          "catalog_conflict",
          failureContext("read_config", error),
        );
      });
    if (currentConfig !== this.#configAtLoad)
      throw new SafeError("catalog_conflict");
  }
  async prepareCatalog(
    reference: Reference,
    json: string,
  ): Promise<CatalogWritePlan> {
    this.security.assertReference(reference);
    const local = this.#catalog.summary();
    if (!local.path || !["ready", "missing"].includes(local.status))
      throw new SafeError("catalog_not_writable", local.failure);
    return this.#writer.prepare(
      reference,
      local.path,
      this.#catalog.originalText(),
      json,
      "save",
      () => this.writeGuard(reference, local.path!),
    );
  }
  async prepareRestore(reference: Reference): Promise<CatalogWritePlan> {
    this.security.assertReference(reference);
    const path = this.#catalog.summary().path;
    if (!path) throw new SafeError("catalog_no_backup");
    return (
      await this.#writer.prepareRestore(reference, path, () =>
        this.writeGuard(reference, path),
      )
    ).plan;
  }
  async commitCatalog(
    reference: Reference,
    planId: string,
    requestId: string,
  ): Promise<CatalogWriteReceipt> {
    this.security.assertReference(reference);
    const path = this.#catalog.summary().path;
    if (!path) throw new SafeError("catalog_not_writable");
    const receipt = await this.#writer.commit(
      reference,
      planId,
      requestId,
      () => this.writeGuard(reference, path),
    );
    try {
      this.#catalog = await this.#discovery.loadCatalog(this.#source);
    } catch {
      // The write is durable; a failed refresh must not turn its receipt into an error.
      const unavailable = new CatalogStore();
      await unavailable.load(path, [], async () => {
        throw new Error("catalog_reload_failed");
      });
      this.#catalog = unavailable;
    }
    this.touch();
    return receipt;
  }
  select(
    reference: Reference,
    candidateId: string | null,
    allowHttp: boolean,
    bearerOnly = false,
  ): Snapshot {
    this.security.assertReference(reference);
    if (candidateId === null) return this.reset(reference);
    const material = this.#discovery.resolveCandidate(candidateId);
    if (!material) throw new SafeError("invalid_selection");
    const candidate = material.summary;
    if (!candidate.reusable && !(bearerOnly && candidate.bearerOnlyAvailable))
      throw new SafeError("unsupported_connection");
    if (candidate.httpRisk && !allowHttp)
      throw new SafeError("http_confirmation_required");
    this.change(reference);
    this.#baseUrl = material.baseUrl;
    this.#credential = material.credential;
    this.#connection = {
      source: "config",
      providerLabel: candidate.providerLabel,
      profileLabel: candidate.profileLabel,
      address: candidate.address,
      addressPresent: candidate.addressPresent,
      credentialPresent: !!material.credential,
      credentialHint: maskCredential(material.credential),
      authMode: bearerOnly ? "explicit_bearer" : "provider",
      credentialSource: material.credential
        ? (material.credentialOrigin ?? "config")
        : "missing",
      httpRisk: candidate.httpRisk,
      httpConfirmed: candidate.httpRisk && allowHttp,
      protocol: candidate.protocol,
      ready: !!this.#baseUrl && !!this.#credential,
    };
    return this.snapshot();
  }
  credentialKey(reference: Reference): PublicChallenge {
    this.security.assertReference(reference);
    if (this.#credential) throw new SafeError("only_missing_fields");
    return this.security.issueChallenge(reference, "connection-credential");
  }
  complete(
    reference: Reference,
    input: { baseUrl?: string; envelope?: Envelope; allowHttp: boolean },
  ): Snapshot {
    this.security.assertReference(reference);
    if (
      (input.baseUrl !== undefined && this.#baseUrl) ||
      (input.envelope && this.#credential) ||
      (input.baseUrl === undefined && !input.envelope)
    )
      throw new SafeError("only_missing_fields");
    let baseUrl = this.#baseUrl;
    let credential = this.#credential;
    if (input.baseUrl !== undefined) {
      try {
        baseUrl = normalizeBaseUrl(input.baseUrl);
      } catch {
        throw new SafeError("invalid_url");
      }
    }
    if (
      baseUrl?.startsWith("http:") &&
      !this.#connection.httpConfirmed &&
      !input.allowHttp
    )
      throw new SafeError("http_confirmation_required");
    if (input.envelope) {
      // Explicit reference as well as envelope's authenticated binding must agree.
      this.security.assertReference(input.envelope.binding);
      credential = this.security.decryptEnvelope(
        input.envelope,
        "connection-credential",
      );
      if (!validCredential(credential))
        throw new SafeError("invalid_credential");
    }
    this.change(reference);
    this.#baseUrl = baseUrl;
    this.#credential = credential;
    const httpRisk = baseUrl?.startsWith("http:") ?? false;
    this.#connection = {
      ...this.#connection,
      source:
        this.#connection.source === "config"
          ? "config+manual"
          : this.#connection.source,
      address: baseUrl
        ? displayAddress(baseUrl, credential ? [credential] : [])
        : null,
      addressPresent: !!baseUrl,
      credentialPresent: !!credential,
      credentialHint: maskCredential(credential),
      credentialSource: input.envelope
        ? "session"
        : this.#connection.credentialSource,
      httpRisk,
      httpConfirmed:
        httpRisk && (this.#connection.httpConfirmed || input.allowHttp),
      ready: !!baseUrl && !!credential,
    };
    return this.snapshot();
  }
  selfTest(envelope: Envelope): Snapshot {
    this.security.runSelfTest(envelope);
    return this.snapshot();
  }
  reference(): Reference {
    return referenceOf(this.security.snapshot());
  }
}
