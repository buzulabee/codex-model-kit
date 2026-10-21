import {
  previewRowsSchema,
  catalogWritePlanSchema,
  catalogWriteReceiptSchema,
} from "../shared/catalog.js";
import { randomUUID } from "node:crypto";
import { diagnosticSchema } from "../shared/diagnostics.js";
import { serverDiagnostic } from "./diagnostics.js";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { SafeError, SecuritySession } from "../connections/envelopes.js";
import { Workbench } from "../tasks/workbench.js";
import { modelIdSchema, probePlanSchema } from "../shared/workbench.js";
import { ConnectionManager } from "../connections/manager.js";
import {
  envelopeSchema,
  publicChallengeSchema,
  referenceSchema,
  snapshotSchema,
  UI_URI,
  VERSION,
  type Snapshot,
} from "../shared/security.js";

const resultSchema = z.strictObject({
  requestId: z.string().uuid(),
  snapshot: snapshotSchema.optional(),
  challenge: publicChallengeSchema.optional(),
  plan: probePlanSchema.optional(),
  catalogJson: z
    .string()
    .max(2 * 1024 * 1024)
    .optional(),
  catalogPlan: catalogWritePlanSchema.optional(),
  catalogReceipt: catalogWriteReceiptSchema.optional(),
  error: z
    .strictObject({
      category: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      diagnostic: diagnosticSchema,
    })
    .optional(),
});
const errorMessages = {
  invalid_catalog: "目录无法安全读取或格式无效。",
  invalid_catalog_draft: "模型参数无效；请检查名称、上下文窗口和思考等级。",
  duplicate_model: "实际请求模型不能重复，请修改或取消勾选重复项。",
  unknown_metadata: "所选模型的上下文窗口或图片能力仍未知，请先编辑确认。",
  stale_reference: "实例或连接已改变，请重新读取状态；旧页面不能继续提交。",
  invalid_envelope: "加密数据未通过校验，请重新运行验证。",
  expired_or_replayed: "验证已过期或已经使用，请重新运行验证。",
  self_test_only: "安全自测只接受内置虚构数据，不接受真实凭据。",
  invalid_selection: "候选已过期或不存在，请重新读取配置并选择。",
  unsupported_connection: "该配置不能完整安全复用；请查看提示并选择手动连接。",
  http_confirmation_required: "HTTP 会明文传输凭据，必须在插件中明确确认风险。",
  only_missing_fields:
    "只能补填缺失项。需要更换已有信息时，请先选择新的手动连接。",
  invalid_credential: "凭据必须为非空可见 ASCII 字符，不能包含空白或控制字符。",
  invalid_url: "地址无效，不能含用户名、密码、查询参数或片段。",
  configuration_not_loaded: "请先在插件中读取配置候选。",
  configuration_read_failed: "本地配置未能安全读取。",
  connection_not_ready: "请先选择完整连接或补填缺失项。",
  invalid_models:
    "请选择 1–1000 个有效模型 ID；不接受重复、未知或含秘密的 ID。",
  task_running: "已有检测正在执行，请等待完成或取消。",
  task_limit: "已达到本实例安全上限；请重建连接后继续。",
  expired_plan: "确认摘要已过期或已使用，请重新打开检测确认。",
  invalid_task: "该任务不属于当前连接。",
  idempotency_conflict: "重复提交标识与原确认摘要不匹配。",
  catalog_not_writable:
    "请先在 config.toml 配置可写的 model_catalog_json 路径并重新读取。",
  catalog_conflict: "配置或目录在确认期间发生变化，请重新读取后再试。",
  config_conflict: "配置已变化，请重新读取后再试。",
  catalog_locked: "目录正被另一写入操作占用，请稍后重试。",
  catalog_write_busy: "已有目录写入正在进行。",
  expired_catalog_plan: "目录确认已过期，请重新预览。",
  catalog_backup_invalid: "备份无法安全读取或内容不匹配；未恢复。",
  catalog_no_backup: "当前实例没有可恢复的上次写入。",
  catalog_write_failed: "目录写入失败，原目录未被替换。",
  catalog_rolled_back: "写入未完成，已恢复原目录；请重新读取确认。",
  catalog_recovery_required: "目录状态不确定，请停止操作并检查目标文件与备份。",
} as const;

export const resourceMeta = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
  "openai/ui": {
    availableDisplayModes: ["inline", "fullscreen"],
    preferredDisplayMode: "inline",
  },
};
const uiMeta = { resourceUri: UI_URI, visibility: ["app"] as const };
const readonlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

