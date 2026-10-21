import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  publicChallengeSchema,
  referenceOf,
  snapshotSchema,
} from "../src/shared/security.js";
import { encryptSecret } from "../src/ui/encrypt.js";

const secret = "FAKE-STDIO-M1-SECRET-NOT-A-CREDENTIAL";
const plugin = resolve("dist/marketplace/plugins/codex-model-kit");
function structured(result: unknown): Record<string, unknown> {
  assert(result && typeof result === "object" && "structuredContent" in result);
  return result.structuredContent as Record<string, unknown>;
}
test("bundled M1 reads fixture only on click, submits missing encrypted credential and never reads auth/writes/uses network", async () => {
  const root = await mkdtemp(resolve(".test-artifacts/m1-protocol-"));
  const config =
    'model_provider="fixture"\n[model_providers.fixture]\nbase_url="https://fixture.test/custom/v1"\n';
  await writeFile(join(root, "config.toml"), config);
  await writeFile(join(root, "auth.json"), secret);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      resolve("tests/m1-io.mjs"),
      resolve(plugin, "server.mjs"),
    ],
    cwd: "/",
    env: { PATH: process.env.PATH ?? "", CODEX_HOME: root },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const client = new Client(
    { name: "M1-isolated-fixture", version: "1.0.0" },
    {},
  );
  const records: unknown[] = [];
  async function call(name: string, args: Record<string, unknown> = {}) {
    records.push(args);
    const result = await client.callTool({ name, arguments: args });
    records.push(result);
    return structured(result);
  }
  try {
    await client.connect(transport);
    const opened = snapshotSchema.parse(
      (await call("open_model_kit")).snapshot,
    );
    assert.equal(opened.stage, "readonly");
    assert.equal(opened.config!.status, "not_loaded");
    assert.equal(opened.networkRequestsEnabled, true);
    const loaded = snapshotSchema.parse(
      (await call("reload_config", referenceOf(opened))).snapshot,
    );
    assert.equal(loaded.config!.status, "loaded");
    assert.equal(loaded.connection!.addressPresent, false); // Discovery is not selection.
    const candidateId = loaded.config!.candidates[0]!.candidateId;
    const selected = snapshotSchema.parse(
      (
        await call("select_connection", {
          ...referenceOf(loaded),
          candidateId,
          allowHttp: false,
        })
      ).snapshot,
    );
    assert(
      selected.connection!.addressPresent &&
        !selected.connection!.credentialPresent,
    );
    const challenge = publicChallengeSchema.parse(
      (await call("get_credential_key", referenceOf(selected))).challenge,
    );
    assert.equal(challenge.binding.purpose, "connection-credential");
    const envelope = await encryptSecret(challenge, secret);
    const completed = snapshotSchema.parse(
      (
        await call("complete_connection", {
          ...referenceOf(selected),
          envelope,
          allowHttp: false,
        })
      ).snapshot,
    );
    assert(completed.connection!.ready);
    assert.equal(completed.connection!.credentialSource, "session");
    const reread = snapshotSchema.parse((await call("read_snapshot")).snapshot);
    assert.equal(reread.connectionRevision, completed.connectionRevision);
    assert(reread.connection!.ready);
    const stale = await call("get_credential_key", referenceOf(selected));
    assert.equal(
      (stale.error as { category: string }).category,
      "stale_reference",
    );
    const manual = snapshotSchema.parse(
      (
        await call("select_connection", {
          ...referenceOf(completed),
          candidateId: null,
          allowHttp: false,
        })
      ).snapshot,
    );
    assert(!manual.connection!.credentialPresent);
    const replay = await call("complete_connection", {
      ...referenceOf(manual),
      envelope,
      allowHttp: false,
    });
    assert.equal(
      (replay.error as { category: string }).category,
      "stale_reference",
    );
    assert(!JSON.stringify(records).includes(secret));
    assert(!stderr.includes(secret));
    assert.equal(stderr, "");
    assert.equal(await readFile(join(root, "config.toml"), "utf8"), config);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
