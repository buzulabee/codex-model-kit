import { metadataSchema, efforts } from "../shared/catalog.js";
import { endpoint } from "../config/url.js";
import {
  modelIdSchema,
  type ModelEntry,
  type ProbeResult,
} from "../shared/workbench.js";

type Reason = ProbeResult["reasonCode"];
export class ProviderFailure extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}
export type Material = { baseUrl: string; credential: string };
export type Fetcher = typeof fetch;
const MAX_BODY = 2 * 1024 * 1024;
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export async function boundedText(
  response: Response,
  limit = MAX_BODY,
): Promise<string> {
  if (!response.body) throw new ProviderFailure("malformed_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new ProviderFailure("size_limit");
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function errorReason(
  response: Response,
  isModels = false,
): Promise<Reason> {
  let code = "";
  try {
    const data = object(JSON.parse(await boundedText(response, 64 * 1024)));
    const error = object(data?.error);
    // Never display raw messages, bodies or unknown codes (they may echo credentials).
    code =
      typeof error?.code === "string"
        ? error.code
        : typeof error?.type === "string"
          ? error.type
          : "";
  } catch {
    /* Classify conservatively using status when safe fields are unavailable. */
  }
  return classifyError(code, response.status, isModels);
}
// Match only known machine codes; unknown upstream text never leaves the backend.
export function classifyError(
  code: unknown,
  status = 0,
  isModels = false,
): Reason {
  if (status >= 300 && status < 400) return "redirect";
  if (
    [
      "insufficient_quota",
      "quota_exceeded",
      "billing_hard_limit_reached",
    ].includes(String(code))
  )
    return "quota";
  if (["rate_limit_exceeded", "rate_limit_error"].includes(String(code)))
    return "rate_limit";
  if (
    status === 401 ||
    status === 403 ||
    ["invalid_api_key", "authentication_error", "permission_denied"].includes(
      String(code),
    )
  )
    return "auth";
  if (status === 429) return "rate_limit";
  if (isModels && [404, 405, 501].includes(status)) return "models_unavailable";
  if (["unsupported_endpoint", "unsupported_protocol"].includes(String(code)))
    return "unsupported_protocol";
  if (["stream_not_supported", "unsupported_stream"].includes(String(code)))
    return "unsupported_stream";
  if (
    [
      "invalid_request_error",
      "invalid_parameter",
      "unsupported_parameter",
    ].includes(String(code)) ||
    status === 400 ||
    status === 422
  )
    return "invalid_parameters";
  return "service";
}

export async function request(
  material: Material,
  path: "models" | "responses",
  signal: AbortSignal,
  fetcher: Fetcher,
  body?: object,
): Promise<Response> {
  try {
    return await fetcher(endpoint(material.baseUrl, path), {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${material.credential}`,
        Accept: body ? "text/event-stream" : "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal,
    });
  } catch {
    throw new ProviderFailure(signal.aborted ? "cancelled" : "network");
  }
}
function safeText(value: unknown, secret: string, max: number): string | null {
  return typeof value === "string" &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    !value.includes(secret)
    ? value
    : null;
}
export function normalizeModels(
  raw: unknown,
  credential: string,
): {
  models: ModelEntry[];
  warnings: ("skipped_invalid" | "truncated" | "pagination_unsupported")[];
} {
  const data = object(raw);
  if (!data || !Array.isArray(data.data))
    throw new ProviderFailure("malformed_response");
  const models: ModelEntry[] = [],
    warnings = new Set<
      "skipped_invalid" | "truncated" | "pagination_unsupported"
    >(),
    seen = new Set<string>();
  if (data.has_more === true || data.next_page || data.next)
    warnings.add("pagination_unsupported");
  for (const entry of data.data) {
    if (models.length >= 1000) {
      warnings.add("truncated");
      break;
    }
    const row = object(entry);
    const id = modelIdSchema.safeParse(row?.id);
    if (!row || !id.success || id.data.includes(credential)) {
      warnings.add("skipped_invalid");
      continue;
    }
    if (seen.has(id.data)) continue;
    seen.add(id.data);
    const claims: string[] = [];
    // Deliberately no inference from model names or arbitrary provider JSON.
    for (const key of [
      "context_window",
      "max_output_tokens",
      "supports_streaming",
      "supports_tools",
    ]) {
      const value = row[key];
      if (
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      )
        claims.push(`${key}: ${String(value)}`);
    }
    const metadata = metadataSchema.safeParse({
      ...(Number.isSafeInteger(row.context_window) &&
      Number(row.context_window) >= 1024 &&
      Number(row.context_window) <= 10_000_000
        ? { contextWindow: row.context_window }
        : {}),
      ...(Array.isArray(row.input_modalities) &&
      row.input_modalities.every((v) => v === "text" || v === "image")
        ? { images: row.input_modalities.includes("image") }
        : typeof row.supports_images === "boolean"
          ? { images: row.supports_images }
          : {}),
      ...(Array.isArray(row.supported_reasoning_levels) &&
      row.supported_reasoning_levels.length <= 8 &&
      row.supported_reasoning_levels.every((v) =>
        efforts.includes(
          (typeof v === "string"
            ? v
            : object(v)?.effort) as (typeof efforts)[number],
        ),
      )
        ? {
            reasoningLevels: [
              ...new Set(
                row.supported_reasoning_levels.map((v) =>
                  typeof v === "string" ? v : object(v)?.effort,
                ),
              ),
            ],
          }
        : {}),
    });
    models.push({
      id: id.data,
      source: "provider",
      owner: safeText(row.owned_by, credential, 128),
      created:
        typeof row.created === "number" &&
        Number.isSafeInteger(row.created) &&
        row.created >= 0
          ? row.created
          : null,
      claims,
      ...(metadata.success && Object.keys(metadata.data).length
        ? { metadata: metadata.data }
        : {}),
      result: null,
    });
  }
  return { models, warnings: [...warnings] };
}
export async function fetchModels(
  material: Material,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
) {
  const response = await request(material, "models", signal, fetcher);
  if (!response.ok)
    throw new ProviderFailure(await errorReason(response, true));
  let raw: unknown;
  try {
    raw = JSON.parse(await boundedText(response));
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure(
      signal.aborted ? "cancelled" : "malformed_response",
    );
  }
  if (signal.aborted) throw new ProviderFailure("cancelled");
  return normalizeModels(raw, material.credential);
}
