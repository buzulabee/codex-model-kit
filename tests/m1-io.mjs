// Only isolated STDIO tests use this module. Allow bundled assets and the
// fixture's config.toml/validated profile files; reject auth/catalog and network.
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname, basename, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const root = resolve(process.env.CODEX_HOME);
const serverAsset = resolve(process.argv[1]);
const htmlAsset = resolve(dirname(serverAsset), "main.html");
function assetAllowed(path) {
  const full = resolve(
    path instanceof URL ? fileURLToPath(path) : String(path),
  );
  return full === serverAsset || full === htmlAsset;
}
function deny() {
  throw new Error("Forbidden fixture IO");
}
function configAllowed(path) {
  const full = resolve(String(path));
  return (
    dirname(full) === root &&
    (basename(full) === "config.toml" ||
      /^[A-Za-z0-9_-]{1,64}\.config\.toml$/.test(basename(full)))
  );
}
const read = fsp.readFile;
const readSync = fs.readFileSync;
const open = fsp.open;
const openSync = fs.openSync;
const opendir = fsp.opendir;
const realpath = fsp.realpath;
fsp.readFile = (path, ...args) =>
  assetAllowed(path) ? read(path, ...args) : deny();
fs.readFileSync = (path, ...args) =>
  assetAllowed(path) ? readSync(path, ...args) : deny();
fsp.open = (path, flags, ...args) =>
  configAllowed(path) &&
  typeof flags === "number" &&
  !(
    flags &
    (fs.constants.O_WRONLY |
      fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC)
  )
    ? open(path, flags, ...args)
    : deny();
fsp.opendir = (path, ...args) =>
  resolve(String(path)) === root ? opendir(path, ...args) : deny();
fsp.realpath = (path, ...args) =>
  resolve(String(path)) === root ? realpath(path, ...args) : deny();
fs.readFile = deny;
fs.open = deny;
// Node's readFileSync uses the public openSync internally. Permit only the
// bundle's read-only assets, never config/auth or any write-capable flags.
fs.openSync = (path, flags, ...args) =>
  assetAllowed(path) && flags === "r" ? openSync(path, flags, ...args) : deny();
fs.writeFile = deny;
fs.writeFileSync = deny;
fsp.writeFile = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
