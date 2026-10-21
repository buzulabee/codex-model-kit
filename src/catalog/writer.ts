import { constants } from "node:fs";
import {
  open,
  realpath,
  link,
  rename,
  unlink,
  lstat,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { SafeError } from "../connections/envelopes.js";
import {
  assertCatalogPath,
  openCatalogRead,
} from "../filesystem/safe-files.js";
import { failureContext, type FailureContext } from "../shared/diagnostics.js";
import type {
  CatalogWritePlan,
  CatalogWriteReceipt,
} from "../shared/catalog.js";
import type { Reference } from "../shared/security.js";
import { readCatalogFile } from "./store.js";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const missing = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";
const binding = (ref: Reference) =>
  JSON.stringify([ref.instanceId, ref.connectionId, ref.connectionRevision]);
type FileState = {
  text: string;
  stamp: string;
  mode: number;
} | null;
type Pending = {
  public: CatalogWritePlan;
  reference: string;
  parent: string;
  before: FileState;
  after: string | null;
};
type Recovery = {
  receipt: CatalogWriteReceipt;
  previousHash: string | null;
  currentHash: string | null;
};

async function state(path: string): Promise<FileState> {
  let file: FileHandle | undefined;
  try {
    file = await openCatalogRead(path);
    const before = await file.stat();
    if (process.platform === "win32" && !(before.mode & 0o200))
      throw new SafeError("catalog_not_writable", {
        stage: "read_target",
        rule: "read_only",
      });
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 2 * 1024 * 1024 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw new SafeError("catalog_not_writable", {
        stage: "read_target",
        rule: !before.isFile()
          ? "not_regular"
          : before.nlink !== 1
            ? "multiple_links"
            : before.size > 2 * 1024 * 1024
              ? "size_limit"
              : "not_owned",
      });
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await file.stat();
    const stamp = (s: typeof before) =>
      [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode].join(":");
    if (length > 2 * 1024 * 1024 || stamp(before) !== stamp(after))
      throw new SafeError("catalog_conflict");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
    return {
      text,
      stamp: `${stamp(after)}:${digest(text)}`,
      mode: before.mode & 0o777,
    };
  } catch (error) {
    if (missing(error)) return null;
    if (error instanceof SafeError) throw error;
    throw new SafeError(
      "catalog_not_writable",
      failureContext("read_target", error),
    );
  } finally {
    await file?.close();
  }
}
const same = (a: FileState, b: FileState) => a?.stamp === b?.stamp;
async function exclusive(
  path: string,
  text: string,
  mode = 0o600,
): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text, "utf8");
    await file.chmod(mode);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function syncCatalogDirectory(
  parent: string,
  platform: NodeJS.Platform = process.platform,
  openDirectory: (
    path: string,
    flags: number,
  ) => Promise<Pick<FileHandle, "sync" | "close">> = open,
): Promise<boolean> {
  // Directory fsync is unsupported on Windows. File fsync remains mandatory.
  if (platform === "win32") return false;
  const directory = await openDirectory(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return true;
}
function diff(before: string | null, after: string | null) {
  const models = (text: string | null): Record<string, unknown>[] =>
    text ? JSON.parse(text).models : [];
  const oldModels = models(before),
    newModels = models(after);
  const old = new Map(oldModels.map((m) => [m.slug as string, m]));
  const next = new Map(newModels.map((m) => [m.slug as string, m]));
  return {
    modelCount: newModels.length,
    added: [...next.keys()].filter((id) => !old.has(id)),
    removed: [...old.keys()].filter((id) => !next.has(id)),
    changed: [...next.keys()].filter(
      (id) =>
        old.has(id) &&
        JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id)),
    ),
    orderChanged:
      JSON.stringify([...old.keys()]) !== JSON.stringify([...next.keys()]),
  };
}

