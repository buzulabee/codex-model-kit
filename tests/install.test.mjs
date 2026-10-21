import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchConfig, selectRuntime } from "../scripts/install/runtime.mjs";
import { releaseVersion } from "../scripts/release-version.mjs";
import { releaseTag } from "../src/shared/release-version.ts";

const probeResult = (version, execPath) => ({
  status: 0,
  stdout: JSON.stringify({ version, execPath }),
});
test("default CI packages releases without downloading or testing Codex CLI", async () => {
  const ci = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(ci, /@openai\/codex|\.ci-tools|npm run test:package/);
  assert.match(ci, /npm run check/);
  assert.match(ci, /npm run release:package/);
  assert.doesNotMatch(ci, /pull_request_target|persist-credentials: true/);
  assert.match(ci, /environment: release/);
  assert.match(ci, /cancel-in-progress: false/);
  assert.match(ci, /github\.ref_protected/);
});

test("real local credentials and generated outputs stay outside Git", () => {
  for (const path of [
    ".env",
    ".env.local",
    "auth.json",
    "config.toml",
    "model-catalog.json",
    "models.json",
    ".npmrc",
    ".netrc",
    "id_ed25519",
    "key.pem",
    "cert.p12",
    "signing.jks",
    "node_modules/package.json",
    "dist/release.json",
    ".test-artifacts/config.toml",
  ]) {
    const result = spawnSync(
      "git",
      ["check-ignore", "--no-index", "--", path],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `Expected ignored private/generated path: ${path}`,
    );
  }
});

test("release distribution does not restore the retired Git asset publisher", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.scripts["release:git-assets"], undefined);
  await assert.rejects(
    readFile(new URL("../scripts/publish-git-assets.mjs", import.meta.url)),
    { code: "ENOENT" },
  );
  for (const path of ["README.md", "README.en.md", "INSTALL.md"]) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      /release:git-assets|codex-release-assets|e99646aebfa/,
    );
    assert.match(text, /github\.com\/buzulabee\/codex-model-kit\/releases/);
  }
});

