import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  ConfigReadError,
  discoverConfig,
  FileConfigSource,
  type ConfigSource,
} from "../src/config/discovery.js";
import { endpoint, normalizeBaseUrl } from "../src/config/url.js";
import { ConnectionManager } from "../src/connections/manager.js";
import { SafeError } from "../src/connections/envelopes.js";
import {
  referenceOf,
  snapshotSchema,
  type Envelope,
} from "../src/shared/security.js";
import { encryptSecret } from "../src/ui/encrypt.js";
import { credentialDisplay } from "../src/shared/config.js";

const secret = "FAKE-M1-CREDENTIAL-NOT-FOR-NETWORK";
const config = `model_provider = "alpha"\n[model_providers.alpha]\nbase_url = "https://example.test/custom/v1/"\nexperimental_bearer_token = "${secret}"\nwire_api = "responses"\n`;
class FixtureSource implements ConfigSource {
  readonly homeSource = "CODEX_HOME" as const;
  readonly reads: string[] = [];
  constructor(
    readonly files: Record<string, string> = { "config.toml": config },
  ) {}
  async read(filename: string) {
    this.reads.push(filename);
    const value = this.files[filename];
    if (value === undefined) throw new ConfigReadError("missing");
    return value;
  }
  async profileNames() {
    return {
      names: Object.keys(this.files).filter((name) =>
        name.endsWith(".config.toml"),
      ),
      limited: false,
    };
  }
}
const fails = (code: string) => (error: unknown) =>
  error instanceof SafeError && error.code === code;
const ref = (manager: ConnectionManager) => referenceOf(manager.snapshot());
async function selectFirst(manager: ConnectionManager) {
  await manager.reload(ref(manager));
  const first = manager.snapshot().config!.candidates[0]!;
  return manager.select(ref(manager), first.candidateId, false);
}

