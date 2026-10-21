// Development-only fixture. Never uses a real Codex home, token or relay.
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
export const fixtureSecret = "FAKE-LOOPBACK-SECRET-NEVER-REAL";
export const fixtureModels = [
  "Fixture-Pass",
  "Fixture-Quota",
  "Fixture-FakeStream",
  "Fixture-Cut",
  "Fixture-Slow",
  "<b>literal-id</b>",
  "__proto__",
  "constructor",
  ...Array.from(
    { length: 61 },
    (_, i) => `model-${String(i).padStart(2, "0")}`,
  ),
];
export async function loopbackFixture(
  extraRoute?: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  options: {
    unknownModels?: string[];
    probeDelayMs?: number;
    delayedModel?: string;
    credentialMode?: "env" | "missing_env";
    modelsStatus?: () => number;
    modelsDelayMs?: number;
  } = {},
) {
  const records: { method: string; path: string; model?: string }[] = [],
    toolRecords: unknown[] = [];
  let client: Client;
  let origin = "";
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      res.writeHead(500);
      res.end("Fixture error");
    });
  });
  async function handler(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url!, origin).pathname;
    if (path === "/tool" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) throw new Error("limit");
      }
      const input = JSON.parse(body);
      toolRecords.push(input);
      const result = await client.callTool(input);
      toolRecords.push(result);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    if (path.startsWith("/relay/")) {
      assert.equal(req.headers.authorization, `Bearer ${fixtureSecret}`);
      assert(path === "/relay/v1/models" || path === "/relay/v1/responses");
      if (path.endsWith("/models")) {
        assert.equal(req.method, "GET");
        records.push({ method: "GET", path });
        if (options.modelsDelayMs)
          await new Promise((r) => setTimeout(r, options.modelsDelayMs));
        const status = options.modelsStatus?.() ?? 200;
        if (status !== 200) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: fixtureSecret } }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: fixtureModels.map((id) => ({
              id,
              owned_by: "fixture",
              supports_streaming: true,
              ...(options.unknownModels?.includes(id)
                ? {}
                : {
                    context_window: 128000,
                    input_modalities: ["text", "image"],
                    supported_reasoning_levels: [
                      { effort: "low" },
                      { effort: "medium" },
                      { effort: "high" },
                    ],
                  }),
            })),
            has_more: false,
          }),
        );
        return;
      }
      assert.equal(req.method, "POST");
      let data = "";
      for await (const chunk of req) data += chunk;
      const body = JSON.parse(data);
      assert.deepEqual(Object.keys(body).sort(), [
        "input",
        "max_output_tokens",
        "model",
        "store",
        "stream",
      ]);
      assert.equal(body.input, "Reply with OK.");
      assert.equal(body.max_output_tokens, 64);
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      records.push({ method: "POST", path, model: body.model });
      if (
        options.probeDelayMs &&
        (!options.delayedModel || body.model === options.delayedModel)
      )
        await new Promise((r) => setTimeout(r, options.probeDelayMs));
      if (body.model === "Fixture-Quota") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "insufficient_quota", message: fixtureSecret },
          }),
        );
        return;
      }
      if (body.model === "Fixture-FakeStream") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            object: "response",
            status: "completed",
            output: [],
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: object) =>
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({
        type: "response.created",
        response: { id: "resp_fixture", status: "in_progress" },
      });
      if (body.model === "Fixture-Slow") {
        res.flushHeaders();
        return;
      }
      send({
        type: "response.output_text.delta",
        item_id: "msg_fixture",
        output_index: 0,
        content_index: 0,
        delta: "fixture output",
      });
      if (body.model === "Fixture-Cut") {
        res.end();
        return;
      }
      send({
        type: "response.completed",
        response: { id: "resp_fixture", status: "completed", output: [] },
      });
      res.end();
      return;
    }
    if (extraRoute) {
      await extraRoute(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  const home = await mkdtemp(resolve(".test-artifacts/loopback-home-"));
  const catalogPath = join(home, "models.json");
  const localModel = (slug: string, display_name: string) => ({
    slug,
    display_name,
    context_window: 64000,
    max_context_window: 128000,
    default_reasoning_level: "low",
    supported_reasoning_levels: [{ effort: "low", description: "Local low" }],
    input_modalities: ["text"],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    custom_local: "preserve this",
    model_messages: { instructions_template: "Keep my local instructions" },
  });
  const catalog = JSON.stringify({
    models: [
      localModel("Fixture-Pass", "Local Pass Alias"),
      localModel("Local-Missing", "Local Missing"),
    ],
    custom_top: "preserve top",
  });
  await writeFile(catalogPath, catalog);
  const credentialConfig = options.credentialMode
    ? 'env_key="KIT_FIXTURE_KEY"'
    : `experimental_bearer_token="${fixtureSecret}"`;
  const config = `model_catalog_json="models.json"\nmodel_provider="fixture"\n[model_providers.fixture]\nbase_url="${origin}/relay/v1"\n${credentialConfig}\n`;
  await writeFile(join(home, "config.toml"), config);
  await writeFile(join(home, "auth.json"), fixtureSecret);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(resolve("tests/workbench-io.mjs")).href,
      resolve("dist/marketplace/plugins/codex-model-kit/server.mjs"),
    ],
    cwd: "/",
    env: {
      PATH: process.env.PATH ?? "",
      CODEX_HOME: home,
      MODEL_KIT_TEST_ORIGIN: origin,
      ...(options.credentialMode === "env"
        ? { KIT_FIXTURE_KEY: fixtureSecret }
        : {}),
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data) => (stderr += data.toString()));
  client = new Client(
    { name: "readonly-loopback-fixture", version: "1.0.0" },
    {},
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    server.closeAllConnections();
    server.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const input = { name, arguments: args };
    toolRecords.push(input);
    const result = await client.callTool(input);
    toolRecords.push(result);
    return result.structuredContent as Record<string, unknown>;
  }
  async function close() {
    try {
      assert.equal(await readFile(join(home, "config.toml"), "utf8"), config);
      assert.equal(await readFile(catalogPath, "utf8"), catalog);
      assert.equal(
        await readFile(join(home, "auth.json"), "utf8"),
        fixtureSecret,
      );
      assert(!JSON.stringify(toolRecords).includes(fixtureSecret));
      assert(!stderr.includes(fixtureSecret));
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(home, { recursive: true, force: true });
    }
  }
  return {
    client,
    origin,
    records,
    toolRecords,
    home,
    catalogPath,
    catalog,
    config,
    call,
    close,
  };
}
