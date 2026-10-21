import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CatalogWriter, syncCatalogDirectory } from "../src/catalog/writer.js";
import { SafeError } from "../src/connections/envelopes.js";

const ref = {
  instanceId: randomUUID(),
  connectionId: randomUUID(),
  connectionRevision: 1,
};
const before = JSON.stringify({ models: [{ slug: "old", priority: 0 }] });
const after = JSON.stringify({ models: [{ slug: "new", priority: 0 }] });
const guard = async () => {};
const code = (value: string) => (error: unknown) =>
  error instanceof SafeError && error.code === value;
const durability = process.platform === "win32" ? "file_synced" : "synced";

test("directory sync is explicitly unsupported on Windows, not silently ignored on POSIX", async () => {
  let opened = false;
  const denied = async () => {
    opened = true;
    throw Object.assign(new Error("fixture permission denied"), {
      code: "EACCES",
    });
  };
  assert.equal(await syncCatalogDirectory("fixture", "win32", denied), false);
  assert.equal(opened, false);
  await assert.rejects(syncCatalogDirectory("fixture", "linux", denied), {
    code: "EACCES",
  });
  assert.equal(opened, true);
  let closed = false;
  await assert.rejects(
    syncCatalogDirectory("fixture", "linux", async () => ({
      sync: async () => {
        throw Object.assign(new Error("fixture IO failure"), { code: "EIO" });
      },
      close: async () => {
        closed = true;
      },
    })),
    { code: "EIO" },
  );
  assert.equal(closed, true);
});

