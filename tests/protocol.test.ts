import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  publicChallengeSchema,
  referenceOf,
  SELF_TEST_TOKEN,
  snapshotSchema,
  UI_URI,
  VERSION,
} from "../src/shared/security.js";
import { encryptSecret } from "../src/ui/encrypt.js";

const plugin = resolve("dist/marketplace/plugins/codex-model-kit");
async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      resolve("tests/deny-io.mjs"),
      resolve(plugin, "server.mjs"),
    ],
    cwd: "/", // Not the repository cwd. Relative assets must still work.
    env: {
      PATH: process.env.PATH ?? "",
      CODEX_HOME: resolve(".test-artifacts/never-read-home"),
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "M0-offline-fixture", version: "1.0.0" },
    {},
  );
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}
function structured(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && "structuredContent" in value);
  return value.structuredContent as Record<string, unknown>;
}

test("bundled STDIO negotiates protocol, metadata, readonly snapshot and ciphertext round trip", async () => {
  assert.equal(
    UI_URI,
    `ui://codex-model-kit/main-catalog-sync-v${VERSION}.html`,
  );
  const { client, stderr } = await connect();
  try {
    assert.equal(client.getServerVersion()?.name, "codex-model-kit");
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 20);
    const open = tools.tools.find((tool) => tool.name === "open_model_kit")!;
    assert.deepEqual(open._meta?.ui, {
      resourceUri: UI_URI,
      visibility: ["model", "app"],
    });
    assert.deepEqual(
      (open._meta?.["openai/ui"] as { entrypoints: unknown }).entrypoints,
      [{ type: "global" }, { type: "thread" }],
    );
    for (const name of [
      "get_self_test_key",
      "submit_self_test_envelope",
      "reset_self_test_connection",
      "reload_config",
      "select_connection",
      "get_credential_key",
      "complete_connection",
    ]) {
      const tool = tools.tools.find((value) => value.name === name)!;
      assert.deepEqual(tool._meta?.ui, {
        resourceUri: UI_URI,
        visibility: ["app"],
      });
    }
    const opened = await client.callTool({
      name: "open_model_kit",
      arguments: {},
    });
    const snapshot = snapshotSchema.parse(structured(opened).snapshot);
    assert.equal(snapshot.selfTestCount, 0);
    const keyResult = await client.callTool({
      name: "get_self_test_key",
      arguments: referenceOf(snapshot),
    });
    const challenge = publicChallengeSchema.parse(
      structured(keyResult).challenge,
    );
    const envelope = await encryptSecret(challenge, SELF_TEST_TOKEN);
    const result = await client.callTool({
      name: "submit_self_test_envelope",
      arguments: envelope,
    });
    assert.equal(
      snapshotSchema.parse(structured(result).snapshot).selfTestCount,
      1,
    );
    const reread = await client.callTool({
      name: "read_snapshot",
      arguments: {},
    });
    assert.equal(
      snapshotSchema.parse(structured(reread).snapshot).selfTestCount,
      1,
    );
    const replay = await client.callTool({
      name: "submit_self_test_envelope",
      arguments: envelope,
    });
    assert.equal((replay as { isError: boolean }).isError, true);
    assert.equal(
      (structured(replay).error as { category: string }).category,
      "expired_or_replayed",
    );
    // Actual MCP tool arguments/results—not merely a direct crypto call.
    for (const data of [
      tools,
      opened,
      keyResult,
      envelope,
      result,
      reread,
      replay,
      stderr(),
    ]) {
      assert(!JSON.stringify(data).includes(SELF_TEST_TOKEN));
    }
    const resources = await client.listResources();
    assert.equal(resources.resources[0]?.mimeType, "text/html;profile=mcp-app");
    const resource = await client.readResource({ uri: UI_URI });
    const content = resource.contents[0]!;
    assert("text" in content && content.text.includes('<div id="root"></div>'));
    assert.deepEqual((content._meta?.ui as { csp: unknown }).csp, {
      connectDomains: [],
      resourceDomains: [],
    });
    // The child denied config/auth reads, writes and network; operations still succeeded.
    assert.equal(stderr(), "");
  } finally {
    await client.close();
  }
});

