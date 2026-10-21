import {
  efforts,
  modelParametersSchema,
  type ModelParameters,
} from "../shared/catalog.js";
import type { Job, ModelEntry } from "../shared/workbench.js";

export function initialParameters(
  id: string,
  local?: ModelParameters,
  remote?: ModelEntry,
): { parameters: ModelParameters; source: string } {
  if (local)
    return {
      parameters: { ...local, reasoningLevels: [...local.reasoningLevels] },
      source: "本地目录",
    };
  const known = remote?.referenceMetadata?.values;
  const referenceLabel =
    remote?.referenceMetadata?.source === "endpoint-preset"
      ? "同地址参数参考"
      : "原厂参数参考（非中转站实测）";
  const meta = { ...known, ...remote?.metadata };
  const reasoningLevels = meta.reasoningLevels ?? [];
  const orderedLevels = efforts.filter((level) =>
    reasoningLevels.includes(level),
  );
  return {
    parameters: {
      displayName: id,
      requestModel: id,
      contextWindow: meta.contextWindow ?? null,
      reasoningLevels,
      defaultReasoning: reasoningLevels.includes("medium")
        ? "medium"
        : (orderedLevels[Math.floor((orderedLevels.length - 1) / 2)] ?? null),
      images: meta.images ?? null,
    },
    source:
      remote?.metadata && Object.keys(remote.metadata).length
        ? known
          ? `供应商声明 / ${referenceLabel}`
          : "供应商声明"
        : known
          ? referenceLabel
          : "参数未知 / 保守草稿",
  };
}
export function directStatus(
  id: string,
  result?: ModelEntry["result"],
  job?: Job,
): { label: string; tone: string } {
  if (
    job &&
    ["queued", "running"].includes(job.status) &&
    job.modelIds.includes(id) &&
    !job.results.some((v) => v.modelId === id)
  )
    return { label: "测试中...", tone: "muted" };
  if (result?.status === "passed") return { label: "通过", tone: "good" };
  if (
    result?.protocolResult === "unsupported" ||
    result?.streamResult === "invalid"
  )
    return { label: "不满足直连", tone: "bad" };
  if (result) return { label: "无法确认", tone: "warn" };
  return { label: "未检测", tone: "muted" };
}

// Decimal K/M, matching the table labels. Preserve exact imported values until edited.
export const contextSteps = [16000, 64000, 128000, 1000000] as const;
export function adjustContextWindow(
  value: number | null,
  direction: -1 | 1,
  step: number,
): number {
  return value === null
    ? 128000
    : Math.min(10000000, Math.max(1024, value + direction * step));
}
export function previewIssues(
  rows: { key: string; parameters: ModelParameters }[],
): { key: string; label: string; issue: string }[] {
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(
      row.parameters.requestModel,
      (counts.get(row.parameters.requestModel) ?? 0) + 1,
    );
  return rows.flatMap(({ key, parameters: p }) => {
    const issues: string[] = [];
    if (!modelParametersSchema.safeParse(p).success)
      issues.push("参数无效，请检查名称、上下文窗口和默认思考等级");
    if (p.contextWindow === null) issues.push("上下文窗口未知");
    if (p.images === null) issues.push("图片支持未知");
    if ((counts.get(p.requestModel) ?? 0) > 1) issues.push("实际请求模型重复");
    return issues.length
      ? [{ key, label: p.displayName, issue: issues.join("；") }]
      : [];
  });
}

// Blank means unknown; invalid input must never overwrite a saved value.
export function parseContextWindow(raw: string): number | null | undefined {
  if (!raw.trim()) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(raw.trim());
  if (!match) return undefined;
  const value =
    Number(match[1]) *
    (match[2]?.toLowerCase() === "m"
      ? 1000000
      : match[2]?.toLowerCase() === "k"
        ? 1000
        : 1);
  return Number.isSafeInteger(value) && value >= 1024 && value <= 10000000
    ? value
    : undefined;
}
export function contextInputValue(n: number | null): string {
  return n === null
    ? ""
    : n % 1000000 === 0
      ? `${n / 1000000}M`
      : n % 1000 === 0
        ? `${n / 1000}K`
        : String(n);
}

// Keep confirmed order, drop removed selections, append newly selected models.
export function reconcileModelOrder(
  previous: readonly string[],
  selected: readonly string[],
): string[] {
  const allowed = new Set(selected);
  return [
    ...new Set([...previous.filter((key) => allowed.has(key)), ...selected]),
  ];
}
export function moveModelOrder(
  order: readonly string[],
  key: string,
  target: number,
): string[] {
  const result = [...order];
  const from = result.indexOf(key);
  if (
    from < 0 ||
    !Number.isInteger(target) ||
    target < 0 ||
    target >= result.length
  )
    return result;
  result.splice(from, 1);
  result.splice(target, 0, key);
  return result;
}
