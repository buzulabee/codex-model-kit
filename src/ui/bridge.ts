import { App } from "@modelcontextprotocol/ext-apps";
import { snapshotSchema, type Snapshot, VERSION } from "../shared/security.js";
import { diagnosticSchema, type Diagnostic } from "../shared/diagnostics.js";

export class ToolFailure extends Error {
  constructor(
    readonly category: string,
    readonly diagnostic?: Diagnostic,
  ) {
    super("tool_failed");
  }
}

export class UiBridge {
  readonly app = new App(
    { name: "Codex 模型工具", version: VERSION },
    {},
    { autoResize: true },
  );
  private readonly lifetime = new AbortController();
  private closed = false;

  async connect(): Promise<void> {
    await this.app.connect(undefined, {
      timeout: 15_000,
      signal: this.lifetime.signal,
    });
    if (!this.app.getHostCapabilities()?.serverTools) {
      throw new Error("host_tools_unavailable");
    }
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed || this.lifetime.signal.aborted)
      throw new Error("bridge_closed");
    const result = await this.app.callServerTool(
      { name, arguments: args },
      { timeout: 15_000, signal: this.lifetime.signal },
    );
    if (result.isError) {
      const error = (
        result.structuredContent as
          { error?: { category?: unknown; diagnostic?: unknown } } | undefined
      )?.error;
      const diagnostic = diagnosticSchema.safeParse(error?.diagnostic);
      throw new ToolFailure(
        typeof error?.category === "string" ? error.category : "internal_error",
        diagnostic.success ? diagnostic.data : undefined,
      );
    }
    if (
      !result.structuredContent ||
      typeof result.structuredContent !== "object" ||
      Array.isArray(result.structuredContent)
    )
      throw new Error("missing_result");
    return result.structuredContent as Record<string, unknown>;
  }

  async snapshot(): Promise<Snapshot> {
    const result = await this.call("read_snapshot");
    return snapshotSchema.parse(result.snapshot);
  }

  cancelPending(): void {
    this.lifetime.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    await this.app.close();
  }
}
