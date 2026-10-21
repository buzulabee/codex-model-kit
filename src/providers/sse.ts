import { ProviderFailure } from "./http.js";

// Incremental SSE framing: CR, LF and CRLF, multi-line data, UTF-8 boundaries.
export class SseDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private eventSize = 0;
  private bytes = 0;
  constructor(private readonly emit: (event: string, data: string) => void) {}
  push(bytes: Uint8Array): void {
    this.bytes += bytes.length;
    if (this.bytes > 1024 * 1024) throw new ProviderFailure("size_limit");
    try {
      this.buffer += this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new ProviderFailure("malformed_response");
    }
    this.drain(false);
  }
  finish(): void {
    try {
      this.buffer += this.decoder.decode();
    } catch {
      throw new ProviderFailure("malformed_response");
    }
    this.drain(true);
    // A final un-delimited event is not dispatched; a truncated event cannot prove completion.
  }
  private drain(final: boolean): void {
    while (true) {
      const index = this.buffer.search(/[\r\n]/);
      if (index < 0) break;
      if (
        !final &&
        this.buffer[index] === "\r" &&
        index === this.buffer.length - 1
      )
        break;
      const line = this.buffer.slice(0, index);
      const end =
        this.buffer[index] === "\r" && this.buffer[index + 1] === "\n"
          ? index + 2
          : index + 1;
      this.buffer = this.buffer.slice(end);
      if (line.length > 65536) throw new ProviderFailure("size_limit");
      this.line(line);
    }
    if (this.buffer.length > 65536) throw new ProviderFailure("size_limit");
  }
  private line(line: string): void {
    if (line === "") {
      if (this.data.length)
        this.emit(this.event || "message", this.data.join("\n"));
      this.event = "";
      this.data = [];
      this.eventSize = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") {
      this.eventSize += value.length;
      if (this.eventSize > 131072) throw new ProviderFailure("size_limit");
      this.data.push(value);
    }
  }
}
