import { z } from "zod";
import { metadataSchema } from "./catalog.js";

export const reasonCodes = [
  "ok",
  "auth",
  "quota",
  "rate_limit",
  "network",
  "timeout",
  "cancelled",
  "models_unavailable",
  "service",
  "invalid_parameters",
  "unsupported_protocol",
  "unsupported_stream",
  "non_streaming",
  "malformed_response",
  "early_eof",
  "incomplete",
  "size_limit",
  "redirect",
  "empty_output",
] as const;
export const reasonMessages: Record<(typeof reasonCodes)[number], string> = {
  ok: "Responses 基础流式检测通过。",
  auth: "鉴权或访问权限不足，无法判定模型能力。",
  quota: "额度不足，无法判定模型能力。",
  rate_limit: "请求受限，无法判定模型能力。",
  network: "网络连接未完成，无法判定模型能力。",
  timeout: "请求超时，无法判定模型能力。",
  cancelled: "本地请求已取消；不保证服务商未处理或未消耗 token。",
  models_unavailable: "模型列表接口不可用；仍可手动输入模型 ID 检测。",
  service: "服务未完成请求，无法判定模型能力。",
  invalid_parameters: "请求参数被拒绝；调整后需重新确认检测，不自动重试。",
  unsupported_protocol: "本次返回明确的接口不支持证据。",
  unsupported_stream: "本次返回明确的流式不支持证据。",
  non_streaming: "请求流式响应，但收到的是普通 JSON 响应。",
  malformed_response: "本次响应未满足预期的 Responses 事件结构。",
  early_eof: "流在正常完成事件前结束。",
  incomplete: "响应未正常完成，无法判定完整流式能力。",
  size_limit: "响应超过安全大小或事件数量限制。",
  redirect: "接口要求重定向；为保护凭据，没有跟随。",
  empty_output: "流结束但没有有效输出，不能判为通过。",
};
export function probeAdvice(reason: (typeof reasonCodes)[number]): string {
  if (reason === "ok")
    return "基础请求已通过；图片、工具调用和思考等级仍需分别验证。";
  if (reason === "auth")
    return "请在中转站确认凭据有效、模型访问权限和账户状态，再主动重测。";
  if (reason === "quota")
    return "请检查中转站余额和该模型额度，恢复额度后再主动重测。";
  if (reason === "rate_limit")
    return "请等待服务商限流窗口恢复后主动重测；本工具不会自动重试。";
  if (["network", "timeout", "service"].includes(reason))
    return "请检查中转站服务和网络是否正常，再主动重测；此结果不能证明模型不支持直连。";
  if (reason === "cancelled")
    return "可以重新确认后主动检测；取消不保证已经发出的请求未被处理或消耗 token。";
  if (reason === "redirect")
    return "请在 Codex 配置中检查接口地址是否为最终地址；本工具不会携带凭据跟随重定向。";
  if (reason === "invalid_parameters")
    return "请向中转站确认该模型是否支持 Responses 流式请求以及本次固定请求参数。";
  if (reason === "size_limit")
    return "响应触及本工具的安全上限，不能据此认定模型不支持直连。";
  return "请向中转站确认此模型的 Responses 接口及 SSE 流式支持；本工具不做路由或协议转换。可在服务恢复后主动重测。";
}
export const modelIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((id) => id === id.trim() && !/[\x00-\x1f\x7f]/.test(id));
export const probeResultSchema = z.strictObject({
  status: z.enum(["passed", "failed", "unknown"]),
  protocolResult: z.enum(["supported", "unsupported", "unknown"]),
  streamResult: z.enum(["valid", "invalid", "unknown"]),
  reasonCode: z.enum(reasonCodes),
  checkedAt: z.number().int(),
  elapsedMs: z.number().int().nonnegative(),
  firstEventMs: z.number().int().nonnegative().nullable(),
  eventCount: z.number().int().nonnegative(),
  outputObserved: z.boolean(),
  end: z.enum([
    "completed",
    "incomplete",
    "failed",
    "eof",
    "json",
    "cancelled",
    "error",
  ]),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;
export const modelSchema = z.strictObject({
  id: modelIdSchema,
  source: z.enum(["provider", "manual"]),
  owner: z.string().max(128).nullable(),
  created: z.number().int().nonnegative().nullable(),
  claims: z.array(z.string().max(160)).max(8),
  metadata: metadataSchema.optional(),
  referenceMetadata: z
    .strictObject({
      values: metadataSchema,
      source: z.enum(["endpoint-preset", "canonical-reference"]),
    })
    .optional(),
  result: probeResultSchema.nullable(),
});
export type ModelEntry = z.infer<typeof modelSchema>;
export const catalogSchema = z.strictObject({
  status: z.enum(["idle", "loading", "ready", "error"]),
  fetchedAt: z.number().int().nullable(),
  reasonCode: z.enum(reasonCodes).nullable(),
  warnings: z
    .array(z.enum(["skipped_invalid", "truncated", "pagination_unsupported"]))
    .max(3),
  models: z.array(modelSchema).max(1000),
});
export const jobSchema = z.strictObject({
  jobId: z.string().uuid(),
  requestId: z.string().uuid(),
  status: z.enum(["queued", "running", "completed", "cancelled"]),
  protocol: z.literal("responses"),
  modelIds: z.array(modelIdSchema).min(1).max(1000),
  currentModel: modelIdSchema.nullable(),
  results: z
    .array(
      z.strictObject({ modelId: modelIdSchema, result: probeResultSchema }),
    )
    .max(1000),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
});
export type Job = z.infer<typeof jobSchema>;
export const probePlanSchema = z.strictObject({
  planId: z.string().uuid(),
  expiresAt: z.number().int(),
  modelIds: z.array(modelIdSchema).min(1).max(1000),
  protocol: z.literal("responses"),
  address: z.string().max(320),
  input: z.literal("Reply with OK."),
  maxOutputTokens: z.literal(64),
  timeoutMs: z.literal(30000),
  firstEventTimeoutMs: z.literal(15000),
});
export type ProbePlan = z.infer<typeof probePlanSchema>;
export const workbenchSchema = z.strictObject({
  catalog: catalogSchema,
  jobs: z.array(jobSchema).max(32),
  activeJobId: z.string().uuid().nullable(),
});
export type WorkbenchSnapshot = z.infer<typeof workbenchSchema>;
