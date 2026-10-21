export class AddressError extends Error {
  constructor() {
    super("invalid_url");
  }
}
export function normalizeBaseUrl(raw: string): string {
  if (
    raw.length > 2048 ||
    !/^https?:\/\//i.test(raw) ||
    raw !== raw.trim() ||
    /[\x00-\x20\x7f\\]/.test(raw)
  )
    throw new AddressError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AddressError();
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AddressError();
  // Reject silent URL path normalization, especially dot segments encoded by an upstream URL.
  if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(raw.split("://")[1] ?? ""))
    throw new AddressError();
  return url.href.replace(/\/+$/, "");
}
export function endpoint(
  baseUrl: string,
  path: "models" | "responses",
): string {
  return `${normalizeBaseUrl(baseUrl)}/${path}`;
}
export function displayAddress(
  baseUrl: string,
  secrets: readonly string[] = [],
): string {
  const origin = new URL(baseUrl).origin;
  return origin.length <= 300 &&
    !secrets.some(
      (secret) => secret && origin.toLowerCase().includes(secret.toLowerCase()),
    )
    ? `${origin}/…`
    : "已配置地址（已隐藏）";
}
export function validCredential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 16384 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

// Explicitly authorized UI fingerprint only: hide short keys and unsafe characters.
export function maskCredential(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (value.length < 16 || !/^[A-Za-z0-9_-]+$/.test(value)) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}
