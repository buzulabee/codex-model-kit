import { appendFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { validateReleaseContext } from "./publish-github.mjs";

const env = process.env;
const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
let publish =
  env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
  event.inputs?.publish === "true";
if (env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main") {
  if (/^0{40}$/.test(event.before || "")) publish = true;
  else {
    if (!/^[a-f0-9]{40}$/.test(event.before || ""))
      throw new Error("Invalid previous main commit");
    const result = spawnSync(
      "git",
      [
        "diff",
        "--name-only",
        event.before,
        env.GITHUB_SHA,
        "--",
        "package.json",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (result.status !== 0)
      throw new Error("Cannot check main version changes");
    publish = result.stdout.trim() === "package.json";
  }
}
if (publish) {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  validateReleaseContext(env, version);
}
await appendFile(env.GITHUB_OUTPUT, `publish=${publish}\n`);
console.log(
  publish
    ? "Release build selected; publication requires the release environment approval."
    : "Verification only; no release will be published.",
);
