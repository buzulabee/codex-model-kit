import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loopbackFixture } from "./loopback-fixture.js";
import { referenceOf, snapshotSchema } from "../src/shared/security.js";
import { probePlanSchema } from "../src/shared/workbench.js";
test("bundled STDIO inherits only explicitly named env credentials; missing env performs no network", async () => {
  for (const credentialMode of ["env", "missing_env"] as const) {
    const f = await loopbackFixture(undefined, { credentialMode });
    try {
      const snap = (raw: Record<string, unknown>) =>
        snapshotSchema.parse(raw.snapshot);
      let s = snap(await f.call("open_model_kit"));
      s = snap(await f.call("load_sync", referenceOf(s)));
      const candidate = s.config!.candidates[0]!;
      assert.equal(candidate.authSource, "env");
      assert.equal(f.records.length, 0);
      if (credentialMode === "missing_env") {
        assert(!s.connection!.ready && !candidate.reusable);
        assert(candidate.issues.includes("missing_env_credential"));
        continue;
      }
      s = snap(
        await f.call("select_connection", {
          ...referenceOf(s),
          candidateId: candidate.candidateId,
          allowHttp: true,
        }),
      );
      assert(s.connection!.ready);
      assert.equal(s.connection!.credentialSource, "env");
      s = snap(await f.call("refresh_models", referenceOf(s)));
      for (
        let i = 0;
        i < 100 && s.workbench!.catalog.status === "loading";
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10));
        s = snap(await f.call("read_snapshot"));
      }
      assert.equal(s.workbench!.catalog.status, "ready");
      assert.deepEqual(f.records, [
        { method: "GET", path: "/relay/v1/models" },
      ]);
    } finally {
      await f.close();
    }
  }
});
test("bundled STDIO + real loopback HTTP: readonly discovery, list, explicit confirmation, single POST, cancellation", async () => {
  const f = await loopbackFixture();
  try {
    const snap = (raw: Record<string, unknown>) =>
      snapshotSchema.parse(raw.snapshot);
    let s = snap(await f.call("open_model_kit"));
    assert.equal(s.stage, "readonly");
    assert.equal(s.config!.status, "not_loaded");
    assert.equal(f.records.length, 0);
    s = snap(await f.call("reload_config", referenceOf(s)));
    const candidate = s.config!.candidates[0]!;
    s = snap(
      await f.call("select_connection", {
        ...referenceOf(s),
        candidateId: candidate.candidateId,
        allowHttp: true,
      }),
    );
    assert(s.connection!.ready);
    assert.equal(f.records.length, 0);
    s = snap(await f.call("refresh_models", referenceOf(s)));
    for (let i = 0; i < 100 && s.workbench!.catalog.status === "loading"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = snap(await f.call("read_snapshot"));
    }
    assert.equal(s.workbench!.catalog.status, "ready");
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0]!.method, "GET");
    assert.equal(s.workbench!.catalog.models[0]!.result, null);
    const plan = probePlanSchema.parse(
      (
        await f.call("prepare_probe", {
          ...referenceOf(s),
          modelIds: [
            "Fixture-Pass",
            "Fixture-Quota",
            "Fixture-FakeStream",
            "Fixture-Cut",
          ],
          protocol: "responses",
        })
      ).plan,
    );
    assert.equal(f.records.length, 1);
    const key = randomUUID();
    s = snap(
      await f.call("start_probe", {
        ...referenceOf(s),
        planId: plan.planId,
        requestId: key,
      }),
    );
    await f.call("start_probe", {
      ...referenceOf(s),
      planId: plan.planId,
      requestId: key,
    });
    for (let i = 0; i < 200 && s.workbench!.activeJobId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = snap(await f.call("read_snapshot"));
    }
    assert.equal(s.workbench!.jobs[0]!.status, "completed");
    assert.deepEqual(
      s.workbench!.jobs[0]!.results.map((r) => r.result.reasonCode),
      ["ok", "quota", "non_streaming", "early_eof"],
    );
    assert.equal(f.records.filter((r) => r.method === "POST").length, 4);
    const next = probePlanSchema.parse(
      (
        await f.call("prepare_probe", {
          ...referenceOf(s),
          modelIds: ["Fixture-Slow", "Fixture-Pass"],
          protocol: "responses",
        })
      ).plan,
    );
    s = snap(
      await f.call("start_probe", {
        ...referenceOf(s),
        planId: next.planId,
        requestId: randomUUID(),
      }),
    );
    for (
      let i = 0;
      i < 100 && f.records.filter((r) => r.method === "POST").length < 5;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    await f.call("cancel_probe", {
      ...referenceOf(s),
      jobId: s.workbench!.activeJobId,
    });
    for (let i = 0; i < 100 && s.workbench!.activeJobId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = snap(await f.call("read_snapshot"));
    }
    assert.equal(s.workbench!.jobs[1]!.status, "cancelled");
    assert.equal(f.records.filter((r) => r.method === "POST").length, 5);
  } finally {
    await f.close();
  }
});