test("two actual server processes do not share instance IDs, state or challenges", async () => {
  const first = await connect();
  const second = await connect();
  try {
    const a = snapshotSchema.parse(
      structured(
        await first.client.callTool({ name: "read_snapshot", arguments: {} }),
      ).snapshot,
    );
    const b = snapshotSchema.parse(
      structured(
        await second.client.callTool({ name: "read_snapshot", arguments: {} }),
      ).snapshot,
    );
    assert.notEqual(a.instanceId, b.instanceId);
    assert.notEqual(a.connectionId, b.connectionId);
    const challenge = publicChallengeSchema.parse(
      structured(
        await first.client.callTool({
          name: "get_self_test_key",
          arguments: referenceOf(a),
        }),
      ).challenge,
    );
    const envelope = await encryptSecret(challenge, SELF_TEST_TOKEN);
    const rejected = await second.client.callTool({
      name: "submit_self_test_envelope",
      arguments: envelope,
    });
    assert.equal(
      (structured(rejected).error as { category: string }).category,
      "stale_reference",
    );
    await first.client.callTool({
      name: "submit_self_test_envelope",
      arguments: envelope,
    });
    const stillB = snapshotSchema.parse(
      structured(
        await second.client.callTool({ name: "read_snapshot", arguments: {} }),
      ).snapshot,
    );
    assert.equal(stillB.selfTestCount, 0);
    const reset = snapshotSchema.parse(
      structured(
        await first.client.callTool({
          name: "reset_self_test_connection",
          arguments: referenceOf(a),
        }),
      ).snapshot,
    );
    assert.equal(reset.connectionRevision, a.connectionRevision + 1);
    const oldRef = await first.client.callTool({
      name: "get_self_test_key",
      arguments: referenceOf(a),
    });
    assert.equal(
      (structured(oldRef).error as { category: string }).category,
      "stale_reference",
    );
    assert.equal(first.stderr(), "");
    assert.equal(second.stderr(), "");
  } finally {
    await Promise.all([first.client.close(), second.client.close()]);
  }
});

test("schema and bundle keep writes app-only and never expose plaintext credentials", async () => {
  const { client } = await connect();
  try {
    const tools = await client.listTools();
    assert(!tools.tools.some((tool) => /export|token/i.test(tool.name)));
    for (const name of [
      "load_sync",
      "preview_catalog",
      "prepare_catalog_write",
      "commit_catalog_write",
      "prepare_catalog_restore",
      "refresh_models",
      "cancel_models",
      "add_manual_model",
      "prepare_probe",
      "start_probe",
      "cancel_probe",
    ]) {
      const tool = tools.tools.find((value) => value.name === name)!;
      assert.deepEqual(tool._meta?.ui, {
        resourceUri: UI_URI,
        visibility: ["app"],
      });
      assert.equal(
        tool.annotations?.openWorldHint,
        ["refresh_models", "start_probe"].includes(name),
      );
    }
    const completion = tools.tools.find(
      (tool) => tool.name === "complete_connection",
    )!;
    assert(
      !Object.keys(completion.inputSchema.properties as object).includes(
        "token",
      ),
    );
    assert.equal(completion.inputSchema.additionalProperties, false);
    const submit = tools.tools.find(
      (tool) => tool.name === "submit_self_test_envelope",
    )!;
    assert(!JSON.stringify(submit.inputSchema).includes('"token"'));
    assert.equal(submit.inputSchema.additionalProperties, false);
    const meta = JSON.parse(await readFile("dist/build-meta.json", "utf8"));
    assert.equal(meta.uiImports.length, 0);
    assert(
      meta.serverImports.every(
        (item: { path: string; external: boolean }) =>
          item.external && item.path.startsWith("node:"),
      ),
    );
  } finally {
    await client.close();
  }
});
