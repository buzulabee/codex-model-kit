import { useEffect, useRef, useState } from "react";
import { UiBridge, ToolFailure } from "./bridge.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { clientDiagnostic, type Diagnostic } from "../shared/diagnostics.js";
import {
  acceptSnapshot,
  referenceOf,
  snapshotSchema,
  VERSION,
  DISPLAY_VERSION,
  type Snapshot,
  type Reference,
} from "../shared/security.js";
import {
  efforts,
  modelParametersSchema,
  catalogWritePlanSchema,
  type CatalogWritePlan,
  type ModelParameters,
} from "../shared/catalog.js";
import {
  initialParameters,
  directStatus,
  contextSteps,
  parseContextWindow,
  contextInputValue,
  adjustContextWindow,
  previewIssues,
  reconcileModelOrder,
  moveModelOrder,
} from "../catalog/parameters.js";
import { reasonMessages, type ProbePlan } from "../shared/workbench.js";

import { ProbeEvidence } from "./ProbeEvidence.js";
import { credentialDisplay } from "../shared/config.js";

type Draft = {
  key: string;
  parameters: ModelParameters;
  source: string;
  edited: boolean;
};
const catalogMessages = {
  not_loaded: "尚未读取",
  not_configured:
    "未配置 model_catalog_json。请在 Codex 配置中指定模型目录 JSON 的绝对路径。",
  relative_path:
    "已配置相对路径；当前预览版不推测路径基准，请改用绝对路径后重新读取。",
  missing: "目录文件尚不存在；确认写入时将新建文件。",
  read_error: "文件无法安全读取（权限、大小或符号链接等）。不会覆盖原文件。",
  invalid: "目录格式无效或含不安全字段。不会覆盖原文件；请先修复原目录。",
  ready: "已读取本地模型目录",
} as const;
const failures: Record<string, string> = {
  unknown_metadata:
    "请先为所选模型确认上下文窗口和图片支持（未知参数不能直接生成目录）。",
  duplicate_model: "实际请求模型重复，请修改或取消勾选重复项。",
  invalid_catalog_draft: "参数无效，请检查名称、上下文窗口和思考等级。",
  stale_reference: "实例或连接已改变，请重新读取配置。",
  connection_not_ready: "连接配置不完整。请在 Codex 配置中补齐后重新读取。",
  expired_plan: "检测确认已过期，请重新打开。",
  http_confirmation_required: "HTTP 需要明确确认风险。",
  task_running: "已有检测任务正在运行。",
  unsupported_connection:
    "此配置包含不能安全复用的鉴权或请求选项，请在 Codex 中修正。",
  catalog_not_writable: "请先配置 model_catalog_json 路径并重新读取。",
  catalog_conflict: "配置或目录已变化，请重新读取后再次确认。",
  config_conflict: "配置已变化，请重新读取后再次确认。",
  catalog_locked: "目录正在被其他写入操作使用。",
  expired_catalog_plan: "确认已过期，请关闭后重新打开目录操作。",
  catalog_rolled_back: "写入失败，已恢复原目录；请重新读取。",
  catalog_recovery_required:
    "目录状态不确定，请检查目标文件和备份，暂停后续操作。",
  catalog_write_failed: "目录写入失败，原目录未被替换。",
  catalog_backup_invalid: "备份内容不匹配，无法恢复。",
};
const windowLabel = (n: number | null) =>
  n === null
    ? "未知"
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : `${Math.round(n / 1000)}K`;

function CloseButton({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      className="icon-close"
      aria-label={label}
      title="关闭"
      disabled={disabled}
      onClick={onClick}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="m6 6 12 12M18 6 6 18" />
      </svg>
    </button>
  );
}

