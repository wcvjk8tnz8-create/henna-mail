import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { toBase64Url } from "./random";

/**
 * AES-256-GCM envelope encryption with a rotatable keyring.
 *
 * Wire format (exactly as specified):
 *
 *   <iv>:<authTag>:<ciphertext>      (all three base64url)
 *
 * The key version is *not* embedded in the payload. Rotation works by trying
 * every key in the keyring on decrypt; GCM's authTag makes a wrong key fail
 * loudly, so there is no ambiguity and no place to smuggle metadata.
 *
 * Used for: upstream IMAP/SMTP credentials, JMAP tokens, TOTP secrets, and
 * administrator-managed secrets (GitHub OAuth client secret, Resend API key).
 */

export class CredentialTamperError extends Error {
  override readonly name = "CredentialTamperError";
  constructor(message = "Encrypted payload failed authentication") {
    super(message);
  }
}

export class CredentialKeyringError extends Error {
  override readonly name = "CredentialKeyringError";
}

const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const KEY_BYTES = 32; // AES-256
const TAG_BYTES = 16; // full 128-bit auth tag

export interface KeyVersion {
  /** Stable, non-secret fingerprint of the key (sha256, first 16 hex chars). */
  readonly id: string;
  readonly key: Buffer;
  /** Position in HENNA_CREDENTIAL_KEY; 0 is the active (encrypt) key. */
  readonly version: number;
}

/**
 * Parse `HENNA_CREDENTIAL_KEY`.
 *
 * Accepts one or more comma-separated base64 (standard or url-safe) 32-byte
 * keys. The first entry is the active key used for encryption; the remaining
 * entries are retained so existing ciphertexts can still be decrypted during
 * a rotation window.
 */
export function parseKeyRing(raw: string): KeyVersion[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CredentialKeyringError(
      "HENNA_CREDENTIAL_KEY is missing or empty. Generate one with `openssl rand -base64 32`.",
    );
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length === 0) {
    throw new CredentialKeyringError("HENNA_CREDENTIAL_KEY contains no usable key.");
  }

  const seen = new Set<string>();
  const keys: KeyVersion[] = parts.map((part, index) => {
    // Support both standard and url-safe base64, with or without padding.
    const normalised = part.replace(/-/g, "+").replace(/_/g, "/");
    const key = Buffer.from(normalised, "base64");
    if (key.length !== KEY_BYTES) {
      throw new CredentialKeyringError(
        `HENNA_CREDENTIAL_KEY entry #${index + 1} is ${key.length} bytes, expected ${KEY_BYTES} bytes (base64 of 32 random bytes).`,
      );
    }
    const id = keyFingerprint(key);
    if (seen.has(id)) {
      throw new CredentialKeyringError(
        `HENNA_CREDENTIAL_KEY entry #${index + 1} duplicates an earlier key.`,
      );
    }
    seen.add(id);
    return { id, key, version: index } satisfies KeyVersion;
  });

  return keys;
}

/** Non-secret fingerprint, safe to display in the admin UI and audit logs. */
export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export interface Keyring {
  /** Encrypt using the active (first) key. */
  encrypt(plaintext: string, aad?: string): string;
  /**
   * Decrypt by trying each key in order.
   * @throws CredentialTamperError when no key authenticates the payload —
   *   which is the signal that the ciphertext was modified or that its key
   *   has been retired and removed too early.
   */
  decrypt(payload: string, aad?: string): string;
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  readonly size: number;
}

export function createKeyring(keys: readonly KeyVersion[]): Keyring {
  if (keys.length === 0) {
    throw new CredentialKeyringError("Keyring requires at least one key.");
  }
  const active = keys[0];
  if (!active) {
    throw new CredentialKeyringError("Keyring requires at least one key.");
  }

  return {
    activeKeyId: active.id,
    keyIds: keys.map((k) => k.id),
    size: keys.length,
    encrypt(plaintext: string, aad?: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", active.key, iv, { authTagLength: TAG_BYTES });
      if (aad !== undefined && aad !== "") {
        cipher.setAAD(Buffer.from(aad, "utf8"));
      }
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return `${toBase64Url(iv)}:${toBase64Url(authTag)}:${toBase64Url(ciphertext)}`;
    },
    decrypt(payload: string, aad?: string): string {
      const parsed = parsePayload(payload);
      let lastError: unknown = null;
      for (const candidate of keys) {
        try {
          const decipher = createDecipheriv("aes-256-gcm", candidate.key, parsed.iv, {
            authTagLength: TAG_BYTES,
          });
          if (aad !== undefined && aad !== "") {
            decipher.setAAD(Buffer.from(aad, "utf8"));
          }
          decipher.setAuthTag(parsed.authTag);
          return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString(
            "utf8",
          );
        } catch (error) {
          lastError = error;
        }
      }
      void lastError;
      throw new CredentialTamperError();
    },
  };
}

interface ParsedPayload {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

function parsePayload(payload: string): ParsedPayload {
  const segments = payload.split(":");
  if (segments.length !== 3) {
    throw new CredentialTamperError("Encrypted payload is malformed.");
  }
  const [ivPart, tagPart, dataPart] = segments as [string, string, string];
  const iv = Buffer.from(ivPart, "base64url");
  const authTag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(dataPart, "base64url");
  if (iv.length !== IV_BYTES || authTag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new CredentialTamperError("Encrypted payload is malformed.");
  }
  return { iv, authTag, ciphertext };
}
