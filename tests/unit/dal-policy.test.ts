import { describe, expect, it } from "vitest";
import {
  canAccessOwnedResource,
  canDisableTotp,
  evaluateMfaRequirement,
  evaluatePasswordPolicy,
  evaluateRegistration,
  isAdmin,
  isMethodEnabled,
  type RegistrationSubject,
} from "@/lib/dal/policy";

describe("MFA requirement — optional", () => {
  it("never forces anyone", () => {
    expect(evaluateMfaRequirement({ role: "user", totpConfirmed: false }, "optional")).toEqual({
      required: false,
      reason: "not-required",
    });
    expect(evaluateMfaRequirement({ role: "admin", totpConfirmed: false }, "optional")).toEqual({
      required: false,
      reason: "not-required",
    });
  });

  it("still verifies anyone who has enrolled", () => {
    expect(evaluateMfaRequirement({ role: "user", totpConfirmed: true }, "optional")).toMatchObject({
      required: true,
      reason: "verification-required",
    });
  });
});

describe("MFA requirement — admin-only (the default)", () => {
  it("forces administrators to enrol", () => {
    expect(evaluateMfaRequirement({ role: "admin", totpConfirmed: false }, "admin-only")).toMatchObject(
      { required: true, reason: "enrollment-required" },
    );
  });

  it("leaves ordinary users alone", () => {
    expect(evaluateMfaRequirement({ role: "user", totpConfirmed: false }, "admin-only")).toEqual({
      required: false,
      reason: "not-required",
    });
  });

  it("requires a code from an enrolled administrator", () => {
    expect(evaluateMfaRequirement({ role: "admin", totpConfirmed: true }, "admin-only")).toMatchObject(
      { required: true, reason: "verification-required" },
    );
  });
});

describe("MFA requirement — required", () => {
  it("forces everyone", () => {
    expect(evaluateMfaRequirement({ role: "user", totpConfirmed: false }, "required")).toMatchObject({
      required: true,
      reason: "enrollment-required",
    });
    expect(evaluateMfaRequirement({ role: "admin", totpConfirmed: false }, "required")).toMatchObject({
      required: true,
      reason: "enrollment-required",
    });
  });
});

describe("disabling TOTP", () => {
  it("is allowed for ordinary users", () => {
    expect(canDisableTotp({ role: "user", totpConfirmed: true }, "optional")).toBe(true);
  });

  it("is never allowed for administrators", () => {
    expect(canDisableTotp({ role: "admin", totpConfirmed: true }, "optional")).toBe(false);
    expect(canDisableTotp({ role: "admin", totpConfirmed: true }, "admin-only")).toBe(false);
    expect(canDisableTotp({ role: "admin", totpConfirmed: true }, "required")).toBe(false);
  });
});

describe("registration control", () => {
  const base: RegistrationSubject = { githubLogin: "alice", existingAccount: false };

  it("rejects everyone when closed", () => {
    expect(evaluateRegistration(base, "closed", ["alice"], ["acme"])).toMatchObject({
      allowed: false,
      reason: "closed",
    });
  });

  it("requires an invitation in invite-only mode", () => {
    expect(evaluateRegistration(base, "invite-only", [], [])).toMatchObject({
      allowed: false,
      reason: "invite-required",
    });
    expect(
      evaluateRegistration({ ...base, hasInvite: true }, "invite-only", [], []),
    ).toMatchObject({ allowed: true, reason: "invited" });
  });

  it("admits an allow-listed GitHub login", () => {
    expect(evaluateRegistration(base, "allowlist", ["Alice"], [])).toMatchObject({
      allowed: true,
      reason: "allowlist",
    });
  });

  it("admits a member of an allow-listed organisation", () => {
    expect(
      evaluateRegistration({ ...base, githubOrgs: ["Acme"] }, "allowlist", [], ["acme"]),
    ).toMatchObject({ allowed: true, reason: "allowlist" });
  });

  it("rejects a user who is on neither list", () => {
    expect(evaluateRegistration(base, "allowlist", ["bob"], ["globex"])).toMatchObject({
      allowed: false,
      reason: "user-not-allowlisted",
    });
  });

  it("fails closed when the allowlist is empty", () => {
    expect(evaluateRegistration(base, "allowlist", [], [])).toMatchObject({ allowed: false });
  });

  it("never blocks an existing account", () => {
    expect(
      evaluateRegistration({ ...base, existingAccount: true }, "closed", [], []),
    ).toMatchObject({ allowed: true, reason: "existing-account" });
  });

  it("handles a GitHub user with no orgs and no login", () => {
    expect(
      evaluateRegistration({ existingAccount: false }, "allowlist", [], ["acme"]),
    ).toMatchObject({ allowed: false });
  });
});

describe("resource ownership", () => {
  it("lets a user reach their own resource", () => {
    expect(canAccessOwnedResource("user", "u1", "u1")).toBe(true);
  });

  it("denies a user someone else's resource", () => {
    expect(canAccessOwnedResource("user", "u1", "u2")).toBe(false);
  });

  it("lets an administrator reach any resource", () => {
    expect(canAccessOwnedResource("admin", "u1", "u2")).toBe(true);
  });

  it("recognises the admin role", () => {
    expect(isAdmin("admin")).toBe(true);
    expect(isAdmin("user")).toBe(false);
  });
});

describe("enabled authentication methods", () => {
  it("reflects the instance switch list", () => {
    const enabled = ["password", "email_otp"] as const;
    expect(isMethodEnabled("password", enabled)).toBe(true);
    expect(isMethodEnabled("github", enabled)).toBe(false);
  });

  it("denies everything when nothing is enabled", () => {
    expect(isMethodEnabled("password", [])).toBe(false);
  });
});

describe("password policy", () => {
  it("enforces the minimum length", () => {
    expect(evaluatePasswordPolicy("short", { minLength: 12, requireComplexity: false })).toMatchObject(
      { ok: false, reason: "too-short" },
    );
    expect(
      evaluatePasswordPolicy("twelve chars!", { minLength: 12, requireComplexity: false }),
    ).toEqual({ ok: true });
  });

  it("enforces the hard maximum", () => {
    const huge = "x".repeat(129);
    expect(evaluatePasswordPolicy(huge, { minLength: 12, requireComplexity: false })).toMatchObject({
      ok: false,
      reason: "too-long",
    });
  });

  it("checks composition only when the instance asks for it", () => {
    expect(
      evaluatePasswordPolicy("alllowercaseletters", { minLength: 12, requireComplexity: true }),
    ).toMatchObject({ ok: false, reason: "no-digit" });
    expect(
      evaluatePasswordPolicy("letters12345678", { minLength: 12, requireComplexity: true }),
    ).toMatchObject({ ok: false, reason: "no-symbol" });
    expect(
      evaluatePasswordPolicy("Letters1234567!", { minLength: 12, requireComplexity: true }),
    ).toEqual({ ok: true });
    // Complexity is not imposed when it is switched off.
    expect(
      evaluatePasswordPolicy("alllowercaseletters", { minLength: 12, requireComplexity: false }),
    ).toEqual({ ok: true });
  });
});
