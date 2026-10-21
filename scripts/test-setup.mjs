import { mkdir } from "node:fs/promises";

await mkdir(new URL("../.test-artifacts/", import.meta.url), {
  recursive: true,
});
