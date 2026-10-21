import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert(
  Number(process.versions.node.split(".")[0]) >= 24,
  "Node >=24 is required",
);
const meta = JSON.parse(
  await readFile(resolve(root, "dist/build-meta.json"), "utf8"),
);
assert(meta.nodeRuntimeIncluded === false);
assert.deepEqual(meta.uiImports, [], "UI must not require external imports");
assert(
  meta.serverImports.every(
    (item) => item.external && item.path.startsWith("node:"),
  ),
  "Server must only import Node built-ins",
);
const plugin = resolve(root, "dist/marketplace/plugins/codex-model-kit");
const manifest = JSON.parse(
  await readFile(resolve(plugin, ".codex-plugin/plugin.json"), "utf8"),
);
assert.equal(manifest.version, meta.version);
const marketplace = JSON.parse(
  await readFile(
    resolve(root, "dist/marketplace/.claude-plugin/marketplace.json"),
    "utf8",
  ),
);
assert.equal(marketplace.plugins[0].version, meta.version);
const mcp = JSON.parse(await readFile(resolve(plugin, ".mcp.json"), "utf8"));
assert.equal(mcp.mcpServers["codex-model-kit"].cwd, ".");
assert.equal(mcp.mcpServers["codex-model-kit"].command, "node");
assert.deepEqual(mcp.mcpServers["codex-model-kit"].args, ["./server.mjs"]);
const html = await readFile(resolve(plugin, "main.html"), "utf8");
assert(
  !/<script[^>]+src=|<link[^>]+href=/i.test(html),
  "UI must be self-contained",
);
assert(
  !html.includes("/Users/liqing/") && !html.includes("/Volumes/myssd/"),
  "UI cannot contain developer paths",
);
const server = await readFile(resolve(plugin, "server.mjs"), "utf8");
assert(
  !server.includes("/Users/liqing/") && !server.includes("/Volumes/myssd/"),
  "Server cannot contain developer paths",
);
assert(!(await readdir(plugin)).includes("node_modules"));
console.log(
  `Preflight passed: ${meta.version}, bundled JS/CSS, no developer paths, no node_modules needed.`,
);
