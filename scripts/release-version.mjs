import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { releaseTag } from "../src/shared/release-version.ts";

export function releaseVersion(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  // Numeric components cannot have leading zeros in SemVer.
  return `${parts.year}.${Number(parts.month + parts.day)}.${Number(parts.hour + parts.minute)}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const version = releaseVersion();
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (pkg.version === version)
    throw new Error(
      "This release minute is already assigned; do not reuse a published UI version.",
    );
  for (const path of [
    "package.json",
    "package-lock.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
  ]) {
    const data = JSON.parse(await readFile(resolve(root, path), "utf8"));
    if (path === ".claude-plugin/marketplace.json")
      data.plugins[0].version = version;
    else data.version = version;
    if (path === "package-lock.json") data.packages[""].version = version;
    await writeFile(resolve(root, path), JSON.stringify(data, null, 2) + "\n");
  }
  const security = resolve(root, "src/shared/security.ts");
  const source = await readFile(security, "utf8");
  if (!/export const VERSION = "[^"]+";/.test(source))
    throw new Error("VERSION declaration not found");
  await writeFile(
    security,
    source.replace(
      /export const VERSION = "[^"]+";/,
      `export const VERSION = "${version}";`,
    ),
  );
  console.log(
    `Release version: ${releaseTag(version)} (package: ${version}, Asia/Shanghai)`,
  );
}