test("READMEs use Chinese by default with an English language switch", async () => {
  const source = new URL("../", import.meta.url);
  const chinese = await readFile(new URL("README.md", source), "utf8");
  const english = await readFile(new URL("README.en.md", source), "utf8");
  assert.match(chinese, /^# Codex 模型工具/m);
  assert.match(english, /^# Codex Model Kit/m);
  for (const text of [chinese, english]) {
    assert.match(text, /\[简体中文\]\(README\.md\)/);
    assert.match(text, /\[English\]\(README\.en\.md\)/);
  }
});

test("built plugin preserves bilingual READMEs, split guides and screenshots", async () => {
  const source = new URL("../", import.meta.url);
  const plugin = new URL("dist/marketplace/plugins/codex-model-kit/", source);
  const documents = [
    "README.md",
    "README.en.md",
    "INSTALL.md",
    "docs/usage.md",
    "docs/development.md",
  ];
  for (const path of [
    ...documents,
    "CI.md",
    "docs/screenshots/model-list.png",
    "docs/screenshots/write-preview.png",
  ]) {
    assert.deepEqual(
      await readFile(new URL(path, plugin)),
      await readFile(new URL(path, source)),
      `Bundled documentation must match source: ${path}`,
    );
  }
  for (const root of [source, plugin]) {
    for (const path of documents) {
      const document = new URL(path, root);
      const text = await readFile(document, "utf8");
      for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        if (target.startsWith("#") || URL.canParse(target)) continue;
        await readFile(new URL(target.split("#")[0], document));
      }
    }
  }
});

test("installer prefers the client runtime over the system runtime", () => {
  const calls = [];
  const runtime = selectRuntime({
    env: { CODEX_MCP_NODE_PATH: "/client/node" },
    current: "/system/node",
    probe: (path) => {
      calls.push(path);
      return probeResult("24.21.0", path);
    },
  });
  assert.equal(runtime.source, "client");
  assert.deepEqual(calls, ["/client/node"]);
});
test("unsupported or broken client runtime falls back to a supported installer runtime", () => {
  for (const first of [
    { status: 1 },
    { status: 0, stdout: "invalid" },
    probeResult("22.0.0", "/old"),
    probeResult("24.invalid", "/bad"),
  ]) {
    const runtime = selectRuntime({
      env: { CODEX_MCP_NODE_PATH: "/old" },
      current: "/new",
      probe: (path) => (path === "/old" ? first : probeResult("24.18.0", path)),
    });
    assert.equal(runtime.path, "/new");
  }
});
test("explicit runtime never silently falls back and unsupported machines fail closed", () => {
  assert.throws(
    () =>
      selectRuntime({
        explicit: "/old",
        env: {},
        probe: () => probeResult("22.0.0", "/old"),
      }),
    /No supported Node/,
  );
  assert.throws(
    () =>
      selectRuntime({
        env: {},
        current: "/missing",
        probe: () => {
          throw new Error("private child output");
        },
      }),
    (error) =>
      !error.message.includes("private child output") &&
      error.message.includes("Nothing was installed"),
  );
});
test("Windows paths with spaces are native command values, not shell commands", () => {
  const path = "C:\\Program Files\\ChatGPT\\resources\\cua_node\\bin\\node.exe";
  const config = launchConfig({ path }).mcpServers["codex-model-kit"];
  assert.equal(config.command, path);
  assert.deepEqual(config.args, ["./server.mjs"]);
  assert.equal(config.cwd, ".");
  assert(!JSON.stringify(config).includes("/bin/sh"));
});
test("release versions use Shanghai release minutes and numeric SemVer components", () => {
  assert.equal(
    releaseVersion(new Date("2026-10-15T09:35:00Z")),
    "2026.1015.1735",
  );
  assert.equal(
    releaseVersion(new Date("2026-01-05T01:03:00Z")),
    "2026.105.903",
  );
  assert.equal(releaseVersion(new Date("2026-12-31T16:00:00Z")), "2027.101.0");
});

test("release tags preserve four-digit dates and times without padding package versions", () => {
  for (const [date, version, tag] of [
    ["2026-10-21T01:45:00Z", "2026.1021.945", "v2026.1021.0945"],
    ["2026-10-21T01:54:00Z", "2026.1021.954", "v2026.1021.0954"],
    ["2026-01-05T01:03:00Z", "2026.105.903", "v2026.0105.0903"],
    ["2026-12-31T16:00:00Z", "2027.101.0", "v2027.0101.0000"],
  ]) {
    assert.equal(releaseVersion(new Date(date)), version);
    assert.equal(releaseTag(version), tag);
  }
  assert.throws(() => releaseTag("2026.1021.0945"));
});

test("release command synchronizes five version files with formatter-clean output", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const fixture = await mkdtemp(join(tmpdir(), "model-kit-release-version-"));
  const jsonPaths = [
    "package.json",
    "package-lock.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
  ];
  try {
    for (const path of [
      ...jsonPaths,
      "src/shared/security.ts",
      "src/shared/release-version.ts",
      "scripts/release-version.mjs",
    ]) {
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      let contents = await readFile(resolve(root, path), "utf8");
      if (path === "package.json") {
        const pkg = JSON.parse(contents);
        pkg.version = "0.0.0";
        contents = JSON.stringify(pkg);
      }
      await writeFile(join(fixture, path), contents);
    }
    const result = spawnSync("npm", ["run", "version:release"], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${resolve(root, "node_modules/.bin")}${delimiter}${process.env.PATH || ""}`,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, "Isolated release command must succeed");
    const version = JSON.parse(
      await readFile(join(fixture, "package.json"), "utf8"),
    ).version;
    assert.match(version, /^\d{4}\.\d{3,4}\.\d{1,4}$/);
    for (const path of jsonPaths) {
      const data = JSON.parse(await readFile(join(fixture, path), "utf8"));
      assert.equal(
        path === ".claude-plugin/marketplace.json"
          ? data.plugins[0].version
          : data.version,
        version,
      );
      if (path === "package-lock.json")
        assert.equal(data.packages[""].version, version);
    }
    const security = await readFile(
      join(fixture, "src/shared/security.ts"),
      "utf8",
    );
    assert(security.includes(`export const VERSION = "${version}";`));
    const formatted = spawnSync(
      process.execPath,
      [
        resolve(root, "node_modules/prettier/bin/prettier.cjs"),
        "--check",
        ...jsonPaths,
        "src/shared/security.ts",
      ],
      { cwd: fixture, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(formatted.status, 0, "Version files must pass formatting");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
