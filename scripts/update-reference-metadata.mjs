// Offline, data-only extraction. Inputs are downloaded public research files;
// never executes upstream TypeScript or reads user configuration/credentials.
import { readFile, writeFile } from "node:fs/promises";
import { transform } from "esbuild";
import { parsers } from "prettier/plugins/babel";
import { createHash } from "node:crypto";
const [presetPath, modelsPath] = process.argv.slice(2);
if (!presetPath || !modelsPath)
  throw new Error(
    "Provide CC Switch v4.0.10 codexProviderPresets.ts and models.dev api.json paths",
  );
const presetText = await readFile(presetPath, "utf8"),
  modelsText = await readFile(modelsPath, "utf8");
const code = (await transform(presetText, { loader: "ts" })).code;
const sf = await parsers.babel.parse(code, {});
const efforts = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
function literal(node) {
  if (!node) return undefined;
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(node.type))
    return node.value;
  if (node.type === "ArrayExpression") return node.elements.map(literal);
  if (node.type === "ObjectExpression")
    return Object.fromEntries(
      node.properties
        .filter((p) => p.type === "ObjectProperty" && !p.computed)
        .map((p) => [p.key.name ?? p.key.value, literal(p.value)]),
    );
  return undefined;
}
function properties(node) {
  return new Map(
    node.properties
      .filter((p) => p.type === "ObjectProperty" && !p.computed)
      .map((p) => [p.key.name ?? p.key.value, p.value]),
  );
}
function metadata(row, preset = false) {
  const result = {};
  const context = preset ? row.contextWindow : row.limit?.context;
  if (Number.isSafeInteger(context) && context >= 1024 && context <= 10000000)
    result.contextWindow = context;
  const modes = preset ? row.inputModalities : row.modalities?.input;
  if (
    Array.isArray(modes) &&
    modes.length &&
    modes.every((v) => typeof v === "string")
  )
    result.images = modes.includes("image");
  const levels = preset
    ? row.reasoningLevels
    : row.reasoning_options
        ?.filter((r) => r.type === "effort")
        .flatMap((r) => r.values ?? []);
  if (
    Array.isArray(levels) &&
    levels.length &&
    levels.every((v) => efforts.has(v))
  )
    result.reasoningLevels = [...new Set(levels)];
  return result;
}
let presets = [];
function visit(node) {
  if (!node || typeof node !== "object") return;
  if (
    node.type === "VariableDeclarator" &&
    node.id?.name === "codexProviderPresets" &&
    node.init?.type === "ArrayExpression"
  ) {
    for (const item of node.init.elements) {
      if (item.type !== "ObjectExpression") continue;
      const p = properties(item),
        catalog = p.get("modelCatalog");
      if (catalog?.type !== "CallExpression") continue;
      const rows = literal(catalog.arguments[0]);
      if (!Array.isArray(rows)) continue;
      const config = p.get("config"),
        url =
          config?.type === "CallExpression"
            ? literal(config.arguments[1])
            : undefined;
      const endpoints = [
        ...new Set(
          [url, ...(literal(p.get("endpointCandidates")) ?? [])].filter(
            (v) => typeof v === "string",
          ),
        ),
      ];
      const models = Object.fromEntries(
        rows
          .filter((r) => r && typeof r.model === "string")
          .map((r) => [r.model, metadata(r, true)])
          .filter(([, m]) => Object.keys(m).length),
      );
      if (endpoints.length && Object.keys(models).length)
        presets.push({ endpoints, models });
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") visit(value);
  }
}
visit(sf);
const data = JSON.parse(modelsText),
  canonical = Object.create(null),
  pointers = new Map(),
  providers = [];
for (const [providerId, provider] of Object.entries(data)) {
  const models = Object.fromEntries(
    Object.entries(provider.models ?? {})
      .map(([id, m]) => [id, metadata(m)])
      .filter(([, m]) => Object.keys(m).length),
  );
  if (typeof provider.api === "string" && Object.keys(models).length)
    providers.push({ endpoints: [provider.api], models });
  for (const [id, model] of Object.entries(provider.models ?? {})) {
    const cid = model.canonical_model_id;
    if (typeof cid !== "string" || !cid.includes("/")) continue;
    const slash = cid.indexOf("/"),
      vendor = data[cid.slice(0, slash)]?.models?.[cid.slice(slash + 1)];
    if (!vendor) continue;
    const set = pointers.get(id) ?? new Set();
    set.add(cid);
    pointers.set(id, set);
  }
}
for (const [id, cids] of pointers) {
  if (cids.size !== 1) continue;
  const cid = [...cids][0],
    slash = cid.indexOf("/");
  const m = metadata(data[cid.slice(0, slash)].models[cid.slice(slash + 1)]);
  if (Object.keys(m).length) canonical[id] = m;
}
const digest = (text) => createHash("sha256").update(text).digest("hex");
await writeFile(
  "src/catalog/reference-metadata.json",
  JSON.stringify(
    {
      source: {
        preset: "CC Switch v4.0.10 codexProviderPresets.ts",
        dataset: "models.dev api.json",
        retrieved: "2026-10-13",
        presetSha256: digest(presetText),
        datasetSha256: digest(modelsText),
        note: "Offline reference snapshot, not relay verification. Endpoint presets are scoped; canonical fallback requires a unique declared origin.",
      },
      presets,
      providers,
      canonical,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Data-only extraction: ${presets.length} preset endpoint groups, ${providers.length} dataset endpoint groups, ${Object.keys(canonical).length} canonical IDs.`,
);
