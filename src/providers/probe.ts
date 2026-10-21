import { type ProbeResult } from "../shared/workbench.js";
import {
  boundedText,
  classifyError,
  errorReason,
  object,
  ProviderFailure,
  request,
  type Fetcher,
  type Material,
} from "./http.js";
import { SseDecoder } from "./sse.js";

export const PROBE_INPUT = "Reply with OK.";
export function outcome(
  reason: ProbeResult["reasonCode"],
  metrics: Partial<ProbeResult> = {},
): ProbeResult {
  const passed = reason === "ok";
  const failed = [
    "unsupported_protocol",
    "unsupported_stream",
    "non_streaming",
    "malformed_response",
    "early_eof",
    "empty_output",
  ].includes(reason);
  return {
    status: passed ? "passed" : failed ? "failed" : "unknown",
    protocolResult:
      passed || reason === "non_streaming"
        ? "supported"
        : reason === "unsupported_protocol"
          ? "unsupported"
          : "unknown",
    streamResult: passed ? "valid" : failed ? "invalid" : "unknown",
    reasonCode: reason,
    checkedAt: Date.now(),
    elapsedMs: 0,
    firstEventMs: null,
    eventCount: 0,
    outputObserved: false,
    end:
      reason === "ok"
        ? "completed"
        : reason === "cancelled"
          ? "cancelled"
          : "error",
    ...metrics,
  };
}
function containsOutput(value: unknown): boolean {
  const response = object(value);
  if (!Array.isArray(response?.output)) return false;
  return response.output.some((item: unknown) => {
    const row = object(item);
    return (
      row?.type === "message" &&
      row.role === "assistant" &&
      Array.isArray(row.content) &&
      row.content.some((part: unknown) => {
        const content = object(part);
        return (
          content?.type === "output_text" &&
          typeof content.text === "string" &&
          content.text.length > 0
        );
      })
    );
  });
}
export async function probeModel(
  material: Material,
  modelId: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  limits = { totalMs: 30000, firstMs: 15000 },
): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false,
    firstEventMs: number | null = null,
    eventCount = 0,
    outputObserved = false;
  const cancel = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", cancel, { once: true });
  const timeout = () => {
    timedOut = true;
    controller.abort();
  };
  const totalTimer = setTimeout(timeout, limits.totalMs),
    firstTimer = setTimeout(timeout, limits.firstMs);
  let terminal: ProbeResult["reasonCode"] | null = null;
  let end: ProbeResult["end"] = "eof";
  const metrics = () => ({
    elapsedMs: Math.max(0, Date.now() - started),
    firstEventMs,
    eventCount,
    outputObserved,
    end,
  });
  try {
    if (controller.signal.aborted) throw new ProviderFailure("cancelled");
    const response = await request(
      material,
      "responses",
      controller.signal,
      fetcher,
      {
        model: modelId,
        input: PROBE_INPUT,
        max_output_tokens: 64,
        stream: true,
        store: false,
      },
    );
    if (!response.ok) {
      const reason = await errorReason(response);
      if (controller.signal.aborted) throw new ProviderFailure("cancelled");
      return outcome(reason, { ...metrics(), end: "error" });
    }
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("text/event-stream")
    ) {
      let raw: unknown;
      try {
        raw = JSON.parse(await boundedText(response, 1024 * 1024));
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure("malformed_response");
      }
      if (controller.signal.aborted) throw new ProviderFailure("cancelled");
      const body = object(raw);
      const reason =
        body?.object === "response" && typeof body.status === "string"
          ? "non_streaming"
          : "malformed_response";
      return outcome(reason, {
        ...metrics(),
        outputObserved: containsOutput(body),
        end: "json",
      });
    }
    if (!response.body) throw new ProviderFailure("malformed_response");
    const parser = new SseDecoder((event, data) => {
      if (terminal || data === "[DONE]") return;
      eventCount += 1;
      if (eventCount > 1000) throw new ProviderFailure("size_limit");
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        throw new ProviderFailure("malformed_response");
      }
      const row = object(raw);
      if (
        !row ||
        typeof row.type !== "string" ||
        (event !== "message" && event !== row.type)
      )
        throw new ProviderFailure("malformed_response");
      if (!row.type.startsWith("response.") && row.type !== "error")
        throw new ProviderFailure("malformed_response");
      if (row.type === "error") {
        const detail = object(row.error) ?? row;
        terminal = classifyError(detail.code ?? detail.type);
        end = "error";
        return;
      }
      if (
        row.type === "response.failed" ||
        row.type === "response.incomplete"
      ) {
        const response = object(row.response);
        if (
          !response ||
          typeof response.id !== "string" ||
          !response.id ||
          response.status !==
            (row.type === "response.failed" ? "failed" : "incomplete")
        )
          throw new ProviderFailure("malformed_response");
        const detail = object(response.error);
        terminal =
          row.type === "response.failed"
            ? classifyError(detail?.code ?? detail?.type)
            : "incomplete";
        end = row.type === "response.failed" ? "failed" : "incomplete";
        return;
      }
      if (row.type === "response.output_text.delta") {
        if (
          typeof row.delta !== "string" ||
          typeof row.item_id !== "string" ||
          !row.item_id ||
          !Number.isSafeInteger(row.output_index) ||
          Number(row.output_index) < 0 ||
          !Number.isSafeInteger(row.content_index) ||
          Number(row.content_index) < 0
        )
          throw new ProviderFailure("malformed_response");
        if (row.delta.length) outputObserved = true;
      }
      if (
        row.type === "response.created" ||
        row.type === "response.in_progress" ||
        row.type === "response.completed"
      ) {
        const item = object(row.response);
        if (
          !item ||
          typeof item.id !== "string" ||
          !item.id ||
          typeof item.status !== "string"
        )
          throw new ProviderFailure("malformed_response");
      }
      // Only protocol-valid, meaningful events satisfy the first-event deadline.
      if (
        [
          "response.created",
          "response.in_progress",
          "response.output_text.delta",
          "response.completed",
        ].includes(row.type) &&
        firstEventMs === null
      ) {
        firstEventMs = Math.max(0, Date.now() - started);
        clearTimeout(firstTimer);
      }
      if (row.type === "response.completed") {
        const item = object(row.response)!;
        if (item.status !== "completed" || !Array.isArray(item.output))
          throw new ProviderFailure("malformed_response");
        outputObserved ||= containsOutput(item);
        terminal = outputObserved ? "ok" : "empty_output";
        end = "completed";
      }
    });
    const reader = response.body.getReader();
    try {
      while (!terminal) {
        const part = await reader.read();
        if (part.done) {
          parser.finish();
          break;
        }
        parser.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (controller.signal.aborted) throw new ProviderFailure("cancelled");
    return outcome(terminal ?? "early_eof", metrics());
  } catch (error) {
    const reason = timedOut
      ? "timeout"
      : signal.aborted
        ? "cancelled"
        : error instanceof ProviderFailure
          ? error.reason
          : "network";
    return outcome(reason, {
      ...metrics(),
      end: reason === "cancelled" ? "cancelled" : "error",
    });
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(firstTimer);
    signal.removeEventListener("abort", cancel);
  }
}
