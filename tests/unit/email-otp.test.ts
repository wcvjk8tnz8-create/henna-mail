import { describe, expect, it } from "vitest";
import {
  DEFAULT_OTP_COOLDOWN_SECONDS,
  DEFAULT_OTP_MAX_ATTEMPTS,
  DEFAULT_OTP_TTL_SECONDS,
  attemptsExhausted,
  attemptsRemaining,
  cooldownRemainingSeconds,
  evaluateOtpState,
  isConsumed,
  isExpired,
  isWithinCooldown,
  type OtpCodeState,
} from "@/lib/auth/otp-rules";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function state(overrides: Partial<OtpCodeState> = {}): OtpCodeState {
  return {
    expiresAt: new Date(NOW + DEFAULT_OTP_TTL_SECONDS * 1000),
    consumedAt: null,
    attempts: 0,
    maxAttempts: DEFAULT_OTP_MAX_ATTEMPTS,
    ...overrides,
  };
}

describe("defaults", () => {
  it("uses a 10 minute lifetime, 5 attempts and a 60 second cooldown", () => {
    expect(DEFAULT_OTP_TTL_SECONDS).toBe(600);
    expect(DEFAULT_OTP_MAX_ATTEMPTS).toBe(5);
    expect(DEFAULT_OTP_COOLDOWN_SECONDS).toBe(60);
  });
});

describe("expiry", () => {
  it("is expired once the deadline passes, not before", () => {
    expect(isExpired(state(), NOW)).toBe(false);
    expect(isExpired(state(), NOW + 599_000)).toBe(false);
    expect(isExpired(state(), NOW + 600_000)).toBe(true);
    expect(isExpired(state(), NOW + 601_000)).toBe(true);
  });

  it("treats the deadline itself as expired (no grace step)", () => {
    const s = state();
    expect(isExpired(s, s.expiresAt.getTime())).toBe(true);
  });
});

describe("single use", () => {
  it("knows whether a code has been consumed", () => {
    expect(isConsumed(state())).toBe(false);
    expect(isConsumed(state({ consumedAt: new Date(NOW) }))).toBe(true);
  });

  it("a consumed code is refused before any other check", () => {
    expect(evaluateOtpState(state({ consumedAt: new Date(NOW) }), NOW)).toMatchObject({
      ok: false,
      reason: "used",
    });
  });
});

describe("attempt accounting", () => {
  it("counts down the remaining attempts", () => {
    expect(attemptsRemaining(state())).toBe(5);
    expect(attemptsRemaining(state({ attempts: 3 }))).toBe(2);
    expect(attemptsRemaining(state({ attempts: 5 }))).toBe(0);
    expect(attemptsRemaining(state({ attempts: 99 }))).toBe(0);
  });

  it("reports exhaustion at the limit", () => {
    expect(attemptsExhausted(state({ attempts: 4 }))).toBe(false);
    expect(attemptsExhausted(state({ attempts: 5 }))).toBe(true);
  });

  it("refuses a code whose attempts are used up", () => {
    expect(evaluateOtpState(state({ attempts: 5 }), NOW)).toMatchObject({
      ok: false,
      reason: "too-many-attempts",
    });
  });
});

describe("resend cooldown", () => {
  it("blocks a resend inside the window and allows it afterwards", () => {
    const created = new Date(NOW);
    expect(isWithinCooldown(created, 60, NOW + 59_000)).toBe(true);
    expect(isWithinCooldown(created, 60, NOW + 60_000)).toBe(false);
  });

  it("reports how long is left", () => {
    const created = new Date(NOW);
    expect(cooldownRemainingSeconds(created, 60, NOW)).toBe(60);
    expect(cooldownRemainingSeconds(created, 60, NOW + 25_000)).toBe(35);
    expect(cooldownRemainingSeconds(created, 60, NOW + 90_000)).toBe(0);
  });
});

describe("combined gate", () => {
  it("passes a fresh, unused code", () => {
    expect(evaluateOtpState(state(), NOW)).toEqual({ ok: true });
  });

  it("prefers 'used' over 'expired' so a replay cannot masquerade as a timeout", () => {
    const s = state({ consumedAt: new Date(NOW), expiresAt: new Date(NOW - 1000) });
    expect(evaluateOtpState(s, NOW)).toMatchObject({ ok: false, reason: "used" });
  });
});
