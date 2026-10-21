import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  publishRelease,
  repository,
  validateReleaseContext,
  verifyReleaseSource,
} from "../scripts/publish-github.mjs";

const version = "2026.1020.945";
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: repository,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  MODEL_KIT_DEFAULT_BRANCH: "main",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "123",
  GITHUB_TOKEN: "fixture-workflow-token-never-log",
};
const tag = "v2026.1020.0945";
const filename = `codex-model-kit-${tag}.zip`;
const zip = Buffer.from("fixture archive bytes");
const sha256 = createHash("sha256").update(zip).digest("hex");
const checksum = Buffer.from(`${sha256}  ${filename}\n`);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "model-kit-github-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/releases"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, "dist/releases", filename), zip);
  await writeFile(join(root, "dist/releases", `${filename}.sha256`), checksum);
  return root;
}

function server() {
  const files = new Map();
  const requests = [];
  const state = {
    release: null,
    tagCommit: null,
    ancestor: true,
    checkout: env.GITHUB_SHA,
    newer: false,
    corrupt: false,
    failUpload: false,
    redirect: null,
    annotated: false,
  };
  const gitImpl = (args) => {
    if (args[0] === "rev-parse") return { status: 0, stdout: state.checkout };
    if (args[0] === "fetch") {
      assert.deepEqual(args, [
        "fetch",
        "--no-tags",
        "origin",
        "refs/heads/main",
      ]);
      return { status: 0, stdout: "" };
    }
    if (args[0] === "merge-base") {
      assert.deepEqual(args, [
        "merge-base",
        "--is-ancestor",
        env.GITHUB_SHA,
        "FETCH_HEAD",
      ]);
      return { status: state.ancestor ? 0 : 1, stdout: "" };
    }
    assert.deepEqual(args, [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ]);
    return {
      status: 0,
      stdout: state.tagCommit
        ? state.annotated
          ? `${"c".repeat(40)}\trefs/tags/${tag}\n${state.tagCommit}\trefs/tags/${tag}^{}`
          : `${state.tagCommit}\trefs/tags/${tag}`
        : "",
    };
  };
  function bytes(asset) {
    return new Response(
      state.corrupt ? "corrupted" : files.get(asset.name).bytes,
    );
  }
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === "release-assets.githubusercontent.com") {
      assert.equal(
        options.headers,
        undefined,
        "Never send the token to a signed download URL",
      );
      assert.equal(options.redirect, "error");
      const asset = [...files.values()].find(
        (item) => String(item.id) === parsed.pathname.slice(1),
      );
      assert(asset);
      return bytes(asset);
    }
    assert(["api.github.com", "uploads.github.com"].includes(parsed.hostname));
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    assert.equal(options.redirect, "manual");
    const path =
      parsed.pathname.slice(`/repos/${repository}`.length) + parsed.search;
    const method = options.method || "GET";
    requests.push({ path, method, host: parsed.hostname });
    if (path.startsWith("/releases?per_page=100&page="))
      return Response.json([
        ...(state.newer
          ? [{ tag_name: "v2026.1021.0001", draft: false, prerelease: false }]
          : []),
        ...(state.release ? [state.release] : []),
      ]);
    if (path === "/releases" && method === "POST") {
      assert(!state.release);
      const body = JSON.parse(options.body);
      assert.equal(body.target_commitish, env.GITHUB_SHA);
      assert.equal(body.draft, true);
      state.release = { ...body, id: 1 };
      return Response.json(state.release, { status: 201 });
    }
    if (path === "/releases/1/assets?per_page=100")
      return Response.json(
        [...files.values()].map(({ bytes, ...asset }) => asset),
      );
    if (path.startsWith("/releases/1/assets?name=") && method === "POST") {
      assert.equal(parsed.hostname, "uploads.github.com");
      const name = parsed.searchParams.get("name");
      assert(!files.has(name), "Never overwrite an asset");
      if (state.failUpload && name.endsWith(".sha256"))
        return new Response("fixture failure", { status: 503 });
      const asset = {
        id: files.size + 10,
        name,
        bytes: Buffer.from(options.body),
      };
      files.set(name, asset);
      return Response.json({ id: asset.id, name }, { status: 201 });
    }
    if (/^\/releases\/assets\/\d+$/.test(path)) {
      assert.equal(options.headers.Accept, "application/octet-stream");
      const asset = [...files.values()].find(
        (item) => String(item.id) === path.split("/").at(-1),
      );
      assert(asset);
      if (state.redirect)
        return new Response(null, {
          status: 302,
          headers: {
            location:
              state.redirect === "signed"
                ? `https://release-assets.githubusercontent.com/${asset.id}?signature=fixture`
                : state.redirect,
          },
        });
      return bytes(asset);
    }
    if (path === "/releases/1" && method === "PATCH") {
      assert(state.release.draft);
      assert.equal(files.size, 2, "Both assets must exist before publication");
      assert.deepEqual(JSON.parse(options.body), {
        draft: false,
        make_latest: "true",
      });
      state.release.draft = false;
      state.tagCommit ||= env.GITHUB_SHA;
      return Response.json(state.release);
    }
    if (path === `/releases/tags/${tag}`) return Response.json(state.release);
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  };
  return { files, requests, state, fetchImpl, gitImpl };
}

