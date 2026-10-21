import { z } from "zod";
import { diagnosticSchema } from "./diagnostics.js";
import { localCatalogSchema, catalogWriteReceiptSchema } from "./catalog.js";
import { workbenchSchema } from "./workbench.js";
import { connectionSummarySchema, discoverySummarySchema } from "./config.js";
import { releaseTag } from "./release-version.js";

export const VERSION = "2026.1021.1007";
export const DISPLAY_VERSION = releaseTag(VERSION);
export const UI_URI = `ui://codex-model-kit/main-catalog-sync-v${VERSION}.html`;
export const SELF_TEST_TOKEN = "CMK-M0-FICTITIOUS-TOKEN-NOT-A-CREDENTIAL";
export const PURPOSE = "m0-security-self-test";
const id = z.string().uuid();
const base64 = (max: number) =>
  z
    .string()
    .min(4)
    .max(max)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const referenceSchema = z.strictObject({
  instanceId: id,
  connectionId: id,
  connectionRevision: z.number().int().positive(),
});
export const bindingSchema = referenceSchema.extend({
  nonce: base64(64),
  purpose: z.enum([PURPOSE, "connection-credential"]),
  expiresAt: z.number().int().positive(),
});
export const envelopeSchema = z.strictObject({
  binding: bindingSchema,
  wrappedKey: base64(1024),
  iv: base64(16),
  ciphertext: base64(24000),
});
export const publicChallengeSchema = z.strictObject({
  binding: bindingSchema,
  algorithm: z.literal("RSA-OAEP-256+A256GCM"),
  publicKeySpki: base64(2048),
});
export const snapshotSchema = referenceSchema.extend({
  sequence: z.number().int().nonnegative(),
  stage: z.enum(["M0", "M1", "readonly", "sync"]),
  version: z.literal(VERSION),
  createdAt: z.number().int(),
  selfTestCount: z.number().int().nonnegative(),
  lastSelfTestAt: z.number().int().nullable(),
  realCredentialsEnabled: z.boolean(),
  networkRequestsEnabled: z.boolean(),
  workbench: workbenchSchema.optional(),
  config: discoverySummarySchema.optional(),
  localCatalog: localCatalogSchema.optional(),
  catalogWrite: catalogWriteReceiptSchema.optional(),
  connection: connectionSummarySchema.optional(),
  diagnostic: diagnosticSchema.optional(),
});
export type Reference = z.infer<typeof referenceSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type PublicChallenge = z.infer<typeof publicChallengeSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;

// Stable AAD construction: bind only known fields, in a fixed order.
export function bindingData(binding: Binding): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      binding.instanceId,
      binding.connectionId,
      binding.connectionRevision,
      binding.nonce,
      binding.purpose,
      binding.expiresAt,
    ]),
  );
}

export function referenceOf(snapshot: Reference): Reference {
  return {
    instanceId: snapshot.instanceId,
    connectionId: snapshot.connectionId,
    connectionRevision: snapshot.connectionRevision,
  };
}

export function acceptSnapshot(
  current: Snapshot | null,
  next: Snapshot,
): boolean {
  if (!current) return true;
  // A different instance requires an explicit re-connect, never a late tool result.
  return (
    current.instanceId === next.instanceId &&
    (next.connectionRevision > current.connectionRevision ||
      (next.connectionRevision === current.connectionRevision &&
        next.sequence >= current.sequence))
  );
}
