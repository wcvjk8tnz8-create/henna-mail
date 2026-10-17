import { createKeyring, parseKeyRing, type Keyring } from "./aes";
import { getCredentialKeyRaw, resetEnvCache, tryGetRootConfig } from "../config/env";

/**
 * Process-wide AES-256-GCM keyring derived from `HENNA_CREDENTIAL_KEY`.
 *
 * The first key in the list encrypts; every key can decrypt. Adding a new key
 * at the front of `HENNA_CREDENTIAL_KEY` starts a rotation: new writes use it,
 * old ciphertexts still read. Removing an old key ends the rotation and must
 * only happen after `reEncryptAll` reports zero rows on retired keys.
 */

let keyring: Keyring | null = null;

export function resetKeyring(): void {
  keyring = null;
  resetEnvCache();
}

export function getKeyring(): Keyring {
  if (keyring !== null) return keyring;
  const parsed = parseKeyRing(getCredentialKeyRaw());
  keyring = createKeyring(parsed);
  return keyring;
}

/**
 * Non-throwing accessor used by the health endpoint and the admin UI so a
 * broken keyring is reported as a configuration problem instead of a crash.
 */
export function tryGetKeyring(): { ok: true; value: Keyring } | { ok: false; error: string } {
  try {
    return { ok: true, value: getKeyring() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Rotation status surfaced at /admin/settings. */
export interface KeyRotationStatus {
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  readonly keyCount: number;
  readonly healthy: boolean;
  readonly error?: string;
}

export function getKeyRotationStatus(): KeyRotationStatus {
  const result = tryGetKeyring();
  if (!result.ok) {
    return {
      activeKeyId: "unavailable",
      keyIds: [],
      keyCount: 0,
      healthy: false,
      error: result.error,
    };
  }
  const ring = result.value;
  return {
    activeKeyId: ring.activeKeyId,
    keyIds: ring.keyIds,
    keyCount: ring.size,
    healthy: tryGetRootConfig().ok,
  };
}

/** Convenience helpers bound to the active keyring. */
export function encryptSecret(plaintext: string, aad?: string): string {
  return getKeyring().encrypt(plaintext, aad);
}

export function decryptSecret(payload: string, aad?: string): string {
  return getKeyring().decrypt(payload, aad);
}
