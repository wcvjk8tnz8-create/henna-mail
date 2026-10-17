import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { createKeyring, parseKeyRing } from "@/lib/crypto/aes";
import { installTestEnv, patchTestEnv, clearTestEnv } from "./helpers/env";
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  currentStep,
  generateTotpSecret,
  secondsUntilNextStep,
  verifyTotp,
} from "@/lib/auth/totp";

/**
 * A throwaway keyring is installed for the whole suite so that TOTP secrets are
 * encrypted exactly as they would be in production, without touching the real
 * environment.
 */
let TEST_KEY = "";

beforeEach(() => {
  TEST_KEY = randomBytes(32).toString("base64");
  installTestEnv({ HENNA_CREDENTIAL_KEY: TEST_KEY });
});

afterEach(() => {
  clearTestEnv();
});

function totpFor(base32: string, at: number): string {
  return new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(base32),
  }).generate({ timestamp: at });
}

describe("TOTP enrolment", () => {
  it("generates a base32 secret and encrypts it before storage", () => {
    const enrollment = generateTotpSecret("Henna", "alice@example.com");
    expect(enrollment.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(enrollment.encryptedSecret.split(":")).toHaveLength(3);
    expect(enrollment.encryptedSecret).not.toContain(enrollment.secret);
    expect(enrollment.keyId).toHaveLength(16);
  });

  it("only the ciphertext can be stored — the plaintext must be re-derivable", () => {
    const enrollment = generateTotpSecret("Henna", "alice@example.com");
    expect(createKeyring(parseKeyRing(TEST_KEY)).decrypt(enrollment.encryptedSecret, "totp_secret"))
      .toBe(enrollment.secret);
  });

  it("produces a provisioning URI for QR rendering", () => {
    const enrollment = generateTotpSecret("Henna", "alice@example.com");
    expect(enrollment.uri.startsWith("otpauth://totp/")).toBe(true);
    expect(enrollment.uri).toContain("issuer=Henna");
    expect(enrollment.uri).toContain("period=30");
  });

  it("generates a different secret each time", () => {
    const a = generateTotpSecret("Henna", "alice@example.com");
    const b = generateTotpSecret("Henna", "alice@example.com");
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("TOTP verification window", () => {
  it("accepts the current code", () => {
    const { encryptedSecret, secret } = generateTotpSecret("Henna", "alice@example.com");
    const now = Date.now();
    const result = verifyTotp(encryptedSecret, totpFor(secret, now), null);
    expect(result.ok).toBe(true);
  });

  it("accepts one step behind and one step ahead, and no further", () => {
    const { encryptedSecret, secret } = generateTotpSecret("Henna", "alice@example.com");
    const now = Date.now();

    // -1 step
    expect(
      verifyTotp(encryptedSecret, totpFor(secret, now - TOTP_PERIOD_SECONDS * 1000), null).ok,
    ).toBe(true);
    // +1 step
    expect(
      verifyTotp(encryptedSecret, totpFor(secret, now + TOTP_PERIOD_SECONDS * 1000), null).ok,
    ).toBe(true);
    // -2 steps: outside the ±1 window
    expect(verifyTotp(encryptedSecret, totpFor(secret, now - 2 * TOTP_PERIOD_SECONDS * 1000), null))
      .toMatchObject({ ok: false, reason: "expired" });
    // +2 steps
    expect(verifyTotp(encryptedSecret, totpFor(secret, now + 2 * TOTP_PERIOD_SECONDS * 1000), null))
      .toMatchObject({ ok: false, reason: "expired" });
  });

  it("rejects a wrong code of the right shape", () => {
    const { encryptedSecret, secret } = generateTotpSecret("Henna", "alice@example.com");
    const right = totpFor(secret, Date.now());
    const wrong = right === "000000" ? "111111" : "000000";
    expect(verifyTotp(encryptedSecret, wrong, null)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects malformed codes outright", () => {
    const { encryptedSecret } = generateTotpSecret("Henna", "alice@example.com");
    for (const bad of ["", "12345", "1234567", "abcdef", " 123456 ", "12 3456"]) {
      expect(verifyTotp(encryptedSecret, bad, null)).toMatchObject({ ok: false, reason: "invalid" });
    }
  });
});

describe("TOTP replay protection", () => {
  it("refuses a code already used in the same step", () => {
    const { encryptedSecret, secret } = generateTotpSecret("Henna", "alice@example.com");
    const now = Date.now();
    const step = currentStep(now);
    const code = totpFor(secret, now);

    const first = verifyTotp(encryptedSecret, code, null);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Same code presented again, with the stored step recorded.
    expect(verifyTotp(encryptedSecret, code, first.step)).toMatchObject({
      ok: false,
      reason: "replay",
    });
    // Even a step recorded by a *later* window blocks anything at or before it.
    expect(verifyTotp(encryptedSecret, code, step + 1)).toMatchObject({
      ok: false,
      reason: "replay",
    });
  });

  it("allows the next step's code after the previous one was consumed", () => {
    const { encryptedSecret, secret } = generateTotpSecret("Henna", "alice@example.com");
    const t0 = Date.now();
    const t1 = t0 + TOTP_PERIOD_SECONDS * 1000;

    const first = verifyTotp(encryptedSecret, totpFor(secret, t0), null);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = verifyTotp(encryptedSecret, totpFor(secret, t1), first.step);
    expect(second.ok).toBe(true);
  });

  it("records the drift so callers can warn about clock skew", () => {
    const { encryptedSecret, secret } = generateTotpSecret("Henna", "alice@example.com");
    const now = Date.now();
    const result = verifyTotp(encryptedSecret, totpFor(secret, now - 30_000), null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.drift).toBe(-1);
  });
});

describe("TOTP tamper handling", () => {
  it("reports a secret that fails authentication without leaking it", () => {
    const { encryptedSecret } = generateTotpSecret("Henna", "alice@example.com");
    const [iv, tag, data] = encryptedSecret.split(":") as [string, string, string];
    const bytes = Buffer.from(data, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = `${iv}:${tag}:${bytes.toString("base64url")}`;

    expect(verifyTotp(tampered, "123456", null)).toMatchObject({ ok: false, reason: "tampered" });
  });

  it("fails closed when the secret was encrypted under a retired key", () => {
    const oldKey = randomBytes(32).toString("base64");
    patchTestEnv({ HENNA_CREDENTIAL_KEY: oldKey });
    const { encryptedSecret } = generateTotpSecret("Henna", "alice@example.com");

    // Rotate: the old key is gone entirely.
    patchTestEnv({ HENNA_CREDENTIAL_KEY: randomBytes(32).toString("base64") });
    expect(verifyTotp(encryptedSecret, "123456", null)).toMatchObject({
      ok: false,
      reason: "tampered",
    });
  });
});

describe("step helpers", () => {
  it("computes the step and the time to rollover", () => {
    const now = Date.now();
    expect(currentStep(now)).toBe(Math.floor(now / 1000 / 30));
    const until = secondsUntilNextStep(now);
    expect(until).toBeGreaterThan(0);
    expect(until).toBeLessThanOrEqual(30);
  });
});
