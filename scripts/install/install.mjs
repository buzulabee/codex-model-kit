import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliError,
  InstallError,
  installRelease,
  runCli,
} from "./installer.mjs";
import { RuntimeError, selectRuntime } from "./runtime.mjs";

async function main() {
  const args = process.argv.slice(2);
  let explicit,
    codex = process.env.CODEX_CLI_PATH || "codex",
    check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (["--node", "--codex"].includes(args[i]) && args[i + 1]) {
      if (args[i++] === "--node") explicit = args[i];
      else codex = args[i];
    } else
      throw new InstallError(
        "Usage: install.mjs [--check] [--node PATH] [--codex PATH]",
      );
  }
  await installRelease({
    root: dirname(fileURLToPath(import.meta.url)),
    home: resolve(process.env.CODEX_HOME || join(homedir(), ".codex")),
    runtime: selectRuntime({ explicit }),
    cli: (command, env) => runCli(codex, command, env),
    check,
  });
}
main().catch((error) => {
  console.error(
    error instanceof CliError ||
      error instanceof InstallError ||
      error instanceof RuntimeError
      ? error.message
      : "Plugin installation/check failed. Review the stage above; no raw error output is logged. Close old plugin sessions and retry if files are in use. Do not hand-edit caches or bypass policy.",
  );
  process.exitCode = 1;
});
