import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "smol-toml";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = resolve(root, ".test-artifacts");
await mkdir(base, { recursive: true });
const sandbox = await mkdtemp(resolve(base, "install-"));
const home = resolve(sandbox, "home with spaces");
const source = resolve(sandbox, "marketplace");
await mkdir(home);
await cp(resolve(root, "dist/marketplace"), source, { recursive: true });
const env = { ...process.env, CODEX_HOME: home };
function cli(args) {
  const result = spawnSync("codex", ["plugin", ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0)
    throw new Error(
      `Isolated codex plugin command failed (${args[0]} ${args[1] ?? ""})`,
    );
  return result.stdout;
}
try {
  const added = cli(["marketplace", "add", source, "--json"]);
  assert(added.includes("codex-model-kit"));
  const installed = cli(["add", "codex-model-kit@codex-model-kit", "--json"]);
  assert(installed.includes("codex-model-kit"));
  const list = cli(["list", "--json"]);
  assert(list.includes("codex-model-kit"));
  const config = await readFile(resolve(home, "config.toml"), "utf8");
  assert(
    !/model_provider|model_catalog_json|experimental_bearer_token/.test(config),
  );
  cli(["remove", "codex-model-kit@codex-model-kit"]);
  cli(["marketplace", "remove", "codex-model-kit"]);
  const configAfter = await readFile(resolve(home, "config.toml"), "utf8");
  assert(
    !configAfter.includes("codex-model-kit"),
    "Plugin enablement must be removed",
  );
  const removed = cli(["marketplace", "list", "--json"]);
  assert(!removed.includes(source), "Marketplace registration must be removed");
  try {
    await access(
      resolve(home, "plugins/cache/codex-model-kit/codex-model-kit"),
    );
    throw new Error("Plugin cache still exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const releaseRoot = resolve(root, "dist/release-content");
  const installer = resolve(releaseRoot, "install.mjs");
  const configPath = resolve(home, "config.toml");
  const catalogPath = resolve(home, "fixture-catalog.json");
  const fixtureConfig =
    'model_provider="fixture"\nmodel="fixture-model"\nmodel_catalog_json="fixture-catalog.json"\n[model_providers.fixture]\nname="Fixture"\nwire_api="responses"\nbase_url="https://fixture.example.invalid/v1"\nexperimental_bearer_token="FICTITIOUS-NOT-A-SECRET"\n';
  await writeFile(configPath, fixtureConfig);
  const fixtureCatalog = JSON.stringify({
    models: [
      {
        slug: "fixture-model",
        display_name: "Fixture",
        context_window: 64000,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "medium", description: "Medium" },
        ],
        input_modalities: ["text"],
        shell_type: "unified_exec",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        support_verbosity: false,
        truncation_policy: { mode: "tokens", limit: 10000 },
        experimental_supported_tools: [],
        model_messages: {
          instructions_template: "Fictitious fixture instructions",
        },
      },
    ],
  });
  await writeFile(catalogPath, fixtureCatalog);
  await writeFile(resolve(home, "auth.json"), '{"fixture":"UNCHANGED"}\n');
  const fixtureCli = spawnSync(
    process.env.CODEX_CLI_PATH || "codex",
    ["plugin", "marketplace", "list", "--json"],
    { env, encoding: "utf8" },
  );
  assert.equal(fixtureCli.status, 0, fixtureCli.stderr);
  const install = async (extra = [], cwd = releaseRoot) => {
    const result = spawnSync(
      process.execPath,
      [installer, "--node", process.execPath, ...extra],
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  await install(["--check"]);
  assert.equal(await readFile(configPath, "utf8"), fixtureConfig);
  // Real official CLI install and update, including a stable path with spaces.
  await install();
  await install();
  const stable = resolve(home, "marketplaces/codex-model-kit");
  const cache = resolve(home, "plugins/cache/codex-model-kit/codex-model-kit");
  const version = JSON.parse(
    await readFile(resolve(root, "dist/build-meta.json"), "utf8"),
  ).version;
  const packaged = resolve(cache, version);
  const launch = JSON.parse(
    await readFile(resolve(packaged, ".mcp.json"), "utf8"),
  ).mcpServers["codex-model-kit"];
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, ["./server.mjs"]);
  assert.equal(
    await readFile(
      resolve(stable, "plugins/codex-model-kit/.mcp.json"),
      "utf8",
    ),
    await readFile(resolve(packaged, ".mcp.json"), "utf8"),
  );
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: packaged,
    env: {
      PATH: process.env.PATH || "",
      CODEX_HOME: resolve(home, "never-read"),
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "release-installer-fixture", version: "1.0.0" },
    {},
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, version);
    assert.equal((await client.listTools()).tools.length, 20);
    const resource = await client.readResource({
      uri: `ui://codex-model-kit/main-catalog-sync-v${version}.html`,
    });
    assert.equal(
      resource.contents[0].text,
      await readFile(resolve(packaged, "main.html"), "utf8"),
    );
    assert.equal(stderr, "");
  } finally {
    await client.close();
  }
  const afterConfig = parse(await readFile(configPath, "utf8"));
  delete afterConfig.plugins;
  delete afterConfig.marketplaces;
  assert.deepEqual(afterConfig, parse(fixtureConfig));
  assert.equal(await readFile(catalogPath, "utf8"), fixtureCatalog);
  assert.equal(
    await readFile(resolve(home, "auth.json"), "utf8"),
    '{"fixture":"UNCHANGED"}\n',
  );
  const oldSource = await readFile(
    resolve(stable, "plugins/codex-model-kit/.mcp.json"),
    "utf8",
  );
  const failOnce = resolve(sandbox, "fail-once.mjs");
  const marker = resolve(sandbox, "failure-injected");
  await writeFile(
    failOnce,
    `#!/usr/bin/env node\nimport {existsSync,readFileSync,writeFileSync} from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nif(args[0]==='plugin'&&args[1]==='list'&&args.includes('--marketplace')){const n=existsSync(${JSON.stringify(marker)})?Number(readFileSync(${JSON.stringify(marker)},'utf8')):0;writeFileSync(${JSON.stringify(marker)},String(n+1));if(n===1)process.exit(1);}\nconst result=spawnSync(${JSON.stringify(process.env.CODEX_CLI_PATH || "codex")},args,{env:process.env,stdio:'inherit'});process.exit(result.status??1);\n`,
    { mode: 0o700 },
  );
  const failedUpdate = spawnSync(
    process.execPath,
    [installer, "--codex", failOnce],
    { env, encoding: "utf8", timeout: 120_000 },
  );
  assert.notEqual(failedUpdate.status, 0);
  assert(failedUpdate.stderr.includes("Official Codex command failed"));
  assert.equal(
    await readFile(
      resolve(stable, "plugins/codex-model-kit/.mcp.json"),
      "utf8",
    ),
    oldSource,
  );
  assert(
    JSON.parse(
      cli(["list", "--marketplace", "codex-model-kit", "--json"]),
    ).installed.some((value) => value.version === version && value.enabled),
  );
  assert.equal(await readFile(catalogPath, "utf8"), fixtureCatalog);
  const tampered = resolve(sandbox, "tampered release");
  await cp(releaseRoot, tampered, { recursive: true });
  await writeFile(
    resolve(tampered, "marketplace/plugins/codex-model-kit/main.html"),
    "tampered",
  );
  const rejected = spawnSync(
    process.execPath,
    [resolve(tampered, "install.mjs"), "--check"],
    { env, encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert(rejected.stderr.includes("checksum failed"));
  cli(["remove", "codex-model-kit@codex-model-kit"]);
  cli(["marketplace", "remove", "codex-model-kit"]);
  await writeFile(
    resolve(base, "isolated-install.json"),
    JSON.stringify(
      {
        version: JSON.parse(
          await readFile(resolve(root, "dist/build-meta.json"), "utf8"),
        ).version,
        status: "passed",
        scope:
          "isolated CODEX_HOME with spaces; official CLI install/update/list/remove; failed-update recovery; release checksums and tamper rejection; installed native launch config, 20 tools and exact versioned UI; fixture business config/catalog/auth unchanged; no GUI, Windows native, or live relay testing",
        runtime: process.version,
        codex: spawnSync("codex", ["--version"], {
          encoding: "utf8",
        }).stdout.trim(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Isolated CODEX_HOME install/list/remove passed. Real Codex home was not changed.",
  );
} finally {
  // Only the uniquely-created, isolated fixture is removed.
  await rm(sandbox, { recursive: true, force: true });
}
