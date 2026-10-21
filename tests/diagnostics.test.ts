import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { serverDiagnostic } from "../src/server/diagnostics.js";
import { SafeError } from "../src/connections/envelopes.js";
import { diagnosticSchema, failureContext } from "../src/shared/diagnostics.js";

const secret = "FAKE-DIAGNOSTIC-SECRET-NOT-REAL";
test("diagnostics retain allowlisted OS facts without messages, stacks, paths, URLs or unknown fields", () => {
  const raw = Object.assign(new Error(secret), {
    code: "EACCES",
    syscall: "rename",
    path: `C:\\Users\\${secret}`,
    dest: secret,
    response: secret,
  });
  const error = new SafeError(
    "catalog_write_failed",
    failureContext("publish", raw),
  );
  const id = randomUUID();
  const report = serverDiagnostic(error, "commit_catalog_write", id);
  assert.equal(report.requestId, id);
  assert.deepEqual(report.failure, {
    stage: "publish",
    systemCode: "EACCES",
    syscall: "rename",
  });
  assert.equal(report.operation, "commit_catalog_write");
  assert.equal(report.node, process.versions.node);
  assert(diagnosticSchema.safeParse(report).success);
  assert(!JSON.stringify(report).includes(secret));
  assert(!diagnosticSchema.safeParse({ ...report, stack: secret }).success);
  assert.deepEqual(
    failureContext("operation", {
      code: secret,
      syscall: secret,
      message: secret,
      failure: { stage: "backup", path: secret },
    }),
    { stage: "operation" },
  );
  assert(
    !JSON.stringify(serverDiagnostic(raw, secret, randomUUID())).includes(
      secret,
    ),
  );
});

test("rollback diagnostics retain both failures without leaking either original exception", () => {
  const report = serverDiagnostic(
    new SafeError(
      "catalog_recovery_required",
      failureContext("verify", { code: "EIO", message: secret }),
      failureContext("rollback", {
        code: "EPERM",
        syscall: "rename",
        message: secret,
      }),
    ),
    "commit_catalog_write",
    randomUUID(),
  );
  assert.equal(report.failure?.stage, "verify");
  assert.equal(report.rollbackFailure?.systemCode, "EPERM");
  assert(!JSON.stringify(report).includes(secret));
});
