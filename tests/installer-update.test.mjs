import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, installRelease } from "../scripts/install/installer.mjs";
import { launchConfig } from "../scripts/install/runtime.mjs";

const selector = "codex-model-kit@codex-model-kit";
const oldVersion = "2026.1016.1440";
const version = "2026.1016.1529";
const prefix = "marketplace/plugins/codex-model-kit/";
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), "cmk-installer-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "测试 user home");
  const root = join(base, "release");
  const target = join(home, "marketplaces/codex-model-kit");
  const cache = (v) =>
    join(home, "plugins/cache/codex-model-kit/codex-model-kit", v);
  const runtime = {
    path: process.execPath,
    version: process.versions.node,
    source: "explicit",
  };
  const log = [],
    calls = [];
  let registered = options.fresh ? false : true;
  let installed = options.fresh
    ? null
    : {
        pluginId: selector,
        version: oldVersion,
        enabled: options.enabled ?? true,
      };
  const files = {
    ".codex-plugin/plugin.json": JSON.stringify({
      name: "codex-model-kit",
      version,
    }),
    ".mcp.json": "{}",
    "main.html": "FAKE_NEW_UI",
    "server.mjs": "// FAKE_NEW_SERVER",
  };
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, prefix, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  await mkdir(join(root, "marketplace/.claude-plugin"), { recursive: true });
  await writeFile(
    join(root, "marketplace/.claude-plugin/marketplace.json"),
    JSON.stringify({ name: "codex-model-kit", plugins: [{ version }] }),
  );
  const manifest = {
    version,
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [prefix + name, sha(text)]),
    ),
  };
  manifest.files["marketplace/.claude-plugin/marketplace.json"] = sha(
    await readFile(join(root, "marketplace/.claude-plugin/marketplace.json")),
  );
  await writeFile(join(root, "release.json"), JSON.stringify(manifest));
  await mkdir(home, { recursive: true });
  const business = 'model="FAKE_MODEL"\nmodel_catalog_json="models.json"\n';
  await writeFile(join(home, "config.toml"), business);
  await writeFile(join(home, "models.json"), "FAKE_CATALOG_UNCHANGED");
  await writeFile(join(home, "auth.json"), "FAKE_AUTH_UNCHANGED");
  if (!options.fresh) {
    cpSync(join(root, "marketplace"), target, { recursive: true });
    writeFileSync(
      join(target, "plugins/codex-model-kit/.codex-plugin/plugin.json"),
      JSON.stringify({ name: "codex-model-kit", version: oldVersion }),
    );
    writeFileSync(
      join(target, "plugins/codex-model-kit/.mcp.json"),
      JSON.stringify(launchConfig(runtime), null, 2) + "\n",
    );
    writeFileSync(
      join(target, "plugins/codex-model-kit/main.html"),
      "FAKE_OLD_UI",
    );
    mkdirSync(dirname(cache(oldVersion)), { recursive: true });
    cpSync(join(target, "plugins/codex-model-kit"), cache(oldVersion), {
      recursive: true,
    });
  }
  const cli = (args) => {
    calls.push(args);
    const verb = args.slice(0, 3).join(" ");
    if (verb === "plugin marketplace list")
      return {
        marketplaces: registered
          ? [
              {
                name: "codex-model-kit",
                root: options.root ?? target,
                ...(options.source !== undefined
                  ? { marketplaceSource: options.source }
                  : {}),
              },
            ]
          : [],
      };
    if (verb === "plugin marketplace add") {
      registered = true;
      return {};
    }
    if (verb === "plugin marketplace remove") {
      registered = false;
      return {};
    }
    if (args[1] === "list")
      return {
        installed: installed
          ? [
              {
                ...installed,
                ...(options.installedSource !== undefined
                  ? { marketplaceSource: options.installedSource }
                  : {}),
              },
            ]
          : [],
      };
    if (args[1] === "add") {
      const nextVersion = JSON.parse(
        readFileSync(
          join(target, "plugins/codex-model-kit/.codex-plugin/plugin.json"),
          "utf8",
        ),
      ).version;
      const count = calls.filter((call) => call[1] === "add").length;
      if ((options.failAdd && count === 1) || options.failAllAdds)
        throw new CliError(args, {
          status: 1,
          stderr: "FAKE_PRIVATE_PATH os error 32 FAKE_SECRET",
        });
      installed = {
        pluginId: selector,
        version: nextVersion,
        enabled: !options.staleEnabled,
      };
      mkdirSync(dirname(cache(nextVersion)), { recursive: true });
      if (!existsSync(cache(nextVersion)))
        cpSync(join(target, "plugins/codex-model-kit"), cache(nextVersion), {
          recursive: true,
        });
      if (options.tamper && count === 1)
        writeFileSync(join(cache(nextVersion), "main.html"), "STALE_UI");
      if (options.partialAdd && count === 1)
        throw new CliError(args, { status: 1 });
      return {};
    }
    if (args[1] === "disable") {
      installed.enabled = false;
      return {};
    }
    if (args[1] === "enable") {
      installed.enabled = true;
      return {};
    }
    if (args[1] === "remove") {
      if (!options.fresh)
        throw new CliError(args, { status: 1, stderr: "os error 32" });
      installed = null;
      return {};
    }
    throw new Error("Unexpected fixture command");
  };
  const run = (extra = {}) =>
    installRelease({
      root,
      home,
      runtime,
      cli,
      log: (text) => log.push(text),
      ...extra,
    });
  const unchanged = async () => {
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), business);
    assert.equal(
      await readFile(join(home, "models.json"), "utf8"),
      "FAKE_CATALOG_UNCHANGED",
    );
    assert.equal(
      await readFile(join(home, "auth.json"), "utf8"),
      "FAKE_AUTH_UNCHANGED",
    );
  };
  return {
    home,
    root,
    target,
    cache,
    run,
    log,
    calls,
    unchanged,
    installed: () => installed,
  };
}

