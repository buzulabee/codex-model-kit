import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { catalogPathIssue } from "../src/filesystem/safe-files.js";
import { readCatalogFile } from "../src/catalog/store.js";
import { ConfigReadError, FileConfigSource } from "../src/config/discovery.js";
import { CatalogWriter } from "../src/catalog/writer.js";
import { SafeError } from "../src/connections/envelopes.js";

const ref = {
  instanceId: randomUUID(),
  connectionId: randomUUID(),
  connectionRevision: 1,
};
const guard = async () => {};
const before = '{"models":[{"slug":"before"}]}';
const after = '{"models":[{"slug":"after"}]}';

test("Windows path policy rejects protected names and ambiguous/device/network/ADS aliases", () => {
  for (const path of [
    "C:\\Users\\test user\\models.json",
    "d:/目录/models.json",
    "C:\\test\\..\\models.json",
  ])
    assert.equal(catalogPathIssue(path, "win32"), undefined, path);
  for (const path of ["C:\\x\\AUTH.JSON", "C:/x/config.TOML"])
    assert.equal(catalogPathIssue(path, "win32"), "protected_path", path);
  for (const path of [
    "C:models.json",
    "\\models.json",
    "/models.json",
    "\\\\server\\share\\models.json",
    "\\\\?\\C:\\x\\models.json",
    "\\\\.\\NUL",
    "C:\\x\\models.json:stream",
    "C:\\x\\auth.json.",
    "C:\\x \\models.json",
    "C:\\x\\NUL.json",
    "C:\\x\\COM1",
    "C:\\x\\LPT¹.json",
    "C:\\x\\NUL .json",
  ])
    assert.equal(catalogPathIssue(path, "win32"), "unsupported_path", path);
  assert.equal(
    catalogPathIssue("models/catalog.json", "win32", true),
    undefined,
  );
  assert.equal(
    catalogPathIssue("C:models.json", "win32", true),
    "unsupported_path",
  );
  for (const path of [
    "C:\\Users\\test\\models.json",
    "\\\\server\\share\\models.json",
    "//server/share/models.json",
  ])
    assert.equal(catalogPathIssue(path, "linux", true), "unsupported_path");
});

test("spaces, Unicode, relative catalog paths and BOM config work with save and restore", async () => {
  const root = await mkdtemp(resolve(".test-artifacts/compat-"));
  const home = join(root, "测试 用户");
  await mkdir(home);
  const path = join(home, "models.json");
  try {
    await writeFile(
      join(home, "config.toml"),
      '\uFEFFmodel_catalog_json="models.json"\n',
    );
    const source = new FileConfigSource(home);
    assert.equal(
      await source.read("config.toml"),
      'model_catalog_json="models.json"\n',
    );
    assert.equal(source.resolveCatalogPath("models.json"), path);
    await writeFile(
      join(home, "config.toml"),
      Buffer.from('\uFEFFmodel_catalog_json="models.json"\n', "utf16le"),
    );
    await assert.rejects(
      source.read("config.toml"),
      (error: unknown) =>
        error instanceof ConfigReadError &&
        error.failure?.rule === "invalid_utf8",
    );
    await writeFile(
      join(home, "config.toml"),
      'model_catalog_json="models.json"\n',
    );
    await writeFile(path, before);
    assert.equal(await readCatalogFile(path), before);
    const writer = new CatalogWriter();
    const plan = await writer.prepare(ref, path, before, after, "save", guard);
    await writer.commit(ref, plan.planId, randomUUID(), guard);
    const restore = await writer.prepareRestore(ref, path, guard);
    await writer.commit(ref, restore.plan.planId, randomUUID(), guard);
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hard-linked catalogs are rejected without modifying either name", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/compat-"));
  try {
    const path = join(dir, "models.json");
    await writeFile(path, before);
    await link(path, join(dir, "alias.json"));
    await assert.rejects(
      new CatalogWriter().prepare(ref, path, before, after, "save", guard),
      (error: unknown) =>
        error instanceof SafeError && error.failure?.rule === "multiple_links",
    );
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config and catalog final symlinks are rejected before reading", async (t) => {
  const dir = await mkdtemp(resolve(".test-artifacts/compat-"));
  try {
    const target = join(dir, "target.json");
    await writeFile(target, before);
    try {
      await symlink(target, join(dir, "models.json"), "file");
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EPERM" &&
        process.platform === "win32"
      ) {
        t.skip("Windows account lacks symlink privileges");
        return;
      }
      throw error;
    }
    await symlink(target, join(dir, "config.toml"), "file");
    await assert.rejects(readCatalogFile(join(dir, "models.json")));
    await assert.rejects(new FileConfigSource(dir).read("config.toml"));
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "Windows read-only catalogs fail before creating backups or staging files",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await mkdtemp(resolve(".test-artifacts/compat-"));
    const path = join(dir, "models.json");
    try {
      await writeFile(path, before);
      await chmod(path, 0o444);
      await assert.rejects(
        new CatalogWriter().prepare(ref, path, before, after, "save", guard),
        (error: unknown) =>
          error instanceof SafeError && error.failure?.rule === "read_only",
      );
      assert.deepEqual(await readdir(dir), ["models.json"]);
      assert.equal(await readFile(path, "utf8"), before);
    } finally {
      await chmod(path, 0o600);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Windows sharing violations preserve the catalog and expose a safe publish failure",
  { skip: process.platform !== "win32", timeout: 15000 },
  async () => {
    const dir = await mkdtemp(resolve(".test-artifacts/compat-"));
    const path = join(dir, "models.json");
    await writeFile(path, before);
    const child = spawn(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$f=[System.IO.File]::Open($env:MODEL_KIT_FIXTURE_LOCK,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); [Console]::WriteLine("READY"); [Console]::ReadLine() | Out-Null; $f.Dispose()',
      ],
      {
        env: { ...process.env, MODEL_KIT_FIXTURE_LOCK: path },
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("fixture lock timeout")),
          5000,
        );
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("fixture lock exited early"));
        });
        child.stdout.once("data", (data) => {
          clearTimeout(timeout);
          String(data).includes("READY")
            ? resolve()
            : reject(new Error("fixture lock not ready"));
        });
      });
      const writer = new CatalogWriter();
      const plan = await writer.prepare(
        ref,
        path,
        before,
        after,
        "save",
        guard,
      );
      await assert.rejects(
        writer.commit(ref, plan.planId, randomUUID(), guard),
        (error: unknown) =>
          error instanceof SafeError &&
          error.code === "catalog_write_failed" &&
          error.failure?.stage === "publish" &&
          ["EPERM", "EACCES", "EBUSY"].includes(error.failure.systemCode ?? ""),
      );
      assert.equal(await readFile(path, "utf8"), before);
      assert(!(await readdir(dir)).some((name) => /\.(lock|tmp)$/.test(name)));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.stdin.end("\n");
        const timeout = setTimeout(() => child.kill(), 2000);
        await exited;
        clearTimeout(timeout);
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