function EditParametersButton({
  disabled,
  label,
  onClick,
}: {
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="icon-button"
      disabled={disabled}
      title="编辑参数"
      aria-label={`编辑 ${label} 参数`}
      onClick={onClick}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

function CatalogPlanSummary({ plan }: { plan: CatalogWritePlan }) {
  return (
    <div className="catalog-summary">
      <p>
        <span className="catalog-target-label">目标：</span>
        <code>{plan.path}</code>。
        {plan.createsFile
          ? "将新建目录文件。"
          : plan.removesFile
            ? "将删除本次新建的目录文件。"
            : "将备份原文件并原子替换。"}{" "}
        模型 {plan.modelCount} 个；新增 {plan.added.length}、移除{" "}
        {plan.removed.length}、修改 {plan.changed.length}；顺序
        {plan.orderChanged ? "有" : "无"}变化。
      </p>
      {(plan.added.length > 0 ||
        plan.removed.length > 0 ||
        plan.changed.length > 0) && (
        <details>
          <summary>查看变更模型</summary>
          <p>新增：{plan.added.join("、") || "无"}</p>
          <p>移除：{plan.removed.join("、") || "无"}</p>
          <p>修改：{plan.changed.join("、") || "无"}</p>
        </details>
      )}
    </div>
  );
}

export function ModelKitApp({
  bridgeFactory = () => new UiBridge(),
}: { bridgeFactory?: () => UiBridge } = {}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [busy, setBusy] = useState(true),
    [message, setMessage] = useState("正在连接宿主并检查现有配置…"),
    [toast, setToast] = useState(""),
    [toastError, setToastError] = useState(false),
    [epoch, setEpoch] = useState(0);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [query, setQuery] = useState(""),
    [onlySelected, setOnlySelected] = useState(false),
    [page, setPage] = useState(0);
  const [editing, setEditing] = useState<string | null>(null),
    [form, setForm] = useState<ModelParameters | null>(null),
    [contextStep, setContextStep] = useState<number>(16000),
    [contextText, setContextText] = useState(""),
    [help, setHelp] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [manual, setManual] = useState(false);
  const [startingModels, setStartingModels] = useState<Set<string>>(new Set()),
    [previewProblem, setPreviewProblem] = useState<{
      message: string;
      issues: ReturnType<typeof previewIssues>;
    } | null>(null);
  const [catalogOrder, setCatalogOrder] = useState<string[]>([]),
    [ordering, setOrdering] = useState<string[] | null>(null);
  const [json, setJson] = useState<string | null>(null),
    [writePlan, setWritePlan] = useState<CatalogWritePlan | null>(null),
    [plan, setPlan] = useState<ProbePlan | null>(null),
    [planRef, setPlanRef] = useState<Reference | null>(null),
    [clock, setClock] = useState(Date.now());
  const [candidate, setCandidate] = useState(""),
    [httpRisk, setHttpRisk] = useState(false);
  const bridge = useRef<UiBridge | null>(null),
    latest = useRef<Snapshot | null>(null),
    busyRef = useRef(true),
    factory = useRef(bridgeFactory),
    requestId = useRef<string | null>(null),
    writeRequestId = useRef<string | null>(null),
    refreshPending = useRef<Reference | null>(null),
    previewInvoker = useRef<HTMLElement | null>(null),
    dialog = useRef<HTMLElement | null>(null),
    invoker = useRef<HTMLElement | null>(null);
  function update(next: Snapshot, first = false) {
    if (!first && !acceptSnapshot(latest.current, next)) return;
    if (next.diagnostic) {
      setDiagnostic(next.diagnostic);
      setMessage("本地配置或模型目录未通过读取校验。");
    } else if (latest.current?.diagnostic) {
      setDiagnostic(null);
      setMessage("");
    }
    const previousLocalStatus = latest.current?.localCatalog?.status;
    const changed =
      first || latest.current?.connectionRevision !== next.connectionRevision;
    latest.current = next;
    setSnapshot(next);
    const pending = refreshPending.current;
    if (pending) {
      const catalog = next.workbench?.catalog;
      if (
        pending.instanceId !== next.instanceId ||
        pending.connectionRevision !== next.connectionRevision
      ) {
        refreshPending.current = null;
      } else if (catalog?.status === "ready" || catalog?.status === "error") {
        refreshPending.current = null;
        setToastError(catalog.status === "error");
        setToast(
          catalog.status === "ready"
            ? `供应商模型已刷新，共 ${catalog.models.filter((model) => model.source === "provider").length} 个${catalog.warnings.length ? "（列表可能不完整）" : ""}。`
            : `刷新供应商模型失败：${catalog.reasonCode ? reasonMessages[catalog.reasonCode] : "请稍后重试。"}`,
        );
      }
    }
    if (changed) {
      setDrafts({});
      setSelected(new Set());
      setEditing(null);
      setForm(null);
      setJson(null);
      setWritePlan(null);
      writeRequestId.current = null;
      setCatalogOrder([]);
      setOrdering(null);
      setPlan(null);
      setHelp(false);
      setHistoryOpen(false);
      setManual(false);
      setPreviewProblem(null);
      setStartingModels(new Set());
      setPage(0);
    }
    setDrafts((prev) => {
      const map: Record<string, Draft> = Object.assign(
        Object.create(null),
        prev,
      );
      for (const local of next.localCatalog?.models ?? [])
        if (!Object.hasOwn(map, local.key))
          map[local.key] = {
            key: local.key,
            ...initialParameters(local.key, local.parameters),
            edited: false,
          };
      for (const model of next.workbench?.catalog.models ?? [])
        if (
          !Object.hasOwn(map, model.id) &&
          !(
            model.source === "manual" &&
            Object.values(map).some(
              (d) => d.parameters.requestModel === model.id,
            )
          )
        )
          map[model.id] = {
            key: model.id,
            ...initialParameters(model.id, undefined, model),
            edited: false,
          };
      return map;
    });
    if (
      changed ||
      (next.localCatalog?.status === "ready" && previousLocalStatus !== "ready")
    )
      setSelected(new Set(next.localCatalog?.models.map((v) => v.key) ?? []));
  }
  async function invoke(
    name: string,
    args: Record<string, unknown> = {},
    apply = true,
  ) {
    if (!bridge.current || !latest.current) throw new Error("no_bridge");
    const result = await bridge.current.call(name, {
      ...referenceOf(latest.current),
      ...args,
    });
    if (apply && result.snapshot) update(snapshotSchema.parse(result.snapshot));
    return result;
  }
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    setDiagnostic(null);
    setToast("");
    setToastError(false);
    try {
      await action();
    } catch (e) {
      setDiagnostic(
        e instanceof ToolFailure && e.diagnostic
          ? e.diagnostic
          : clientDiagnostic(VERSION),
      );
      setMessage(
        e instanceof ToolFailure
          ? (failures[e.category] ?? "操作未完成，请检查配置或重新读取状态。")
          : "宿主通信未完成，请重新连接后重试。",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const b = factory.current();
    bridge.current = b;
    latest.current = null;
    refreshPending.current = null;
    busyRef.current = true;
    setBusy(true);
    let disposed = false,
      polling = false;
    b.app.onhostcontextchanged = (ctx) => {
      if (!disposed) {
        if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
      }
    };
    b.app.onteardown = async () => {
      disposed = true;
      b.cancelPending();
      return {};
    };
    b.app.onerror = () => {
      if (!disposed) {
        setDiagnostic(clientDiagnostic(VERSION));
        setMessage(
          "宿主通信异常，请重新连接。不会使用明文密钥或直接访问浏览器网络。",
        );
      }
    };
    void (async () => {
      try {
        await b.connect();
        const s = await b.snapshot();
        if (disposed) return;
        update(s, true);
        const ctx = b.app.getHostContext();
        if (ctx?.theme) document.documentElement.dataset.theme = ctx.theme;
        if (s.config?.status === "not_loaded") {
          const r = await b.call("load_sync", referenceOf(s));
          if (!disposed) update(snapshotSchema.parse(r.snapshot));
        }
        if (!disposed && !latest.current?.diagnostic) setMessage("");
      } catch (error) {
        if (!disposed) {
          setDiagnostic(
            error instanceof ToolFailure && error.diagnostic
              ? error.diagnostic
              : clientDiagnostic(VERSION),
          );
          setMessage(
            "无法连接当前版本宿主，请重新连接。不会读取账号鉴权文件。",
          );
        }
      } finally {
        if (!disposed) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    })();
    const timer = setInterval(() => {
      if (
        disposed ||
        polling ||
        busyRef.current ||
        (!latest.current?.workbench?.activeJobId &&
          latest.current?.workbench?.catalog.status !== "loading")
      )
        return;
      polling = true;
      void b
        .snapshot()
        .then((s) => {
          if (!disposed) update(s);
        })
        .catch(() => {
          if (!disposed) setMessage("任务状态读取失败，请勿重复发送检测请求。");
        })
        .finally(() => (polling = false));
    }, 800);
    return () => {
      disposed = true;
      clearInterval(timer);
      if (bridge.current === b) bridge.current = null;
      void b.close().catch(() => undefined);
    };
  }, [epoch]);
  useEffect(() => {
    if (!plan) return;
    const t = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(t);
  }, [plan]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (
      !json &&
      !writePlan &&
      !plan &&
      !editing &&
      !help &&
      !historyOpen &&
      !manual &&
      !previewProblem &&
      !ordering
    )
      return;
    // Keep the original opener across related dialogs.
    invoker.current ??= document.activeElement as HTMLElement;
    const modal = dialog.current;
    const controls = () =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea, select:not(:disabled), summary, [tabindex="0"]',
        ) ?? [],
      );
    if (!json && ordering && previewInvoker.current) {
      controls()
        .find((item) => item.textContent === "预览变更")
        ?.focus();
      previewInvoker.current = null;
    } else controls()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        if (json && ordering) {
          setJson(null);
          return;
        }
        setJson(null);
        setWritePlan(null);
        writeRequestId.current = null;
        setOrdering(null);
        setPlan(null);
        setEditing(null);
        setForm(null);
        setHelp(false);
        setHistoryOpen(false);
        setManual(false);
        setPreviewProblem(null);
      }
      if (e.key === "Tab") {
        const items = controls(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      if (!document.querySelector('[role="dialog"]')) {
        previewInvoker.current = null;
        invoker.current?.focus();
        invoker.current = null;
      }
    };
  }, [
    !!json,
    !!writePlan,
    !!plan,
    !!editing,
    !!help,
    !!historyOpen,
    !!manual,
    !!previewProblem,
    !!ordering,
  ]);
  const remote = snapshot?.workbench?.catalog,
    locals = new Map(
      snapshot?.localCatalog?.models.map((v) => [v.key, v]) ?? [],
    ),
    remotes = new Map(remote?.models.map((v) => [v.id, v]) ?? []),
    localPositions = new Map(
      snapshot?.localCatalog?.models.map((v, index) => [v.key, index]) ?? [],
    ),
    providerIds = new Set(
      remote?.models.filter((v) => v.source === "provider").map((v) => v.id) ??
        [],
    ),
    active = snapshot?.workbench?.activeJobId,
    activeJob = snapshot?.workbench?.jobs.find((j) => j.jobId === active);
  const rows = Object.values(drafts).filter(
    (d) =>
      (locals.has(d.key) || remotes.has(d.key) || d.edited) &&
      (!onlySelected || selected.has(d.key)) &&
      `${d.parameters.displayName} ${d.parameters.requestModel}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  function group(d: Draft): number {
    return locals.has(d.key)
      ? 0
      : remotes.get(d.key)?.source === "manual"
        ? 2
        : 1;
  }
  rows.sort(
    (a, b) =>
      group(a) - group(b) ||
      (locals.has(a.key) && locals.has(b.key)
        ? localPositions.get(a.key)! - localPositions.get(b.key)!
        : 0) ||
      a.parameters.displayName.localeCompare(b.parameters.displayName),
  );
  const pages = Math.max(1, Math.ceil(rows.length / 50)),
    currentPage = Math.min(page, pages - 1),
    visible = rows.slice(currentPage * 50, (currentPage + 1) * 50),
    count = Object.keys(drafts).filter((k) => selected.has(k)).length;
  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function edit(d: Draft) {
    setSelected((prev) => new Set([...prev, d.key]));
    setMessage("");
    setEditing(d.key);
    setForm(structuredClone(d.parameters));
    setContextStep(16000);
    setContextText(contextInputValue(d.parameters.contextWindow));
  }
  async function save() {
    if (!form || (!editing && !manual)) return;
    const contextWindow = parseContextWindow(contextText);
    if (contextWindow === undefined) {
      setMessage(
        "上下文窗口请输入 1024–10000000 的整数 tokens，或 128K、1M 等容量。",
      );
      return;
    }
    const parsed = modelParametersSchema.safeParse({ ...form, contextWindow });
    if (!parsed.success) {
      setMessage(
        "请输入有效参数：窗口为 1024–10000000 的整数，名称非空，默认思考等级在支持列表中。",
      );
      return;
    }
    const parameters = parsed.data;
    if (manual) {
      const id = parameters.requestModel;
      if (
        Object.values(drafts).some((d) => d.parameters.requestModel === id) ||
        Object.hasOwn(drafts, id)
      ) {
        setMessage(
          "此模型已在列表中，请使用该行的设置图标编辑，或填写不同的实际请求模型。",
        );
        return;
      }
      await run(async () => {
        await invoke("add_manual_model", { modelId: id });
        setDrafts((prev) => ({
          ...prev,
          [id]: {
            key: id,
            parameters,
            edited: true,
            source: "手动设置（未实测）",
          },
        }));
        setSelected((prev) => new Set([...prev, id]));
        setQuery("");
        setPage(0);
        setManual(false);
        setForm(null);
        setMessage("模型已加入当前页面草稿，未发送推理请求或写入文件。");
      });
      return;
    }
    setDrafts((prev) => ({
      ...prev,
      [editing!]: {
        ...prev[editing!]!,
        parameters,
        edited: true,
        source: "手动设置（未实测）",
      },
    }));
    setEditing(null);
    setForm(null);
    setMessage("参数已保存在当前页面草稿中，未写入文件。");
  }
  async function prepare(items: Draft[]) {
    await run(async () => {
      const ids = [...new Set(items.map((d) => d.parameters.requestModel))];
      if (!ids.length || ids.length > 1000) {
        setMessage("请选择 1–1000 个不同的实际请求模型进行检测。");
        return;
      }
      for (const id of ids)
        if (!remotes.has(id)) await invoke("add_manual_model", { modelId: id });
      const r = await invoke("prepare_probe", {
        modelIds: ids,
        protocol: "responses",
      });
      setPlan(r.plan as ProbePlan);
      setPlanRef(referenceOf(latest.current!));
      requestId.current = crypto.randomUUID();
      setClock(Date.now());
    });
  }
  function clearCatalogPlan() {
    setJson(null);
    setWritePlan(null);
    writeRequestId.current = null;
  }
  function validateCatalog(keys: string[]) {
    const rows = keys.map((key) => ({
      key,
      parameters: drafts[key]!.parameters,
    }));
    const issues = previewIssues(rows);
    if (issues.length) {
      setOrdering(null);
      clearCatalogPlan();
      setPreviewProblem({
        message: `已选 ${rows.length} 个模型，其中 ${issues.length} 个需要确认参数。不会忽略这些模型或编造能力。`,
        issues,
      });
      return null;
    }
    return rows;
  }
  async function prepareCatalog() {
    if (!ordering) return null;
    const rows = validateCatalog(ordering);
    if (!rows) return null;
    setCatalogOrder([...ordering]);
    const r = await invoke("prepare_catalog_write", { rows });
    if (typeof r.catalogJson !== "string") throw new Error("missing_preview");
    const prepared = catalogWritePlanSchema.parse(r.catalogPlan);
    setWritePlan(prepared);
    writeRequestId.current = null;
    return { plan: prepared, json: r.catalogJson };
  }
  async function commitCatalog(prepared: CatalogWritePlan) {
    const id = (writeRequestId.current ??= crypto.randomUUID());
    await invoke("commit_catalog_write", {
      planId: prepared.planId,
      requestId: id,
    });
    setOrdering(null);
    setHistoryOpen(false);
    clearCatalogPlan();
    setToast(
      prepared.action === "restore"
        ? "模型目录已恢复。请重启 Codex 客户端后生效。"
        : `模型列表已更新，已写入 ${prepared.modelCount} 个模型。请重启 Codex 客户端后生效。`,
    );
  }
  async function confirmCatalog() {
    // Reordering invalidates the plan; retries retain its idempotency key.
    const prepared =
      writePlan && (writeRequestId.current || Date.now() < writePlan.expiresAt)
        ? writePlan
        : (await prepareCatalog())?.plan;
    if (prepared) await commitCatalog(prepared);
  }
  const local = snapshot?.localCatalog;
  const configured = snapshot?.config?.candidates.find(
    (c) => c.configuredDefault && c.profileLabel === "配置文件默认值",
  );
  const connection = snapshot?.connection;
  const credentialText = credentialDisplay(connection, configured);
  const ambiguous = snapshot?.config?.warnings.some((w) =>
    w.includes("profile"),
  );
  return (
    <main>
      <div
        inert={
          !!(
            editing ||
            json ||
            writePlan ||
            plan ||
            help ||
            historyOpen ||
            manual ||
            previewProblem ||
            ordering
          )
        }
      >
        <header>
          <div className="header-brand">
            <div>
              <p className="eyebrow">模型列表同步</p>
              <h1>CODEX MODEL KIT</h1>
            </div>
            <button
              className="icon-button"
              aria-label="使用说明"
              title="使用说明"
              onClick={() => setHelp(true)}
            >
              ⓘ
            </button>
          </div>
          <span className="version">{DISPLAY_VERSION}</span>
        </header>
        <section className="status-card" aria-label="配置状态">
          <div className="section-heading">
            <h2>当前配置</h2>
            <div className="config-actions">
              <button
                disabled={busy}
                onClick={() => {
                  setMessage("");
                  setHistoryOpen(true);
                }}
              >
                写入记录与恢复
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await invoke("load_sync");
                    setToastError(!!latest.current?.diagnostic);
                    setToast(
                      latest.current?.diagnostic
                        ? "配置或模型目录读取失败。"
                        : "已重新读取配置；内存草稿已重置。",
                    );
                  })
                }
              >
                重新读取配置
              </button>
            </div>
          </div>
          <div className="status-grid">
            <div>
              <label>base_url</label>
              <strong>
                {connection?.address ?? configured?.address ?? "未配置有效地址"}
              </strong>
              <small>
                {connection?.addressPresent || configured?.addressPresent
                  ? `${connection?.providerLabel ?? configured?.providerLabel} · 配置文件默认值`
                  : "请在 Codex 的 model_providers 中配置 base_url。"}
              </small>
            </div>
            <div>
              <label>{credentialText.label}</label>
              <strong>
                {(
                  connection?.addressPresent
                    ? connection?.credentialPresent
                    : configured?.credentialPresent ||
                      configured?.bearerOnlyAvailable
                )
                  ? `已配置（${(connection?.addressPresent ? connection?.credentialHint : configured?.credentialHint) ?? "***"}）`
                  : "缺失或不能复用"}
              </strong>
              <small>{credentialText.detail}</small>
            </div>
            <div>
              <label>model_catalog_json</label>
              <strong>{local?.path ?? "未配置目录路径"}</strong>
              <small>
                {catalogMessages[local?.status ?? "not_loaded"]}
                {local?.status === "ready"
                  ? ` · ${local.models.length} 个本地模型`
                  : ""}
              </small>
            </div>{" "}
            <div>
              <label>连接状态</label>
              <strong className={remote?.status === "ready" ? "good" : ""}>
                {remote?.status === "ready"
                  ? "模型列表接口正常"
                  : remote?.status === "loading"
                    ? "正在检查列表接口…"
                    : remote?.status === "error"
                      ? "本次连接检查未通过"
                      : connection?.ready
                        ? "配置完整 · 网络待检查"
                        : "配置未就绪"}
              </strong>
              <small>
                {remote?.reasonCode
                  ? reasonMessages[remote.reasonCode]
                  : "只检查 GET /models；直连能力需对具体模型测试。"}
              </small>
            </div>
          </div>
          {ambiguous && (
            <p className="notice">
              发现 profile
              配置；这里使用配置文件默认值，不声明它就是当前聊天的活动配置。
            </p>
          )}
          {!connection?.ready && snapshot?.config?.status !== "not_loaded" && (
            <details>
              <summary>配置指引 / 选择其他已配置的 provider</summary>
              <p>
                请在 Codex 配置中设置 model_provider、同一 provider 的 base_url
                和 experimental_bearer_token 或单独的 env_key，wire_api 使用
                responses。模型目录使用 model_catalog_json。env_key
                对应的变量必须对插件进程可见，终端临时设置不保证传入桌面应用。这里只读取，不提供地址或密钥编辑；不读取账号文件、不执行鉴权命令。
              </p>
              {snapshot?.config?.candidates.length ? (
                <div className="connection-choice">
                  <select
                    aria-label="已配置连接"
                    value={candidate}
                    onChange={(e) => setCandidate(e.target.value)}
                  >
                    <option value="">选择已有配置</option>
                    {snapshot.config.candidates.map((c) => (
                      <option key={c.candidateId} value={c.candidateId}>
                        {c.providerLabel} · {c.profileLabel}
                        {!c.reusable && !c.bearerOnlyAvailable
                          ? "（不能复用）"
                          : ""}
                      </option>
                    ))}
                  </select>
                  <label>
                    <input
                      type="checkbox"
                      checked={httpRisk}
                      onChange={(e) => setHttpRisk(e.target.checked)}
                    />
                    如使用 HTTP，同意明文传输凭据的风险
                  </label>
                  <button
                    disabled={!candidate || busy}
                    onClick={() =>
                      void run(async () => {
                        const c = snapshot.config?.candidates.find(
                          (c) => c.candidateId === candidate,
                        );
                        await invoke("select_connection", {
                          candidateId: candidate,
                          allowHttp: httpRisk,
                          bearerOnly: !!c?.bearerOnlyAvailable,
                        });
                      })
                    }
                  >
                    使用已有配置
                  </button>
                </div>
              ) : null}
            </details>
          )}
        </section>
        {(message || (!snapshot && !busy)) && (
          <div className="live-message" role="status">
            <ErrorNotice message={message} diagnostic={diagnostic} />
            {!snapshot && !busy && (
              <button onClick={() => setEpoch((v) => v + 1)}>
                重新连接宿主
              </button>
            )}
          </div>
        )}
        <section className="models-card">
          <div className="section-heading">
            <div>
              <h2>选择模型</h2>
              <p>
                本地 {locals.size} · 供应商{" "}
                {remote?.status === "ready" ? providerIds.size : "待刷新"}
              </p>
            </div>
            <button
              className="primary"
              disabled={
                busy || !connection?.ready || remote?.status === "loading"
              }
              onClick={() =>
                void run(async () => {
                  refreshPending.current = referenceOf(latest.current!);
                  try {
                    await invoke("refresh_models");
                  } catch (error) {
                    refreshPending.current = null;
                    setToastError(true);
                    setToast("刷新供应商模型未完成，请检查连接后重试。");
                    throw error;
                  }
                })
              }
            >
              {remote?.status === "loading" ? "正在刷新…" : "刷新供应商模型"}
            </button>
          </div>
          <div className="toolbar">
            <input
              type="search"
              placeholder="搜索显示名称或请求模型…"
              aria-label="搜索模型"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </div>
          {remote?.warnings.length ? (
            <p className="notice">
              供应商列表可能不完整（无效条目、截断或分页尚未获取）；“未返回”不代表已下架。
            </p>
          ) : null}
          <div className="model-layout">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="selection-column">
                      <input
                        type="checkbox"
                        aria-label="选择全部筛选模型"
                        disabled={busy || !rows.length}
                        checked={
                          rows.length > 0 &&
                          rows.every((d) => selected.has(d.key))
                        }
                        ref={(el) => {
                          if (el)
                            el.indeterminate =
                              rows.some((d) => selected.has(d.key)) &&
                              !rows.every((d) => selected.has(d.key));
                        }}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSelected((prev) => {
                            const next = new Set(prev);
                            for (const d of rows)
                              checked ? next.add(d.key) : next.delete(d.key);
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th className="model-column">模型</th>
                    <th className="capability-column">上下文 / 思考 / 图片</th>
                    <th className="direct-column">Codex 直连</th>
                    <th className="settings-column">设置</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((d, i) => {
                    const m = remotes.get(d.parameters.requestModel),
                      s = startingModels.has(d.parameters.requestModel)
                        ? { label: "测试中...", tone: "muted" }
                        : directStatus(
                            d.parameters.requestModel,
                            m?.result,
                            activeJob,
                          ),
                      inProvider = providerIds.has(d.parameters.requestModel),
                      start =
                        i === 0 ||
                        group(visible[i - 1]!) !== group(d) ||
                        (locals.has(d.key) &&
                          providerIds.has(
                            visible[i - 1]!.parameters.requestModel,
                          ) !== inProvider);
                    return [
                      start ? (
                        <tr className="group-row" key={`group-${d.key}`}>
                          <td colSpan={5}>
                            {!locals.has(d.key)
                              ? remotes.get(d.key)?.source === "manual"
                                ? "手动添加 · 本地未配置"
                                : "供应商其他模型 · 本地未配置"
                              : inProvider
                                ? "本地已配置 · 供应商仍提供"
                                : remote?.status === "ready"
                                  ? "本地模型 · 本次未在供应商列表返回"
                                  : "本地已配置模型 · 供应商状态待刷新"}
                          </td>
                        </tr>
                      ) : null,
                      <tr
                        className={selected.has(d.key) ? "selected-row" : ""}
                        key={d.key}
                      >
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`选择 ${d.parameters.displayName}`}
                            checked={selected.has(d.key)}
                            onChange={() => toggle(d.key)}
                          />
                        </td>
                        <td>
                          <strong className="model-name">
                            {d.parameters.displayName}
                          </strong>
                          <code className="model-id">
                            {d.parameters.requestModel}
                          </code>
                          {d.edited && <small>已编辑</small>}
                        </td>
                        <td title={d.source}>
                          <div className="capability-line">
                            <strong>
                              {windowLabel(d.parameters.contextWindow)}
                            </strong>
                            <span className="image-badge">
                              {d.parameters.images === null
                                ? "图片?"
                                : d.parameters.images
                                  ? "图片"
                                  : "文本"}
                            </span>
                          </div>
                          <small className="reasoning-levels">
                            {d.parameters.reasoningLevels.length
                              ? d.parameters.reasoningLevels.join(" / ")
                              : "思考未配置"}
                          </small>
                        </td>
                        <td>
                          {s.label === "测试中..." ? (
                            <span className={`direct ${s.tone}`} role="status">
                              {s.label}
                            </span>
                          ) : (
                            <button
                              className={`direct ${s.tone}`}
                              disabled={busy || !connection?.ready || !!active}
                              title="检测 / 重新检测；确认框中可查看上次详情"
                              aria-label={`${d.parameters.displayName}：${s.label}，检测直连`}
                              onClick={() => void prepare([d])}
                            >
                              {s.label}
                            </button>
                          )}
                        </td>
                        <td>
                          <EditParametersButton
                            disabled={busy}
                            label={d.parameters.displayName}
                            onClick={() => edit(d)}
                          />
                        </td>
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
              {!visible.length && (
                <div className="empty">
                  <strong>
                    {query || onlySelected
                      ? "没有匹配的模型"
                      : "还没有模型列表"}
                  </strong>
                  <p>
                    {locals.size === 0
                      ? "配置完整后，点击“刷新供应商模型”。已配置本地目录的模型会自动勾选。"
                      : "清空搜索或关闭“只看已选”后重试。"}
                  </p>
                </div>
              )}
            </div>
          </div>
          <div className="pagination">
            <span>
              已选 {count} / 共 {Object.keys(drafts).length} · {rows.length}{" "}
              个筛选结果 · 第 {currentPage + 1} / {pages} 页
            </span>
            <button
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </button>
            <button
              disabled={currentPage >= pages - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </button>
          </div>
          {active && (
            <p className="notice">
              直连检测进行中：已完成{" "}
              {snapshot?.workbench?.jobs.find((j) => j.jobId === active)
                ?.results.length ?? 0}{" "}
              /{" "}
              {snapshot?.workbench?.jobs.find((j) => j.jobId === active)
                ?.modelIds.length ?? 0}
              （串行、固定短文本）。
              <button
                onClick={() =>
                  void run(async () => {
                    await invoke("cancel_probe", { jobId: active });
                  })
                }
              >
                取消检测
              </button>
            </p>
          )}
          <footer>
            <label className="only-selected">
              <input
                type="checkbox"
                checked={onlySelected}
                onChange={(e) => {
                  setOnlySelected(e.target.checked);
                  setPage(0);
                }}
              />
              只看已选
            </label>
            <div className="footer-actions">
              <button
                disabled={busy || !connection?.ready || !!active || !count}
                onClick={() =>
                  void prepare(
                    Object.values(drafts).filter((d) => selected.has(d.key)),
                  )
                }
              >
                测试已选直连（{count}）
              </button>
              <button
                disabled={busy || !connection?.ready}
                onClick={() => {
                  setEditing(null);
                  setForm(initialParameters("").parameters);
                  setContextText("");
                  setContextStep(16000);
                  setManual(true);
                  setMessage("");
                }}
              >
                手动添加模型
              </button>
              <button
                className="primary"
                title={
                  !count ? "请先勾选至少一个模型" : "调整顺序并确认写入目录"
                }
                disabled={
                  busy ||
                  !count ||
                  !!editing ||
                  [
                    "invalid",
                    "read_error",
                    "relative_path",
                    "not_configured",
                    "not_loaded",
                  ].includes(local?.status ?? "")
                }
                onClick={() => {
                  setMessage("");
                  clearCatalogPlan();
                  const keys = reconcileModelOrder(
                    catalogOrder,
                    Object.values(drafts)
                      .filter((d) => selected.has(d.key))
                      .map((d) => d.key),
                  );
                  if (validateCatalog(keys)) setOrdering(keys);
                }}
              >
                更新模型列表
              </button>
            </div>
          </footer>
          {count > 0 &&
            ["invalid", "read_error", "relative_path"].includes(
              local?.status ?? "",
            ) && (
              <p className="notice">
                无法预览：{catalogMessages[local!.status]}
              </p>
            )}
        </section>
      </div>
      <div className="app-bottom-space" />
      {toast && (
        <div
          className={`toast${toastError ? " toast-error" : ""}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="toast-check" aria-hidden="true">
            {toastError ? "!" : "✓"}
          </span>
          <strong>{toast}</strong>
          <CloseButton
            disabled={false}
            label="关闭提示"
            onClick={() => setToast("")}
          />
        </div>
      )}
      {(editing || manual) && form && (
        <div className="modal-backdrop">
          <section
            ref={dialog}
            className="modal editor"
            role="dialog"
            aria-modal="true"
            aria-label={manual ? "手动添加模型" : "模型参数编辑"}
          >
            <div className="section-heading">
              <h3>{manual ? "手动添加模型" : "编辑模型参数"}</h3>
              <CloseButton
                disabled={busy}
                label="关闭参数编辑"
                onClick={() => {
                  setEditing(null);
                  setManual(false);
                  setForm(null);
                }}
              />
            </div>
            <p>
              {manual
                ? "填写模型名称和能力参数，保存后自动勾选。仅加入本页草稿，不会自动发送推理请求。"
                : "自动勾选此模型。参考值不是中转站实测能力。"}
            </p>
            {message && (
              <ErrorNotice message={message} diagnostic={diagnostic} />
            )}
            <label>
              菜单显示名称
              <input
                aria-label="菜单显示名称"
                value={form.displayName}
                onChange={(e) =>
                  setForm({ ...form, displayName: e.target.value })
                }
              />
            </label>
            <label>
              实际请求模型
              <input
                aria-label="实际请求模型"
                value={form.requestModel}
                onChange={(e) =>
                  setForm({ ...form, requestModel: e.target.value })
                }
              />
            </label>
            <div className="context-control">
              <label htmlFor="context-window">上下文窗口</label>
              <div className="context-row">
                <div className="context-value">
                  {([-1, 1] as const).map((direction) => (
                    <button
                      key={direction}
                      aria-label={
                        direction === -1 ? "减少上下文窗口" : "增加上下文窗口"
                      }
                      disabled={
                        parseContextWindow(contextText) === undefined ||
                        (direction === -1
                          ? parseContextWindow(contextText) === 1024
                          : parseContextWindow(contextText) === 10000000)
                      }
                      onClick={() =>
                        setContextText(
                          contextInputValue(
                            adjustContextWindow(
                              parseContextWindow(contextText) ?? null,
                              direction,
                              contextStep,
                            ),
                          ),
                        )
                      }
                    >
                      {direction === -1 ? "−" : "＋"}
                    </button>
                  ))}
                  <input
                    id="context-window"
                    aria-label="上下文窗口"
                    inputMode="decimal"
                    value={contextText}
                    placeholder="128K / 1M"
                    onChange={(e) => setContextText(e.target.value)}
                  />
                </div>
                <label className="context-step">
                  步长
                  <select
                    aria-label="上下文调整步长"
                    value={contextStep}
                    onChange={(e) => setContextStep(Number(e.target.value))}
                  >
                    {contextSteps.map((v) => (
                      <option key={v} value={v}>
                        {windowLabel(v)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <fieldset>
              <legend>支持的思考等级（从低到高）</legend>
              <div className="effort-grid">
                {efforts.map((effort) => (
                  <label key={effort}>
                    <input
                      type="checkbox"
                      checked={form.reasoningLevels.includes(effort)}
                      onChange={(e) => {
                        const levels = e.target.checked
                          ? [...form.reasoningLevels, effort]
                          : form.reasoningLevels.filter((v) => v !== effort);
                        setForm({
                          ...form,
                          reasoningLevels: levels,
                          defaultReasoning: levels.includes(
                            form.defaultReasoning!,
                          )
                            ? form.defaultReasoning
                            : null,
                        });
                      }}
                    />
                    {effort}
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              默认思考等级
              <select
                aria-label="默认思考等级"
                value={form.defaultReasoning ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    defaultReasoning:
                      (e.target.value as typeof form.defaultReasoning) || null,
                  })
                }
              >
                <option value="">不设置 / 不使用思考参数</option>
                {efforts
                  .filter((v) => form.reasoningLevels.includes(v))
                  .map((v) => (
                    <option key={v}>{v}</option>
                  ))}
              </select>
            </label>
            <label>
              图片输入
              <select
                aria-label="图片输入"
                value={form.images === null ? "unknown" : String(form.images)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    images:
                      e.target.value === "unknown"
                        ? null
                        : e.target.value === "true",
                  })
                }
              >
                <option value="unknown">未知（生成预览前须确认）</option>
                <option value="true">支持图片</option>
                <option value="false">仅文本</option>
              </select>
            </label>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {manual ? "添加模型草稿" : "保存参数草稿"}
            </button>
          </section>
        </div>
      )}
      {ordering && !json && (
        <div className="modal-backdrop">
          <section
            ref={dialog}
            className="modal order-modal"
            role="dialog"
            aria-modal="true"
            aria-label="调整模型顺序"
            aria-describedby="catalog-restart-notice"
          >
            <div className="section-heading">
              <h2>调整模型顺序</h2>
              <CloseButton
                disabled={busy}
                label="关闭顺序调整"
                onClick={() => {
                  setOrdering(null);
                  clearCatalogPlan();
                }}
              />
            </div>
            <p>
              已选 {ordering.length} 个模型 · 目标：<code>{local?.path}</code>
            </p>
            <p className="notice" id="catalog-restart-notice">
              写入模型目录 JSON 后，需重启 Codex
              客户端，模型列表及顺序变更才会生效。
            </p>
            {message && (
              <ErrorNotice message={message} diagnostic={diagnostic} />
            )}
            <ol className="order-list">
              {ordering.map((key, index) => {
                const d = drafts[key]!;
                return (
                  <li key={key}>
                    <span
                      className="order-rank"
                      aria-label={`第 ${index + 1} 位`}
                    >
                      {index + 1}
                    </span>
                    <div className="order-name">
                      <strong>{d.parameters.displayName}</strong>
                      <span className="model-id">
                        {d.parameters.requestModel}
                      </span>
                    </div>
                    <div className="order-controls">
                      {(
                        [
                          ["置顶", "⇈", 0],
                          ["上移", "↑", index - 1],
                          ["下移", "↓", index + 1],
                          ["置底", "⇊", ordering.length - 1],
                        ] as const
                      ).map(([label, icon, target]) => (
                        <button
                          key={label}
                          className="icon-button"
                          title={label}
                          aria-label={`${label} ${d.parameters.displayName}`}
                          disabled={
                            busy ||
                            target < 0 ||
                            target >= ordering.length ||
                            target === index
                          }
                          onClick={() => {
                            clearCatalogPlan();
                            setMessage("");
                            setOrdering(
                              (prev) =>
                                prev && moveModelOrder(prev, key, target),
                            );
                          }}
                        >
                          {icon}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="catalog-actions">
              <button
                disabled={busy}
                onClick={(event) => {
                  previewInvoker.current = event.currentTarget;
                  void run(async () => {
                    const prepared = await prepareCatalog();
                    if (prepared) setJson(prepared.json);
                  });
                }}
              >
                预览变更
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void run(confirmCatalog)}
              >
                {busy ? "处理中..." : "确认写入"}
              </button>
            </div>
          </section>
        </div>
      )}
      {json && writePlan && ordering && (
        <div className="modal-backdrop">
          <section
            ref={dialog}
            className="modal details-modal catalog-preview"
            role="dialog"
            aria-modal="true"
            aria-label="变更预览"
          >
            <div className="section-heading">
              <h2>变更预览</h2>
              <CloseButton
                disabled={busy}
                label="关闭变更预览"
                onClick={() => setJson(null)}
              />
            </div>
            {message && (
              <ErrorNotice message={message} diagnostic={diagnostic} />
            )}
            <CatalogPlanSummary plan={writePlan} />
            <textarea
              aria-label="模型目录 JSON"
              readOnly
              value={json}
              spellCheck={false}
            />
            <div className="catalog-actions">
              <button
                onClick={() => {
                  const text =
                    dialog.current?.querySelector<HTMLTextAreaElement>(
                      'textarea[aria-label="模型目录 JSON"]',
                    );
                  text?.focus();
                  text?.select();
                }}
              >
                全选 JSON
              </button>
              <button disabled={busy} onClick={() => setJson(null)}>
                返回调整顺序
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void run(confirmCatalog)}
              >
                {busy ? "处理中..." : "确认写入"}
              </button>
            </div>
          </section>
        </div>
      )}
      {previewProblem && (
        <div className="modal-backdrop">
          <section
            ref={dialog}
            className="modal details-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="catalog-problem-title"
          >
            <div className="section-heading">
              <h2 id="catalog-problem-title" className="bad">
                未写入：请完善模型参数
              </h2>
              <CloseButton
                disabled={busy}
                label="关闭写入提示"
                onClick={() => setPreviewProblem(null)}
              />
            </div>
            <p role="alert">{previewProblem!.message}</p>
            <ul className="preview-issues">
              {previewProblem!.issues.map((issue) => (
                <li key={issue.key}>
                  <strong>{issue.label}</strong>
                  <small>{issue.issue}</small>
                  <EditParametersButton
                    disabled={busy}
                    label={issue.label}
                    onClick={() => {
                      setPreviewProblem(null);
                      edit(drafts[issue.key]!);
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {historyOpen && (
        <div className="modal-backdrop">
          <section
            ref={dialog}
            className="modal details-modal"
            role="dialog"
            aria-modal="true"
            aria-label="写入记录与恢复"
          >
            <div className="section-heading">
              <h2>写入记录与恢复</h2>
              <CloseButton
                disabled={busy}
                label="关闭写入记录"
                onClick={() => setHistoryOpen(false)}
              />
            </div>
            {message && (
              <ErrorNotice message={message} diagnostic={diagnostic} />
            )}
            {snapshot?.catalogWrite ? (
              <>
                <dl className="write-record">
                  <dt>最近操作</dt>
                  <dd>
                    {snapshot.catalogWrite.action === "save"
                      ? "写入模型列表"
                      : "恢复模型目录"}
                  </dd>
                  <dt>完成时间</dt>
                  <dd>
                    {new Date(snapshot.catalogWrite.savedAt).toLocaleString()}
                  </dd>
                  <dt>目标文件</dt>
                  <dd>
                    <code>{snapshot.catalogWrite.path}</code>
                  </dd>
                  <dt>模型数量</dt>
                  <dd>{snapshot.catalogWrite.modelCount}</dd>
                  <dt>备份文件</dt>
                  <dd>
                    {snapshot.catalogWrite.backupPath ? (
                      <code>{snapshot.catalogWrite.backupPath}</code>
                    ) : (
                      "原目录不存在；恢复将删除本次新建文件。"
                    )}
                  </dd>
                </dl>
                {snapshot.catalogWrite.durability === "file_synced" && (
                  <p role="status" className="notice">
                    文件已同步并回读校验。当前系统不支持目录项同步，异常断电时不保证目录项持久化。
                  </p>
                )}
                {snapshot.catalogWrite.durability === "uncertain" && (
                  <p role="alert" className="notice">
                    目录状态不确定，请检查目标文件和备份，暂停后续操作。
                  </p>
                )}
                <button
                  disabled={
                    busy || snapshot.catalogWrite.durability === "uncertain"
                  }
                  onClick={() =>
                    void run(async () => {
                      const r = await invoke("prepare_catalog_restore");
                      setWritePlan(catalogWritePlanSchema.parse(r.catalogPlan));
                      writeRequestId.current = null;
                      setJson(null);
                      setHistoryOpen(false);
                    })
                  }
                >
                  {snapshot.catalogWrite.action === "save"
                    ? "恢复上次写入"
                    : "撤销上次恢复"}
                </button>
              </>
            ) : (
              <p>当前实例暂无写入记录。</p>
            )}
            <small>
              仅保留当前后端实例的最近一次操作；重启后可手动检查目录旁的备份文件。
            </small>
          </section>
        </div>
      )}
      {(plan || writePlan?.action === "restore") && (
        <div className="modal-backdrop">
          <section
            ref={dialog}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              writePlan
                ? writePlan.action === "restore"
                  ? "确认恢复目录"
                  : "确认写入目录"
                : "确认直连检测"
            }
          >
            <div className="section-heading">
              <h2>
                {writePlan
                  ? writePlan.action === "restore"
                    ? "确认恢复目录"
                    : "确认写入目录"
                  : "确认直连检测"}
              </h2>
              <CloseButton
                disabled={busy}
                label={writePlan ? "取消目录操作" : "关闭直连检测"}
                onClick={() => {
                  setJson(null);
                  setWritePlan(null);
                  writeRequestId.current = null;
                  setPlan(null);
                }}
              />
            </div>
            {message && (
              <ErrorNotice message={message} diagnostic={diagnostic} />
            )}
            {writePlan ? (
              <>
                <CatalogPlanSummary plan={writePlan} />
                <button
                  className="primary"
                  disabled={
                    busy ||
                    (!writeRequestId.current &&
                      Date.now() >= writePlan.expiresAt)
                  }
                  onClick={() => void run(() => commitCatalog(writePlan))}
                >
                  {writePlan.action === "restore" ? "确认恢复" : "确认写入目录"}
                </button>
              </>
            ) : (
              <>
                <p>
                  将向已配置中转站发送 {plan?.modelIds.length} 次 Responses
                  流式请求（每个实际请求模型一次，串行执行），会消耗
                  token。本工具不做路由或协议转换。取消后不再启动后续模型，但已发出的请求仍可能消耗
                  token。
                </p>
                <div className="probe-summary">
                  <small>目标：{plan?.address}</small>
                  <strong>{plan?.modelIds.join(", ")}</strong>
                  <code>Reply with OK.</code>
                  <small>
                    最多 64 输出 tokens · 30 秒超时 ·
                    通过仅代表基础流式请求，不验证图片、工具调用或全部思考等级。
                  </small>
                </div>
                {plan?.modelIds.length === 1 &&
                  remotes.get(plan.modelIds[0]!)?.result && (
                    <details
                      open={
                        remotes.get(plan.modelIds[0]!)!.result!.status !==
                        "passed"
                      }
                    >
                      <summary>上次测试详情</summary>
                      <ProbeEvidence
                        id={plan.modelIds[0]!}
                        result={remotes.get(plan.modelIds[0]!)!.result!}
                      />
                    </details>
                  )}
                {clock >= (plan?.expiresAt ?? 0) && (
                  <p className="notice">确认已过期，请关闭后重新测试。</p>
                )}
                <button
                  className="primary"
                  disabled={
                    busy ||
                    clock >= (plan?.expiresAt ?? 0) ||
                    planRef?.connectionRevision !== snapshot?.connectionRevision
                  }
                  onClick={() =>
                    void run(async () => {
                      setStartingModels(new Set(plan!.modelIds));
                      try {
                        await invoke("start_probe", {
                          planId: plan!.planId,
                          requestId: requestId.current,
                        });
                        setPlan(null);
                      } finally {
                        setStartingModels(new Set());
                      }
                    })
                  }
                >
                  确认并测试
                </button>
              </>
            )}
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop">
          <section
            ref={dialog}
            className="modal details-modal"
            role="dialog"
            aria-modal="true"
            aria-label="使用说明"
          >
            <div className="section-heading">
              <h2>使用说明</h2>
              <CloseButton
                label="关闭使用说明"
                disabled={busy}
                onClick={() => {
                  setHelp(false);
                  setManual(false);
                }}
              />
            </div>
            <>
              <p>同步中转站的模型变化，只管理模型目录，不改连接配置。</p>
              <ol>
                <li>
                  在 Codex 配置中设置同一 provider 的 base_url 和
                  experimental_bearer_token 或单独的 env_key。模型目录由
                  model_catalog_json
                  指向；本工具只读取这些配置，密钥仅显示安全脱敏片段。
                  环境变量必须对插件进程可见；桌面应用可能看不到终端临时变量。不读取账号文件，不执行鉴权命令。
                </li>
                <li>
                  点击“刷新供应商模型”，对照本地已配置模型和供应商其他模型。未返回只代表本次列表差异，不保证已下架；本地条目不会自动取消勾选。
                </li>
                <li>
                  勾选加入目录，取消勾选移除。表头复选框作用于全部筛选结果（含其他页）。可手动添加供应商未公开的模型，设置图标用于编辑参数；参数编辑仅影响本页草稿。
                </li>
                <li>
                  点击直连状态或“测试已选直连”，确认后才会发送消耗 token
                  的请求。通过只代表基础 Responses
                  流式可用，不是图片、工具调用或全部思考等级的完整兼容认证；上次详情在确认框中查看。
                </li>
                <li>
                  点击“更新模型列表”先校验参数，通过后调整顺序，可预览变更或直接确认写入。
                  原文件保留备份，可从“写入记录与恢复”查看并恢复最近操作；不修改
                  config.toml。 草稿仅保留在当前页面，重新读取或关闭页面会重置。
                </li>
              </ol>
              <p>
                能力参数优先来自本地目录，其次供应商元数据及内置公开参数快照；未知能力须手动确认。上下文支持精确
                tokens、K（1000）和 M（1000000），例如 128K、1M。
              </p>
            </>
          </section>
        </div>
      )}
    </main>
  );
}
