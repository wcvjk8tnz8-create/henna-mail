import { describe, expect, it } from "vitest";
import {
  PASSWORD_LIMITS,
  PasswordPolicyError,
  assertPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@/lib/crypto/password";

const GOOD = "correct horse battery staple";

describe("password policy", () => {
  it("accepts a long passphrase", () => {
    expect(() => assertPasswordPolicy(GOOD)).not.toThrow();
  });

  it("rejects anything shorter than 12 characters", () => {
    expect(() => assertPasswordPolicy("short")).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy("aB3!xY7q")).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy("aB3!xY7qZ2mK")).not.toThrow();
  });

  it("rejects rather than truncates an over-long password", () => {
    const tooLong = `Tr0ub4dor&3${"x".repeat(PASSWORD_LIMITS.maxLength)}`;
    expect(() => assertPasswordPolicy(tooLong)).toThrow(/at most/);
    // The boundary itself is fine.
    const atLimit = `Tr0ub4dor&3${"x".repeat(PASSWORD_LIMITS.maxLength - 11)}`;
    expect(atLimit).toHaveLength(PASSWORD_LIMITS.maxLength);
    expect(() => assertPasswordPolicy(atLimit)).not.toThrow();
  });

  it("rejects non-string input", () => {
    expect(() => assertPasswordPolicy(12345 as unknown as string)).toThrow(PasswordPolicyError);
  });

  it("rejects a single repeated character", () => {
    expect(() => assertPasswordPolicy("aaaaaaaaaaaaaa")).toThrow(PasswordPolicyError);
  });

  it("rejects known-weak passwords", () => {
    expect(() => assertPasswordPolicy("password123456")).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy("changeme123456")).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy("letmein987654")).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy("qwertyuiop123")).toThrow(PasswordPolicyError);
    // A passphrase that merely contains a weak word is fine.
    expect(() => assertPasswordPolicy("my dragon keeps dancing")).not.toThrow();
  });
});

describe("scrypt hashing", () => {
  it("round-trips a password", async () => {
    const encoded = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, encoded)).toBe(true);
    expect(await verifyPassword(`${GOOD} `, encoded)).toBe(false);
    expect(await verifyPassword("wrong", encoded)).toBe(false);
  });

  it("stores parameters, salt and hash in a self-describing string", async () => {
    const encoded = await hashPassword(GOOD);
    const parts = encoded.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    // No plaintext password material appears anywhere in the encoding.
    expect(encoded).not.toContain(GOOD);
  });

  it("salts every hash independently", async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(GOOD, b)).toBe(true);
  });

  it("rejects a malformed stored hash without throwing", async () => {
    for (const bad of ["", "garbage", "scrypt$1$2$3", "bcrypt$32768$8$1$c2FsdA$aGFzaA"]) {
      expect(await verifyPassword(GOOD, bad)).toBe(false);
    }
  });

  it("rejects stored parameters that are too weak to trust", async () => {
    const weak = `scrypt$1024$8$1${"$"}c2FsdHlzYWx0${"$"}aGFzaGhhc2g`;
    expect(await verifyPassword(GOOD, weak)).toBe(false);
  });

  it("reports when a hash should be upgraded", async () => {
    const current = await hashPassword(GOOD);
    expect(needsRehash(current)).toBe(false);

    const weaker = `scrypt$16384$8$1${"$"}c2FsdHlzYWx0${"$"}aGFzaGhhc2g`;
    expect(needsRehash(weaker)).toBe(true);
  });

  it("rejects an empty password on verify", async () => {
    const encoded = await hashPassword(GOOD);
    expect(await verifyPassword("", encoded)).toBe(false);
  });
});
