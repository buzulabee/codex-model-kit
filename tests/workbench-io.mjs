// Only isolated STDIO tests use this module. Allow bundled assets and the
// fixture's config.toml/validated profiles and models.json; catalog writes
// are limited to the fixture directory. Reject auth and external IO.
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
const catalog = resolve(root, "models.json");
const catalogArtifact =
  /^models\.json\.codex-model-kit(?:-[0-9a-f-]{36}\.(?:bak|tmp)|\.lock)$/;
function catalogAllowed(path) {
  const full = resolve(String(path));
  return (
    full === catalog ||
    (dirname(full) === root && catalogArtifact.test(basename(full)))
  );
}
function configAllowed(path) {
  const full = resolve(String(path));
  return (
    dirname(full) === root &&
    (basename(full) === "config.toml" ||
      basename(full) === "models.json" ||
      catalogArtifact.test(basename(full)) ||
      /^[A-Za-z0-9_-]{1,64}\.config\.toml$/.test(basename(full)))
  );
}
const read = fsp.readFile;
const readSync = fs.readFileSync;
const open = fsp.open;
const openSync = fs.openSync;
const opendir = fsp.opendir;
const realpath = fsp.realpath;
const link = fsp.link;
const rename = fsp.rename;
const unlink = fsp.unlink;
fsp.readFile = (path, ...args) =>
  assetAllowed(path) ? read(path, ...args) : deny();
fs.readFileSync = (path, ...args) =>
  assetAllowed(path) ? readSync(path, ...args) : deny();
fsp.open = (path, flags, ...args) => {
  const writable =
    typeof flags === "number" &&
    !!(
      flags &
      (fs.constants.O_WRONLY |
        fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC)
    );
  return typeof flags === "number" &&
    (writable
      ? catalogAllowed(path) &&
        resolve(String(path)) !== catalog &&
        !!(flags & fs.constants.O_EXCL)
      : configAllowed(path) || resolve(String(path)) === root)
    ? open(path, flags, ...args)
    : deny();
};
fsp.link = (source, target) =>
  catalogAllowed(source) && resolve(String(target)) === catalog
    ? link(source, target)
    : deny();
fsp.rename = (source, target) =>
  catalogAllowed(source) && resolve(String(target)) === catalog
    ? rename(source, target)
    : deny();
fsp.unlink = (path) => (catalogAllowed(path) ? unlink(path) : deny());
fsp.opendir = (path, ...args) =>
  resolve(String(path)) === root ? opendir(path, ...args) : deny();
fsp.realpath = (path, ...args) =>
  resolve(String(path)) === root || catalogAllowed(path)
    ? realpath(path, ...args)
    : deny();
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
const origin = new URL(process.env.MODEL_KIT_TEST_ORIGIN);
if (origin.hostname !== "127.0.0.1" || origin.protocol !== "http:") deny();
const connect = net.createConnection;
const fixtureConnect = (options, ...args) =>
  options &&
  typeof options === "object" &&
  options.host === "127.0.0.1" &&
  String(options.port) === origin.port
    ? connect(options, ...args)
    : deny();
net.connect = fixtureConnect;
net.createConnection = fixtureConnect;
const fetchFixture = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(String(input));
  if (
    url.origin !== origin.origin ||
    !/^\/relay\/v1\/(models|responses)$/.test(url.pathname) ||
    options?.redirect !== "manual"
  )
    deny();
  return fetchFixture(input, options);
};
syncBuiltinESMExports();
