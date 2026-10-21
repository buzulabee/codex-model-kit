import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedText,
  errorReason,
  fetchModels,
  normalizeModels,
  ProviderFailure,
  type Fetcher,
} from "../src/providers/http.js";
import { probeModel } from "../src/providers/probe.js";
import { SseDecoder } from "../src/providers/sse.js";
const material = {
  baseUrl: "https://fixture.test/prefix/v1/",
  credential: "FAKE-PROVIDER-SECRET",
};
const encoder = new TextEncoder();
const event = (value: object, ending = "\n\n") =>
  `data: ${JSON.stringify(value)}${ending}`;
const created = {
  type: "response.created",
  response: { id: "resp_fixture", status: "in_progress" },
};
const delta = {
  type: "response.output_text.delta",
  item_id: "msg_fixture",
  output_index: 0,
  content_index: 0,
  delta: "好的🙂",
};
const complete = {
  type: "response.completed",
  response: { id: "resp_fixture", status: "completed", output: [] },
};
const sse =
  (text: string, bytes = 1): Fetcher =>
  async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const raw = encoder.encode(text);
          for (let i = 0; i < raw.length; i += bytes)
            controller.enqueue(raw.slice(i, i + bytes));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );
const run = (
  fetcher: Fetcher,
  signal = new AbortController().signal,
  limits = { totalMs: 200, firstMs: 100 },
) => probeModel(material, "Exact-MODEL-ID", signal, fetcher, limits);
const fail = (reason: string) => (error: unknown) =>
  error instanceof ProviderFailure && error.reason === reason;
test("models normalization preserves exact ID, labels claims, deduplicates and filters invalid/secret data", () => {
  const normalized = normalizeModels(
    {
      data: [
        {
          id: "GPT-X",
          owned_by: material.credential,
          supports_streaming: true,
          context_window: 128000,
          custom: material.credential,
        },
        { id: "gpt-x" },
        { id: "GPT-X" },
        { id: " <script>" },
        { id: "evil\u0000" },
        { id: "a".repeat(513) },
        { id: material.credential },
        { id: "<b>literal</b>", owned_by: "<script>owner</script>" },
      ],
      has_more: true,
    },
    material.credential,
  );
  assert.deepEqual(
    normalized.models.map((m) => m.id),
    ["GPT-X", "gpt-x", "<b>literal</b>"],
  );
  assert.equal(normalized.models[0]!.owner, null);
  assert.equal(normalized.models[0]!.result, null);
  assert.deepEqual(normalized.models[0]!.claims, [
    "context_window: 128000",
    "supports_streaming: true",
  ]);
  assert.deepEqual(
    new Set(normalized.warnings),
    new Set(["pagination_unsupported", "skipped_invalid"]),
  );
  assert(!JSON.stringify(normalized).includes(material.credential));
  assert.deepEqual(
    normalizeModels({ data: [] }, material.credential).models,
    [],
  );
  assert.throws(
    () => normalizeModels({ models: [] }, material.credential),
    fail("malformed_response"),
  );
  assert.equal(
    normalizeModels(
      { data: Array.from({ length: 1001 }, (_, i) => ({ id: `id-${i}` })) },
      material.credential,
    ).models.length,
    1000,
  );
});
test("GET endpoint keeps base path, never follows redirects, no POST or inference side effect", async () => {
  let count = 0;
  const fetcher: Fetcher = async (url, options) => {
    count++;
    assert.equal(String(url), "https://fixture.test/prefix/v1/models");
    assert.equal(options!.method, "GET");
    assert.equal(options!.redirect, "manual");
    assert.equal(
      (options!.headers as Record<string, string>).Authorization,
      `Bearer ${material.credential}`,
    );
    return Response.json({ data: [{ id: "Exact-ID" }] });
  };
  assert.equal(
    (await fetchModels(material, new AbortController().signal, fetcher))
      .models[0]!.id,
    "Exact-ID",
  );
  assert.equal(count, 1);
  await assert.rejects(
    fetchModels(
      material,
      new AbortController().signal,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.test" },
        }),
    ),
    fail("redirect"),
  );
  await assert.rejects(
    fetchModels(
      material,
      new AbortController().signal,
      async () => new Response("<html>"),
    ),
    fail("malformed_response"),
  );
  await assert.rejects(
    fetchModels(material, new AbortController().signal, async () => {
      throw new Error(material.credential);
    }),
    fail("network"),
  );
});
test("bounded response enforces byte limit and releases reader", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(100));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(boundedText(response, 10), fail("size_limit"));
  assert(cancelled);
});
for (const [status, code, reason] of [
  [401, "", "auth"],
  [403, "", "auth"],
  [429, "insufficient_quota", "quota"],
  [429, "", "rate_limit"],
  [400, "invalid_parameter", "invalid_parameters"],
  [404, "", "service"],
  [404, "unsupported_endpoint", "unsupported_protocol"],
  [500, "", "service"],
  [400, "unsupported_stream", "unsupported_stream"],
] as const) {
  test(`HTTP error ${status}/${code} is conservative and never echoes text`, async () => {
    assert.equal(
      await errorReason(
        Response.json(
          { error: { code, message: material.credential } },
          { status },
        ),
      ),
      reason,
    );
  });
}
test("models 404 is list-unavailable rather than proof model unsupported", async () =>
  assert.equal(
    await errorReason(new Response(null, { status: 404 }), true),
    "models_unavailable",
  ));
