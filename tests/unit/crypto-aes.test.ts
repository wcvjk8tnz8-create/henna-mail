import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  CredentialTamperError,
  createKeyring,
  keyFingerprint,
  parseKeyRing,
} from "@/lib/crypto/aes";
import { safeEqual } from "@/lib/crypto/constant-time";
import { generateRecoveryCodes, randomNumericCode, randomId } from "@/lib/crypto/random";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const KEY_C = randomBytes(32).toString("base64");

describe("AES-256-GCM envelope encryption", () => {
  it("round-trips a plaintext and emits iv:authTag:ciphertext", () => {
    const ring = createKeyring(parseKeyRing(KEY_A));
    const payload = ring.encrypt("correct horse battery staple");

    const parts = payload.split(":");
    expect(parts).toHaveLength(3);
    const iv = Buffer.from(parts[0] ?? "", "base64url");
    const tag = Buffer.from(parts[1] ?? "", "base64url");
    expect(iv).toHaveLength(12);
    expect(tag).toHaveLength(16);

    expect(ring.decrypt(payload)).toBe("correct horse battery staple");
  });

  it("never reuses an IV across encryptions", () => {
    const ring = createKeyring(parseKeyRing(KEY_A));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(ring.encrypt("same plaintext").split(":")[0] ?? "");
    }
    expect(seen.size).toBe(200);
  });

  it("rejects a ciphertext whose bytes were flipped", () => {
    const ring = createKeyring(parseKeyRing(KEY_A));
    const payload = ring.encrypt("imap password");
    const [iv, tag, data] = payload.split(":") as [string, string, string];
    const bytes = Buffer.from(data, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = `${iv}:${tag}:${bytes.toString("base64url")}`;

    expect(() => ring.decrypt(tampered)).toThrow(CredentialTamperError);
  });

  it("rejects a swapped auth tag", () => {
    const ring = createKeyring(parseKeyRing(KEY_A));
    const payload = ring.encrypt("imap password");
    const [iv, , data] = payload.split(":") as [string, string, string];
    const forgedTag = randomBytes(16).toString("base64url");
    expect(() => ring.decrypt(`${iv}:${forgedTag}:${data}`)).toThrow(CredentialTamperError);
  });

  it("rejects malformed payloads instead of returning garbage", () => {
    const ring = createKeyring(parseKeyRing(KEY_A));
    for (const bad of ["", "a:b", "a:b:c:d", "::::"]) {
      expect(() => ring.decrypt(bad)).toThrow(CredentialTamperError);
    }
  });

  it("binds ciphertext to its additional authenticated data", () => {
    const ring = createKeyring(parseKeyRing(KEY_A));
    const payload = ring.encrypt("jmap-token", "user-1");
    expect(ring.decrypt(payload, "user-1")).toBe("jmap-token");
    // Moving the credential to another user's row must not work.
    expect(() => ring.decrypt(payload, "user-2")).toThrow(CredentialTamperError);
  });
});

describe("key rotation", () => {
  it("encrypts with the first key and decrypts with any key in the ring", () => {
    const keys = parseKeyRing(`${KEY_B},${KEY_A}`);
    const ring = createKeyring(keys);
    expect(ring.activeKeyId).toBe(keyFingerprint(Buffer.from(KEY_B, "base64")));

    // A payload written under the old key still reads after rotation.
    const oldRing = createKeyring(parseKeyRing(KEY_A));
    const legacy = oldRing.encrypt("legacy secret");
    expect(ring.decrypt(legacy)).toBe("legacy secret");

    // New writes use the new key.
    const fresh = ring.encrypt("fresh secret");
    expect(createKeyring(parseKeyRing(KEY_B)).decrypt(fresh)).toBe("fresh secret");
    expect(() => createKeyring(parseKeyRing(KEY_A)).decrypt(fresh)).toThrow(CredentialTamperError);
  });

  it("supports a three-key ring and reports every version", () => {
    const ring = createKeyring(parseKeyRing(`${KEY_C},${KEY_B},${KEY_A}`));
    expect(ring.size).toBe(3);
    expect(new Set(ring.keyIds).size).toBe(3);
    expect(ring.decrypt(ring.encrypt("x"))).toBe("x");
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => parseKeyRing(randomBytes(16).toString("base64"))).toThrow();
  });

  it("refuses an empty keyring", () => {
    expect(() => parseKeyRing("")).toThrow();
    expect(() => parseKeyRing("   ")).toThrow();
  });

  it("refuses duplicate keys", () => {
    expect(() => parseKeyRing(`${KEY_A},${KEY_A}`)).toThrow(/duplicate/i);
  });

  it("accepts url-safe base64 and ignores whitespace", () => {
    const urlSafe = randomBytes(32).toString("base64url");
    const ring = createKeyring(parseKeyRing(`  ${urlSafe}  `));
    expect(ring.decrypt(ring.encrypt("ok"))).toBe("ok");
  });

  it("produces a stable, non-secret fingerprint", () => {
    const a = keyFingerprint(Buffer.from(KEY_A, "base64"));
    const b = keyFingerprint(Buffer.from(KEY_A, "base64"));
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(a).not.toContain(KEY_A.slice(0, 8));
  });
});

describe("constant-time comparison", () => {
  it("matches equal strings and rejects different ones", () => {
    expect(safeEqual("abcdef", "abcdef")).toBe(true);
    expect(safeEqual("abcdef", "abcdeF")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("rejects prefix and length differences", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abcd", "abc")).toBe(false);
  });

  it("handles multi-byte input without throwing", () => {
    expect(safeEqual("密码密码", "密码密码")).toBe(true);
    expect(safeEqual("密码密码", "密码密马")).toBe(false);
  });
});

describe("randomness helpers", () => {
  it("produces fixed-width numeric codes", () => {
    for (let i = 0; i < 500; i += 1) {
      const code = randomNumericCode(6);
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("rejects out-of-range digit counts", () => {
    expect(() => randomNumericCode(3)).toThrow(RangeError);
    expect(() => randomNumericCode(11)).toThrow(RangeError);
  });

  it("generates unique 16-byte identifiers", () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomId()));
    expect(ids.size).toBe(500);
  });

  it("generates recovery codes in xxxx-xxxx-xxxx form", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(new Set(codes).size).toBe(10);
  });
});