test("name/root-only marketplace metadata passes check and updates without removing the live old cache", async (t) => {
  const f = await fixture(t);
  await f.run({ check: true });
  assert(!f.calls.some((args) => ["add", "remove"].includes(args[1])));
  assert.equal((await readdir(join(f.home, "marketplaces"))).length, 1);
  await f.run();
  assert.equal(f.installed().version, version);
  assert(!f.calls.some((args) => args[1] === "remove"));
  assert.equal(
    await readFile(join(f.cache(oldVersion), "main.html"), "utf8"),
    "FAKE_OLD_UI",
  );
  assert.equal(
    await readFile(join(f.cache(version), "main.html"), "utf8"),
    "FAKE_NEW_UI",
  );
  await f.unchanged();
});

test("explicit local source and same-version reinstall work; a changed runtime cannot silently reuse stale launch files", async (t) => {
  const f = await fixture(t, { source: { sourceType: "local" } });
  await f.run();
  await f.run();
  assert.equal(f.calls.filter((args) => args[1] === "add").length, 1);
  await assert.rejects(
    f.run({ runtime: { path: join(f.home, "new node.exe") } }),
    /Installed files do not match/,
  );
  assert.equal(f.installed().version, version);
  assert(!f.log.some((text) => text.includes("recovery_required")));
  await f.unchanged();
});

test("an intact same-version disabled plugin is enabled without reinstalling or removing caches", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.installed().enabled = false;
  await f.run();
  assert.equal(f.installed().enabled, true);
  assert.equal(f.calls.filter((args) => args[1] === "add").length, 1);
  assert(f.calls.some((args) => args[1] === "enable"));
  await f.unchanged();
});

test("first installation registers then adds and verifies the installed release", async (t) => {
  const f = await fixture(t, { fresh: true });
  await f.run();
  assert(
    f.calls.some(
      (args) => args.slice(0, 3).join(" ") === "plugin marketplace add",
    ),
  );
  assert.equal(f.installed().version, version);
  await f.unchanged();
});

test("different roots and explicitly conflicting or unknown source metadata stop before changing files", async (t) => {
  for (const options of [
    { root: tmpdir() },
    { source: { sourceType: "git" } },
    { source: {} },
    { installedSource: { sourceType: "git" } },
  ]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run({ check: true }));
    assert.equal(
      await readFile(
        join(f.target, "plugins/codex-model-kit/main.html"),
        "utf8",
      ),
      "FAKE_OLD_UI",
    );
    assert(!f.calls.some((args) => ["add", "remove"].includes(args[1])));
    await f.unchanged();
  }
});

