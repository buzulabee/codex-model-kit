import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import {
  bindingData,
  envelopeSchema,
  PURPOSE,
  SELF_TEST_TOKEN,
  VERSION,
  type Binding,
  type Envelope,
  type PublicChallenge,
  type Reference,
  type Snapshot,
} from "../shared/security.js";
import type { FailureContext } from "../shared/diagnostics.js";

export type SafeErrorCode =
  | "catalog_not_writable"
  | "catalog_conflict"
  | "config_conflict"
  | "catalog_locked"
  | "catalog_write_failed"
  | "catalog_rolled_back"
  | "catalog_recovery_required"
  | "catalog_backup_invalid"
  | "catalog_write_busy"
  | "catalog_no_backup"
  | "expired_catalog_plan"
  | "invalid_catalog"
  | "invalid_catalog_draft"
  | "duplicate_model"
  | "unknown_metadata"
  | "stale_reference"
  | "invalid_envelope"
  | "expired_or_replayed"
  | "self_test_only"
  | "invalid_selection"
  | "unsupported_connection"
  | "http_confirmation_required"
  | "only_missing_fields"
  | "invalid_credential"
  | "invalid_url"
  | "configuration_not_loaded"
  | "configuration_read_failed"
  | "connection_not_ready"
  | "invalid_models"
  | "task_running"
  | "task_limit"
  | "expired_plan"
  | "invalid_task"
  | "idempotency_conflict";
export class SafeError extends Error {
  constructor(
    readonly code: SafeErrorCode,
    readonly failure?: FailureContext,
    readonly rollbackFailure?: FailureContext,
  ) {
    super(code);
  }
}

export class SecuritySession {
  readonly instanceId = randomUUID();
  readonly connectionId = randomUUID();
  private revision = 1;
  private sequence = 0;
  private count = 0;
  private lastSelfTestAt: number | null = null;
  private readonly createdAt: number;
  private readonly privateKey: KeyObject;
  private readonly publicKeySpki: string;
  private readonly challenges = new Map<string, Binding>();

  constructor(private readonly now: () => number = Date.now) {
    this.createdAt = now();
    const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
    this.privateKey = pair.privateKey;
    this.publicKeySpki = pair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
  }

  snapshot(): Snapshot {
    return {
      instanceId: this.instanceId,
      connectionId: this.connectionId,
      connectionRevision: this.revision,
      sequence: this.sequence,
      stage: "M0",
      version: VERSION,
      createdAt: this.createdAt,
      selfTestCount: this.count,
      lastSelfTestAt: this.lastSelfTestAt,
      realCredentialsEnabled: false,
      networkRequestsEnabled: false,
    };
  }

  assertReference(reference: Reference): void {
    if (
      reference.instanceId !== this.instanceId ||
      reference.connectionId !== this.connectionId ||
      reference.connectionRevision !== this.revision
    )
      throw new SafeError("stale_reference");
  }

  issueChallenge(
    reference: Reference,
    purpose: Binding["purpose"] = PURPOSE,
  ): PublicChallenge {
    this.assertReference(reference);
    for (const [nonce, binding] of this.challenges) {
      if (binding.expiresAt <= this.now()) this.challenges.delete(nonce);
    }
    // Bound memory use. Requesting a ninth challenge invalidates the oldest.
    if (this.challenges.size >= 8) {
      this.challenges.delete(this.challenges.keys().next().value!);
    }
    const binding: Binding = {
      instanceId: this.instanceId,
      connectionId: this.connectionId,
      connectionRevision: this.revision,
      nonce: randomBytes(24).toString("base64"),
      purpose,
      expiresAt: this.now() + 60_000,
    };
    this.challenges.set(binding.nonce, binding);
    return {
      binding,
      algorithm: "RSA-OAEP-256+A256GCM",
      publicKeySpki: this.publicKeySpki,
    };
  }

  decryptEnvelope(
    raw: Envelope,
    purpose: Binding["purpose"] = PURPOSE,
  ): string {
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.binding.purpose !== purpose)
      throw new SafeError("invalid_envelope");
    const envelope = parsed.data;
    this.assertReference(envelope.binding);
    const expected = this.challenges.get(envelope.binding.nonce);
    // Consume before decryption. Even a failed decryption cannot reuse a nonce.
    this.challenges.delete(envelope.binding.nonce);
    if (!expected || expected.expiresAt <= this.now())
      throw new SafeError("expired_or_replayed");
    if (
      !Buffer.from(bindingData(expected)).equals(
        Buffer.from(bindingData(envelope.binding)),
      )
    )
      throw new SafeError("invalid_envelope");
    let key: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      key = privateDecrypt(
        {
          key: this.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(envelope.wrappedKey, "base64"),
      );
      if (key.length !== 32) throw new Error("Invalid key size");
      const iv = Buffer.from(envelope.iv, "base64");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");
      if (iv.length !== 12 || ciphertext.length <= 16)
        throw new Error("Invalid ciphertext size");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(bindingData(expected));
      decipher.setAuthTag(ciphertext.subarray(-16));
      plaintext = Buffer.concat([
        decipher.update(ciphertext.subarray(0, -16)),
        decipher.final(),
      ]);
      if (plaintext.length === 0 || plaintext.length > 16384)
        throw new Error("Invalid plaintext size");
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new SafeError("invalid_envelope");
    } finally {
      key?.fill(0);
      plaintext?.fill(0);
    }
  }

  runSelfTest(envelope: Envelope): Snapshot {
    // M0 deliberately cannot accept real credentials. Never store the plaintext.
    if (this.decryptEnvelope(envelope) !== SELF_TEST_TOKEN)
      throw new SafeError("self_test_only");
    this.count += 1;
    this.sequence += 1;
    this.lastSelfTestAt = this.now();
    return this.snapshot();
  }

  touch(): void {
    this.sequence += 1;
  }

  reset(reference: Reference): Snapshot {
    this.assertReference(reference);
    this.revision += 1;
    this.sequence += 1;
    this.count = 0;
    this.lastSelfTestAt = null;
    this.challenges.clear();
    return this.snapshot();
  }
}