export function createServer(
  html: string,
  session = new SecuritySession(),
  connections = new ConnectionManager(session),
  workbench = new Workbench(connections),
): McpServer {
  const server = new McpServer({ name: "codex-model-kit", version: VERSION });
  const safe = async (
    work: () => object | Promise<object>,
    operation = "operation",
  ): Promise<CallToolResult> => {
    const requestId = randomUUID();
    try {
      const payload = await work();
      if ("snapshot" in payload) {
        const snapshot = payload.snapshot as Snapshot;
        const failure =
          snapshot.localCatalog?.failure ?? snapshot.config?.failure;
        if (failure)
          payload.snapshot = {
            ...snapshot,
            diagnostic: serverDiagnostic(
              new SafeError(
                snapshot.localCatalog?.failure
                  ? snapshot.localCatalog.status === "invalid"
                    ? "invalid_catalog"
                    : "catalog_not_writable"
                  : "configuration_read_failed",
                failure,
              ),
              operation,
              requestId,
            ),
          };
      }
      return {
        content: [
          {
            type: "text",
            text: "模型同步工作台；只有插件内确认短期写入计划后才会修改已配置的目录，绝不修改 config.toml。",
          },
        ],
        structuredContent: { requestId, ...payload },
      };
    } catch (error) {
      const code = error instanceof SafeError ? error.code : "internal_error";
      return {
        isError: true,
        content: [
          { type: "text", text: "操作未完成，请在插件内查看安全提示。" },
        ],
        structuredContent: {
          requestId,
          error: {
            category: code,
            message:
              code === "internal_error"
                ? "操作未完成，请重新连接插件。"
                : errorMessages[code],
            retryable: code !== "self_test_only",
            diagnostic: serverDiagnostic(error, operation, requestId),
          },
        },
      };
    }
  };
  registerAppTool(
    server,
    "open_model_kit",
    {
      title: "打开 Codex 模型工具",
      description:
        "打开模型同步工作台：检查连接、编辑目录草稿、预览并确认目录写入；不修改连接配置。",
      inputSchema: z.strictObject({}),
      outputSchema: resultSchema,
      annotations: readonlyAnnotations,
      _meta: {
        ui: { resourceUri: UI_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": UI_URI,
        "openai/widgetAccessible": true,
        "openai/ui": {
          entrypoints: [{ type: "global" }, { type: "thread" }],
          preferredModelDisplayMode: "inline",
        },
      },
    },
    () => safe(() => ({ snapshot: workbench.snapshot() })),
  );
  registerAppTool(
    server,
    "read_snapshot",
    {
      title: "读取脱敏验证状态",
      description:
        "只读获取当前实例、连接 revision 和脱敏状态；不含秘密，也不自动读取配置。",
      inputSchema: z.strictObject({}),
      outputSchema: resultSchema,
      annotations: readonlyAnnotations,
      _meta: { ui: { resourceUri: UI_URI, visibility: ["model", "app"] } },
    },
    () => safe(() => ({ snapshot: workbench.snapshot() })),
  );
  registerAppTool(
    server,
    "get_self_test_key",
    {
      title: "获取本实例临时加密公钥",
      inputSchema: referenceSchema,
      outputSchema: resultSchema,
      annotations: {
        ...readonlyAnnotations,
        readOnlyHint: false,
        idempotentHint: false,
      },
      _meta: { ui: uiMeta },
    },
    (args) => safe(() => ({ challenge: session.issueChallenge(args) })),
  );
  registerAppTool(
    server,
    "submit_self_test_envelope",
    {
      title: "提交虚构数据密文（仅 App）",
      inputSchema: envelopeSchema,
      outputSchema: resultSchema,
      annotations: {
        ...readonlyAnnotations,
        readOnlyHint: false,
        idempotentHint: false,
      },
      _meta: { ui: uiMeta },
    },
    (args) =>
      safe(() => {
        connections.selfTest(args);
        return { snapshot: workbench.snapshot() };
      }),
  );
  registerAppTool(
    server,
    "reset_self_test_connection",
    {
      title: "重建验证连接（仅 App）",
      inputSchema: referenceSchema,
      outputSchema: resultSchema,
      annotations: {
        ...readonlyAnnotations,
        readOnlyHint: false,
        idempotentHint: false,
      },
      _meta: { ui: uiMeta },
    },
    (args) =>
      safe(() => {
        connections.reset(args);
        return { snapshot: workbench.snapshot() };
      }),
  );
  const appAnnotations = {
    ...readonlyAnnotations,
    readOnlyHint: false,
    idempotentHint: false,
  };
  const appTool = (
    name: string,
    title: string,
    inputSchema: z.ZodObject,
    work: (args: Record<string, unknown>) => object | Promise<object>,
  ) => {
    registerAppTool(
      server,
      name,
      {
        title,
        inputSchema,
        outputSchema: resultSchema,
        annotations: {
          ...appAnnotations,
          openWorldHint: ["refresh_models", "start_probe"].includes(name),
        },
        _meta: { ui: uiMeta },
      },
      (args) => safe(() => work(args), name),
    );
  };
  appTool(
    "load_sync",
    "只读检查现有配置和本地模型目录",
    referenceSchema,
    async (args) => {
      await connections.loadSync(referenceSchema.parse(args));
      return { snapshot: workbench.snapshot() };
    },
  );
  const previewSchema = referenceSchema.extend({ rows: previewRowsSchema });
  appTool(
    "preview_catalog",
    "预览模型目录 JSON（不写入文件）",
    previewSchema,
    (args) => {
      const input = previewSchema.parse(args);
      return { catalogJson: workbench.preview(input, input.rows) };
    },
  );
  appTool(
    "prepare_catalog_write",
    "预览目录变更并准备写入（不写文件）",
    previewSchema,
    async (args) => {
      const input = previewSchema.parse(args);
      return workbench.prepareCatalog(input, input.rows);
    },
  );
  const commitSchema = referenceSchema.extend({
    planId: z.string().uuid(),
    requestId: z.string().uuid(),
  });
  appTool(
    "commit_catalog_write",
    "确认写入已配置模型目录（仅 App）",
    commitSchema,
    async (args) => {
      const input = commitSchema.parse(args);
      return {
        catalogReceipt: await connections.commitCatalog(
          input,
          input.planId,
          input.requestId,
        ),
        snapshot: workbench.snapshot(),
      };
    },
  );
  appTool(
    "prepare_catalog_restore",
    "准备恢复上次目录（不写文件）",
    referenceSchema,
    async (args) => ({
      catalogPlan: await connections.prepareRestore(
        referenceSchema.parse(args),
      ),
    }),
  );
  appTool(
    "reload_config",
    "只读重新发现配置候选（仅 App）",
    referenceSchema,
    async (args) => ({
      snapshot: await (async () => {
        await connections.reload(referenceSchema.parse(args));
        return workbench.snapshot();
      })(),
    }),
  );
  const selectionSchema = referenceSchema.extend({
    candidateId: z.string().uuid().nullable(),
    allowHttp: z.boolean(),
    bearerOnly: z.boolean().optional(),
  });
  appTool(
    "select_connection",
    "确认配置候选或新建本次手动连接",
    selectionSchema,
    (args) => {
      const input = selectionSchema.parse(args);
      connections.select(
        input,
        input.candidateId,
        input.allowHttp,
        input.bearerOnly ?? false,
      );
      return { snapshot: workbench.snapshot() };
    },
  );
  appTool(
    "get_credential_key",
    "获取当前缺失凭据的临时加密公钥",
    referenceSchema,
    (args) => ({
      challenge: connections.credentialKey(referenceSchema.parse(args)),
    }),
  );
  const completionSchema = referenceSchema.extend({
    baseUrl: z.string().max(2048).optional(),
    envelope: envelopeSchema.optional(),
    allowHttp: z.boolean(),
  });
  appTool(
    "complete_connection",
    "仅补缺失地址或加密凭据（仅本实例）",
    completionSchema,
    (args) => {
      const input = completionSchema.parse(args);
      connections.complete(input, input);
      return { snapshot: workbench.snapshot() };
    },
  );
  appTool(
    "refresh_models",
    "主动读取模型列表（不推理）",
    referenceSchema,
    (args) => ({
      snapshot: workbench.refreshModels(referenceSchema.parse(args)),
    }),
  );
  appTool("cancel_models", "取消模型列表请求", referenceSchema, (args) => ({
    snapshot: workbench.cancelModels(referenceSchema.parse(args)),
  }));
  const manualSchema = referenceSchema.extend({ modelId: modelIdSchema });
  appTool(
    "add_manual_model",
    "添加手动模型 ID（不发请求）",
    manualSchema,
    (args) => {
      const input = manualSchema.parse(args);
      return { snapshot: workbench.addManual(input, input.modelId) };
    },
  );
  const planSchema = referenceSchema.extend({
    modelIds: z.array(modelIdSchema).min(1).max(1000),
    protocol: z.literal("responses"),
  });
  appTool(
    "prepare_probe",
    "创建检测确认摘要（不发请求）",
    planSchema,
    (args) => {
      const input = planSchema.parse(args);
      return { plan: workbench.plan(input, input.modelIds) };
    },
  );
  const startSchema = referenceSchema.extend({
    planId: z.string().uuid(),
    requestId: z.string().uuid(),
  });
  appTool("start_probe", "确认后开始检测（可能计费）", startSchema, (args) => {
    const input = startSchema.parse(args);
    return { snapshot: workbench.start(input, input.planId, input.requestId) };
  });
  const cancelSchema = referenceSchema.extend({ jobId: z.string().uuid() });
  appTool("cancel_probe", "取消当前检测任务", cancelSchema, (args) => {
    const input = cancelSchema.parse(args);
    return { snapshot: workbench.cancel(input, input.jobId) };
  });
  registerAppResource(
    server,
    "Codex 模型工具",
    UI_URI,
    { _meta: resourceMeta },
    async () => ({
      contents: [
        {
          uri: UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: resourceMeta,
        },
      ],
    }),
  );
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    workbench.close();
    previousClose?.();
  };
  return server;
}
