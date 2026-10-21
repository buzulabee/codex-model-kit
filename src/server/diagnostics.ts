import { release } from "node:os";
import {
  diagnosticSchema,
  failureContext,
  type Diagnostic,
} from "../shared/diagnostics.js";
import { VERSION } from "../shared/security.js";
import { SafeError } from "../connections/envelopes.js";

export function serverDiagnostic(
  error: unknown,
  operation: string,
  requestId: string,
): Diagnostic {
  const osRelease = release();
  const parsedOperation = diagnosticSchema.shape.operation.safeParse(operation);
  return diagnosticSchema.parse({
    format: 1,
    source: "server",
    requestId,
    time: new Date().toISOString(),
    version: VERSION,
    operation: parsedOperation.success ? parsedOperation.data : "operation",
    category: error instanceof SafeError ? error.code : "internal_error",
    platform: ["win32", "darwin", "linux"].includes(process.platform)
      ? process.platform
      : "other",
    arch: ["x64", "arm64", "ia32"].includes(process.arch)
      ? process.arch
      : "other",
    node: process.versions.node,
    ...(diagnosticSchema.shape.osRelease.safeParse(osRelease).success
      ? { osRelease }
      : {}),
    failure: failureContext("operation", error),
    ...(error instanceof SafeError && error.rollbackFailure
      ? { rollbackFailure: error.rollbackFailure }
      : {}),
  });
}
