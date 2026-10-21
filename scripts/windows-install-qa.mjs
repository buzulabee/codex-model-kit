import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse } from "smol-toml";

assert.equal(
  process.platform,
  "win32",
  "Run with native Windows Node, not WSL/Linux",
);
assert(Number(process.versions.node.split(".")[0]) >= 24);
assert(process.argv[2], "Pass the built dist/release-content directory");
const releaseRoot = resolve(process.argv[2]);
const codex = process.env.CODEX_CLI_PATH;
assert(
  codex && isAbsolute(codex) && /\.exe$/i.test(codex),
  "Pass the actual native CLI in CODEX_CLI_PATH",
);
const base = await mkdtemp(join(tmpdir(), "cmk-native-install-"));
const home = join(base, "测试 user home");
const oldRelease = join(base, "old-release");
const env = {
  ...process.env,
  CODEX_HOME: home,
  CODEX_MCP_NODE_PATH: process.execPath,
  CODEX_CLI_PATH: codex,
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
let client, holder, transport;
const cli = (args) => {
  const result = spawnSync(codex, args, {
    env,
    cwd: home,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(
    result.status,
    0,
    `Official fixture CLI failed: ${args.slice(0, 3).join(" ")}`,
  );
  return JSON.parse(result.stdout);
};
const install = (root, check = false) => {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "install.mjs"),
      "--node",
      process.execPath,
      "--codex",
      codex,
      ...(check ? ["--check"] : []),
    ],
    { env, cwd: home, encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stdout.includes('"status":"failed"'));
  return result.stdout;
};
try {
  await cp(releaseRoot, oldRelease, { recursive: true });
  // Synthetic prior manifest; production code bytes remain unchanged. This tests installation, not old UI behavior.
  const oldVersion = "0.0.1";
  const manifest = JSON.parse(
    await readFile(join(oldRelease, "release.json"), "utf8"),
  );
  const version = manifest.version;
  for (const path of [
    "marketplace/plugins/codex-model-kit/.codex-plugin/plugin.json",
    "marketplace/.claude-plugin/marketplace.json",
  ]) {
    const value = JSON.parse(await readFile(join(oldRelease, path), "utf8"));
    if (value.plugins) value.plugins[0].version = oldVersion;
    else value.version = oldVersion;
    const bytes = JSON.stringify(value, null, 2) + "\n";
    await writeFile(join(oldRelease, path), bytes);
    manifest.files[path] = hash(bytes);
  }
  manifest.version = oldVersion;
  await writeFile(join(oldRelease, "release.json"), JSON.stringify(manifest));
  await mkdir(home, { recursive: true });
  const business = 'model="FAKE_MODEL"\nmodel_catalog_json="models.json"\n';
  const catalog = JSON.stringify({
    models: [
      {
        slug: "FAKE_MODEL",
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
        model_messages: { instructions_template: "Fictitious fixture" },
      },
    ],
  });
  await writeFile(join(home, "config.toml"), business);
  await writeFile(join(home, "models.json"), catalog);
  await writeFile(join(home, "auth.json"), "FAKE_AUTH_UNCHANGED");
  install(oldRelease, true);
  install(oldRelease);
  const oldCache = join(
    home,
    "plugins/cache/codex-model-kit/codex-model-kit",
    oldVersion,
  );
  const oldBytes = await readFile(join(oldCache, "server.mjs"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./server.mjs"],
    cwd: oldCache,
    env,
    stderr: "pipe",
  });
  client = new Client(
    { name: "isolated-native-updater", version: "1.0.0" },
    {},
  );
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, version);
  holder = spawn(
    join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '$f=[System.IO.File]::Open($env:MODEL_KIT_FIXTURE_LOCK,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); [Console]::WriteLine("READY"); [Console]::ReadLine() | Out-Null; $f.Dispose()',
    ],
    {
      env: { ...env, MODEL_KIT_FIXTURE_LOCK: join(oldCache, "server.mjs") },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Fixture lock timeout")),
      10000,
    );
    holder.once("error", reject);
    holder.once("exit", () => reject(new Error("Fixture lock exited early")));
    holder.stdout.once("data", (chunk) => {
      clearTimeout(timeout);
      if (chunk.toString().includes("READY")) resolve();
      else reject(new Error("Fixture lock not ready"));
    });
  });
  // Prove the handle really prevents deletion, rather than merely assuming a live process locks a file.
  const blocked = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {unlink} from "node:fs/promises"; try {await unlink(process.argv[1]); process.exitCode=2;} catch(e){if(!["EPERM","EBUSY","EACCES"].includes(e.code))process.exitCode=3;}',
      join(oldCache, "server.mjs"),
    ],
    { env, windowsHide: true },
  );
  assert.equal(
    blocked.status,
    0,
    "Old fixture file must be truly held without delete sharing",
  );
  install(releaseRoot, true);
  install(releaseRoot);
  install(releaseRoot); // Same-version rerun must also work without removing the locked old cache.
  const installed = cli([
    "plugin",
    "list",
    "--marketplace",
    "codex-model-kit",
    "--json",
  ]).installed;
  assert(installed.some((value) => value.version === version && value.enabled));
  assert.deepEqual(await readFile(join(oldCache, "server.mjs")), oldBytes);
  assert(
    (await client.listTools()).tools.length > 0,
    "Old backend remains responsive",
  );
  // Official CLI owns plugin metadata; compare business fields separately without persisting secrets.
  const config = parse(await readFile(join(home, "config.toml"), "utf8"));
  delete config.plugins;
  delete config.marketplaces;
  assert.deepEqual(config, parse(business));
  assert.equal(await readFile(join(home, "models.json"), "utf8"), catalog);
  assert.equal(
    await readFile(join(home, "auth.json"), "utf8"),
    "FAKE_AUTH_UNCHANGED",
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        version,
        previousFixtureVersion: oldVersion,
        node: process.versions.node,
        cli: spawnSync(codex, ["--version"], {
          env,
          encoding: "utf8",
          windowsHide: true,
        }).stdout.trim(),
        scope:
          "native Windows isolated CODEX_HOME; production installer check/first install/version update/reinstall; live old STDIO plus verified Windows deny-delete handle; old cache unchanged; fake config/catalog/auth unchanged; NOT real home, native UI or business catalog acceptance",
      },
      null,
      2,
    ),
  );
} finally {
  if (holder) {
    holder.stdin.end("\n");
    if (holder.exitCode === null) await once(holder, "exit");
  }
  await client?.close();
  await transport?.close();
  await rm(base, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 300,
  });
}
