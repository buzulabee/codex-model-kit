import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { launchConfig } from "./runtime.mjs";
import { releaseTag } from "../../src/shared/release-version.ts";

const selector = "codex-model-kit@codex-model-kit";
export class InstallError extends Error {}
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function businessState(home) {
  const bytes = await readOptional(join(home, "config.toml"));
  let config;
  try {
    config = bytes ? parse(bytes.toString("utf8")) : {};
  } catch {
    throw new InstallError(
      "Existing config.toml could not be parsed. Fix it locally before installing; no configuration content is logged.",
    );
  }
  for (const [section, key] of [
    ["plugins", selector],
    ["marketplaces", "codex-model-kit"],
  ]) {
    if (config[section] && typeof config[section] === "object") {
      delete config[section][key];
      if (!Object.keys(config[section]).length) delete config[section];
    }
  }
  // Compare parsed configuration in memory; never log or persist its contents.
  const catalogPaths = new Set();
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.model_catalog_json === "string")
      catalogPaths.add(resolve(home, value.model_catalog_json));
    for (const child of Object.values(value)) collect(child);
  };
  collect(config);
  const catalogs = [];
  for (const path of [...catalogPaths].sort()) {
    const content = await readOptional(path);
    catalogs.push([path, content === null ? null : sha(content)]);
  }
  return { config, catalogs };
}
async function verifyFiles(root) {
  const manifest = JSON.parse(
    await readFile(join(root, "release.json"), "utf8"),
  );
  if (
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new InstallError("Invalid release manifest metadata");
  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(relative) ||
      isAbsolute(relative) ||
      relative.split("/").includes("..")
    )
      throw new InstallError("Unsafe release manifest");
    if (sha(await readFile(join(root, relative))) !== expected)
      throw new InstallError(`Release checksum failed: ${relative}`);
  }
  const plugin = JSON.parse(
    await readFile(
      join(
        root,
        "marketplace/plugins/codex-model-kit/.codex-plugin/plugin.json",
      ),
      "utf8",
    ),
  );
  if (plugin.version !== manifest.version)
    throw new InstallError("Release version mismatch");
  return manifest;
}
export class CliError extends Error {
  constructor(command, result) {
    super(
      `Official Codex command failed: ${command.slice(0, 3).join(" ")}. No raw CLI output is logged.`,
    );
    this.details = {
      command: command.slice(0, 2).join(" "),
      exitStatus: Number.isInteger(result.status) ? result.status : null,
      reason: /os error 32|\bEBUSY\b/i.test(result.stderr || "")
        ? "file_in_use"
        : result.error?.code === "ETIMEDOUT"
          ? "timeout"
          : result.error?.code === "ENOENT"
            ? "executable_not_found"
            : /os error 5|\bEACCES\b|\bEPERM\b/i.test(result.stderr || "")
              ? "permission_denied"
              : "command_failed",
    };
  }
}
function failureDetails(error) {
  return {
    ...(error instanceof CliError ? { cli: error.details } : {}),
    ...([
      "EACCES",
      "EPERM",
      "EBUSY",
      "ENOENT",
      "ENOSPC",
      "EIO",
      "ENOTEMPTY",
      "EXDEV",
    ].includes(error?.code)
      ? { systemCode: error.code }
      : {}),
  };
}
export function runCli(codex, command, env) {
  // Native executables only: no shell interpolation, including paths with spaces.
  if (/\.(cmd|bat)$/i.test(codex))
    throw new InstallError(
      "Pass the native codex.exe via --codex / -CodexPath, not a .cmd wrapper.",
    );
  const result = spawnSync(codex, command, {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.status !== 0) throw new CliError(command, result);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new InstallError("Unexpected Codex CLI response");
  }
}
const samePath = (a, b) => relative(resolve(a), resolve(b)) === "";
function assertLocalSource(source) {
  if (source !== undefined && source?.sourceType !== "local")
    throw new InstallError(
      "Marketplace explicitly declares a non-local or unsupported source. Stop; do not replace it.",
    );
}
async function installedFiles(home, version, files) {
  const cache = join(
    home,
    "plugins/cache/codex-model-kit/codex-model-kit",
    version,
  );
  const canonicalCache = join(await realpath(dirname(cache)), basename(cache));
  if (!samePath(await realpath(cache), canonicalCache))
    throw new InstallError(
      "Installed cache path is not the expected version directory. Do not edit the managed cache.",
    );
  for (const [name, expected] of Object.entries(files)) {
    const pathInCache = join(cache, name);
    const stat = await lstat(pathInCache);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !samePath(await realpath(pathInCache), join(canonicalCache, name))
    )
      throw new InstallError(
        "Installed cache contains an unexpected file type. Do not edit the managed cache.",
      );
    if (sha(await readFile(pathInCache)) !== expected)
      throw new InstallError(
        "Installed files do not match the release and checked runtime. Close old plugin sessions and retry; do not edit the managed cache.",
      );
  }
}
export async function installRelease({
  root,
  home,
  runtime,
  cli,
  check = false,
  log = (text) => console.log(text),
  cleanup = (path) => rm(path, { recursive: true, force: true }),
}) {
  let stage = "preflight";
  const diagnostic = {
    format: 1,
    requestId: randomUUID(),
    platform: process.platform,
    node: process.versions.node,
  };
  try {
    return await install();
  } catch (error) {
    log(
      JSON.stringify({
        ...diagnostic,
        status: "failed",
        stage,
        ...failureDetails(error),
      }),
    );
    throw error;
  }
  async function install() {
    if (!isAbsolute(runtime.path))
      throw new InstallError(
        "Node runtime must resolve to an absolute executable path",
      );
    const release = await verifyFiles(root);
    diagnostic.version = release.version;
    const launchText = JSON.stringify(launchConfig(runtime), null, 2) + "\n";
    const prefix = "marketplace/plugins/codex-model-kit/";
    const expectedFiles = Object.fromEntries(
      Object.entries(release.files)
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, hash]) => [path.slice(prefix.length), hash]),
    );
    expectedFiles[".mcp.json"] = sha(launchText);
    const target = join(home, "marketplaces/codex-model-kit");
    const env = { ...process.env, CODEX_HOME: home };
    const marketplaces = cli(
      ["plugin", "marketplace", "list", "--json"],
      env,
    ).marketplaces;
    if (!Array.isArray(marketplaces))
      throw new InstallError("Unexpected marketplace list response");
    const existing = marketplaces.find(
      (value) => value.name === "codex-model-kit",
    );
    if (
      existing &&
      (typeof existing.root !== "string" || !isAbsolute(existing.root))
    )
      throw new InstallError(
        "Marketplace name already belongs to a different source. Resolve it explicitly before installing.",
      );
    if (existing) assertLocalSource(existing.marketplaceSource);
    const installed = cli(
      ["plugin", "list", "--marketplace", "codex-model-kit", "--json"],
      env,
    ).installed;
    if (!Array.isArray(installed))
      throw new InstallError("Unexpected installed plugin list response");
    const previousInstalled = installed.filter(
      (value) => value.pluginId === selector,
    );
    if (previousInstalled.length > 1)
      throw new InstallError("Ambiguous installed plugin state");
    const prior = previousInstalled[0];
    if (prior) {
      assertLocalSource(prior.marketplaceSource);
      if (
        !/^\d+\.\d+\.\d+$/.test(prior.version) ||
        typeof prior.enabled !== "boolean"
      )
        throw new InstallError("Unexpected installed plugin metadata");
    }
    log(
      JSON.stringify(
        {
          version: releaseTag(release.version),
          runtime,
          target,
          checkOnly: check,
        },
        null,
        2,
      ),
    );
    const parent = dirname(target);
    let hasTarget = false;
    try {
      const stat = await lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new InstallError("Marketplace target is not a regular directory");
      const previous = JSON.parse(
        await readFile(join(target, ".claude-plugin/marketplace.json"), "utf8"),
      );
      if (previous.name !== "codex-model-kit")
        throw new InstallError(
          "Marketplace target is owned by another package",
        );
      hasTarget = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // An existing directory with a missing manifest is not an empty install target.
      if (
        await lstat(target).then(
          () => true,
          (e) => {
            if (e.code === "ENOENT") return false;
            throw e;
          },
        )
      )
        throw new InstallError(
          "Stable target exists without an owned marketplace manifest. Stop; do not replace it.",
        );
    }
    if ((existing || prior) && !hasTarget)
      throw new InstallError(
        "Registered marketplace has no owned stable source. Resolve it explicitly before updating.",
      );
    if (
      existing &&
      !samePath(await realpath(existing.root), await realpath(target))
    )
      throw new InstallError(
        "Marketplace name already belongs to a different source. Resolve it explicitly before installing.",
      );
    const previousFiles = {};
    if (prior) {
      for (const name of [
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "main.html",
        "server.mjs",
      ])
        previousFiles[name] = sha(
          await readFile(join(target, "plugins/codex-model-kit", name)),
        );
      const previousPlugin = JSON.parse(
        await readFile(
          join(target, "plugins/codex-model-kit/.codex-plugin/plugin.json"),
          "utf8",
        ),
      );
      if (previousPlugin.version !== prior.version)
        throw new InstallError(
          "Stable source and installed version already differ. Inspect the existing installation before updating.",
        );
    }
    if (check) return;
    const before = await businessState(home);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, ".codex-model-kit-stage-"));
    const backup = join(staging, "previous");
    const next = join(staging, "next");
    let switched = false,
      registrationAttempted = false,
      installAttempted = false,
      keepRecovery = false;
    try {
      stage = "stage_source";
      await cp(join(root, "marketplace"), next, { recursive: true });
      await writeFile(
        join(next, "plugins/codex-model-kit/.mcp.json"),
        launchText,
      );
      if (hasTarget) {
        stage = "switch_source";
        await rename(target, backup);
        keepRecovery = true;
      }
      try {
        await rename(next, target);
      } catch (error) {
        if (hasTarget) {
          await rename(backup, target);
          keepRecovery = false;
        }
        throw error;
      }
      switched = true;
      keepRecovery = false;
      if (!existing) {
        stage = "register_marketplace";
        registrationAttempted = true;
        cli(["plugin", "marketplace", "add", target, "--json"], env);
      }
      // Add the versioned release without deleting the old cache used by live MCP processes.
      stage = "install_plugin";
      let alreadyCurrent = false;
      if (prior?.version === release.version) {
        try {
          await installedFiles(home, release.version, expectedFiles);
          alreadyCurrent = true;
        } catch {
          // A changed runtime or incomplete cache needs an official repair, not a false no-op.
        }
      }
      if (!alreadyCurrent) {
        installAttempted = true;
        cli(["plugin", "add", selector, "--json"], env);
      } else if (!prior.enabled) {
        installAttempted = true;
        cli(["plugin", "enable", selector, "--json"], env);
      }
      stage = "verify_install";
      const result = cli(
        ["plugin", "list", "--marketplace", "codex-model-kit", "--json"],
        env,
      );
      if (
        !Array.isArray(result.installed) ||
        !result.installed.some(
          (value) =>
            value.pluginId === selector &&
            value.version === release.version &&
            value.enabled === true,
        )
      )
        throw new InstallError("Installed version/enabled verification failed");
      await installedFiles(home, release.version, expectedFiles);
      stage = "verify_business_state";
      const after = await businessState(home);
      if (!isDeepStrictEqual(after, before)) {
        throw new InstallError(
          "Business configuration/catalog changed unexpectedly. Stop and inspect locally; no secret copies were saved.",
        );
      }
      log(
        `Installed and enabled ${releaseTag(release.version)}. Open a NEW chat and verify the page version. This does not prove native UI or Windows catalog-write validation.`,
      );
    } catch (error) {
      const failedStage = stage;
      if (switched) {
        try {
          stage = "rollback";
          await rename(target, join(staging, "failed"));
          if (hasTarget) await rename(backup, target);
          if (installAttempted && prior) {
            cli(["plugin", "add", selector, "--json"], env);
            if (!prior.enabled)
              cli(["plugin", "disable", selector, "--json"], env);
          } else if (installAttempted) {
            cli(["plugin", "remove", selector, "--json"], env);
          }
          if (registrationAttempted) {
            cli(
              ["plugin", "marketplace", "remove", "codex-model-kit", "--json"],
              env,
            );
          }
          const restored = cli(["plugin", "list", "--json"], env).installed;
          if (
            !Array.isArray(restored) ||
            (prior
              ? !restored.some(
                  (value) =>
                    value.pluginId === selector &&
                    value.version === prior.version &&
                    value.enabled === prior.enabled,
                )
              : restored.some((value) => value.pluginId === selector))
          )
            throw new InstallError("Previous plugin state was not restored");
          if (!isDeepStrictEqual(await businessState(home), before))
            throw new InstallError("Business state differs after recovery");
          if (prior) {
            // Old releases may have fewer docs; the executable and launch files must match.
            await installedFiles(home, prior.version, previousFiles);
          }
          stage = failedStage;
        } catch (recoveryError) {
          keepRecovery = true;
          log(
            `Automatic recovery incomplete. Preserve ${staging} and inspect the stable marketplace with official commands; do not edit the managed cache.`,
          );
          log(
            JSON.stringify({
              ...diagnostic,
              status: "recovery_required",
              stage: failedStage,
              rollbackStage: stage,
              rollbackFailure: failureDetails(recoveryError),
            }),
          );
        }
      } else if (keepRecovery) {
        log(
          `Source recovery incomplete. Preserve ${staging}; do not delete its previous directory or edit managed caches.`,
        );
        log(
          JSON.stringify({
            ...diagnostic,
            status: "recovery_required",
            stage: failedStage,
          }),
        );
      }
      stage = failedStage;
      throw error;
    } finally {
      if (!keepRecovery) {
        try {
          await cleanup(staging);
        } catch {
          log(
            `Cleanup pending: ${staging}. Installation/recovery result is unchanged. Close old plugin sessions before retrying cleanup; do not delete managed caches manually.`,
          );
          log(
            JSON.stringify({
              ...diagnostic,
              status: "cleanup_pending",
              stage: "cleanup",
            }),
          );
        }
      }
    }
  }
}
