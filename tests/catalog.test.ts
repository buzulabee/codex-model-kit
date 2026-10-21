import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CatalogStore, readCatalogFile } from "../src/catalog/store.js";
import {
  initialParameters,
  directStatus,
  adjustContextWindow,
  previewIssues,
} from "../src/catalog/parameters.js";
import { ConnectionManager } from "../src/connections/manager.js";
import {
  ConfigReadError,
  FileConfigSource,
  type ConfigSource,
} from "../src/config/discovery.js";
import { SafeError } from "../src/connections/envelopes.js";
import { Workbench } from "../src/tasks/workbench.js";
import { normalizeModels } from "../src/providers/http.js";
import {
  modelParametersSchema,
  type ModelParameters,
} from "../src/shared/catalog.js";
import { outcome } from "../src/providers/probe.js";
import type { Job } from "../src/shared/workbench.js";
import { referenceOf } from "../src/shared/security.js";

const secret = "FAKE-CATALOG-SECRET-NOT-REAL";
const params: ModelParameters = {
  displayName: "Local Alias",
  requestModel: "local-model",
  contextWindow: 128000,
  images: false,
  reasoningLevels: ["low", "high"],
  defaultReasoning: "high",
};
const original = {
  shell_type: "unified_exec",
  visibility: "list",
  supported_in_api: true,
  priority: 0,
  support_verbosity: false,
  truncation_policy: { mode: "tokens", limit: 10000 },
  experimental_supported_tools: [],
  slug: params.requestModel,
  display_name: params.displayName,
  context_window: 128000,
  max_context_window: 256000,
  auto_compact_token_limit: 100000,
  supported_reasoning_levels: [
    { effort: "low", description: "custom low" },
    { effort: "high", description: "custom high" },
  ],
  default_reasoning_level: "high",
  input_modalities: ["text"],
  model_messages: {
    instructions_template: "Keep my custom instructions",
    instructions_variables: null,
  },
  custom_extra: { preserve: true },
};
class Source implements ConfigSource {
  homeSource = "CODEX_HOME" as const;
  reads: string[] = [];
  constructor(
    readonly config: string,
    readonly catalog = JSON.stringify({
      models: [original],
      custom_top: "keep",
    }),
  ) {}
  async read(name: string) {
    this.reads.push(name);
    if (name !== "config.toml") throw new ConfigReadError("missing");
    return this.config;
  }
  async profileNames() {
    return { names: [], limited: false };
  }
  async readCatalog(path: string) {
    this.reads.push(path);
    return this.catalog;
  }
}
const config = `model_provider="relay"\nmodel_catalog_json="/fixture/models.json"\n[model_providers.relay]\nbase_url="https://relay.test/v1"\nexperimental_bearer_token="${secret}"\nrequires_openai_auth=true\nwire_api="responses"\n`;
const fails = (code: string) => (e: unknown) =>
  e instanceof SafeError && e.code === code;

