import {
  bindingData,
  publicChallengeSchema,
  type Envelope,
  type PublicChallenge,
} from "../shared/security.js";

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function encode(value: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

// Browser Web Crypto only. The bridge receives an envelope, never plaintext.
export async function encryptSecret(
  rawChallenge: PublicChallenge,
  secret: string,
  cryptoApi: Crypto = globalThis.crypto,
): Promise<Envelope> {
  const challenge = publicChallengeSchema.parse(rawChallenge);
  if (!cryptoApi?.subtle) throw new Error("Web Crypto unavailable");
  const plaintext = new TextEncoder().encode(secret);
  if (plaintext.length === 0 || plaintext.length > 16384)
    throw new Error("Invalid secret size");
  const publicKey = await cryptoApi.subtle.importKey(
    "spki",
    decode(challenge.publicKeySpki),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const rawKey = cryptoApi.getRandomValues(new Uint8Array(32));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  try {
    const aesKey = await cryptoApi.subtle.importKey(
      "raw",
      rawKey,
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const [wrappedKey, ciphertext] = await Promise.all([
      cryptoApi.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey),
      cryptoApi.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: bindingData(challenge.binding),
          tagLength: 128,
        },
        aesKey,
        plaintext,
      ),
    ]);
    return {
      binding: challenge.binding,
      wrappedKey: encode(wrappedKey),
      iv: encode(iv),
      ciphertext: encode(ciphertext),
    };
  } finally {
    // Best effort for these arrays only, not a guarantee of JS memory erasure.
    rawKey.fill(0);
    plaintext.fill(0);
  }
}
