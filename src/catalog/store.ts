import { z } from "zod";
import { isAbsolute } from "node:path";
import { catalogPathIssue, openCatalogRead } from "../filesystem/safe-files.js";
import { failureContext } from "../shared/diagnostics.js";
import { SafeError } from "../connections/envelopes.js";
import {
  modelParametersSchema,
  previewRowsSchema,
  efforts,
  type LocalCatalog,
  type ModelParameters,
} from "../shared/catalog.js";

type JsonObject = Record<string, unknown>;
const obj = (v: unknown): v is JsonObject =>
  !!v && typeof v === "object" && !Array.isArray(v);
const LIMIT = 2 * 1024 * 1024;
const unsafeKey =
  /^(?:__proto__|prototype|constructor|auth|authorization|api[_-]?key|token|experimental_bearer_token|password|secret|headers|env_key)$/i;
// Required structural fields in Codex rust-v0.159.0 ModelInfo. Preserve safe
// extension fields, but never label an incomplete core entry as a usable catalog.
const coreModelSchema = z.object({
  slug: z.string(),
  display_name: z.string(),
  supported_reasoning_levels: z.array(
    z.object({ effort: z.enum(efforts), description: z.string() }),
  ),
  shell_type: z.enum([
    "unified_exec",
    "disabled",
    "default",
    "local",
    "shell_command",
  ]),
  visibility: z.enum(["list", "hide", "none"]),
  supported_in_api: z.boolean(),
  priority: z.number().int().min(-2147483648).max(2147483647),
  support_verbosity: z.boolean(),
  truncation_policy: z.object({
    mode: z.enum(["tokens", "bytes"]),
    limit: z.number().int(),
  }),
  experimental_supported_tools: z.array(z.string()),
});
export function safeCatalogValue(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): boolean {
  if (depth > 24) return false;
  if (typeof value === "string")
    return !secrets.some((s) => s && value.includes(s));
  if (Array.isArray(value))
    return value.every((v) => safeCatalogValue(v, secrets, depth + 1));
  if (obj(value))
    return Object.entries(value).every(
      ([k, v]) =>
        !unsafeKey.test(k) &&
        !secrets.some((s) => s && k.includes(s)) &&
        safeCatalogValue(v, secrets, depth + 1),
    );
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
export async function readCatalogFile(path: string): Promise<string> {
  // Only the path discovered from config, never a UI-controlled path. No auth/config read through this API.
  if (catalogPathIssue(path)) throw new SafeError("invalid_catalog");
  let file;
  try {
    file = await openCatalogRead(path);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIMIT)
      throw new SafeError("invalid_catalog");
    const buf = Buffer.alloc(LIMIT + 1);
    let size = 0;
    while (size < buf.length) {
      const read = await file.read(buf, size, buf.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > LIMIT) throw new SafeError("invalid_catalog");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buf.subarray(0, size),
    );
  } finally {
    await file?.close();
  }
}
function parameters(row: JsonObject): ModelParameters {
  const levels = row.supported_reasoning_levels;
  if (
    !Array.isArray(levels) ||
    levels.some(
      (v) => !obj(v) || !efforts.includes(v.effort as (typeof efforts)[number]),
    )
  )
    throw new SafeError("invalid_catalog");
  if (
    row.input_modalities !== undefined &&
    (!Array.isArray(row.input_modalities) ||
      row.input_modalities.some((v) => v !== "text" && v !== "image"))
  )
    throw new SafeError("invalid_catalog");
  return modelParametersSchema.parse({
    displayName: row.display_name,
    requestModel: row.slug,
    contextWindow: row.context_window ?? null,
    reasoningLevels: levels.map((v) => (v as JsonObject).effort),
    defaultReasoning: row.default_reasoning_level ?? null,
    images: Array.isArray(row.input_modalities)
      ? row.input_modalities.includes("image")
      : null,
  });
}
export class CatalogStore {
  #summary: LocalCatalog = { status: "not_loaded", path: null, models: [] };
  #raw: JsonObject | null = null;
  #originalText: string | null = null;
  originalText(): string | null {
    return this.#originalText;
  }
  summary(): LocalCatalog {
    return structuredClone(this.#summary);
  }
  async load(
    path: unknown,
    secrets: readonly string[],
    reader = readCatalogFile,
  ): Promise<void> {
    this.#raw = null;
    this.#originalText = null;
    this.#summary = { status: "not_configured", path: null, models: [] };
    if (path === undefined) return;
    if (
      typeof path !== "string" ||
      !path.trim() ||
      path.length > 1024 ||
      /[\x00-\x1f\x7f]/.test(path) ||
      !safeCatalogValue(path, secrets)
    ) {
      this.#summary.status = "invalid";
      this.#summary.failure = { stage: "read_target", rule: "invalid_schema" };
      return;
    }
    this.#summary.path = path;
    if (!isAbsolute(path)) {
      this.#summary.status = "relative_path";
      return;
    }
    const pathIssue = catalogPathIssue(path);
    if (pathIssue) {
      this.#summary.status = "invalid";
      this.#summary.failure = { stage: "read_target", rule: pathIssue };
      return;
    }
    let raw: string;
    try {
      raw = await reader(path);
    } catch (error) {
      this.#summary.status =
        obj(error) && error.code === "ENOENT" ? "missing" : "read_error";
      if (this.#summary.status === "read_error")
        this.#summary.failure = failureContext("read_target", error);
      return;
    }
    try {
      if (Buffer.byteLength(raw) > LIMIT)
        throw new SafeError("invalid_catalog");
      const data: unknown = JSON.parse(raw);
      if (
        !obj(data) ||
        !Array.isArray(data.models) ||
        !data.models.length ||
        data.models.length > 1000 ||
        !safeCatalogValue(data, secrets)
      )
        throw new SafeError("invalid_catalog");
      const models = data.models.map((row) => {
        if (!obj(row) || !coreModelSchema.safeParse(row).success)
          throw new SafeError("invalid_catalog");
        return { key: String(row.slug), parameters: parameters(row) };
      });
      if (new Set(models.map((v) => v.key)).size !== models.length)
        throw new SafeError("invalid_catalog");
      this.#raw = data;
      this.#originalText = raw;
      this.#summary = { status: "ready", path, models };
    } catch (error) {
      this.#summary.status = "invalid";
      this.#summary.failure = {
        stage: "read_target",
        rule: error instanceof SyntaxError ? "invalid_json" : "invalid_schema",
      };
    }
  }
  preview(
    raw: unknown,
    allowed: ReadonlySet<string>,
    secrets: readonly string[],
  ): string {
    const rows = previewRowsSchema.safeParse(raw);
    if (!rows.success) throw new SafeError("invalid_catalog_draft");
    if (
      !safeCatalogValue(rows.data, secrets) ||
      rows.data.some((r) => !allowed.has(r.key))
    )
      throw new SafeError("invalid_catalog_draft");
    if (
      new Set(rows.data.map((r) => r.key)).size !== rows.data.length ||
      new Set(rows.data.map((r) => r.parameters.requestModel)).size !==
        rows.data.length
    )
      throw new SafeError("duplicate_model");
    const originals = new Map(
      ((this.#raw?.models as JsonObject[]) ?? []).map((r) => [r.slug, r]),
    );
    const models = rows.data.map(({ key, parameters: p }, priority) => {
      if (p.contextWindow === null || p.images === null)
        throw new SafeError("unknown_metadata");
      const original = originals.get(key);
      // Neutral minimal structural defaults, not a claim of model/tool compatibility. No copied vendor instructions.
      const row: JsonObject = original
        ? structuredClone(original)
        : {
            description: null,
            shell_type: "shell_command",
            visibility: "list",
            supported_in_api: true,
            priority,
            support_verbosity: false,
            default_verbosity: null,
            apply_patch_tool_type: "freeform",
            truncation_policy: { mode: "tokens", limit: 10000 },
            experimental_supported_tools: [],
            supports_parallel_tool_calls: false,
            base_instructions:
              "You are a coding assistant. Help the user with their coding tasks.",
          };
      // The confirmed UI order governs both array position and Codex menu priority.
      row.priority = priority;
      row.slug = p.requestModel;
      row.display_name = p.displayName;
      row.context_window = p.contextWindow;
      if (!original || p.contextWindow !== original.context_window) {
        row.max_context_window = p.contextWindow;
        row.auto_compact_token_limit = null;
      }
      row.default_reasoning_level = p.defaultReasoning;
      row.supported_reasoning_levels = p.reasoningLevels.map((effort) => ({
        effort,
        description:
          (
            original?.supported_reasoning_levels as JsonObject[] | undefined
          )?.find((v) => v.effort === effort)?.description ?? effort,
      }));
      row.input_modalities = p.images ? ["text", "image"] : ["text"];
      if (!p.images && row.supports_image_detail_original === true)
        row.supports_image_detail_original = false;
      if (!coreModelSchema.safeParse(row).success)
        throw new SafeError("invalid_catalog_draft");
      return row;
    });
    const result = { ...this.#raw, models };
    const json = JSON.stringify(result, null, 2);
    if (Buffer.byteLength(json) > LIMIT || !safeCatalogValue(result, secrets))
      throw new SafeError("invalid_catalog_draft");
    return json;
  }
}