test("missing, empty, invalid and read errors return fixed safe summaries without parser text", async () => {
  for (const [files, status] of [
    [{}, "missing"],
    [{ "config.toml": "\n " }, "empty"],
    [{ "config.toml": `x = "${secret}\n` }, "invalid"],
  ] as const) {
    const discovery = await discoverConfig(new FixtureSource(files));
    assert.equal(discovery.summary().status, status);
    assert(!JSON.stringify(discovery).includes(secret));
    assert(!JSON.stringify(discovery.summary()).includes(secret));
  }
  const source = new FixtureSource();
  source.read = async () => {
    throw new Error(secret);
  };
  assert.equal((await discoverConfig(source)).summary().status, "read_error");
});
test("single provider remains private, activity is unknown and selection is explicit", async () => {
  const source = new FixtureSource();
  const discovery = await discoverConfig(source);
  const summary = discovery.summary();
  const a = summary.candidates[0]!;
  assert.equal(a.providerLabel, "alpha");
  assert.equal(a.configuredDefault, true);
  assert.equal(a.address, "https://example.test/…");
  assert(a.addressPresent && a.credentialPresent && a.reusable);
  assert.equal(summary.activityKnown, false);
  assert.deepEqual(source.reads, ["config.toml"]);
  assert(!JSON.stringify(summary).includes(secret));
  assert(!JSON.stringify(discovery).includes(secret));
  assert.equal(
    discovery.resolveCandidate(a.candidateId)!.baseUrl,
    "https://example.test/custom/v1",
  );
  // Mutating the public projection cannot alter backend material.
  a.providerLabel = "changed";
  assert.equal(discovery.summary().candidates[0]!.providerLabel, "alpha");
});
test("multi provider never combines address from one with a token from another", async () => {
  const source = new FixtureSource({
    "config.toml": `model_provider = "a"\n[model_providers.a]\nbase_url = "https://a.test/v1"\n[model_providers.b]\nexperimental_bearer_token = "${secret}"\n[model_providers.c]\nbase_url = " "\nexperimental_bearer_token = " "`,
  });
  const manager = new ConnectionManager(undefined, source);
  await manager.reload(ref(manager));
  const candidates = manager.snapshot().config!.candidates;
  assert.equal(candidates.length, 3);
  const a = manager.select(ref(manager), candidates[0]!.candidateId, false);
  assert(
    a.connection!.addressPresent &&
      !a.connection!.credentialPresent &&
      !a.connection!.ready,
  );
  const b = manager.select(ref(manager), candidates[1]!.candidateId, false);
  assert(
    !b.connection!.addressPresent &&
      b.connection!.credentialPresent &&
      !b.connection!.ready,
  );
  const c = manager.select(ref(manager), candidates[2]!.candidateId, false);
  assert(!c.connection!.addressPresent && !c.connection!.credentialPresent);
});
test("independent profile overlays merge same-provider fields, not different-provider credentials", async () => {
  const source = new FixtureSource({
    "config.toml": config,
    "work.config.toml": `model_provider="beta"\n[model_providers.alpha]\nbase_url="https://changed.test/prefix"\n[model_providers.beta]\nbase_url="https://beta.test/v1"`,
    "broken.config.toml": `token="${secret}\n`,
  });
  const discovery = await discoverConfig(source);
  const work = discovery
    .summary()
    .candidates.filter((c) => c.profileLabel === "work");
  assert.equal(work.length, 2);
  const alpha = work.find((c) => c.providerLabel === "alpha")!;
  const beta = work.find((c) => c.providerLabel === "beta")!;
  assert(!alpha.configuredDefault && alpha.credentialPresent);
  assert(beta.configuredDefault && !beta.credentialPresent);
  assert.equal(
    discovery.resolveCandidate(alpha.candidateId)!.baseUrl,
    "https://changed.test/prefix",
  );
  assert.equal(
    discovery.resolveCandidate(alpha.candidateId)!.credential,
    secret,
  );
  assert(discovery.summary().warnings.includes("profile_invalid"));
  assert(!JSON.stringify(discovery.summary()).includes(secret));
});
test("legacy profiles are not selected or parsed into connections; same-name overlay is blocked", async () => {
  const source = new FixtureSource({
    "config.toml": `${config}\n[profiles.work]\nmodel_provider="alpha"\n`,
    "work.config.toml": `model_provider="alpha"`,
  });
  const discovery = await discoverConfig(source);
  assert(discovery.summary().warnings.includes("legacy_profiles"));
  const work = discovery
    .summary()
    .candidates.find((c) => c.profileLabel === "work")!;
  assert(!work.reusable && work.issues.includes("legacy_profile_conflict"));
  const manager = new ConnectionManager(undefined, source);
  await manager.reload(ref(manager));
  const conflict = manager
    .snapshot()
    .config!.candidates.find((c) => c.profileLabel === "work")!;
  assert.throws(
    () => manager.select(ref(manager), conflict.candidateId, false),
    fails("unsupported_connection"),
  );
});
test("auth/env/command/account and custom request fields fail closed without exposing or executing values", async () => {
  for (const extra of [
    `env_key="${secret}"`,
    `requires_openai_auth=true`,
    `auth={command="${secret}"}`,
    `http_headers={Authorization="${secret}"}`,
    `query_params={key="${secret}"}`,
    `env_http_headers={Authorization="${secret}"}`,
    `supports_websockets=true`,
    `future_option="${secret}"`,
  ]) {
    const discovery = await discoverConfig(
      new FixtureSource({ "config.toml": `${config}${extra}\n` }),
    );
    const candidate = discovery.summary().candidates[0]!;
    assert(!candidate.reusable, extra);
    assert(!JSON.stringify(discovery.summary()).includes(secret));
  }
  for (const reserved of ["openai", "ollama", "lmstudio"]) {
    const discovery = await discoverConfig(
      new FixtureSource({
        "config.toml": config.replaceAll("alpha", reserved),
      }),
    );
    assert(!discovery.summary().candidates[0]!.reusable);
  }
});
const envConfig = config.replace(
  `experimental_bearer_token = "${secret}"`,
  'env_key = "KIT_TEST_KEY"',
);
test("standalone env_key is reused privately, masked in UI and refreshed on reload", async () => {
  const env = { KIT_TEST_KEY: secret, UNUSED_KEY: "unused" };
  const discovery = await discoverConfig(
    new FixtureSource({ "config.toml": envConfig }),
    env,
  );
  const candidate = discovery.summary().candidates[0]!;
  assert(candidate.reusable && candidate.credentialPresent);
  assert.equal(candidate.authSource, "env");
  assert.equal(
    discovery.resolveCandidate(candidate.candidateId)!.credential,
    secret,
  );
  assert.equal(
    discovery.resolveCandidate(candidate.candidateId)!.credentialOrigin,
    "env",
  );
  const manager = new ConnectionManager(
    undefined,
    new FixtureSource({ "config.toml": envConfig }),
    env,
  );
  const snapshot = await manager.loadSync(ref(manager));
  assert(snapshot.connection!.ready);
  assert.equal(snapshot.connection!.credentialSource, "env");
  assert(snapshotSchema.safeParse(snapshot).success);
  assert.equal(
    credentialDisplay(snapshot.connection, candidate).label,
    "env_key（环境变量）",
  );
  assert.match(
    credentialDisplay(snapshot.connection, candidate).detail,
    /已复用 env_key/,
  );
  assert(
    !JSON.stringify([
      discovery.summary(),
      snapshot,
      credentialDisplay(snapshot.connection, candidate),
    ]).includes(secret),
  );
  await manager.useConnection(ref(manager), async (material) =>
    assert.equal(material.credential, secret),
  );
  env.KIT_TEST_KEY = "FAKE-ROTATED-ENV-CREDENTIAL";
  await manager.loadSync(ref(manager));
  await manager.useConnection(ref(manager), async (material) =>
    assert.equal(material.credential, env.KIT_TEST_KEY),
  );
});
test("missing, blank and malformed environment credentials fail closed without trimming a token", async () => {
  for (const [value, issue] of [
    [undefined, "missing_env_credential"],
    ["", "missing_env_credential"],
    [" \t ", "missing_env_credential"],
    [` ${secret}`, "invalid_credential"],
    [`${secret}\n`, "invalid_credential"],
    ["非ASCII", "invalid_credential"],
  ] as const) {
    const manager = new ConnectionManager(
      undefined,
      new FixtureSource({ "config.toml": envConfig }),
      { KIT_TEST_KEY: value },
    );
    const snapshot = await manager.loadSync(ref(manager));
    const candidate = snapshot.config!.candidates[0]!;
    assert.equal(candidate.authSource, "env");
    assert(
      !candidate.reusable &&
        !candidate.credentialPresent &&
        !snapshot.connection!.ready,
    );
    assert(candidate.issues.includes(issue));
    assert.equal(candidate.credentialHint, null);
    assert.match(
      credentialDisplay(snapshot.connection, candidate).detail,
      /插件进程|格式无效/,
    );
    assert.throws(
      () => manager.select(ref(manager), candidate.candidateId, false),
      fails("unsupported_connection"),
    );
  }
  const inherited = Object.create({ KIT_TEST_KEY: secret });
  const d = await discoverConfig(
    new FixtureSource({ "config.toml": envConfig }),
    inherited,
  );
  assert(d.summary().candidates[0]!.issues.includes("missing_env_credential"));
});
test("invalid environment names never read the environment", async () => {
  for (const name of [
    "",
    " ",
    "1KEY",
    "HAS-DASH",
    "__proto__",
    "prototype",
    "constructor",
    "A".repeat(129),
  ]) {
    const env = Object.defineProperty({}, name, {
      get() {
        throw new Error("must not read");
      },
    });
    const d = await discoverConfig(
      new FixtureSource({
        "config.toml": envConfig.replace("KIT_TEST_KEY", name),
      }),
      env,
    );
    const candidate = d.summary().candidates[0]!;
    assert(candidate.issues.includes("invalid_env_key"));
    assert.equal(candidate.authSource, "unsupported");
    assert(!candidate.reusable && !candidate.credentialPresent);
  }
});
test("mixed auth, reserved providers, profile conflicts and unsupported options never read env_key", async () => {
  const env = Object.defineProperty({}, "KIT_TEST_KEY", {
    get() {
      throw new Error("must not read");
    },
  });
  for (const extra of [
    `experimental_bearer_token="${secret}"`,
    'experimental_bearer_token=""',
    'auth={command="do-not-run"}',
    "requires_openai_auth=true",
    'http_headers={X="value"}',
    'env_http_headers={X="OTHER"}',
    'query_params={key="value"}',
    "request_max_retries=1",
    "supports_websockets=false",
    "requires_openai_auth=1",
    "gateway_oauth={}",
    "aws={}",
    "capabilities={}",
    "future_option=true",
  ]) {
    const d = await discoverConfig(
      new FixtureSource({ "config.toml": `${envConfig}${extra}\n` }),
      env,
    );
    const c = d.summary().candidates[0]!;
    assert(
      !c.reusable && !c.credentialPresent && !c.bearerOnlyAvailable,
      extra,
    );
    assert.equal(d.resolveCandidate(c.candidateId)!.credential, null);
    assert(!JSON.stringify(d.summary()).includes(secret));
  }
  for (const provider of ["openai", "ollama", "lmstudio"]) {
    const d = await discoverConfig(
      new FixtureSource({
        "config.toml": envConfig.replaceAll("alpha", provider),
      }),
      env,
    );
    assert(d.summary().candidates[0]!.issues.includes("reserved_provider"));
  }
  const conflict = `profile="work"\n${envConfig.replace('env_key = "KIT_TEST_KEY"', "")}\n[profiles.work]\nmodel_provider="alpha"`;
  const d = await discoverConfig(
    new FixtureSource({
      "config.toml": conflict,
      "work.config.toml": '[model_providers.alpha]\nenv_key="KIT_TEST_KEY"',
    }),
    env,
  );
  assert(
    d
      .summary()
      .candidates.find((c) => c.profileLabel === "work")!
      .issues.includes("legacy_profile_conflict"),
  );
});
test("documented non-auth provider metadata permits standalone env_key and env secrets redact labels", async () => {
  const cfg = `${envConfig}\nrequires_openai_auth=false\nenv_key_instructions="not echoed"\nmodel_catalog_url="https://metadata.test/models"\nsupports_standalone_web_search=false`;
  const d = await discoverConfig(new FixtureSource({ "config.toml": cfg }), {
    KIT_TEST_KEY: secret,
  });
  assert(d.summary().candidates[0]!.reusable);
  assert(!JSON.stringify(d.summary()).includes("not echoed"));
  const hidden = await discoverConfig(
    new FixtureSource({ "config.toml": envConfig.replaceAll("alpha", secret) }),
    { KIT_TEST_KEY: secret },
  );
  assert(!JSON.stringify(hidden.summary()).includes(secret));
  const bearer = await discoverConfig(new FixtureSource());
  assert.equal(
    credentialDisplay(null, bearer.summary().candidates[0]!).label,
    "experimental_bearer_token",
  );
});
test("a conflicting profile cannot inherit an env credential resolved for the default provider", async () => {
  let reads = 0;
  const env = Object.defineProperty({}, "KIT_TEST_KEY", {
    get() {
      reads += 1;
      return secret;
    },
  });
  const d = await discoverConfig(
    new FixtureSource({
      "config.toml": `profile="work"\n${envConfig}`,
      "work.config.toml": 'model_provider="alpha"',
    }),
    env,
  );
  assert.equal(reads, 1);
  assert(d.defaultCandidate()!.summary.credentialPresent);
  const candidate = d
    .summary()
    .candidates.find((c) => c.profileLabel === "work")!;
  assert(candidate.issues.includes("legacy_profile_conflict"));
  assert(!candidate.reusable && !candidate.credentialPresent);
  assert.equal(d.resolveCandidate(candidate.candidateId)!.credential, null);
});
test("unknown protocol is not silently advertised as responses", async () => {
  const manager = new ConnectionManager(
    undefined,
    new FixtureSource({
      "config.toml": config.replace('"responses"', '"chat"'),
    }),
  );
  const selected = await selectFirst(manager);
  assert.equal(selected.connection!.protocol, "unknown");
});
test("credential text in labels and URL path is not returned; URL userinfo/query is rejected", async () => {
  const discovery = await discoverConfig(
    new FixtureSource({
      "config.toml": config
        .replaceAll("alpha", secret)
        .replace("/custom/v1/", `/${secret}/`),
    }),
  );
  assert(!JSON.stringify(discovery.summary()).includes(secret));
  for (const url of [
    `https://u:${secret}@example.test/v1`,
    `https://example.test/v1?key=${secret}`,
  ]) {
    const d = await discoverConfig(
      new FixtureSource({
        "config.toml": config.replace("https://example.test/custom/v1/", url),
      }),
    );
    assert.equal(d.summary().candidates[0]!.addressPresent, false);
    assert(!JSON.stringify(d.summary()).includes(secret));
  }
});
test("address preserves base path, does not duplicate v1, rejects unsafe URLs and allows explicit HTTP risk", () => {
  for (const [base, expected] of [
    ["https://a.test", "https://a.test/models"],
    ["https://a.test/v1/", "https://a.test/v1/models"],
    ["https://a.test/custom/v2///", "https://a.test/custom/v2/models"],
    ["http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1/models"],
  ]) {
    assert.equal(endpoint(base!, "models"), expected);
  }
  for (const value of [
    "",
    " https://a.test",
    "file:///etc/passwd",
    "http:example.test",
    "https://a.test/a/../b",
    "https://a.test/a/%2e%2e/b",
    "https://u:p@a.test",
    "https://a.test/?x=1",
    "https://a.test/#secret",
    "https://a.test/\\evil",
    "https://a.test/\n",
  ])
    assert.throws(() => normalizeBaseUrl(value));
});
test("safe filesystem source reads only config and valid independent profiles; no auth, catalog or symlinks", async () => {
  const root = await mkdtemp(resolve(".test-artifacts/m1-home-"));
  try {
    await writeFile(join(root, "config.toml"), config);
    await writeFile(join(root, "auth.json"), secret);
    await writeFile(join(root, "catalog.json"), secret);
    await writeFile(join(root, "work.config.toml"), 'model_provider="alpha"');
    await symlink(join(root, "auth.json"), join(root, "trap.config.toml"));
    const source = new FileConfigSource(root);
    assert.equal(source.homeSource, "CODEX_HOME");
    const before = await readFile(join(root, "config.toml"), "utf8");
    const summary = (await discoverConfig(source)).summary();
    assert.equal(summary.candidates.length, 2);
    assert(summary.warnings.includes("profile_read_error"));
    assert(!JSON.stringify(summary).includes(secret));
    assert.equal(await readFile(join(root, "config.toml"), "utf8"), before);
    for (const path of [
      "auth.json",
      "catalog.json",
      "../config.toml",
      "/config.toml",
      "trap.config.toml",
    ])
      await assert.rejects(source.read(path));
    await writeFile(join(root, "huge.config.toml"), "a".repeat(262145));
    await assert.rejects(source.read("huge.config.toml"));
    await mkdir(join(root, ".codex"));
    const defaultSource = new FileConfigSource("", root);
    assert.equal(defaultSource.homeSource, "default");
    await assert.rejects(defaultSource.read("config.toml"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("candidate/file limits and injected malicious profile paths fail closed", async () => {
  const source = new FixtureSource();
  source.profileNames = async () => ({
    names: [
      "../auth.config.toml",
      "/secret.config.toml",
      ...Array.from({ length: 20 }, (_, i) => `x${i}.config.toml`),
    ],
    limited: false,
  });
  const summary = (await discoverConfig(source)).summary();
  assert(summary.warnings.includes("discovery_limit"));
  assert(!source.reads.some((path) => path.includes("/")));
});
test("only missing fields are supplemented; no config writes and no plaintext in projections", async () => {
  const manager = new ConnectionManager(
    undefined,
    new FixtureSource({
      "config.toml": config.replace(
        `experimental_bearer_token = "${secret}"\n`,
        "",
      ),
    }),
  );
  await selectFirst(manager);
  assert.throws(
    () =>
      manager.complete(ref(manager), {
        baseUrl: "https://attacker.test",
        allowHttp: false,
      }),
    fails("only_missing_fields"),
  );
  const before = manager.snapshot();
  const key = manager.credentialKey(ref(manager));
  const envelope = await encryptSecret(key, secret);
  const after = manager.complete(ref(manager), { envelope, allowHttp: false });
  assert.equal(after.connectionRevision, before.connectionRevision + 1);
  assert(after.connection!.ready);
  assert.equal(after.connection!.source, "config+manual");
  assert.equal(after.connection!.credentialSource, "session");
  assert(!JSON.stringify([envelope, after, manager]).includes(secret));
  assert(snapshotSchema.safeParse(after).success);
  assert.throws(
    () => manager.credentialKey(ref(manager)),
    fails("only_missing_fields"),
  );
});
test("missing only address keeps same-provider token, complete candidates require no password", async () => {
  const manager = new ConnectionManager(
    undefined,
    new FixtureSource({
      "config.toml": config.replace(
        'base_url = "https://example.test/custom/v1/"\n',
        "",
      ),
    }),
  );
  await selectFirst(manager);
  const after = manager.complete(ref(manager), {
    baseUrl: "https://example.test/v1",
    allowHttp: false,
  });
  assert(
    after.connection!.ready && after.connection!.credentialSource === "config",
  );
  assert(!JSON.stringify(after).includes(secret));
  const complete = new ConnectionManager(undefined, new FixtureSource());
  assert((await selectFirst(complete)).connection!.ready);
});
test("HTTP is never enabled without explicit confirmation; credential validation is atomic", async () => {
  const manager = new ConnectionManager(undefined, new FixtureSource());
  const initial = manager.snapshot();
  assert.throws(
    () =>
      manager.complete(ref(manager), {
        baseUrl: "http://localhost:1234/v1",
        allowHttp: false,
      }),
    fails("http_confirmation_required"),
  );
  assert.equal(
    manager.snapshot().connectionRevision,
    initial.connectionRevision,
  );
  const key = manager.credentialKey(ref(manager));
  const bad = await encryptSecret(key, `${secret}\n`);
  assert.throws(
    () =>
      manager.complete(ref(manager), {
        baseUrl: "https://example.test/v1",
        envelope: bad,
        allowHttp: false,
      }),
    fails("invalid_credential"),
  );
  assert.equal(manager.snapshot().connection!.addressPresent, false);
  const envelope = await encryptSecret(
    manager.credentialKey(ref(manager)),
    secret,
  );
  const next = manager.complete(ref(manager), {
    baseUrl: "http://localhost:1234/v1",
    envelope,
    allowHttp: true,
  });
  assert(next.connection!.ready && next.connection!.httpConfirmed);
});
test("purpose binding, stale revisions, replay and cross-instance submissions cannot mix secrets", async () => {
  const a = new ConnectionManager(undefined, new FixtureSource());
  const b = new ConnectionManager(undefined, new FixtureSource());
  const key = a.credentialKey(ref(a));
  const envelope = await encryptSecret(key, secret);
  assert.throws(() => a.selfTest(envelope), fails("invalid_envelope"));
  assert.throws(
    () => b.complete(ref(b), { envelope, allowHttp: false }),
    fails("stale_reference"),
  );
  a.complete(ref(a), { envelope, allowHttp: false });
  assert.throws(
    () => a.complete(ref(a), { envelope, allowHttp: false }),
    fails("only_missing_fields"),
  );
  const old = ref(a);
  a.select(old, null, false);
  assert.throws(() => a.credentialKey(old), fails("stale_reference"));
  assert.equal(a.snapshot().connection!.credentialPresent, false);
  assert.equal(b.snapshot().connection!.credentialPresent, false);
  const selfEnvelope = await encryptSecret(
    a.security.issueChallenge(ref(a)),
    secret,
  );
  assert.throws(
    () =>
      a.complete(ref(a), {
        envelope: selfEnvelope as Envelope,
        allowHttp: false,
      }),
    fails("invalid_envelope"),
  );
});
test("reload invalidates candidate IDs and concurrent reload cannot overwrite a new selection", async () => {
  const source = new FixtureSource();
  const manager = new ConnectionManager(undefined, source);
  await manager.reload(ref(manager));
  const id = manager.snapshot().config!.candidates[0]!.candidateId;
  await manager.reload(ref(manager));
  assert.throws(
    () => manager.select(ref(manager), id, false),
    fails("invalid_selection"),
  );
  let release: (() => void) | undefined;
  const read = source.read.bind(source);
  source.read = async (name) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return read(name);
  };
  const reloading = manager.reload(ref(manager));
  manager.select(ref(manager), null, false);
  release!();
  await assert.rejects(reloading, fails("stale_reference"));
  assert.equal(manager.snapshot().connection!.source, "manual");
});
