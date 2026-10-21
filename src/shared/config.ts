import { z } from "zod";
import { failureContextSchema } from "./diagnostics.js";

const maskedCredential = z
  .string()
  .regex(/^(?:[A-Za-z0-9_-]{3}\*{3}[A-Za-z0-9_-]{3}|\*{3})$/)
  .nullable()
  .optional();

export const candidateSummarySchema = z.strictObject({
  candidateId: z.string().uuid(),
  providerLabel: z.string().max(96),
  profileLabel: z.string().max(96),
  configuredDefault: z.boolean(),
  address: z.string().max(320).nullable(),
  addressPresent: z.boolean(),
  credentialPresent: z.boolean(),
  credentialHint: maskedCredential,
  authSource: z.enum(["config", "env", "missing", "unsupported"]),
  protocol: z.enum(["responses", "unknown"]),
  httpRisk: z.boolean(),
  reusable: z.boolean(),
  bearerOnlyAvailable: z.boolean().optional(),
  issues: z.array(z.string().max(80)).max(16),
});
export const discoverySummarySchema = z.strictObject({
  status: z.enum([
    "not_loaded",
    "missing",
    "empty",
    "invalid",
    "read_error",
    "loaded",
  ]),
  homeSource: z.enum(["default", "CODEX_HOME"]),
  candidates: z.array(candidateSummarySchema).max(128),
  warnings: z.array(z.string().max(80)).max(64),
  activityKnown: z.literal(false),
  failure: failureContextSchema.optional(),
});
export const connectionSummarySchema = z.strictObject({
  source: z.enum(["manual", "config", "config+manual"]),
  providerLabel: z.string().max(96),
  profileLabel: z.string().max(96),
  address: z.string().max(320).nullable(),
  addressPresent: z.boolean(),
  credentialPresent: z.boolean(),
  credentialHint: maskedCredential,
  credentialSource: z.enum(["missing", "config", "env", "session"]),
  httpRisk: z.boolean(),
  httpConfirmed: z.boolean(),
  protocol: z.enum(["responses", "unknown"]),
  ready: z.boolean(),
  authMode: z.enum(["provider", "explicit_bearer"]).optional(),
});
export type CandidateSummary = z.infer<typeof candidateSummarySchema>;
export type DiscoverySummary = z.infer<typeof discoverySummarySchema>;
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;
export const issueMessages: Record<string, string> = {
  invalid_url: "地址无效；不能包含用户名、密码、查询参数或片段。",
  missing_url: "缺少有效地址。",
  missing_credential: "缺少凭据；可以在插件内加密补填。",
  invalid_credential: "配置中的凭据格式无效，不能复用。",
  invalid_env_key: "env_key 不是合法的环境变量名；未读取变量。",
  missing_env_credential:
    "env_key 指定的变量在插件进程中缺失或为空。终端临时变量可能不会传入桌面应用。",
  auth_command: "发现命令鉴权；本工具不执行鉴权命令。",
  account_auth: "发现账号鉴权标记；本工具不读取账号文件。",
  unsupported_auth:
    "发现混合、命令或账号鉴权；不能自动复用，不执行命令或读取账号文件。",
  unsupported_options: "发现额外请求配置，首版不能完整复用，请选择手动连接。",
  unknown_protocol: "配置协议未知或不适用，后续检测须另行明确范围。",
  reserved_provider: "内置 provider 不能作为自定义连接复用，请选择手动连接。",
  legacy_profiles:
    "发现旧 profiles/profile 配置；当前版本不把它们当活动 profile。",
  legacy_profile_conflict: "独立 profile 与旧同名配置冲突，已阻止复用。",
  profile_invalid: "部分独立 profile 配置无效，未作为候选。",
  profile_read_error: "部分独立 profile 无法安全读取，未作为候选。",
  discovery_limit: "候选或文件数量超出安全上限；未读取超出部分。",
  incomplete_config: "配置字段结构不适用，未推测或拼接连接。",
};

export function credentialDisplay(
  connection?: ConnectionSummary | null,
  candidate?: CandidateSummary,
) {
  const env = connection?.credentialPresent
    ? connection.credentialSource === "env"
    : candidate?.authSource === "env";
  const bearer =
    connection?.credentialPresent || candidate?.bearerOnlyAvailable;
  const label = env
    ? "env_key（环境变量）"
    : bearer
      ? "experimental_bearer_token"
      : candidate?.issues.includes("auth_command")
        ? "auth（命令鉴权）"
        : candidate?.issues.includes("account_auth")
          ? "账号鉴权"
          : candidate?.authSource === "unsupported"
            ? "鉴权配置"
            : "experimental_bearer_token";
  const detail = connection?.credentialPresent
    ? env
      ? "已复用 env_key 指定的环境变量；只显示脱敏片段。"
      : "已复用显式 Bearer；只显示脱敏片段。"
    : candidate?.issues.includes("missing_env_credential")
      ? issueMessages.missing_env_credential!
      : candidate?.issues.includes("invalid_env_key")
        ? issueMessages.invalid_env_key!
        : candidate?.issues.includes("invalid_credential")
          ? issueMessages.invalid_credential!
          : candidate?.authSource === "unsupported"
            ? "鉴权配置不能安全复用；不读取账号文件、不执行鉴权命令。"
            : "请在同一 provider 中配置显式 Bearer 或单独的 env_key。环境变量必须对插件进程可见。";
  return { label, detail };
}