test("catalog write confirms an opaque plan, backs up, restores, and is idempotent", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/writer-"));
  const path = join(dir, "models.json");
  try {
    await writeFile(path, before);
    const writer = new CatalogWriter();
    const plan = await writer.prepare(ref, path, before, after, "save", guard);
    assert.deepEqual([plan.added, plan.removed], [["new"], ["old"]]);
    assert.equal(await readFile(path, "utf8"), before);
    const id = randomUUID();
    const receipt = await writer.commit(ref, plan.planId, id, guard);
    assert.equal(receipt.durability, durability);
    assert.equal(await readFile(receipt.backupPath!, "utf8"), before);
    assert.equal(await readFile(path, "utf8"), after);
    assert.deepEqual(await writer.commit(ref, plan.planId, id, guard), receipt);
    const restore = await writer.prepareRestore(ref, path, guard);
    assert.equal(await readFile(path, "utf8"), after);
    const restored = await writer.commit(
      ref,
      restore.plan.planId,
      randomUUID(),
      guard,
    );
    assert.equal(restored.action, "restore");
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first save verifies a single-link catalog and restore removes only the new file", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/writer-"));
  const path = join(dir, "models.json");
  try {
    const writer = new CatalogWriter();
    const plan = await writer.prepare(ref, path, null, after, "save", guard);
    const receipt = await writer.commit(ref, plan.planId, randomUUID(), guard);
    assert.equal(receipt.durability, durability);
    assert.equal(receipt.backupPath, null);
    assert.equal(await readFile(path, "utf8"), after);
    assert.deepEqual(await readdir(dir), ["models.json"]);
    const restore = await writer.prepareRestore(ref, path, guard);
    const restored = await writer.commit(
      ref,
      restore.plan.planId,
      randomUUID(),
      guard,
    );
    assert.equal(restored.durability, durability);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.equal(await readFile(restored.backupPath!, "utf8"), after);
    assert(!(await readdir(dir)).some((name) => /\.(lock|tmp)$/.test(name)));
    const undo = await writer.prepareRestore(ref, path, guard);
    await writer.commit(ref, undo.plan.planId, randomUUID(), guard);
    assert.equal(await readFile(path, "utf8"), after);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first save rolls back to a missing file when verification fails", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/writer-"));
  const path = join(dir, "models.json");
  try {
    const writer = new CatalogWriter(Date.now, async (phase) => {
      if (phase === "verify") throw new Error("fixture verify failure");
    });
    const plan = await writer.prepare(ref, path, null, after, "save", guard);
    await assert.rejects(
      writer.commit(ref, plan.planId, randomUUID(), guard),
      code("catalog_rolled_back"),
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog write rejects changed files, and post-publish failures roll back", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/writer-"));
  const path = join(dir, "models.json");
  try {
    await writeFile(path, before);
    const writer = new CatalogWriter();
    const plan = await writer.prepare(ref, path, before, after, "save", guard);
    await writeFile(path, "external edit");
    await assert.rejects(
      writer.commit(ref, plan.planId, randomUUID(), guard),
      code("catalog_conflict"),
    );
    assert.equal(await readFile(path, "utf8"), "external edit");
    await writeFile(path, before);
    const failing = new CatalogWriter(Date.now, async (phase) => {
      if (phase === "verify") throw new Error("injected failure");
    });
    const retry = await failing.prepare(
      ref,
      path,
      before,
      after,
      "save",
      guard,
    );
    await assert.rejects(
      failing.commit(ref, retry.planId, randomUUID(), guard),
      code("catalog_rolled_back"),
    );
    assert.equal(await readFile(path, "utf8"), before);
    assert(
      !(await readdir(dir)).some(
        (name) => name.endsWith(".lock") || name.endsWith(".tmp"),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new catalog is never overwritten when another process creates it", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/writer-"));
  const path = join(dir, "models.json");
  try {
    const writer = new CatalogWriter();
    const plan = await writer.prepare(ref, path, null, after, "save", guard);
    await writeFile(path, before);
    await assert.rejects(
      writer.commit(ref, plan.planId, randomUUID(), guard),
      code("catalog_conflict"),
    );
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pre-publication IO errors preserve the original and its backup", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/writer-"));
  const path = join(dir, "models.json");
  try {
    await writeFile(path, before);
    const writer = new CatalogWriter(Date.now, async (phase) => {
      if (phase === "publish")
        throw Object.assign(new Error("fixture access denied"), {
          code: "EACCES",
        });
    });
    const plan = await writer.prepare(ref, path, before, after, "save", guard);
    await assert.rejects(
      writer.commit(ref, plan.planId, randomUUID(), guard),
      (error: unknown) =>
        error instanceof SafeError &&
        error.code === "catalog_write_failed" &&
        error.failure?.stage === "publish" &&
        error.failure.systemCode === "EACCES",
    );
    assert.equal(await readFile(path, "utf8"), before);
    const files = await readdir(dir);
    assert(!files.some((name) => /\.(lock|tmp)$/.test(name)));
    const backups = files.filter((name) => name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(dir, backups[0]!), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed rollback retains both failure phases and an uncertain recovery receipt", async () => {
  const dir = await mkdtemp(resolve(".test-artifacts/writer-"));
  const path = join(dir, "models.json");
  try {
    await writeFile(path, before);
    const writer = new CatalogWriter(Date.now, async (phase) => {
      if (phase === "verify")
        throw Object.assign(new Error("fixture verification failure"), {
          code: "EIO",
        });
      if (phase === "rollback")
        throw Object.assign(new Error("fixture rollback failure"), {
          code: "EPERM",
          syscall: "rename",
        });
    });
    const plan = await writer.prepare(ref, path, before, after, "save", guard);
    await assert.rejects(
      writer.commit(ref, plan.planId, randomUUID(), guard),
      (error: unknown) =>
        error instanceof SafeError &&
        error.code === "catalog_recovery_required" &&
        error.failure?.stage === "verify" &&
        error.failure.systemCode === "EIO" &&
        error.rollbackFailure?.stage === "rollback" &&
        error.rollbackFailure.systemCode === "EPERM",
    );
    const receipt = writer.receipt(path)!;
    assert.equal(receipt.durability, "uncertain");
    assert.equal(await readFile(receipt.backupPath!, "utf8"), before);
    assert.equal(await readFile(path, "utf8"), after);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
