import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
// Only generated output is replaced. No user configuration or catalog writes.
await rm(dist, { recursive: true, force: true });
const plugin = resolve(dist, "marketplace/plugins/codex-model-kit");
await mkdir(plugin, { recursive: true });
const ui = await build({
  absWorkingDir: root,
  entryPoints: ["src/ui/main.tsx"],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  target: "es2022",
  outfile: "main.js",
  legalComments: "inline",
  metafile: true,
});
const js = ui.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
const css = ui.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
if (!js || !css) throw new Error("Missing UI build output");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 模型工具 · 模型列表同步</title><style>${css.replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
await writeFile(resolve(plugin, "main.html"), html);
const serverBuild = await build({
  absWorkingDir: root,
  entryPoints: ["src/server/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: resolve(plugin, "server.mjs"),
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  legalComments: "inline",
  metafile: true,
});
for (const path of [
  ".codex-plugin",
  ".mcp.json",
  "assets",
  "README.md",
  "README.en.md",
  "INSTALL.md",
  "CI.md",
  "docs",
  "ACCEPTANCE.md",
  "WINDOWS.md",
]) {
  await cp(resolve(root, path), resolve(plugin, path), { recursive: true });
}
await cp(
  resolve(root, ".claude-plugin"),
  resolve(dist, "marketplace/.claude-plugin"),
  { recursive: true },
);
await cp(
  resolve(root, "package-lock.json"),
  resolve(dist, "package-lock.json"),
);
const installer = resolve(dist, "installer");
await mkdir(installer, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["scripts/install/install.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: resolve(installer, "install.mjs"),
});
for (const filename of ["install.ps1", "install.sh"]) {
  await cp(
    resolve(root, "scripts/install", filename),
    resolve(installer, filename),
  );
}
const lock = JSON.parse(
  await readFile(resolve(root, "package-lock.json"), "utf8"),
);
await writeFile(
  resolve(plugin, "DEPENDENCIES.json"),
  JSON.stringify(
    {
      note: "Bundled production dependencies; Node runtime is NOT included. License information is retained in server.mjs/main.html and THIRD_PARTY_LICENSES.txt.",
      packages: Object.fromEntries(
        Object.entries(lock.packages)
          .filter(([name, value]) => name && !value.dev)
          .map(([name, value]) => [
            name,
            {
              version: value.version,
              license: value.license,
              integrity: value.integrity,
            },
          ]),
      ),
    },
    null,
    2,
  ) + "\n",
);
let notices = "Bundled third-party license notices\n\n";
for (const name of Object.keys(lock.packages)) {
  if (!name || lock.packages[name].dev) continue;
  for (const filename of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "license",
    "license.md",
  ]) {
    try {
      notices += `--- ${name} ${lock.packages[name].version} ---\n${await readFile(resolve(root, name, filename), "utf8")}\n\n`;
      break;
    } catch {
      /* Not all packages use the same license filename. */
    }
  }
}
notices += await readFile(
  resolve(root, "src/catalog/REFERENCE_LICENSES.txt"),
  "utf8",
);
await writeFile(resolve(plugin, "THIRD_PARTY_LICENSES.txt"), notices);
await writeFile(
  resolve(dist, "build-meta.json"),
  JSON.stringify(
    {
      version: lock.version,
      nodeRuntimeIncluded: false,
      runtime: ">=24",
      htmlSha256: createHash("sha256").update(html).digest("hex"),
      uiImports: Object.values(ui.metafile.outputs).flatMap(
        (value) => value.imports,
      ),
      serverImports: Object.values(serverBuild.metafile.outputs).flatMap(
        (value) => value.imports,
      ),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Built self-contained catalog-sync marketplace: dist/marketplace (Node >=24 still required)",
);
