import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "smol-toml";
import { SecuritySession, SafeError } from "../src/connections/envelopes.js";
import {
  acceptSnapshot,
  envelopeSchema,
  referenceOf,
  SELF_TEST_TOKEN,
} from "../src/shared/security.js";
import { ModelKitApp } from "../src/ui/App.js";
import { encryptSecret } from "../src/ui/encrypt.js";

const session = new SecuritySession();
const another = new SecuritySession();
function challenge() {
  return session.issueChallenge(referenceOf(session.snapshot()));
}
function fails(code: string) {
  return (error: unknown) => error instanceof SafeError && error.code === code;
}

test("browser encryption helper runs on Node Web Crypto; no plaintext envelope fields", async () => {
  const envelope = await encryptSecret(challenge(), SELF_TEST_TOKEN);
  assert(!JSON.stringify(envelope).includes(SELF_TEST_TOKEN));
  assert(envelopeSchema.safeParse(envelope).success);
  const snapshot = session.runSelfTest(envelope);
  assert.equal(snapshot.selfTestCount, 1);
  assert.equal(snapshot.realCredentialsEnabled, false);
  assert.equal(snapshot.networkRequestsEnabled, false);
  assert(!JSON.stringify(snapshot).includes(SELF_TEST_TOKEN));
});
test("already-consumed nonce rejects replay", async () => {
  const envelope = await encryptSecret(challenge(), SELF_TEST_TOKEN);
  session.runSelfTest(envelope);
  assert.throws(
    () => session.runSelfTest(envelope),
    fails("expired_or_replayed"),
  );
});
test("cross-instance reference rejected; other instance has isolated state", async () => {
  const envelope = await encryptSecret(challenge(), SELF_TEST_TOKEN);
  assert.throws(() => another.runSelfTest(envelope), fails("stale_reference"));
  assert.equal(another.snapshot().selfTestCount, 0);
  assert.notEqual(another.instanceId, session.instanceId);
});
test("stale connection revision rejected, new challenge succeeds", async () => {
  const ref = referenceOf(session.snapshot());
  const envelope = await encryptSecret(
    session.issueChallenge(ref),
    SELF_TEST_TOKEN,
  );
  const next = session.reset(ref);
  assert.equal(next.connectionRevision, ref.connectionRevision + 1);
  assert.equal(next.selfTestCount, 0);
  assert.throws(() => session.runSelfTest(envelope), fails("stale_reference"));
  session.runSelfTest(await encryptSecret(challenge(), SELF_TEST_TOKEN));
});
test("expiry boundary is enforced by backend, not browser clock", async () => {
  let time = 1_790_749_200_000;
  const expiring = new SecuritySession(() => time);
  const envelope = await encryptSecret(
    expiring.issueChallenge(referenceOf(expiring.snapshot())),
    SELF_TEST_TOKEN,
  );
  time += 60_000;
  assert.throws(
    () => expiring.runSelfTest(envelope),
    fails("expired_or_replayed"),
  );
});
test("AAD expiry tampering rejected and consumes nonce", async () => {
  const envelope = await encryptSecret(challenge(), SELF_TEST_TOKEN);
  const changed = {
    ...envelope,
    binding: { ...envelope.binding, expiresAt: envelope.binding.expiresAt + 1 },
  };
  assert.throws(() => session.runSelfTest(changed), fails("invalid_envelope"));
  assert.throws(
    () => session.runSelfTest(envelope),
    fails("expired_or_replayed"),
  );
});
test("ciphertext authentication catches tampering without echoing decrypted content", async () => {
  const envelope = await encryptSecret(challenge(), SELF_TEST_TOKEN);
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] = bytes[0]! ^ 1;
  assert.throws(
    () =>
      session.runSelfTest({
        ...envelope,
        ciphertext: bytes.toString("base64"),
      }),
    fails("invalid_envelope"),
  );
});
test("M0 tool path accepts only fixed fictitious data, not arbitrary credentials", async () => {
  const envelope = await encryptSecret(
    challenge(),
    "FAKE-BUT-NOT-THE-SELF-TEST-SENTINEL",
  );
  assert.throws(() => session.runSelfTest(envelope), fails("self_test_only"));
});
test("hybrid encryption supports long UTF-8 token beyond RSA direct capacity", async () => {
  const text = "虚构字符-test-".repeat(700);
  const envelope = await encryptSecret(challenge(), text);
  assert.equal(session.decryptEnvelope(envelope), text);
});
test("oversized or empty plaintext rejected before tool call", async () => {
  const current = challenge();
  await assert.rejects(
    encryptSecret(current, "x".repeat(16385)),
    /Invalid secret size/,
  );
  await assert.rejects(encryptSecret(current, ""), /Invalid secret size/);
});
test("missing Web Crypto is a hard failure, no plaintext fallback", async () => {
  await assert.rejects(
    encryptSecret(challenge(), SELF_TEST_TOKEN, {} as Crypto),
    /Web Crypto unavailable/,
  );
});
test("schema rejects wrong purpose, excess properties, malformed base64, huge ciphertext", async () => {
  const envelope = await encryptSecret(challenge(), SELF_TEST_TOKEN);
  for (const input of [
    { ...envelope, token: SELF_TEST_TOKEN },
    { ...envelope, binding: { ...envelope.binding, purpose: "real-secret" } },
    { ...envelope, ciphertext: "!@#$" },
    { ...envelope, ciphertext: "A".repeat(24004) },
  ])
    assert(!envelopeSchema.safeParse(input).success);
});
test("invalid RSA wrap, IV length and tiny ciphertext return safe errors", async () => {
  for (const patch of [
    { wrappedKey: Buffer.alloc(10).toString("base64") },
    { iv: Buffer.alloc(9).toString("base64") },
    { ciphertext: Buffer.alloc(16).toString("base64") },
  ]) {
    const envelope = await encryptSecret(challenge(), SELF_TEST_TOKEN);
    assert.throws(
      () => session.runSelfTest({ ...envelope, ...patch }),
      fails("invalid_envelope"),
    );
  }
});
test("outstanding challenges have a bounded count; ninth evicts oldest", async () => {
  const first = challenge();
  for (let index = 0; index < 8; index++) challenge();
  const envelope = await encryptSecret(first, SELF_TEST_TOKEN);
  assert.throws(
    () => session.runSelfTest(envelope),
    fails("expired_or_replayed"),
  );
});
test("different connection ID is rejected", () => {
  assert.throws(
    () =>
      session.issueChallenge({
        ...referenceOf(session.snapshot()),
        connectionId: another.connectionId,
      }),
    fails("stale_reference"),
  );
});
test("UI rejects older revision/sequence and unsolicited different instance", () => {
  const current = session.snapshot();
  assert(acceptSnapshot(null, current));
  assert(
    acceptSnapshot(current, { ...current, sequence: current.sequence + 1 }),
  );
  assert(
    !acceptSnapshot(current, { ...current, sequence: current.sequence - 1 }),
  );
  assert(
    !acceptSnapshot(current, {
      ...current,
      connectionRevision: current.connectionRevision - 1,
      sequence: 9999,
    }),
  );
  assert(!acceptSnapshot(current, another.snapshot()));
});
test("sample TOML parses with maintained parser; providers remain distinct", async () => {
  const config = parse(
    await readFile(
      new URL("./fixtures/config.example.toml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(config.model_provider, "example");
  const providers = config.model_providers as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(providers.example?.wire_api, "responses");
  assert.equal(providers.other?.experimental_bearer_token, undefined);
});
test("React readonly workbench initial markup is accessible, disabled before connection, and has no writer", () => {
  const html = renderToStaticMarkup(createElement(ModelKitApp));
  assert(html.includes('role="status"'));
  assert(html.includes("模型列表同步"));
  assert(html.includes("模型列表"));
  assert(html.includes("刷新供应商模型"));
  assert(html.includes('aria-label="使用说明"'));
  assert(html.includes('aria-label="选择全部筛选模型"'));
  assert(!html.includes("退出全屏"));
  assert(!html.includes("导出目录</button>"));
  assert(!html.includes("写入配置</button>"));
});
