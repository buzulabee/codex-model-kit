// Opt-in single GET smoke. Never writes daily config/catalog or sends inference.
// Provider selection is explicit; this is NOT proof of the host's active profile.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { ConnectionManager } from "../src/connections/manager.js";
import { fetchModels, ProviderFailure } from "../src/providers/http.js";
import { referenceOf } from "../src/shared/security.js";

const provider = process.argv
  .find((arg) => arg.startsWith("--provider="))
  ?.slice(11);
if (!process.argv.includes("--allow-real-get") || !provider)
  throw new Error(
    "Requires explicit --allow-real-get --provider=<name>; no inference is supported.",
  );
const home = resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"));
const configPath = resolve(home, "config.toml");
const digest = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");
const beforeConfig = await readFile(configPath);
const document = parse(beforeConfig.toString("utf8"));
// Hash only explicitly referenced catalogs, in memory. No auth files or config copies.
const catalogs = new Set<string>();
function collect(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "model_catalog_json" && typeof item === "string" && item)
      catalogs.add(resolve(home, item));
    else if (item && typeof item === "object") collect(item);
  }
}
collect(document);
const catalogBefore = new Map<string, string | null>();
for (const path of catalogs) {
  try {
    catalogBefore.set(path, digest(await readFile(path)));
  } catch {
    catalogBefore.set(path, null);
  }
}
let requests = 0;
const methodGuard: typeof fetch = async (input, init) => {
  if (init?.method !== "GET" || init.redirect !== "manual" || requests !== 0)
    throw new ProviderFailure("service");
  requests += 1;
  return fetch(input, init);
};
const report: Record<string, unknown> = {
  version: "0.1.0-readonly.0",
  scope:
    "opt-in real relay single GET /models only; not native UI or inference acceptance",
  status: "not_run",
  inferenceRequests: 0,
};
try {
  const manager = new ConnectionManager();
  let snapshot = await manager.reload(referenceOf(manager.snapshot()));
  const candidates = snapshot.config!.candidates.filter(
    (row) => row.providerLabel === provider && row.configuredDefault,
  );
  if (candidates.length !== 1) throw new Error("unsafe-selection");
  const candidate = candidates[0]!;
  if (
    candidate.httpRisk ||
    !candidate.addressPresent ||
    (!candidate.credentialPresent && !candidate.bearerOnlyAvailable)
  )
    throw new Error("incomplete-or-http");
  snapshot = manager.select(
    referenceOf(snapshot),
    candidate.candidateId,
    false,
    !candidate.reusable && !!candidate.bearerOnlyAvailable,
  );
  const result = await manager.useConnection(
    referenceOf(snapshot),
    (material) =>
      fetchModels(material, AbortSignal.timeout(15000), methodGuard),
  );
  report.status = "passed";
  report.modelCount = result.models.length;
  report.warnings = result.warnings;
  report.explicitBearerOnly =
    snapshot.connection?.authMode === "explicit_bearer";
} catch (error) {
  report.status = "failed";
  report.reason =
    error instanceof ProviderFailure
      ? error.reason
      : "local_or_network_failure";
}
report.listRequests = requests;
report.configUnchanged =
  digest(beforeConfig) === digest(await readFile(configPath));
let catalogsUnchanged = true;
for (const [path, before] of catalogBefore) {
  let after: string | null = null;
  try {
    after = digest(await readFile(path));
  } catch {
    /* Missing before/after stays missing. */
  }
  catalogsUnchanged &&= before === after;
}
report.catalogCandidatesChecked = catalogBefore.size;
report.catalogsUnchanged = catalogsUnchanged;
await writeFile(
  resolve(".test-artifacts/readonly-real-models.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (!report.configUnchanged || !catalogsUnchanged) process.exitCode = 1;
