import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseTag } from "../src/shared/release-version.ts";

export const repository = "buzulabee/codex-model-kit";
const tagPattern = /^v\d{4}\.\d{4}\.\d{4}$/;

export function validateReleaseContext(env, version) {
  const tag = releaseTag(version);
  assert(env.GITHUB_ACTIONS === "true", "Only GitHub Actions can publish");
  assert(
    env.GITHUB_REPOSITORY === repository,
    "Only the canonical repository can publish",
  );
  assert(env.GITHUB_SERVER_URL === "https://github.com", "Expected GitHub.com");
  assert(
    env.GITHUB_API_URL === "https://api.github.com",
    "Expected the GitHub.com API",
  );
  assert(
    ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
    "Only main pushes or manual workflows can publish",
  );
  assert(
    env.MODEL_KIT_DEFAULT_BRANCH === "main",
    "The default branch must be main",
  );
  assert(env.GITHUB_REF === "refs/heads/main", "Only main can publish");
  assert(env.GITHUB_REF_PROTECTED === "true", "main must be protected");
  assert(
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ""),
    "Expected a source commit SHA",
  );
  assert(
    /^[1-9]\d*$/.test(env.GITHUB_RUN_ID || ""),
    "Expected an Actions run ID",
  );
  return tag;
}

export function verifyReleaseSource({
  env,
  tag,
  root,
  requireTag = false,
  gitImpl = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 120_000 }),
}) {
  function git(args) {
    const result = gitImpl(args);
    assert(
      result.status === 0,
      "Cannot verify release source; Git output was not logged",
    );
    return result.stdout.trim();
  }
  assert(
    git(["rev-parse", "HEAD"]) === env.GITHUB_SHA,
    "Checkout differs from the workflow source",
  );
  git(["fetch", "--no-tags", "origin", "refs/heads/main"]);
  git(["merge-base", "--is-ancestor", env.GITHUB_SHA, "FETCH_HEAD"]);
  const ref = `refs/tags/${tag}`;
  const refs = git(["ls-remote", "--tags", "origin", ref, `${ref}^{}`]);
  const targets = new Map(
    refs
      ? refs.split("\n").map((line) => {
          const [sha, name] = line.split(/\s+/);
          return [name, sha];
        })
      : [],
  );
  const target = targets.get(`${ref}^{}`) || targets.get(ref);
  assert(
    (!refs && !requireTag) || target === env.GITHUB_SHA,
    "Release tag differs or is missing; never move a published tag",
  );
}