test("sync automatically reuses only main default bearer, reads catalog without auth or network", async () => {
  const source = new Source(config),
    manager = new ConnectionManager(undefined, source);
  const result = await manager.loadSync(manager.reference());
  assert(result.connection?.ready);
  assert.equal(result.connection.authMode, "explicit_bearer");
  assert.equal(result.localCatalog?.status, "ready");
  assert.equal(
    result.localCatalog.models[0]?.parameters.displayName,
    "Local Alias",
  );
  assert.deepEqual(source.reads, [
    "config.toml",
    "config.toml",
    "/fixture/models.json",
    "config.toml",
  ]);
  assert(!JSON.stringify(result).includes(secret));
  assert(!JSON.stringify(manager).includes(secret));
});
test("sync never mixes providers, guesses activity or automatically permits HTTP", async () => {
  for (const cfg of [
    `model_provider="a"\n[model_providers.a]\nbase_url="https://a.test"\n[model_providers.b]\nexperimental_bearer_token="${secret}"`,
    config.replace("https://relay", "http://relay"),
  ]) {
    const m = new ConnectionManager(undefined, new Source(cfg));
    const s = await m.loadSync(m.reference());
    assert(!s.connection?.ready);
    assert.equal(s.config?.activityKnown, false);
  }
});
test("catalog states, invalid duplicate/schema/secret/oversized values, no unsafe file read", async () => {
  for (const [path, raw, state] of [
    [undefined, "", "not_configured"],
    ["relative.json", "", "relative_path"],
    ["/fixture/models.json", "not json", "invalid"],
    [
      "/fixture/models.json",
      JSON.stringify({ models: [original, original] }),
      "invalid",
    ],
    [
      "/fixture/models.json",
      JSON.stringify({ models: [{ ...original, display_name: secret }] }),
      "invalid",
    ],
    [
      "/fixture/models.json",
      JSON.stringify({ models: [original], token: "hidden" }),
      "invalid",
    ],
    [
      "/fixture/models.json",
      JSON.stringify({
        models: [{ ...original, input_modalities: ["video"] }],
      }),
      "invalid",
    ],
    ["/fixture/models.json", "x".repeat(2 * 1024 * 1024 + 1), "invalid"],
    ["/fixture/auth.json", "", "invalid"],
    ["/fixture/config.toml", "", "invalid"],
  ] as const) {
    const store = new CatalogStore();
    let reads = 0;
    await store.load(path, [secret], async () => {
      reads++;
      return raw;
    });
    assert.equal(store.summary().status, state);
    if (
      !path ||
      state === "relative_path" ||
      path.endsWith("auth.json") ||
      path.endsWith(".toml")
    )
      assert.equal(reads, 0);
    assert(!JSON.stringify(store.summary()).includes(secret));
  }
  const store = new CatalogStore();
  await store.load("/fixture/models.json", [], async () => {
    throw Object.assign(new Error("sensitive"), { code: "ENOENT" });
  });
  assert.equal(store.summary().status, "missing");
  await store.load("/fixture/models.json", [], async () => {
    throw new Error(secret);
  });
  assert.equal(store.summary().status, "read_error");
});
test("preview preserves safe extra fields/instructions and explicitly updates only selected parameters", async () => {
  const store = new CatalogStore();
  await store.load("/fixture/models.json", [], async () =>
    JSON.stringify({ models: [original], custom_top: "keep" }),
  );
  const json = store.preview(
    [{ key: "local-model", parameters: params }],
    new Set(["local-model"]),
    [],
  );
  const data = JSON.parse(json);
  assert.equal(data.custom_top, "keep");
  assert.deepEqual(data.models[0].model_messages, original.model_messages);
  assert.deepEqual(data.models[0].custom_extra, original.custom_extra);
  assert.equal(data.models[0].max_context_window, 256000);
  assert.equal(data.models[0].auto_compact_token_limit, 100000);
  const updated = JSON.parse(
    store.preview(
      [
        {
          key: "local-model",
          parameters: {
            ...params,
            requestModel: "new-id",
            displayName: "New Name",
            contextWindow: 64000,
            images: true,
          },
        },
      ],
      new Set(["local-model"]),
      [],
    ),
  );
  assert.equal(updated.models[0].slug, "new-id");
  assert.equal(updated.models[0].context_window, 64000);
  assert.equal(updated.models[0].max_context_window, 64000);
  assert.equal(updated.models[0].auto_compact_token_limit, null);
  assert.deepEqual(updated.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(store.summary().models[0]?.parameters, params);
});
test("new catalog preview uses target CLI required structure; unknowns, duplicates and secrets are blocked", () => {
  const store = new CatalogStore(),
    allowed = new Set(["a", "b"]);
  const rows = [{ key: "a", parameters: params }];
  const model = JSON.parse(store.preview(rows, allowed, [])).models[0];
  for (const key of [
    "slug",
    "display_name",
    "supported_reasoning_levels",
    "shell_type",
    "visibility",
    "supported_in_api",
    "priority",
    "support_verbosity",
    "truncation_policy",
    "experimental_supported_tools",
  ])
    assert(Object.hasOwn(model, key));
  assert.throws(
    () =>
      store.preview(
        [{ key: "a", parameters: { ...params, images: null } }],
        allowed,
        [],
      ),
    fails("unknown_metadata"),
  );
  assert.throws(
    () =>
      store.preview(
        [
          { key: "a", parameters: params },
          { key: "b", parameters: params },
        ],
        allowed,
        [],
      ),
    fails("duplicate_model"),
  );
  assert.throws(
    () =>
      store.preview([{ key: "not-allowed", parameters: params }], allowed, []),
    fails("invalid_catalog_draft"),
  );
  assert.throws(
    () =>
      store.preview(
        [{ key: "a", parameters: { ...params, requestModel: secret } }],
        allowed,
        [secret],
      ),
    fails("invalid_catalog_draft"),
  );
  assert.throws(
    () => store.preview([], allowed, []),
    fails("invalid_catalog_draft"),
  );
  for (const p of [
    { ...params, contextWindow: 1 },
    { ...params, contextWindow: 1.2 },
    { ...params, defaultReasoning: "ultra" },
    { ...params, reasoningLevels: ["low", "low"] },
  ])
    assert(!modelParametersSchema.safeParse(p).success);
});
test("local > supplier declarations > exact reference metadata; names alone never prove Responses", () => {
  const remote = normalizeModels(
    {
      data: [
        {
          id: "kimi-for-coding",
          context_window: 64000,
          input_modalities: ["text"],
          supported_reasoning_levels: [{ effort: "none" }],
        },
      ],
    },
    secret,
  ).models[0]!;
  assert.deepEqual(
    initialParameters("kimi-for-coding", params, remote).parameters,
    params,
  );
  const p = initialParameters("kimi-for-coding", undefined, remote).parameters;
  assert.equal(p.contextWindow, 64000);
  assert.equal(p.images, false);
  assert.deepEqual(p.reasoningLevels, ["none"]);
  assert.equal(
    initialParameters("gpt-entirely-new").parameters.contextWindow,
    null,
  );
  assert.equal(initialParameters("unknown-model").parameters.images, null);
  assert.match(directStatus("gpt-entirely-new").label, /未检测/);
  assert.equal(directStatus("claude-any").label, "未检测");
  assert(
    !JSON.stringify(
      normalizeModels(
        {
          data: [
            {
              id: "a",
              input_modalities: [secret],
              supported_reasoning_levels: [secret],
            },
          ],
        },
        secret,
      ),
    ).includes(secret),
  );
});
test("supplier drafts prefer medium, otherwise the lower middle supported effort regardless of response order", () => {
  const cases = [
    { levels: ["high", "low", "medium"], expected: "medium" },
    { levels: ["ultra", "max", "xhigh", "high", "medium"], expected: "medium" },
    { levels: ["xhigh", "low", "high"], expected: "high" },
    { levels: ["ultra", "high", "low", "xhigh"], expected: "high" },
    { levels: ["high", "low"], expected: "low" },
    { levels: ["none"], expected: "none" },
    { levels: [], expected: null },
  ];
  for (const { levels, expected } of cases) {
    const remote = normalizeModels(
      { data: [{ id: "supplier-model", supported_reasoning_levels: levels }] },
      secret,
    ).models[0]!;
    const p = initialParameters(remote.id, undefined, remote).parameters;
    assert.equal(p.defaultReasoning, expected);
    assert.deepEqual(p.reasoningLevels, levels);
    assert(modelParametersSchema.safeParse(p).success);
  }
  assert.equal(
    initialParameters("unknown-model").parameters.defaultReasoning,
    null,
  );
});
test("reference efforts use medium without replacing local defaults, including explicitly unset values", async () => {
  const { referenceMetadata } = await import("../src/catalog/reference.js");
  const remote = normalizeModels({ data: [{ id: "gpt-6-astra" }] }, secret)
    .models[0]!;
  remote.referenceMetadata = referenceMetadata(
    "https://arbitrary-relay.invalid/v1",
    remote.id,
  );
  assert.equal(
    initialParameters(remote.id, undefined, remote).parameters.defaultReasoning,
    "medium",
  );
  for (const defaultReasoning of ["high", null] as const) {
    const local = { ...params, defaultReasoning };
    const result = initialParameters(remote.id, local, remote).parameters;
    assert.deepEqual(result, local);
    assert.notEqual(result.reasoningLevels, local.reasoningLevels);
  }
});
test("supplier default medium survives catalog preview serialization", () => {
  const remote = normalizeModels(
    {
      data: [
        {
          id: "supplier-model",
          context_window: 128000,
          supports_images: false,
          supported_reasoning_levels: ["low", "medium", "high"],
        },
      ],
    },
    secret,
  ).models[0]!;
  const p = initialParameters(remote.id, undefined, remote).parameters;
  const json = new CatalogStore().preview(
    [{ key: remote.id, parameters: p }],
    new Set([remote.id]),
    [],
  );
  assert.equal(JSON.parse(json).models[0].default_reasoning_level, "medium");
});
test("catalog reader bounds regular files and denies symlink, auth/config paths; preview leaves bytes unchanged", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/catalog-home-")),
    file = join(dir, "models.json");
  try {
    const bytes = JSON.stringify({ models: [original] });
    await writeFile(file, bytes);
    await symlink(file, join(dir, "link.json"));
    assert.equal(await readCatalogFile(file), bytes);
    await assert.rejects(readCatalogFile(join(dir, "link.json")));
    await assert.rejects(readCatalogFile(join(dir, "auth.json")));
    await assert.rejects(readCatalogFile(join(dir, "config.toml")));
    const store = new CatalogStore();
    await store.load(file, []);
    store.preview(
      [{ key: "local-model", parameters: params }],
      new Set(["local-model"]),
      [],
    );
    assert.equal(await readFile(file, "utf8"), bytes);
    await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(readCatalogFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("preview enforces current connection revision and requires no configured network connection", async () => {
  const manager = new ConnectionManager(
      undefined,
      new Source(config.replace(/experimental_bearer_token=.*\n/, "")),
    ),
    workbench = new Workbench(manager, async () => {
      throw new Error("network forbidden");
    });
  try {
    await manager.loadSync(manager.reference());
    const ref = referenceOf(workbench.snapshot());
    assert(!workbench.snapshot().connection?.ready);
    assert(
      JSON.parse(
        workbench.preview(ref, [{ key: "local-model", parameters: params }]),
      ).models.length === 1,
    );
    manager.reset(ref);
    assert.throws(
      () =>
        workbench.preview(ref, [{ key: "local-model", parameters: params }]),
      fails("stale_reference"),
    );
  } finally {
    workbench.close();
  }
});

test("a failed post-commit catalog refresh still returns the durable write receipt", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/reload-"));
  const path = join(dir, "models.json");
  const originalJson = JSON.stringify({ models: [original] });
  const nextJson = JSON.stringify({ models: [{ ...original, priority: 1 }] });
  class FailingRefreshSource extends Source {
    failRefresh = false;
    resolveCatalogPath(value: string) {
      if (this.failRefresh) throw new Error("injected refresh failure");
      return value;
    }
  }
  try {
    await writeFile(path, originalJson);
    const source = new FailingRefreshSource(
      config.replace("/fixture/models.json", path),
      originalJson,
    );
    const manager = new ConnectionManager(undefined, source);
    await manager.loadSync(manager.reference());
    const reference = manager.reference();
    const plan = await manager.prepareCatalog(reference, nextJson);
    source.failRefresh = true;
    const receipt = await manager.commitCatalog(
      reference,
      plan.planId,
      "reload-failure-request",
    );
    assert.equal(
      receipt.durability,
      process.platform === "win32" ? "file_synced" : "synced",
    );
    assert.equal(await readFile(path, "utf8"), nextJson);
    assert.equal(manager.snapshot().localCatalog?.status, "read_error");
    assert.deepEqual(manager.snapshot().catalogWrite, receipt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("metadata references scope supplier presets to the endpoint and use only unique canonical fallback", async () => {
  const { referenceMetadata } = await import("../src/catalog/reference.js");
  const relay = referenceMetadata(
    "https://arbitrary-relay.invalid/v1",
    "gpt-6-astra",
  )!;
  assert.equal(relay.source, "canonical-reference");
  assert.equal(relay.values.images, true);
  const copilot = referenceMetadata(
    "https://api.githubcopilot.com/responses",
    "gpt-6-astra",
  )!;
  assert.equal(copilot.source, "endpoint-preset");
  assert.equal(copilot.values.images, false);
  assert.equal(copilot.values.contextWindow, 272000);
  const otherPath = referenceMetadata(
    "https://api.githubcopilot.com/different-plan/v1",
    "gpt-6-astra",
  )!;
  assert.equal(otherPath.source, "canonical-reference");
  assert.equal(otherPath.values.images, true);
  assert.equal(
    referenceMetadata("https://arbitrary-relay.invalid", "nonexistent-model"),
    undefined,
  );
});

test("incomplete core catalog entries are not marked usable", async () => {
  const store = new CatalogStore();
  const incomplete = { ...original } as Record<string, unknown>;
  delete incomplete.truncation_policy;
  await store.load("/fixture/models.json", [], async () =>
    JSON.stringify({ models: [incomplete] }),
  );
  assert.equal(store.summary().status, "invalid");
});

test("configured relative catalog resolves against CODEX_HOME, not plugin cwd, without writes", async () => {
  const home = await mkdtemp(resolve(".test-artifacts/relative-catalog-home-"));
  try {
    const config = 'model_catalog_json="models.json"\n';
    const catalog = JSON.stringify({ models: [original] });
    await writeFile(join(home, "config.toml"), config);
    await writeFile(join(home, "models.json"), catalog);
    const source = new FileConfigSource(home);
    assert.equal(
      source.resolveCatalogPath("models.json"),
      join(home, "models.json"),
    );
    assert.equal(source.resolveCatalogPath(""), "");
    const manager = new ConnectionManager(undefined, source);
    const snapshot = await manager.loadSync(manager.reference());
    assert.equal(snapshot.localCatalog?.status, "ready");
    assert.equal(snapshot.localCatalog?.models.length, 1);
    assert.equal(snapshot.localCatalog?.path, join(home, "models.json"));
    const json = manager.previewCatalog(
      manager.reference(),
      [{ key: "local-model", parameters: params }],
      new Set(["local-model"]),
    );
    assert.equal(JSON.parse(json).models.length, 1);
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), config);
    assert.equal(await readFile(join(home, "models.json"), "utf8"), catalog);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("direct status masks old results for queued/running models, then uses new results", () => {
  const passed = outcome("ok");
  const job: Job = {
    jobId: "fixture",
    requestId: "fixture",
    status: "queued",
    protocol: "responses",
    modelIds: ["a", "b"],
    currentModel: null,
    results: [],
    startedAt: null,
    endedAt: null,
  };
  assert.equal(directStatus("a", passed, job).label, "测试中...");
  assert.equal(
    directStatus("b", null, { ...job, status: "running" }).label,
    "测试中...",
  );
  assert.equal(directStatus("not-in-job", passed, job).label, "通过");
  assert.equal(
    directStatus("a", passed, {
      ...job,
      results: [{ modelId: "a", result: passed }],
    }).label,
    "通过",
  );
  assert.equal(directStatus("a", outcome("quota")).label, "无法确认");
  assert.equal(directStatus("a", outcome("non_streaming")).label, "不满足直连");
  assert.equal(
    directStatus("a", null, { ...job, status: "cancelled" }).label,
    "未检测",
  );
});

test("context increments use fixed K/M steps, preserve exact values and clamp bounds", () => {
  assert.equal(adjustContextWindow(128000, 1, 16000), 144000);
  assert.equal(adjustContextWindow(144000, -1, 16000), 128000);
  assert.equal(adjustContextWindow(32768, 1, 64000), 96768);
  assert.equal(adjustContextWindow(1000000, 1, 1000000), 2000000);
  assert.equal(adjustContextWindow(9999999, 1, 16000), 10000000);
  assert.equal(adjustContextWindow(1024, -1, 16000), 1024);
  assert.equal(adjustContextWindow(null, 1, 16000), 128000);
});

test("preview supports 7, 61 and 1000 known models; unknown seventh and duplicates are actionable", () => {
  const store = new CatalogStore();
  for (const count of [7, 61, 1000]) {
    const rows = Array.from({ length: count }, (_, i) => ({
      key: `model-${i}`,
      parameters: { ...params, requestModel: `model-${i}` },
    }));
    assert.deepEqual(previewIssues(rows), []);
    const allowed = new Set(rows.map((r) => r.key));
    assert.equal(
      JSON.parse(store.preview(rows, allowed, [])).models.length,
      count,
    );
    const unknown = rows.map((r, i) =>
      i === 6
        ? {
            ...r,
            parameters: { ...r.parameters, images: null, contextWindow: null },
          }
        : r,
    );
    assert.deepEqual(previewIssues(unknown), [
      {
        key: "model-6",
        label: params.displayName,
        issue: "上下文窗口未知；图片支持未知",
      },
    ]);
    assert.throws(
      () => store.preview(unknown, allowed, []),
      fails("unknown_metadata"),
    );
  }
  assert.equal(
    previewIssues([
      { key: "a", parameters: params },
      { key: "b", parameters: params },
    ]).length,
    2,
  );
});

test("confirmed order rewrites all priorities and preserves original fields without modifying loaded catalog", async () => {
  const store = new CatalogStore();
  const raw = {
    models: [
      { ...original, priority: 90 },
      { ...original, slug: "other", display_name: "Other", priority: -8 },
    ],
    custom_top: "keep",
  };
  await store.load("/fixture/models.json", [], async () => JSON.stringify(raw));
  const rows = [
    {
      key: "other",
      parameters: { ...params, requestModel: "other", displayName: "Other" },
    },
    { key: "local-model", parameters: params },
    { key: "new", parameters: { ...params, requestModel: "new" } },
  ];
  const data = JSON.parse(
    store.preview(rows, new Set(["local-model", "other", "new"]), []),
  );
  assert.deepEqual(
    data.models.map((m: any) => m.slug),
    ["other", "local-model", "new"],
  );
  assert.deepEqual(
    data.models.map((m: any) => m.priority),
    [0, 1, 2],
  );
  assert.deepEqual(data.models[1].model_messages, original.model_messages);
  assert.deepEqual(data.models[1].custom_extra, original.custom_extra);
  assert.equal(data.custom_top, "keep");
  assert.deepEqual(
    store.summary().models.map((m) => m.key),
    ["local-model", "other"],
  );
  const again = JSON.parse(
    store.preview(
      [...rows].reverse(),
      new Set(["local-model", "other", "new"]),
      [],
    ),
  );
  assert.deepEqual(
    again.models.map((m: any) => m.slug),
    ["new", "local-model", "other"],
  );
  assert.deepEqual(
    raw.models.map((m) => m.priority),
    [90, -8],
  );
});
