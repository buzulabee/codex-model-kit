import data from "./reference-metadata.json" with { type: "json" };
import { metadataSchema, type ModelMetadata } from "../shared/catalog.js";
// Match the whole deployment path, never just the host or a parent path.
// Only terminal API version / request suffixes are ignored, following CC Switch.
function endpointKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean);
    while (parts.length) {
      const last = parts.at(-1)!;
      if (last === "completions" && parts.at(-2) === "chat") parts.splice(-2);
      else if (/^(?:responses|messages|v\d+(?:(?:alpha|beta)\d*)?)$/.test(last))
        parts.pop();
      else break;
    }
    return `${u.protocol}//${u.host}/${parts.join("/")}`;
  } catch {
    return null;
  }
}
// Validate the bundled public snapshot once; Maps also handle prototype-like IDs.
const validatedModels = (rows: object) =>
  new Map(
    Object.entries(rows).map(([id, metadata]) => [
      id,
      metadataSchema.parse(metadata),
    ]),
  );
const canonicalModels = validatedModels(data.canonical);
const byEndpoint = new Map<string, Array<Map<string, ModelMetadata>>>();
for (const group of [...data.presets, ...data.providers]) {
  const models = validatedModels(group.models);
  for (const url of group.endpoints) {
    const key = endpointKey(url);
    if (!key) continue;
    const maps = byEndpoint.get(key) ?? [];
    if (!maps.includes(models)) maps.push(models);
    byEndpoint.set(key, maps);
  }
}
export function referenceMetadata(
  baseUrl: string,
  id: string,
):
  | { values: ModelMetadata; source: "endpoint-preset" | "canonical-reference" }
  | undefined {
  const key = endpointKey(baseUrl);
  let values: ModelMetadata = {},
    matched = false;
  for (const models of key ? (byEndpoint.get(key) ?? []) : []) {
    const found = models.get(id);
    if (found) {
      values = { ...found, ...values };
      matched = true;
    }
  }
  const canonical = canonicalModels.get(id);
  values = { ...canonical, ...values };
  return Object.keys(values).length
    ? { values, source: matched ? "endpoint-preset" : "canonical-reference" }
    : undefined;
}