export async function publishRelease({
  env = process.env,
  root = process.cwd(),
  fetchImpl = fetch,
  gitImpl,
} = {}) {
  const version = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  ).version;
  const tag = validateReleaseContext(env, version);
  assert(env.GITHUB_TOKEN, "The workflow GITHUB_TOKEN is required");
  const base = `https://api.github.com/repos/${repository}`;
  const run = `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`;
  const commit = env.GITHUB_SHA;

  async function request(path, options = {}, upload = false) {
    const url = `${upload ? `https://uploads.github.com/repos/${repository}` : base}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...options.headers,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new Error(
        "GitHub request failed; no credentials or response were logged",
      );
    }
    if (
      !response.ok &&
      !(
        options.headers?.Accept === "application/octet-stream" &&
        response.status === 302
      )
    )
      throw new Error(
        `GitHub publish failed: HTTP ${response.status} (${options.method || "GET"})`,
      );
    return response;
  }
  async function metadata(response) {
    try {
      return await response.json();
    } catch {
      throw new Error("GitHub returned invalid release metadata");
    }
  }
  async function download(asset) {
    assert(Number.isSafeInteger(asset.id) && asset.id > 0, "Invalid asset ID");
    let response = await request(`/releases/assets/${asset.id}`, {
      headers: { Accept: "application/octet-stream" },
    });
    if (response.status === 302) {
      let url;
      try {
        url = new URL(response.headers.get("location"));
      } catch {
        throw new Error("Invalid asset download redirect");
      }
      assert(
        url.protocol === "https:" &&
          [
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
          ].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.port,
        "Unexpected asset download host",
      );
      try {
        // Signed asset URLs must never receive the workflow token.
        response = await fetchImpl(url.href, {
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        throw new Error("Asset download failed; no signed URL was logged");
      }
      assert(response.ok, "Asset download failed");
    }
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Error("Asset body could not be read; no signed URL was logged");
    }
  }
  async function releases() {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await metadata(
        await request(`/releases?per_page=100&page=${page}`),
      );
      assert(Array.isArray(rows), "GitHub returned invalid releases");
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new Error("Too many releases to verify safely");
  }
  function verifyOrder(rows) {
    for (const previous of rows.filter(
      (item) => !item.draft && !item.prerelease,
    )) {
      assert(
        typeof previous.tag_name === "string" &&
          tagPattern.test(previous.tag_name),
        "Existing release has an unsupported version",
      );
      const a = version.split(".").map(Number);
      const b = previous.tag_name.slice(1).split(".").map(Number);
      const index = a.findIndex((value, i) => value !== b[i]);
      assert(
        index < 0 || a[index] > b[index],
        "A newer version is already released",
      );
    }
  }

  const name = `codex-model-kit-${tag}.zip`;
  const zip = await readFile(resolve(root, "dist/releases", name));
  const checksum = await readFile(
    resolve(root, "dist/releases", `${name}.sha256`),
  );
  const sha256 = createHash("sha256").update(zip).digest("hex");
  assert(
    checksum.toString().trim() === `${sha256}  ${name}`,
    "Local ZIP/checksum mismatch",
  );
  const files = [
    { name, bytes: zip },
    { name: `${name}.sha256`, bytes: checksum },
  ];
  verifyReleaseSource({ env, tag, root, gitImpl });
  let rows = await releases();
  verifyOrder(rows);
  let release = rows.find((item) => item.tag_name === tag);
  const reused = Boolean(release && !release.draft);
  const body = `Prebuilt plugin package; Node >=24 is required and is not included. Download the ZIP and SHA256 and follow INSTALL.md. Do not use the source-code archive.\n\nSHA256: \`${sha256}\`\n\nSource: \`${commit}\`\n\nWorkflow: ${run}\n\nBuilt from the source commit by this GitHub Actions workflow. Linux CI does not validate native Windows/macOS installation or the Codex UI. See ACCEPTANCE.md for the validation scope.`;
  function validateRelease(item) {
    assert(
      item?.tag_name === tag &&
        item.target_commitish === commit &&
        !item.prerelease,
      "Existing release source differs",
    );
    assert(
      item.body === body,
      "Existing release checksum or provenance differs; use the original workflow artifacts",
    );
    assert(Number.isSafeInteger(item.id) && item.id > 0, "Invalid release ID");
  }
  if (release) validateRelease(release);
  else {
    release = await metadata(
      await request("/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: commit,
          name: `Codex Model Kit ${tag}`,
          body,
          draft: true,
          prerelease: false,
        }),
      }),
    );
    validateRelease(release);
    assert(release.draft, "Release must be staged as a draft");
  }
  const assets = await metadata(
    await request(`/releases/${release.id}/assets?per_page=100`),
  );
  assert(
    Array.isArray(assets) && assets.length <= files.length,
    "Unexpected release assets; refusing to modify them",
  );
  assert(
    assets.every((asset) => files.some((file) => file.name === asset.name)) &&
      new Set(assets.map((asset) => asset.name)).size === assets.length,
    "Unexpected or duplicate release assets",
  );
  // Verify every existing asset before uploading anything. Never overwrite or delete.
  for (const file of files) {
    file.asset = assets.find((asset) => asset.name === file.name);
    if (file.asset)
      assert(
        file.bytes.equals(await download(file.asset)),
        "Published version is immutable; publish a new version",
      );
    else assert(release.draft, "A published release asset is missing");
  }
  for (const file of files) {
    if (!file.asset)
      file.asset = await metadata(
        await request(
          `/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: file.bytes,
          },
          true,
        ),
      );
    assert(
      file.asset.name === file.name &&
        file.bytes.equals(await download(file.asset)),
      "Remote download verification failed; release remains a draft",
    );
  }
  if (release.draft) {
    verifyReleaseSource({ env, tag, root, gitImpl });
    rows = await releases();
    verifyOrder(rows);
    release = await metadata(
      await request(`/releases/${release.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: false, make_latest: "true" }),
      }),
    );
  }
  validateRelease(release);
  assert(!release.draft, "Release is not published");
  verifyReleaseSource({ env, tag, root, gitImpl, requireTag: true });
  const published = await metadata(await request(`/releases/tags/${tag}`));
  validateRelease(published);
  assert(!published.draft, "Release is not public");
  for (const file of files)
    assert(
      file.bytes.equals(await download(file.asset)),
      "Published asset download verification failed",
    );
  return {
    tag,
    commit,
    sha256,
    reused,
    url: `https://github.com/${repository}/releases/tag/${tag}`,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(await publishRelease(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
