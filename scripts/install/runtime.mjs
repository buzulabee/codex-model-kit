import { spawnSync } from "node:child_process";

export class RuntimeError extends Error {}

export function selectRuntime({
  explicit,
  env = process.env,
  current = process.execPath,
  probe = (file) =>
    spawnSync(
      file,
      [
        "-p",
        "JSON.stringify({version:process.versions.node,execPath:process.execPath})",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    ),
} = {}) {
  const candidates = explicit
    ? [["explicit", explicit]]
    : [
        ["client", env.CODEX_MCP_NODE_PATH],
        ["installer", current],
        ["PATH", "node"],
      ];
  const seen = new Set();
  for (const [source, file] of candidates) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    try {
      const result = probe(file);
      if (result.status !== 0) continue;
      const value = JSON.parse(result.stdout);
      if (
        !/^\d+\.\d+\.\d+$/.test(value.version) ||
        Number(value.version.split(".")[0]) < 24 ||
        typeof value.execPath !== "string" ||
        !value.execPath
      )
        continue;
      return { source, path: value.execPath, version: value.version };
    } catch {
      /* Try the next runtime without exposing process output. */
    }
  }
  throw new RuntimeError(
    "No supported Node.js runtime. Use the desktop client's Node >=24 or install Node >=24, then retry with -NodePath / --node. Nothing was installed.",
  );
}

export function launchConfig(runtime) {
  return {
    mcpServers: {
      "codex-model-kit": {
        command: runtime.path,
        args: ["./server.mjs"],
        cwd: ".",
        env_vars: ["PATH", "CODEX_HOME", "CODEX_MCP_NODE_PATH"],
        tool_timeout_sec: 30,
      },
    },
  };
}