test("GitHub release gate requires the canonical protected main and a valid version", () => {
  assert.equal(validateReleaseContext(env, version), tag);
  assert.equal(
    validateReleaseContext(
      { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" },
      version,
    ),
    tag,
  );
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "fork/model-kit" },
    { GITHUB_SERVER_URL: "https://evil.test" },
    { GITHUB_API_URL: "https://evil.test" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_REF: `refs/tags/${tag}` },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REF_PROTECTED: "false" },
    { MODEL_KIT_DEFAULT_BRANCH: "other" },
    { GITHUB_SHA: "invalid" },
    { GITHUB_RUN_ID: "123/evil" },
  ])
    assert.throws(() => validateReleaseContext({ ...env, ...change }, version));
  for (const invalid of ["1.2.3", `v${version}`, "2026.1020.0012"])
    assert.throws(() => validateReleaseContext(env, invalid));
});

test("release stages exact Actions artifacts, verifies downloads, publishes, then retries read-only", async (t) => {
  const root = await fixture(t);
  const api = server();
  const first = await publishRelease({ root, env, ...api });
  assert.deepEqual(first, {
    tag,
    commit: env.GITHUB_SHA,
    sha256,
    reused: false,
    url: `https://github.com/${repository}/releases/tag/${tag}`,
  });
  assert(api.state.release.body.includes(`SHA256: \`${sha256}\``));
  assert(api.state.release.body.includes(`/actions/runs/${env.GITHUB_RUN_ID}`));
  assert.equal(api.state.tagCommit, env.GITHUB_SHA);
  const publishIndex = api.requests.findIndex(
    (item) => item.method === "PATCH",
  );
  for (const asset of api.files.values()) {
    const uploadIndex = api.requests.findIndex(
      (item) =>
        item.path.includes(encodeURIComponent(asset.name)) &&
        item.method === "POST",
    );
    assert(uploadIndex > 0 && uploadIndex < publishIndex);
    assert(
      api.requests
        .slice(uploadIndex + 1, publishIndex)
        .some((item) => item.path === `/releases/assets/${asset.id}`),
    );
  }
  const count = api.requests.length;
  const second = await publishRelease({ root, env, ...api });
  assert.equal(second.reused, true);
  assert(api.requests.slice(count).every((item) => item.method === "GET"));
});

test("partial draft upload resumes using identical artifacts without deleting or overwriting", async (t) => {
  const root = await fixture(t);
  const api = server();
  api.state.failUpload = true;
  await assert.rejects(publishRelease({ root, env, ...api }), /HTTP 503/);
  assert(api.state.release.draft);
  assert.equal(api.files.size, 1);
  api.state.failUpload = false;
  await publishRelease({ root, env, ...api });
  assert.equal(api.files.size, 2);
  assert.equal(
    api.requests.filter(
      (item) =>
        item.method === "POST" &&
        item.path.endsWith(encodeURIComponent(filename)),
    ).length,
    1,
  );
});

test("same version with changed remote bytes fails before any write", async (t) => {
  const root = await fixture(t);
  const api = server();
  await publishRelease({ root, env, ...api });
  api.files.get(filename).bytes = Buffer.from("changed");
  const count = api.requests.length;
  await assert.rejects(publishRelease({ root, env, ...api }), /immutable/);
  assert(api.requests.slice(count).every((item) => item.method === "GET"));
});

test("published assets cannot be silently repaired and provenance cannot switch workflows", async (t) => {
  const root = await fixture(t);
  const api = server();
  await publishRelease({ root, env, ...api });
  await assert.rejects(
    publishRelease({ root, env: { ...env, GITHUB_RUN_ID: "124" }, ...api }),
    /provenance/,
  );
  api.files.delete(`${filename}.sha256`);
  await assert.rejects(
    publishRelease({ root, env, ...api }),
    /published release asset is missing/,
  );
});

test("local checksum mismatch, newer release and unrelated source prevent writes", async (t) => {
  for (const kind of ["checksum", "newer", "ancestor", "checkout", "tag"]) {
    const root = await fixture(t);
    const api = server();
    if (kind === "checksum")
      await writeFile(
        join(root, "dist/releases", `${filename}.sha256`),
        "wrong",
      );
    if (kind === "newer") api.state.newer = true;
    if (kind === "ancestor") api.state.ancestor = false;
    if (kind === "checkout") api.state.checkout = "b".repeat(40);
    if (kind === "tag") api.state.tagCommit = "b".repeat(40);
    await assert.rejects(publishRelease({ root, env, ...api }));
    assert(api.requests.every((item) => item.method === "GET"));
  }
});

