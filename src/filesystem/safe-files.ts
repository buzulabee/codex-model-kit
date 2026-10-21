import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { SafeError } from "../connections/envelopes.js";
import type { FailureContext } from "../shared/diagnostics.js";

export function catalogPathIssue(
  path: string,
  platform: NodeJS.Platform = process.platform,
  relative = false,
): FailureContext["rule"] | undefined {
  if (!path.trim() || path.length > 1200 || /[\x00-\x1f\x7f]/.test(path))
    return "unsupported_path";
  const parts = path.split(/[\\/]/);
  const name = parts.at(-1)!;
  if (/^(?:auth\.json|.*\.toml)$/i.test(name)) return "protected_path";
  if (platform === "win32") {
    const drive = /^[A-Za-z]:[\\/]/.test(path);
    // No device namespace, UNC shares, ADS, drive-relative or root-relative paths.
    if ((!drive && !relative) || (!drive && /^(?:[\\/]|[A-Za-z]:)/.test(path)))
      return "unsupported_path";
    const components = (drive ? path.slice(3) : path).split(/[\\/]/);
    if (
      components.some(
        (part) =>
          part !== "." &&
          part !== ".." &&
          (/[ .]$/.test(part) ||
            /[:<>"|?*]/.test(part) ||
            /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:[ .]|$)/i.test(
              part,
            )),
      )
    )
      return "unsupported_path";
  } else if (
    /^[A-Za-z]:|^(?:\\\\|\/\/)/.test(path) ||
    (!relative && !isAbsolute(path))
  )
    return "unsupported_path";
  return undefined;
}

export function assertCatalogPath(path: string): void {
  const rule = catalogPathIssue(path);
  if (rule)
    throw new SafeError("catalog_not_writable", { stage: "read_target", rule });
}

export async function openRegularRead(path: string) {
  const before = await lstat(path);
  if (before.isSymbolicLink())
    throw new SafeError("catalog_not_writable", {
      stage: "read_target",
      rule: "symbolic_link",
    });
  if (!before.isFile())
    throw new SafeError("catalog_not_writable", {
      stage: "read_target",
      rule: "not_regular",
    });
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw new SafeError("catalog_not_writable", {
        stage: "read_target",
        rule: "file_changed",
      });
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function openCatalogRead(path: string) {
  assertCatalogPath(path);
  const file = await openRegularRead(path);
  try {
    // Check canonical names too (Windows short-name aliases can hide auth.json).
    assertCatalogPath(await realpath(path));
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
