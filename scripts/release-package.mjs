import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseTag } from "../src/shared/release-version.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const meta = JSON.parse(await readFile(join(dist, "build-meta.json"), "utf8"));
const version = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;
assert.equal(meta.version, version, "Rebuild before packaging a release");
const filename = `codex-model-kit-${releaseTag(version)}.zip`;
const staging = join(dist, "release-content");
await rm(staging, { recursive: true, force: true });
await mkdir(staging);
await cp(join(dist, "marketplace"), join(staging, "marketplace"), {
  recursive: true,
});
await cp(join(dist, "installer"), staging, { recursive: true });
for (const path of [
  "README.md",
  "README.en.md",
  "ACCEPTANCE.md",
  "INSTALL.md",
  "CI.md",
  "WINDOWS.md",
  "docs",
])
  await cp(join(root, path), join(staging, path), { recursive: true });
const files = {};
async function collect(relative = "") {
  for (const entry of await readdir(join(staging, relative), {
    withFileTypes: true,
  })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile())
      files[path] = createHash("sha256")
        .update(await readFile(join(staging, path)))
        .digest("hex");
    else throw new Error("Release cannot contain symlinks");
  }
}
await collect();
await writeFile(
  join(staging, "release.json"),
  JSON.stringify(
    { version, runtime: ">=24", nodeRuntimeIncluded: false, files },
    null,
    2,
  ) + "\n",
);
const output = join(dist, "releases");
await mkdir(output, { recursive: true });
await rm(join(output, filename), { force: true });
const zipped = spawnSync("zip", ["-q", "-r", join(output, filename), "."], {
  cwd: staging,
  encoding: "utf8",
});
assert.equal(
  zipped.status,
  0,
  "Release packaging requires the zip utility (maintainer/CI only)",
);
const checksum = createHash("sha256")
  .update(await readFile(join(output, filename)))
  .digest("hex");
await writeFile(
  join(output, `${filename}.sha256`),
  `${checksum}  ${filename}\n`,
);
console.log(
  JSON.stringify(
    {
      version: releaseTag(version),
      archive: join(output, filename),
      sha256: checksum,
    },
    null,
    2,
  ),
);
