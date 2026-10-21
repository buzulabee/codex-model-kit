import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { diagnosticSchema } from "../src/shared/diagnostics.js";
import { join } from "node:path";
import { test } from "node:test";
import { loopbackFixture, fixtureSecret } from "./loopback-fixture.js";
import { referenceOf, snapshotSchema } from "../src/shared/security.js";
import {
  catalogWritePlanSchema,
  catalogWriteReceiptSchema,
} from "../src/shared/catalog.js";

test("bundled app confirms catalog write and restores exact original bytes", async () => {
  const f = await loopbackFixture();
  try {
    const snap = (value: Record<string, unknown>) =>
      snapshotSchema.parse(value.snapshot);
    let snapshot = snap(await f.call("open_model_kit"));
    snapshot = snap(await f.call("load_sync", referenceOf(snapshot)));
    assert.equal(snapshot.localCatalog?.status, "ready");
    const rows = snapshot.localCatalog!.models.map((model) => ({
      key: model.key,
      parameters: model.parameters,
    }));
    rows.reverse();
    const prepared = await f.call("prepare_catalog_write", {
      ...referenceOf(snapshot),
      rows,
    });
    const plan = catalogWritePlanSchema.parse(prepared.catalogPlan);
    assert.equal(plan.path, f.catalogPath);
    assert(plan.orderChanged);
    assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);
    assert(!JSON.stringify(prepared).includes(fixtureSecret));

    const configPath = join(f.home, "config.toml");
    await writeFile(configPath, f.config + "\n# changed after confirmation\n");
    const rejected = await f.call("commit_catalog_write", {
      ...referenceOf(snapshot),
      planId: plan.planId,
      requestId: randomUUID(),
    });
    assert.equal(
      (rejected.error as { category: string }).category,
      "catalog_conflict",
    );
    assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);
    await writeFile(configPath, f.config);
    snapshot = snap(await f.call("load_sync", referenceOf(snapshot)));

    const save = catalogWritePlanSchema.parse(
      (
        await f.call("prepare_catalog_write", {
          ...referenceOf(snapshot),
          rows,
        })
      ).catalogPlan,
    );
    const requestId = randomUUID();
    const input = { ...referenceOf(snapshot), planId: save.planId, requestId };
    const written = await f.call("commit_catalog_write", input);
    assert(!written.error, JSON.stringify(written.error));
    const receipt = catalogWriteReceiptSchema.parse(written.catalogReceipt);
    assert.equal(
      receipt.durability,
      process.platform === "win32" ? "file_synced" : "synced",
    );
    assert.equal(await readFile(receipt.backupPath!, "utf8"), f.catalog);
    assert.equal(await readFile(f.catalogPath, "utf8"), prepared.catalogJson);
    assert.deepEqual(
      catalogWriteReceiptSchema.parse(
        (await f.call("commit_catalog_write", input)).catalogReceipt,
      ),
      receipt,
    );
    snapshot = snap(written);

    const restore = catalogWritePlanSchema.parse(
      (await f.call("prepare_catalog_restore", referenceOf(snapshot)))
        .catalogPlan,
    );
    assert.equal(restore.action, "restore");
    const restored = await f.call("commit_catalog_write", {
      ...referenceOf(snapshot),
      planId: restore.planId,
      requestId: randomUUID(),
    });
    assert.equal(
      catalogWriteReceiptSchema.parse(restored.catalogReceipt).action,
      "restore",
    );
    assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);
    assert.equal(await readFile(configPath, "utf8"), f.config);
    assert.equal(
      await readFile(join(f.home, "auth.json"), "utf8"),
      fixtureSecret,
    );
  } finally {
    await f.close();
  }
});

test("catalog read failures expose a safe snapshot diagnostic without throwing or reading a directory", async () => {
  const f = await loopbackFixture();
  const saved = `${f.catalogPath}.fixture-original`;
  await rename(f.catalogPath, saved);
  await mkdir(f.catalogPath);
  try {
    const opened = snapshotSchema.parse(
      (await f.call("open_model_kit")).snapshot,
    );
    const result = await f.call("load_sync", referenceOf(opened));
    const snapshot = snapshotSchema.parse(result.snapshot);
    assert.equal(snapshot.localCatalog?.status, "read_error");
    const report = snapshot.diagnostic!;
    assert.equal(report.requestId, result.requestId);
    assert.equal(report.operation, "load_sync");
    assert.equal(report.failure?.rule, "not_regular");
    assert(!JSON.stringify(report).includes(f.home));
    assert(!JSON.stringify(report).includes(fixtureSecret));
  } finally {
    await rm(f.catalogPath, { recursive: true });
    await rename(saved, f.catalogPath);
    await f.close();
  }
});

test("bundled catalog failures include copyable diagnostics without local paths or credentials", async () => {
  const f = await loopbackFixture();
  const lock = `${f.catalogPath}.codex-model-kit.lock`;
  try {
    let snapshot = snapshotSchema.parse(
      (await f.call("open_model_kit")).snapshot,
    );
    snapshot = snapshotSchema.parse(
      (await f.call("load_sync", referenceOf(snapshot))).snapshot,
    );
    const prepared = await f.call("prepare_catalog_write", {
      ...referenceOf(snapshot),
      rows: snapshot.localCatalog!.models,
    });
    const plan = catalogWritePlanSchema.parse(prepared.catalogPlan);
    await writeFile(lock, "fixture lock only");
    const result = await f.call("commit_catalog_write", {
      ...referenceOf(snapshot),
      planId: plan.planId,
      requestId: randomUUID(),
    });
    const report = diagnosticSchema.parse(
      (result.error as { diagnostic: unknown }).diagnostic,
    );
    assert.equal(report.requestId, result.requestId);
    assert.equal(report.category, "catalog_locked");
    assert.equal(report.operation, "commit_catalog_write");
    assert.deepEqual(report.failure, {
      stage: "lock",
      systemCode: "EEXIST",
      syscall: "open",
    });
    assert(!JSON.stringify(report).includes(f.home));
    assert(!JSON.stringify(report).includes(fixtureSecret));
    assert.equal(await readFile(f.catalogPath, "utf8"), f.catalog);
    assert.equal(await readFile(lock, "utf8"), "fixture lock only");
  } finally {
    await unlink(lock).catch(() => undefined);
    await f.close();
  }
});