test("SSE incremental CRLF, UTF8, comments, multi-line data and truncated tail", () => {
  const rows: string[][] = [];
  const parser = new SseDecoder((e, d) => rows.push([e, d]));
  const data = encoder.encode(
    ": heartbeat\r\nevent: custom\r\ndata: 中🙂\r\ndata: two\r\n\r\ndata: not-finished\n",
  );
  for (const byte of data) parser.push(new Uint8Array([byte]));
  parser.finish();
  assert.deepEqual(rows, [["custom", "中🙂\ntwo"]]);
  assert.throws(
    () => new SseDecoder(() => {}).push(new Uint8Array([0xff])),
    fail("malformed_response"),
  );
  assert.throws(
    () => new SseDecoder(() => {}).push(encoder.encode("x".repeat(65537))),
    fail("size_limit"),
  );
  assert.throws(
    () => new SseDecoder(() => {}).push(new Uint8Array(1024 * 1024 + 1)),
    fail("size_limit"),
  );
});
test("valid Responses stream parses byte boundaries, fixed minimal POST, no raw output retention", async () => {
  const fetcher = sse(event(created) + event(delta) + event(complete));
  let calls = 0;
  const result = await run(async (url, options) => {
    calls++;
    assert.equal(String(url), "https://fixture.test/prefix/v1/responses");
    assert.equal(options!.method, "POST");
    assert.equal(options!.redirect, "manual");
    assert.deepEqual(JSON.parse(String(options!.body)), {
      model: "Exact-MODEL-ID",
      input: "Reply with OK.",
      max_output_tokens: 64,
      stream: true,
      store: false,
    });
    return fetcher(url, options);
  });
  assert.equal(result.status, "passed");
  assert.equal(result.end, "completed");
  assert.equal(result.eventCount, 3);
  assert(result.outputObserved);
  assert.notEqual(result.firstEventMs, null);
  assert.equal(calls, 1);
  assert(!JSON.stringify(result).includes(delta.delta));
  assert(!JSON.stringify(result).includes(material.credential));
});
for (const [text, reason] of [
  [event(created) + event(delta), "early_eof"],
  [event(complete), "empty_output"],
  [event(created) + "data: [DONE]\n\n", "early_eof"],
  [event(created) + event(delta) + event(complete, "\n"), "early_eof"],
  ["data: {}\n\n", "malformed_response"],
  [
    event({ type: "response.output_text.delta", delta: "" }),
    "malformed_response",
  ],
  [
    event({
      type: "error",
      code: "insufficient_quota",
      message: material.credential,
    }),
    "quota",
  ],
  [
    event({
      type: "response.failed",
      response: {
        id: "r",
        status: "failed",
        error: { code: "invalid_parameter", message: material.credential },
      },
    }),
    "invalid_parameters",
  ],
  [
    event({
      type: "response.incomplete",
      response: { id: "r", status: "incomplete" },
    }),
    "incomplete",
  ],
] as const) {
  test(`stream outcome ${reason} for fixture ${text.length} bytes`, async () => {
    const result = await run(sse(text, 13));
    assert.equal(result.reasonCode, reason);
    assert(!JSON.stringify(result).includes(material.credential));
  });
}
test("200 JSON is not valid SSE, empty HTML/invalid UTF8 aren't treated as success", async () => {
  assert.equal(
    (
      await run(async () =>
        Response.json({ object: "response", status: "completed", output: [] }),
      )
    ).reasonCode,
    "non_streaming",
  );
  assert.equal(
    (await run(async () => new Response("<html>error</html>"))).reasonCode,
    "malformed_response",
  );
});
function hanging(withEvent = false): Fetcher {
  return async (_url, options) =>
    new Response(
      new ReadableStream({
        start(controller) {
          if (withEvent) controller.enqueue(encoder.encode(event(created)));
          options!.signal!.addEventListener(
            "abort",
            () => controller.error(new Error(material.credential)),
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
}
test("first event and total deadlines abort streams and preserve unknown conclusion", async () => {
  const first = await run(hanging(), undefined, { totalMs: 150, firstMs: 15 });
  assert.equal(first.reasonCode, "timeout");
  assert.equal(first.firstEventMs, null);
  const total = await run(hanging(true), undefined, {
    totalMs: 25,
    firstMs: 15,
  });
  assert.equal(total.reasonCode, "timeout");
  assert.notEqual(total.firstEventMs, null);
});
test("cancellation aborts in-flight fetch/body, releases stream and never retries", async () => {
  const controller = new AbortController();
  const promise = run(hanging(true), controller.signal);
  setTimeout(() => controller.abort(), 10);
  assert.equal((await promise).reasonCode, "cancelled");
  let calls = 0;
  controller.abort();
  assert.equal(
    (
      await run(async () => {
        calls++;
        return Response.json({});
      }, controller.signal)
    ).reasonCode,
    "cancelled",
  );
  assert.equal(calls, 0);
});
test("timeout while reading HTTP error body does not become false auth/service evidence", async () => {
  const result = await run(
    async (url, options) => {
      const response = await hanging()(url, options);
      return new Response(response.body, { status: 401 });
    },
    undefined,
    { totalMs: 150, firstMs: 10 },
  );
  assert.equal(result.reasonCode, "timeout");
});
