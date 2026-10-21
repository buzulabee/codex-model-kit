import assert from "node:assert/strict";
import { test } from "node:test";
import { maskCredential } from "../src/config/url.js";
import {
  parseContextWindow,
  contextInputValue,
  adjustContextWindow,
  reconcileModelOrder,
  moveModelOrder,
} from "../src/catalog/parameters.js";
import { ConnectionManager } from "../src/connections/manager.js";
import { referenceOf, snapshotSchema } from "../src/shared/security.js";
import type { ConfigSource } from "../src/config/discovery.js";

test("credential fingerprint exposes only authorized bounded fragments", () => {
  assert.equal(maskCredential(null), null);
  assert.equal(maskCredential(""), null);
  assert.equal(maskCredential("short-key"), "***");
  assert.equal(maskCredential("unsafe@credential-key"), "***");
  assert.equal(maskCredential("密钥-long-credential-value"), "***");
  assert.equal(maskCredential("abc-very-long-secret-xyz"), "abc***xyz");
});
test("fingerprint follows selected connection and clears on reset/reload", async () => {
  const keys = ["abc-very-long-secret-xyz", "def-another-long-key-uvw"];
  const source: ConfigSource = {
    homeSource: "CODEX_HOME",
    read: async () =>
      `model_provider="a"\n[model_providers.a]\nbase_url="https://a.test/v1"\nexperimental_bearer_token="${keys[0]}"\n[model_providers.b]\nbase_url="https://b.test/v1"\nexperimental_bearer_token="${keys[1]}"`,
    profileNames: async () => ({ names: [], limited: false }),
  };
  const manager = new ConnectionManager(undefined, source);
  await manager.reload(referenceOf(manager.snapshot()));
  const candidates = manager.snapshot().config!.candidates;
  assert.deepEqual(candidates.map((c) => c.credentialHint).sort(), [
    "abc***xyz",
    "def***uvw",
  ]);
  for (const c of candidates) {
    manager.select(referenceOf(manager.snapshot()), c.candidateId, false);
    assert.equal(
      manager.snapshot().connection?.credentialHint,
      c.credentialHint,
    );
    assert(!JSON.stringify(manager.snapshot()).includes(keys[0]!));
    assert(!JSON.stringify(manager.snapshot()).includes(keys[1]!));
  }
  manager.reset(referenceOf(manager.snapshot()));
  assert.equal(manager.snapshot().connection?.credentialHint, null);
  assert(snapshotSchema.safeParse(manager.snapshot()).success);
  const unsafe = structuredClone(manager.snapshot());
  unsafe.connection!.credentialHint = keys[0];
  assert.equal(snapshotSchema.safeParse(unsafe).success, false);
  await manager.reload(referenceOf(manager.snapshot()));
  assert.equal(manager.snapshot().connection?.credentialHint, null);
});
test("context text accepts decimal K/M and preserves exact imported tokens", () => {
  for (const [text, n] of [
    ["128K", 128000],
    ["1M", 1000000],
    ["1.024k", 1024],
    ["200001", 200001],
    [" 10m ", 10000000],
  ] as const)
    assert.equal(parseContextWindow(text), n);
  assert.equal(parseContextWindow(" "), null);
  for (const text of [
    "1K",
    "11M",
    "1.0241K",
    "-128K",
    "1e6",
    "NaN",
    "10000001",
    "abc",
  ])
    assert.equal(parseContextWindow(text), undefined);
  for (const n of [null, 1024, 128000, 1000000, 200001, 10000000])
    assert.equal(parseContextWindow(contextInputValue(n)), n);
  assert.equal(adjustContextWindow(200001, 1, 16000), 216001);
  assert.equal(adjustContextWindow(null, 1, 16000), 128000);
});

test("model ordering reconciles selection changes and moves immutably including unusual keys", () => {
  const order = ["a", "__proto__", "b", "constructor"];
  assert.deepEqual(moveModelOrder(order, "b", 0), [
    "b",
    "a",
    "__proto__",
    "constructor",
  ]);
  assert.deepEqual(moveModelOrder(order, "a", 3), [
    "__proto__",
    "b",
    "constructor",
    "a",
  ]);
  assert.deepEqual(moveModelOrder(order, "__proto__", 2), [
    "a",
    "b",
    "__proto__",
    "constructor",
  ]);
  assert.deepEqual(moveModelOrder(order, "b", 1), [
    "a",
    "b",
    "__proto__",
    "constructor",
  ]);
  for (const target of [-1, 4, NaN, 1.5])
    assert.deepEqual(moveModelOrder(order, "a", target), order);
  assert.deepEqual(moveModelOrder(order, "missing", 0), order);
  assert.deepEqual(order, ["a", "__proto__", "b", "constructor"]);
  assert.deepEqual(
    reconcileModelOrder(
      ["b", "a", "removed", "b"],
      ["a", "b", "new", "__proto__"],
    ),
    ["b", "a", "new", "__proto__"],
  );
  const many = Array.from({ length: 1000 }, (_, i) => `model-${i}`);
  assert.equal(moveModelOrder(many, "model-999", 0)[0], "model-999");
  assert.equal(reconcileModelOrder(many, many).length, 1000);
});
