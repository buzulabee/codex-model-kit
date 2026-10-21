import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./app.js";

try {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Unsupported runtime");
  // Relative to the packaged server, independent of cwd and development source.
  const html = await readFile(new URL("./main.html", import.meta.url), "utf8");
  const server = createServer(html);
  server.server.onerror = () => {
    // Do not log raw exceptions, request arguments, or decrypted content.
    process.stderr.write("codex-model-kit: protocol operation failed\n");
  };
  await server.connect(new StdioServerTransport());
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch {
  process.stderr.write(
    "codex-model-kit: startup failed; check package and Node runtime\n",
  );
  process.exitCode = 1;
}
