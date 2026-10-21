// Only a child process running the M0 MCP fixture loads this module.
// Prevent unapproved configuration reads/network calls during protocol tests.
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
function deny() {
  throw new Error("Forbidden M0 IO");
}
const originalRead = fsp.readFile;
const originalReadSync = fs.readFileSync;
const allowed = (path) => /\/(main\.html|server\.mjs)$/.test(String(path));
fsp.readFile = (path, ...args) => {
  if (!allowed(path)) return Promise.reject(new Error("Forbidden M0 read"));
  return originalRead(path, ...args);
};
fs.readFile = deny;
fs.readFileSync = (path, ...args) => {
  if (!allowed(path)) return deny();
  return originalReadSync(path, ...args);
};
fs.writeFile = deny;
fs.writeFileSync = deny;
fsp.writeFile = deny;
fsp.open = deny;
fsp.opendir = deny;
fsp.realpath = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