// Paths and payloads are backend-owned. A commit accepts only an opaque, expiring plan.
export class CatalogWriter {
  #plans = new Map<string, Pending>();
  #requests = new Map<
    string,
    { planId: string; receipt: CatalogWriteReceipt }
  >();
  #recovery: Recovery | null = null;
  #busy = false;
  constructor(
    readonly now: () => number = Date.now,
    readonly checkpoint: (
      phase: "backup" | "publish" | "verify" | "rollback",
    ) => Promise<void> = async () => {},
  ) {}
  invalidate(): void {
    this.#plans.clear();
  }
  receipt(path: string | null): CatalogWriteReceipt | undefined {
    return this.#recovery?.receipt.path === path
      ? structuredClone(this.#recovery.receipt)
      : undefined;
  }
  async prepare(
    reference: Reference,
    path: string,
    original: string | null,
    after: string | null,
    action: CatalogWritePlan["action"],
    guard: () => Promise<void>,
  ): Promise<CatalogWritePlan> {
    if (this.#busy) throw new SafeError("catalog_write_busy");
    if (path.length > 1024)
      throw new SafeError("catalog_not_writable", {
        stage: "read_target",
        rule: "unsupported_path",
      });
    assertCatalogPath(path);
    const parent = await realpath(dirname(path)).catch((error) => {
      throw new SafeError(
        "catalog_not_writable",
        failureContext("resolve_parent", error),
      );
    });
    const before = await state(path);
    if ((before?.text ?? null) !== original)
      throw new SafeError("catalog_conflict");
    await guard();
    for (const [id, plan] of this.#plans)
      if (plan.public.expiresAt <= this.now()) this.#plans.delete(id);
    if (this.#plans.size >= 8)
      this.#plans.delete(this.#plans.keys().next().value!);
    const plan: CatalogWritePlan = {
      planId: randomUUID(),
      expiresAt: this.now() + 5 * 60_000,
      action,
      path,
      createsFile: before === null,
      removesFile: after === null,
      ...diff(original, after),
    };
    this.#plans.set(plan.planId, {
      public: plan,
      reference: binding(reference),
      parent,
      before,
      after,
    });
    return structuredClone(plan);
  }
  async prepareRestore(
    reference: Reference,
    path: string,
    guard: () => Promise<void>,
  ) {
    const recovery = this.#recovery;
    if (!recovery || recovery.receipt.path !== path)
      throw new SafeError("catalog_no_backup");
    const current = await state(path);
    if ((current ? digest(current.text) : null) !== recovery.currentHash)
      throw new SafeError("catalog_conflict");
    let json: string | null = null;
    if (recovery.receipt.backupPath) {
      try {
        json = await readCatalogFile(recovery.receipt.backupPath);
      } catch (error) {
        throw new SafeError(
          "catalog_backup_invalid",
          failureContext("backup", error),
        );
      }
      if (digest(json) !== recovery.previousHash)
        throw new SafeError("catalog_backup_invalid");
    }
    return {
      plan: await this.prepare(
        reference,
        path,
        current?.text ?? null,
        json,
        "restore",
        guard,
      ),
      json,
    };
  }
  async commit(
    reference: Reference,
    planId: string,
    requestId: string,
    guard: () => Promise<void>,
  ): Promise<CatalogWriteReceipt> {
    const previous = this.#requests.get(requestId);
    if (previous) {
      if (previous.planId !== planId)
        throw new SafeError("idempotency_conflict");
      await guard();
      return structuredClone(previous.receipt);
    }
    if (this.#busy) throw new SafeError("catalog_write_busy");
    const plan = this.#plans.get(planId);
    if (!plan || plan.public.expiresAt <= this.now()) {
      this.#plans.delete(planId);
      throw new SafeError("expired_catalog_plan");
    }
    if (plan.reference !== binding(reference))
      throw new SafeError("stale_reference");
    this.#plans.delete(planId);
    this.#busy = true;
    const path = plan.public.path;
    const lockPath = `${path}.codex-model-kit.lock`;
    const tempPath = `${path}.codex-model-kit-${randomUUID()}.tmp`;
    const backupPath = plan.before
      ? `${path}.codex-model-kit-${randomUUID()}.bak`
      : null;
    let lock: FileHandle | undefined;
    let lockInode: number | undefined;
    let tempOwned = false,
      published = false;
    let stage: FailureContext["stage"] = "verify";
    const check = async () => {
      await guard();
      if (
        (await realpath(dirname(path))) !== plan.parent ||
        !same(await state(path), plan.before)
      )
        throw new SafeError("catalog_conflict");
    };
    try {
      await check();
      stage = "lock";
      try {
        lock = await open(
          lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        lockInode = (await lock.stat()).ino;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
          throw new SafeError("catalog_locked", failureContext(stage, error));
        throw error;
      }
      await check();
      if (backupPath) {
        stage = "backup";
        await this.checkpoint("backup");
        await exclusive(backupPath, plan.before!.text);
        if ((await readCatalogFile(backupPath)) !== plan.before!.text)
          throw new SafeError("catalog_backup_invalid");
        stage = "sync_directory";
        await syncCatalogDirectory(plan.parent);
      }
      if (plan.after !== null) {
        stage = "write_temp";
        // Set ownership before IO so a failed write/fsync also cleans up our temp file.
        tempOwned = true;
        await exclusive(tempPath, plan.after, plan.before?.mode ?? 0o600);
      }
      stage = "publish";
      await this.checkpoint("publish");
      await check();
      if (plan.after === null) {
        await unlink(path);
      } else if (plan.before === null) {
        // A first save must never clobber a file that appeared after confirmation.
        await link(tempPath, path);
        published = true;
        // Drop our staging link before checking the single-link safety invariant.
        await unlink(tempPath);
        tempOwned = false;
      } else {
        await rename(tempPath, path);
        tempOwned = false;
      }
      published = true;
      stage = "verify";
      await this.checkpoint("verify");
      const written = await state(path);
      if ((written?.text ?? null) !== plan.after)
        throw new SafeError("catalog_recovery_required");
      stage = "sync_directory";
      const directorySynced = await syncCatalogDirectory(plan.parent);
      const receipt: CatalogWriteReceipt = {
        requestId,
        action: plan.public.action,
        path,
        backupPath,
        savedAt: this.now(),
        modelCount: plan.public.modelCount,
        durability: directorySynced ? "synced" : "file_synced",
      };
      this.#recovery = {
        receipt,
        previousHash: plan.before ? digest(plan.before.text) : null,
        currentHash: plan.after === null ? null : digest(plan.after),
      };
      if (this.#requests.size >= 32)
        this.#requests.delete(this.#requests.keys().next().value!);
      this.#requests.set(requestId, { planId, receipt });
      this.#plans.clear();
      return structuredClone(receipt);
    } catch (error) {
      const failure = failureContext(stage, error);
      if (published) {
        try {
          await this.checkpoint("rollback");
          const current = await state(path);
          if (
            (current?.text ?? null) !== plan.after ||
            (await realpath(dirname(path))) !== plan.parent
          )
            throw new SafeError("catalog_conflict");
          if (plan.before) {
            // Use a fresh exclusive temp; the failed publish may already have consumed its file.
            const rollbackPath = `${path}.codex-model-kit-${randomUUID()}.tmp`;
            try {
              await exclusive(rollbackPath, plan.before.text, plan.before.mode);
              if (plan.after === null) await link(rollbackPath, path);
              else await rename(rollbackPath, path);
            } finally {
              await unlink(rollbackPath).catch(() => undefined);
            }
          } else await unlink(path);
          await syncCatalogDirectory(plan.parent);
          if ((await state(path))?.text !== plan.before?.text)
            throw new SafeError("catalog_recovery_required");
        } catch (rollbackError) {
          this.#recovery = {
            receipt: {
              requestId,
              action: plan.public.action,
              path,
              backupPath,
              savedAt: this.now(),
              modelCount: plan.public.modelCount,
              durability: "uncertain",
            },
            previousHash: plan.before ? digest(plan.before.text) : null,
            currentHash: plan.after === null ? null : digest(plan.after),
          };
          throw new SafeError(
            "catalog_recovery_required",
            failure,
            failureContext("rollback", rollbackError),
          );
        }
        throw new SafeError("catalog_rolled_back", failure);
      }
      if (error instanceof SafeError)
        throw new SafeError(error.code, failure, error.rollbackFailure);
      throw new SafeError("catalog_write_failed", failure);
    } finally {
      if (tempOwned) await unlink(tempPath).catch(() => undefined);
      await lock?.close().catch(() => undefined);
      if (lockInode !== undefined) {
        const current = await lstat(lockPath).catch(() => null);
        if (current?.ino === lockInode)
          await unlink(lockPath).catch(() => undefined);
      }
      this.#busy = false;
    }
  }
}