test("corrupt remote download leaves a draft rather than publishing", async (t) => {
  const root = await fixture(t);
  const api = server();
  api.state.corrupt = true;
  await assert.rejects(
    publishRelease({ root, env, ...api }),
    /download verification/,
  );
  assert(api.state.release.draft);
  assert(!api.requests.some((item) => item.method === "PATCH"));
});

test("unexpected draft assets and changed metadata are refused without writes", async (t) => {
  const root = await fixture(t);
  const api = server();
  api.state.failUpload = true;
  await assert.rejects(publishRelease({ root, env, ...api }), /HTTP 503/);
  api.state.failUpload = false;
  api.files.set("unexpected.txt", {
    id: 40,
    name: "unexpected.txt",
    bytes: Buffer.from("fixture"),
  });
  let count = api.requests.length;
  await assert.rejects(publishRelease({ root, env, ...api }), /Unexpected/);
  assert(api.requests.slice(count).every((item) => item.method === "GET"));
  api.files.delete("unexpected.txt");
  api.state.release.body = "changed provenance";
  count = api.requests.length;
  await assert.rejects(publishRelease({ root, env, ...api }), /provenance/);
  assert(api.requests.slice(count).every((item) => item.method === "GET"));
});

test("signed asset redirects strip authentication and unexpected hosts are rejected", async (t) => {
  const root = await fixture(t);
  const api = server();
  api.state.redirect = "signed";
  await publishRelease({ root, env, ...api });
  for (const redirect of [
    "https://evil.test/asset",
    "http://release-assets.githubusercontent.com/asset",
    "https://user:password@release-assets.githubusercontent.com/asset",
    "https://release-assets.githubusercontent.com:444/asset",
  ]) {
    api.state.redirect = redirect;
    await assert.rejects(
      publishRelease({ root, env, ...api }),
      /Unexpected asset download host/,
    );
  }
});

test("release source supports annotated tags, requires the final tag, and redacts Git failures", () => {
  const api = server();
  assert.throws(
    () =>
      verifyReleaseSource({ env, tag, gitImpl: api.gitImpl, requireTag: true }),
    /tag differs or is missing/,
  );
  api.state.tagCommit = env.GITHUB_SHA;
  api.state.annotated = true;
  verifyReleaseSource({ env, tag, gitImpl: api.gitImpl, requireTag: true });
  assert.throws(
    () =>
      verifyReleaseSource({
        env,
        tag,
        gitImpl: () => ({
          status: 1,
          stdout: env.GITHUB_TOKEN,
          stderr: env.GITHUB_TOKEN,
        }),
      }),
    (error) => !error.message.includes(env.GITHUB_TOKEN),
  );
});

test("API failures and invalid metadata never include credentials or raw response bodies", async (t) => {
  const root = await fixture(t);
  for (const fetchImpl of [
    async () => {
      throw new Error(env.GITHUB_TOKEN);
    },
    async () => new Response(env.GITHUB_TOKEN, { status: 403 }),
    async () => new Response(env.GITHUB_TOKEN),
    async () => Response.json({ value: env.GITHUB_TOKEN }),
  ]) {
    await assert.rejects(
      publishRelease({ root, env, fetchImpl, gitImpl: server().gitImpl }),
      (error) => !error.message.includes(env.GITHUB_TOKEN),
    );
  }
});

test("workflow eligibility selects version changes or explicit dispatch, never PRs or docs pushes", async (t) => {
  const root = await fixture(t);
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["add", "package.json"]);
  git(["commit", "-m", "initial"]);
  const before = git(["rev-parse", "HEAD"]);
  await writeFile(join(root, "note.md"), "fixture");
  git(["add", "note.md"]);
  git(["commit", "-m", "docs"]);
  const docs = git(["rev-parse", "HEAD"]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ version, description: "fixture" }),
  );
  git(["add", "package.json"]);
  git(["commit", "-m", "version"]);
  const source = git(["rev-parse", "HEAD"]);
  for (const [eventName, event, sha, expected, protectedRef] of [
    ["pull_request", {}, source, "false", "false"],
    ["push", { before }, docs, "false", "true"],
    ["push", { before: docs }, source, "true", "true"],
    [
      "workflow_dispatch",
      { inputs: { publish: "false" } },
      source,
      "false",
      "true",
    ],
    [
      "workflow_dispatch",
      { inputs: { publish: "true" } },
      source,
      "true",
      "true",
    ],
    ["push", { before: docs }, source, null, "false"],
    ["push", { before: "invalid" }, source, null, "true"],
  ]) {
    const output = join(root, "output");
    const eventPath = join(root, "event.json");
    await writeFile(output, "");
    await writeFile(eventPath, JSON.stringify(event));
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/verify-release.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          ...env,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_SHA: sha,
          GITHUB_REF_PROTECTED: protectedRef,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, expected === null ? 1 : 0, result.stderr);
    assert.equal(
      await readFile(output, "utf8"),
      expected === null ? "" : `publish=${expected}\n`,
    );
  }
});
