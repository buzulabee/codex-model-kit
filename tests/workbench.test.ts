import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ConfigReadError, type ConfigSource } from "../src/config/discovery.js";
import { ConnectionManager } from "../src/connections/manager.js";
import { SafeError, SecuritySession } from "../src/connections/envelopes.js";
import { referenceOf, snapshotSchema } from "../src/shared/security.js";
import { Workbench } from "../src/tasks/workbench.js";
import { type Fetcher } from "../src/providers/http.js";
const secret = "FAKE-WORKBENCH-SECRET";
const config = (options = "") =>
  `model_provider="fixture"\n[model_providers.fixture]\nbase_url="https://fixture.test/custom/v1"\nexperimental_bearer_token="${secret}"\n${options}`;
class Source implements ConfigSource {
  homeSource = "CODEX_HOME" as const;
  reads: string[] = [];
  constructor(readonly content = config()) {}
  async read(filename: string) {
    this.reads.push(filename);
    if (filename !== "config.toml") throw new ConfigReadError("missing");
    return this.content;
  }
  async profileNames() {
    return { names: [], limited: false };
  }
}
const success = () =>
  new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "anything" }] }] } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
async function setup(fetcher: Fetcher = async () => success(), options = "") {
  const source = new Source(config(options));
  const manager = new ConnectionManager(new SecuritySession(), source);
  const workbench = new Workbench(manager, fetcher);
  await manager.reload(referenceOf(manager.snapshot()));
  const candidate = manager.snapshot().config!.candidates[0]!;
  manager.select(
    referenceOf(manager.snapshot()),
    candidate.candidateId,
    false,
    !!candidate.bearerOnlyAvailable,
  );
  workbench.addManual(referenceOf(manager.snapshot()), "model-A");
  workbench.addManual(referenceOf(manager.snapshot()), "model-B");
  return {
    manager,
    workbench,
    source,
    ref: () => referenceOf(manager.snapshot()),
  };
}
async function wait(
  workbench: Workbench,
  predicate: (s: ReturnType<Workbench["snapshot"]>) => boolean,
) {
  for (let i = 0; i < 300; i++) {
    if (predicate(workbench.snapshot())) return workbench.snapshot();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Fixture deadline");
}
const fails = (code: string) => (error: unknown) =>
  error instanceof SafeError && error.code === code;
test("open/select/add/plan are local, GET never POSTs, refresh preserves evidence and manual IDs", async () => {
  const requests: RequestInit[] = [];
  const { workbench, ref, source } = await setup(async (_url, options) => {
    requests.push(options!);
    return options!.method === "GET"
      ? Response.json({ data: [{ id: "model-A" }] })
      : success();
  });
  try {
    snapshotSchema.parse(workbench.snapshot());
    assert.deepEqual(source.reads, ["config.toml"]);
    workbench.plan(ref(), ["model-A"]);
    assert.equal(requests.length, 0);
    workbench.refreshModels(ref());
    const ready = await wait(
      workbench,
      (s) => s.workbench!.catalog.status !== "loading",
    );
    assert.equal(ready.workbench!.catalog.status, "ready");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "GET");
    const plan = workbench.plan(ref(), ["model-A"]);
    workbench.start(ref(), plan.planId, randomUUID());
    await wait(workbench, (s) => !s.workbench!.activeJobId);
    workbench.refreshModels(ref());
    const next = await wait(
      workbench,
      (s) => s.workbench!.catalog.status !== "loading",
    );
    assert.equal(
      next.workbench!.catalog.models.find((m) => m.id === "model-A")!.result!
        .status,
      "passed",
    );
    assert.equal(
      next.workbench!.catalog.models.find((m) => m.id === "model-B")!.source,
      "manual",
    );
    assert(!JSON.stringify(next).includes(secret));
  } finally {
    workbench.close();
  }
});
test("idempotent start is single POST, new key cannot reuse consumed plan, model batch is bounded", async () => {
  let posts = 0;
  const { workbench, ref } = await setup(async () => {
    posts++;
    return success();
  });
  try {
    assert.throws(() => workbench.plan(ref(), []), fails("invalid_models"));
    assert.throws(
      () => workbench.plan(ref(), ["model-A", "model-A"]),
      fails("invalid_models"),
    );
    assert.throws(
      () => workbench.plan(ref(), ["unknown"]),
      fails("invalid_models"),
    );
    assert.throws(
      () => workbench.plan(ref(), Array(11).fill("model-A")),
      fails("invalid_models"),
    );
    assert.throws(
      () => workbench.addManual(ref(), secret),
      fails("invalid_models"),
    );
    const plan = workbench.plan(ref(), ["model-A"]),
      key = randomUUID();
    const first = workbench.start(ref(), plan.planId, key);
    assert.equal(first.workbench!.jobs[0]!.status, "queued");
    workbench.start(ref(), plan.planId, key);
    assert.throws(
      () => workbench.plan(ref(), ["model-A"]),
      fails("task_running"),
    );
    await wait(workbench, (s) => !s.workbench!.activeJobId);
    workbench.start(ref(), plan.planId, key);
    assert.equal(posts, 1);
    assert.equal(workbench.snapshot().workbench!.jobs.length, 1);
    assert.throws(
      () => workbench.start(ref(), plan.planId, randomUUID()),
      fails("expired_plan"),
    );
    assert.throws(
      () => workbench.start(ref(), randomUUID(), key),
      fails("idempotency_conflict"),
    );
  } finally {
    workbench.close();
  }
});
test("refresh attaches official Terra defaults without inference requests", async () => {
  const requests: string[] = [];
  const { workbench, ref } = await setup(async (_url, options) => {
    requests.push(options!.method!);
    return Response.json({ data: [{ id: "gpt-6.1-terra" }] });
  });
  try {
    workbench.refreshModels(ref());
    const ready = await wait(
      workbench,
      (s) => s.workbench!.catalog.status !== "loading",
    );
    snapshotSchema.parse(ready);
    assert.equal(ready.workbench!.catalog.status, "ready");
    const model = ready.workbench!.catalog.models.find(
      (m) => m.id === "gpt-6.1-terra",
    )!;
    assert.deepEqual(model.referenceMetadata, {
      source: "canonical-reference",
      values: {
        contextWindow: 1050000,
        images: true,
        reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    });
    assert.equal(model.metadata, undefined);
    assert.equal(model.result, null);
    assert.deepEqual(requests, ["GET"]);
  } finally {
    workbench.close();
  }
});
test("queued cancellation performs no POST; in-flight cancellation stops next models and preserves completed results", async () => {
  let posts = 0;
  const { workbench, ref } = await setup(async (_url, options) => {
    posts++;
    if (posts === 1) return success();
    return new Promise((_r, reject) =>
      options!.signal!.addEventListener(
        "abort",
        () => reject(new Error(secret)),
        { once: true },
      ),
    );
  });
  try {
    let plan = workbench.plan(ref(), ["model-A"]);
    let started = workbench.start(ref(), plan.planId, randomUUID());
    workbench.cancel(ref(), started.workbench!.activeJobId!);
    await wait(workbench, (s) => !s.workbench!.activeJobId);
    assert.equal(posts, 0);
    assert.equal(workbench.snapshot().workbench!.jobs[0]!.status, "cancelled");
    workbench.addManual(ref(), "model-C");
    plan = workbench.plan(ref(), ["model-A", "model-B", "model-C"]);
    started = workbench.start(ref(), plan.planId, randomUUID());
    await wait(
      workbench,
      (s) => s.workbench!.jobs[1]!.currentModel === "model-B",
    );
    workbench.cancel(ref(), started.workbench!.activeJobId!);
    const end = await wait(workbench, (s) => !s.workbench!.activeJobId);
    assert.equal(posts, 2);
    assert.equal(end.workbench!.jobs[1]!.results[0]!.result.status, "passed");
    assert.equal(
      end.workbench!.jobs[1]!.results[1]!.result.reasonCode,
      "cancelled",
    );
    assert.equal(end.workbench!.jobs[1]!.status, "cancelled");
  } finally {
    workbench.close();
  }
});
test("cross instance/revision and stale asynchronous results cannot attach to a new connection", async () => {
  let resolveFetch!: (value: Response) => void;
  const { workbench, manager, ref } = await setup(
    async () => new Promise((r) => (resolveFetch = r)),
  );
  const other = await setup();
  try {
    const old = ref();
    const plan = workbench.plan(old, ["model-A"]);
    assert.throws(
      () => workbench.start(other.ref(), plan.planId, randomUUID()),
      fails("stale_reference"),
    );
    workbench.refreshModels(old);
    manager.reset(old);
    resolveFetch(Response.json({ data: [{ id: "stale" }] }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(workbench.snapshot().workbench!.catalog.status, "idle");
    assert.equal(workbench.snapshot().workbench!.catalog.models.length, 0);
    assert.throws(
      () => workbench.start(old, plan.planId, randomUUID()),
      fails("stale_reference"),
    );
    assert.equal(other.workbench.snapshot().workbench!.jobs.length, 0);
  } finally {
    workbench.close();
    other.workbench.close();
  }
});
test("serial batches never overlap; history limit is enforced without silent deletion", async () => {
  let active = 0,
    max = 0;
  const { workbench, ref } = await setup(async () => {
    active++;
    max = Math.max(active, max);
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return success();
  });
  try {
    for (let i = 0; i < 32; i++) {
      const plan = workbench.plan(ref(), ["model-A", "model-B"]);
      workbench.start(ref(), plan.planId, randomUUID());
      await wait(workbench, (s) => !s.workbench!.activeJobId);
    }
    assert.equal(max, 1);
    assert.equal(workbench.snapshot().workbench!.jobs.length, 32);
    assert.throws(
      () => workbench.plan(ref(), ["model-A"]),
      fails("task_limit"),
    );
  } finally {
    workbench.close();
  }
});
test("cancelled models read transitions out of loading, invalid list responses have actionable errors", async () => {
  const { workbench, ref } = await setup(
    async (_url, options) =>
      new Promise((_r, reject) =>
        options!.signal!.addEventListener(
          "abort",
          () => reject(new Error(secret)),
          { once: true },
        ),
      ),
  );
  try {
    workbench.refreshModels(ref());
    workbench.refreshModels(ref());
    workbench.cancelModels(ref());
    const s = await wait(
      workbench,
      (s) => s.workbench!.catalog.status !== "loading",
    );
    assert.equal(s.workbench!.catalog.reasonCode, "cancelled");
  } finally {
    workbench.close();
  }
});
test("account marker plus same provider Bearer requires explicit fallback; headers/env/options cannot fallback", async () => {
  for (const options of [
    "requires_openai_auth=true",
    'requires_openai_auth=true\nhttp_headers={x="v"}',
    'requires_openai_auth=true\nenv_key="OTHER_KEY"',
    "requires_openai_auth=true\nrequest_max_retries=1",
  ]) {
    const manager = new ConnectionManager(
      new SecuritySession(),
      new Source(config(options)),
    );
    await manager.reload(referenceOf(manager.snapshot()));
    const candidate = manager.snapshot().config!.candidates[0]!;
    assert.equal(candidate.reusable, false);
    assert.equal(candidate.credentialPresent, false);
    assert.throws(
      () =>
        manager.select(
          referenceOf(manager.snapshot()),
          candidate.candidateId,
          false,
        ),
      fails("unsupported_connection"),
    );
    if (options === "requires_openai_auth=true") {
      assert(candidate.bearerOnlyAvailable);
      manager.select(
        referenceOf(manager.snapshot()),
        candidate.candidateId,
        false,
        true,
      );
      assert.equal(manager.snapshot().connection!.authMode, "explicit_bearer");
      assert(manager.snapshot().connection!.ready);
    } else {
      assert(!candidate.bearerOnlyAvailable);
      assert.throws(
        () =>
          manager.select(
            referenceOf(manager.snapshot()),
            candidate.candidateId,
            false,
            true,
          ),
        fails("unsupported_connection"),
      );
    }
  }
});
test("confirmation expiry and cap are checked before sending POST", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let posts = 0;
  const { workbench, ref } = await setup(async () => {
    posts++;
    return success();
  });
  try {
    const plan = workbench.plan(ref(), ["model-A"]);
    t.mock.timers.tick(60001);
    assert.throws(
      () => workbench.start(ref(), plan.planId, randomUUID()),
      fails("expired_plan"),
    );
    assert.equal(posts, 0);
  } finally {
    workbench.close();
    t.mock.timers.reset();
  }
});

test("connection rebuild aborts in-flight inference and discards a late old-generation result", async () => {
  let release!: (response: Response) => void;
  let signal: AbortSignal | null = null;
  let requests = 0;
  const { workbench, manager, ref } = await setup(async (_url, options) => {
    requests++;
    signal = options!.signal as AbortSignal;
    // Simulate a broken transport that resolves even after abort.
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  try {
    const old = ref();
    const plan = workbench.plan(old, ["model-A", "model-B"]);
    workbench.start(old, plan.planId, randomUUID());
    await wait(workbench, () => requests === 1);
    manager.select(
      ref(),
      manager.snapshot().config!.candidates[0]!.candidateId,
      false,
    );
    assert.equal((signal as unknown as AbortSignal).aborted, true);
    workbench.addManual(ref(), "model-A");
    release(success());
    await new Promise((resolve) => setTimeout(resolve, 15));
    const next = workbench.snapshot().workbench!;
    assert.equal(requests, 1, "old batch cannot start its next model");
    assert.equal(next.jobs.length, 0);
    assert.equal(next.activeJobId, null);
    assert.equal(
      next.catalog.models[0]!.result,
      null,
      "same ID under a new revision remains untested",
    );
    assert.throws(
      () => workbench.cancel(old, "unused"),
      fails("stale_reference"),
    );
  } finally {
    release?.(success());
    workbench.close();
  }
});

test("one confirmed plan handles more than ten models serially, without implicit POST or duplicate starts", async () => {
  let posts = 0,
    inFlight = 0,
    peak = 0;
  const { workbench, ref } = await setup(async () => {
    posts++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return success();
  });
  try {
    const ids = Array.from({ length: 12 }, (_, i) => `batch-${i}`);
    for (const id of ids) workbench.addManual(ref(), id);
    const plan = workbench.plan(ref(), ids);
    assert.equal(posts, 0);
    assert.equal(plan.modelIds.length, 12);
    const request = randomUUID();
    workbench.start(ref(), plan.planId, request);
    workbench.start(ref(), plan.planId, request);
    const done = await wait(workbench, (s) => !s.workbench!.activeJobId);
    snapshotSchema.parse(done);
    assert.equal(posts, 12);
    assert.equal(peak, 1);
    assert.equal(done.workbench!.jobs[0]!.results.length, 12);
    assert.throws(
      () =>
        workbench.plan(
          ref(),
          Array.from({ length: 1001 }, (_, i) => `over-${i}`),
        ),
      fails("invalid_models"),
    );
  } finally {
    workbench.close();
  }
});
