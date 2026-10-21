import { z } from "zod";

export const failureContextSchema = z.strictObject({
  stage: z.enum([
    "operation",
    "read_target",
    "read_config",
    "resolve_parent",
    "lock",
    "backup",
    "write_temp",
    "publish",
    "verify",
    "sync_directory",
    "rollback",
  ]),
  systemCode: z
    .enum([
      "EACCES",
      "EPERM",
      "EBUSY",
      "EEXIST",
      "ENOENT",
      "ENOTDIR",
      "EISDIR",
      "ELOOP",
      "EMLINK",
      "ENOSPC",
      "EDQUOT",
      "EROFS",
      "EXDEV",
      "EIO",
      "EINVAL",
      "ENOTSUP",
      "EOPNOTSUPP",
      "ENOSYS",
      "EMFILE",
      "ENFILE",
      "ENAMETOOLONG",
      "ENOTEMPTY",
      "UNKNOWN",
    ])
    .optional(),
  syscall: z
    .enum([
      "open",
      "read",
      "write",
      "fsync",
      "fdatasync",
      "rename",
      "link",
      "unlink",
      "chmod",
      "fchmod",
      "lstat",
      "stat",
      "fstat",
      "realpath",
      "close",
      "scandir",
    ])
    .optional(),
  rule: z
    .enum([
      "unsupported_path",
      "protected_path",
      "symbolic_link",
      "not_regular",
      "file_changed",
      "multiple_links",
      "not_owned",
      "size_limit",
      "invalid_utf8",
      "read_only",
      "invalid_json",
      "invalid_schema",
      "invalid_toml",
    ])
    .optional(),
});
export type FailureContext = z.infer<typeof failureContextSchema>;

export const diagnosticSchema = z.strictObject({
  format: z.literal(1),
  source: z.enum(["server", "ui"]),
  requestId: z.string().uuid(),
  time: z.string().datetime(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  operation: z.enum([
    "operation",
    "host_communication",
    "open_model_kit",
    "read_snapshot",
    "load_sync",
    "reload_config",
    "preview_catalog",
    "prepare_catalog_write",
    "commit_catalog_write",
    "prepare_catalog_restore",
    "refresh_models",
    "cancel_models",
    "select_connection",
    "get_credential_key",
    "complete_connection",
    "add_manual_model",
    "prepare_probe",
    "start_probe",
    "cancel_probe",
  ]),
  category: z.enum([
    "catalog_not_writable",
    "catalog_conflict",
    "config_conflict",
    "catalog_locked",
    "catalog_write_failed",
    "catalog_rolled_back",
    "catalog_recovery_required",
    "catalog_backup_invalid",
    "catalog_write_busy",
    "catalog_no_backup",
    "expired_catalog_plan",
    "invalid_catalog",
    "invalid_catalog_draft",
    "duplicate_model",
    "unknown_metadata",
    "stale_reference",
    "invalid_envelope",
    "expired_or_replayed",
    "self_test_only",
    "invalid_selection",
    "unsupported_connection",
    "http_confirmation_required",
    "only_missing_fields",
    "invalid_credential",
    "invalid_url",
    "configuration_not_loaded",
    "configuration_read_failed",
    "connection_not_ready",
    "invalid_models",
    "task_running",
    "task_limit",
    "expired_plan",
    "invalid_task",
    "idempotency_conflict",
    "internal_error",
    "host_communication_failed",
  ]),
  platform: z.enum(["win32", "darwin", "linux", "other"]).optional(),
  arch: z.enum(["x64", "arm64", "ia32", "other"]).optional(),
  node: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
  osRelease: z
    .string()
    .regex(/^[0-9A-Za-z._+-]{1,100}$/)
    .optional(),
  failure: failureContextSchema.optional(),
  rollbackFailure: failureContextSchema.optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

// Only enum members leave the backend; messages, stacks, paths and bodies never do.
export function failureContext(
  stage: FailureContext["stage"],
  error?: unknown,
): FailureContext {
  if (error && typeof error === "object") {
    const value = error as {
      failure?: unknown;
      code?: unknown;
      syscall?: unknown;
    };
    const existing = failureContextSchema.safeParse(value.failure);
    if (existing.success) return existing.data;
    const systemCode = failureContextSchema.shape.systemCode.safeParse(
      value.code,
    );
    const syscall = failureContextSchema.shape.syscall.safeParse(value.syscall);
    return {
      stage,
      ...(value.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
        ? { rule: "invalid_utf8" as const }
        : {}),
      ...(systemCode.success && systemCode.data
        ? { systemCode: systemCode.data }
        : {}),
      ...(syscall.success && syscall.data ? { syscall: syscall.data } : {}),
    };
  }
  return { stage };
}

export function clientDiagnostic(version: string): Diagnostic {
  return {
    format: 1,
    source: "ui",
    requestId: crypto.randomUUID(),
    time: new Date().toISOString(),
    version,
    operation: "host_communication",
    category: "host_communication_failed",
  };
}