test("an unowned or incomplete stable directory is rejected even in check mode", async (t) => {
  const f = await fixture(t);
  await rm(join(f.target, ".claude-plugin/marketplace.json"));
  await assert.rejects(
    f.run({ check: true }),
    /without an owned marketplace manifest/,
  );
  assert.equal(
    await readFile(join(f.target, "plugins/codex-model-kit/main.html"), "utf8"),
    "FAKE_OLD_UI",
  );
});

test("failed or partially successful updates restore the previous source and plugin without remove", async (t) => {
  for (const options of [
    { failAdd: true },
    { partialAdd: true },
    { tamper: true },
    { failAdd: true, enabled: false },
  ]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run());
    assert.equal(f.installed().version, oldVersion);
    assert.equal(f.installed().enabled, options.enabled ?? true);
    assert.equal(
      await readFile(
        join(f.target, "plugins/codex-model-kit/main.html"),
        "utf8",
      ),
      "FAKE_OLD_UI",
    );
    assert(!f.calls.some((args) => args[1] === "remove"));
    assert(!f.log.some((text) => text.includes("recovery_required")));
    assert(!f.log.join(" ").includes("FAKE_SECRET"));
    const report = f.log
      .filter((text) => text.startsWith("{"))
      .map(JSON.parse)
      .find((value) => value.status === "failed");
    assert(["install_plugin", "verify_install"].includes(report.stage));
    await f.unchanged();
  }
});

test("unverified enabled state cannot be reported as a successful installation or rollback", async (t) => {
  const f = await fixture(t, { staleEnabled: true });
  await assert.rejects(f.run(), /verification failed/);
  assert(f.log.some((text) => text.includes("recovery_required")));
  assert(!f.log.some((text) => text.startsWith("Installed and enabled")));
  await f.unchanged();
});

test("failed first installation removes partial registration through official commands", async (t) => {
  const f = await fixture(t, { fresh: true, partialAdd: true });
  await assert.rejects(f.run());
  assert.equal(f.installed(), null);
  assert(f.calls.some((args) => args[1] === "remove"));
  assert(
    f.calls.some(
      (args) => args.slice(0, 3).join(" ") === "plugin marketplace remove",
    ),
  );
  assert(!existsSync(f.target));
  await f.unchanged();
});

test("failed rollback retains recovery directories and reports both sanitized command failures", async (t) => {
  const f = await fixture(t, { failAllAdds: true });
  await assert.rejects(f.run());
  const stages = (await readdir(join(f.home, "marketplaces"))).filter((name) =>
    name.startsWith(".codex-model-kit-stage-"),
  );
  assert.equal(stages.length, 1);
  assert(existsSync(join(f.home, "marketplaces", stages[0], "failed")));
  const reports = f.log.filter((text) => text.startsWith("{")).map(JSON.parse);
  assert.equal(
    reports.find((value) => value.status === "recovery_required")
      .rollbackFailure.cli.reason,
    "file_in_use",
  );
  assert.equal(
    reports.find((value) => value.status === "failed").cli.reason,
    "file_in_use",
  );
  assert(!f.log.join(" ").includes("FAKE_SECRET"));
  await f.unchanged();
});

test("cleanup failure after successful verification is a warning, not a failed update", async (t) => {
  const f = await fixture(t);
  await f.run({
    cleanup: async () => {
      throw Object.assign(new Error("FAKE_SECRET"), { code: "EPERM" });
    },
  });
  assert.equal(f.installed().version, version);
  assert(f.log.some((text) => text.includes("cleanup_pending")));
  assert(!f.log.join(" ").includes("FAKE_SECRET"));
  assert(!f.log.some((text) => text.includes('"status":"failed"')));
  await f.unchanged();
});

test("CLI error classification never includes raw stdout, stderr or executable paths", () => {
  const error = new CliError(["plugin", "add", selector], {
    status: 1,
    stderr: "FAKE_PRIVATE_PATH os error 32 FAKE_SECRET",
    stdout: "FAKE_SECRET",
  });
  assert.deepEqual(error.details, {
    command: "plugin add",
    exitStatus: 1,
    reason: "file_in_use",
  });
  assert(!JSON.stringify(error).includes("FAKE_SECRET"));
});
