import { describe, expect, it } from "vitest";
import * as v from "@/lib/validation/schemas";
import { parseInput, parseInputOrThrow, ValidationError, paramsToObject, formDataToObject } from "@/lib/validation/schemas";

describe("email", () => {
  it("normalises case and trims", () => {
    expect(v.emailInput.parse("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "alice", "alice@", "@example.com", "a b@example.com", "a@com"]) {
      expect(v.emailInput.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects an address longer than 320 characters", () => {
    const long = `${"a".repeat(310)}@example.com`;
    expect(v.emailInput.safeParse(long).success).toBe(false);
  });
});

describe("codes", () => {
  it("accepts exactly six digits for OTP and TOTP", () => {
    expect(v.otpCodeInput.parse("123456")).toBe("123456");
    expect(v.totpCodeInput.parse("000000")).toBe("000000");
    for (const bad of ["12345", "1234567", "abcdef", "12345a", ""]) {
      expect(v.totpCodeInput.safeParse(bad).success).toBe(false);
      expect(v.otpCodeInput.safeParse(bad).success).toBe(false);
    }
  });

  it("trims whitespace around a typed code", () => {
    expect(v.totpCodeInput.parse("  123456  ")).toBe("123456");
  });

  it("accepts recovery codes case-insensitively but not in other shapes", () => {
    expect(v.recoveryCodeInput.parse("abcd-1234-efgh")).toBe("abcd-1234-efgh");
    // Users type these in upper case; normalising is friendlier than rejecting.
    expect(v.recoveryCodeInput.parse("ABCD-1234-EFGH")).toBe("abcd-1234-efgh");
    for (const bad of ["abcd1234efgh", "abc-1234-efgh", "abcd-1234-efg!", "abcd-1234-efgh-extra"]) {
      expect(v.recoveryCodeInput.safeParse(bad).success).toBe(false);
    }
  });
});

describe("password login form", () => {
  it("accepts a valid submission", () => {
    const parsed = v.passwordLoginSchema.parse({
      email: "alice@example.com",
      password: "correct horse battery staple",
    });
    expect(parsed.email).toBe("alice@example.com");
  });

  it("rejects a short password", () => {
    expect(v.passwordLoginSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
  });

  it("restricts the redirect target to same-site paths", () => {
    expect(v.passwordLoginSchema.parse({ email: "a@b.co", password: "longenoughpassword", next: "/inbox" }).next).toBe("/inbox");
    for (const bad of ["https://evil.example.com", "//evil.example.com", "/\\evil.example.com", "inbox"]) {
      expect(
        v.passwordLoginSchema.safeParse({ email: "a@b.co", password: "longenoughpassword", next: bad })
          .success,
      ).toBe(false);
    }
  });

  it("reports the offending field name", () => {
    const result = parseInput(v.passwordLoginSchema, { email: "nope", password: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/email|password/);
  });
});

describe("mail credential schemas", () => {
  it("accepts a JMAP credential over https", () => {
    const parsed = v.mailCredentialSchema.parse({
      protocol: "jmap",
      endpoint: "https://jmap.example.com/.well-known/jmap",
      username: "alice@example.com",
      token: "a-very-long-api-token",
    });
    expect(parsed.protocol).toBe("jmap");
  });

  it("refuses a plaintext JMAP endpoint unless it is loopback", () => {
    const base = { protocol: "jmap" as const, username: "a@b.co", token: "a-very-long-api-token" };
    expect(v.mailCredentialSchema.safeParse({ ...base, endpoint: "http://jmap.example.com" }).success).toBe(false);
    expect(v.mailCredentialSchema.safeParse({ ...base, endpoint: "http://localhost:8080/jmap" }).success).toBe(true);
  });

  it("rejects a non-URL JMAP endpoint", () => {
    expect(
      v.mailCredentialSchema.safeParse({
        protocol: "jmap",
        endpoint: "not a url",
        username: "a@b.co",
        token: "a-very-long-api-token",
      }).success,
    ).toBe(false);
  });

  it("accepts an IMAP credential and refuses port 25", () => {
    expect(
      v.mailCredentialSchema.safeParse({
        protocol: "imap",
        endpoint: "imap.example.com",
        port: 993,
        username: "alice@example.com",
        password: "secret",
      }).success,
    ).toBe(true);
    const blocked = v.mailCredentialSchema.safeParse({
      protocol: "imap",
      endpoint: "imap.example.com",
      port: 25,
      username: "alice@example.com",
      password: "secret",
    });
    expect(blocked.success).toBe(false);
  });

  it("rejects an out-of-range port", () => {
    for (const port of [0, 65536, -1]) {
      expect(
        v.mailCredentialSchema.safeParse({
          protocol: "imap",
          endpoint: "imap.example.com",
          port,
          username: "a@b.co",
          password: "secret",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an unknown protocol outright", () => {
    expect(
      v.mailCredentialSchema.safeParse({
        protocol: "pop3",
        endpoint: "pop.example.com",
        username: "a@b.co",
        password: "secret",
      }).success,
    ).toBe(false);
  });

  it("rejects a hostname that is not a hostname", () => {
    expect(
      v.mailCredentialSchema.safeParse({
        protocol: "imap",
        endpoint: "https://imap.example.com",
        port: 993,
        username: "a@b.co",
        password: "secret",
      }).success,
    ).toBe(false);
  });
});

describe("admin settings", () => {
  const valid = {
    authMethods: ["password"],
    githubClientId: null,
    githubClientSecret: null,
    githubAllowedUsers: [],
    githubAllowedOrgs: [],
    resendApiKey: null,
    emailFrom: null,
    registrationMode: "closed",
    totpPolicy: "admin-only",
    passwordMinLength: 12,
    passwordRequireComplexity: false,
    otpTtlSeconds: 600,
    otpMaxAttempts: 5,
    otpResendCooldownSeconds: 60,
    transitionsEnabled: true,
    respectReducedMotion: true,
    allowedMailOrigins: [],
  } as const;

  it("accepts a well-formed payload", () => {
    expect(v.adminSettingsSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses an empty authentication method list", () => {
    expect(v.adminSettingsSchema.safeParse({ ...valid, authMethods: [] }).success).toBe(false);
  });

  it("refuses an unknown TOTP policy", () => {
    expect(v.adminSettingsSchema.safeParse({ ...valid, totpPolicy: "sometimes" }).success).toBe(false);
  });

  it("refuses OTP settings outside the safe range", () => {
    expect(v.adminSettingsSchema.safeParse({ ...valid, otpTtlSeconds: 30 }).success).toBe(false);
    expect(v.adminSettingsSchema.safeParse({ ...valid, otpTtlSeconds: 7200 }).success).toBe(false);
    expect(v.adminSettingsSchema.safeParse({ ...valid, otpMaxAttempts: 2 }).success).toBe(false);
    expect(v.adminSettingsSchema.safeParse({ ...valid, otpMaxAttempts: 11 }).success).toBe(false);
    expect(v.adminSettingsSchema.safeParse({ ...valid, otpResendCooldownSeconds: 10 }).success).toBe(false);
  });

  it("refuses a password minimum below 12", () => {
    expect(v.adminSettingsSchema.safeParse({ ...valid, passwordMinLength: 8 }).success).toBe(false);
  });
});

describe("audit query", () => {
  it("clamps limit and offset", () => {
    const parsed = v.auditQuerySchema.parse({ limit: "9999", offset: "-5" });
    expect(parsed.limit).toBe(500);
    expect(parsed.offset).toBe(0);
  });

  it("coerces ISO dates", () => {
    const parsed = v.auditQuerySchema.parse({ from: "2026-01-01T00:00:00.000Z" });
    expect(parsed.from).toBeInstanceOf(Date);
  });

  it("rejects an unknown result filter", () => {
    expect(v.auditQuerySchema.safeParse({ result: "maybe" }).success).toBe(false);
  });
});

describe("parse helpers", () => {
  it("collects issues rather than throwing", () => {
    const result = parseInput(v.emailInput, "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it("throws a ValidationError with every issue", () => {
    expect(() => parseInputOrThrow(v.emailInput, "nope")).toThrow(ValidationError);
    try {
      parseInputOrThrow(v.emailInput, "nope");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      if (error instanceof ValidationError) expect(error.issues.length).toBeGreaterThan(0);
    }
  });

  it("converts search params and form data", () => {
    expect(paramsToObject(new URLSearchParams("a=1&b=2"))).toEqual({ a: "1", b: "2" });
    const fd = new FormData();
    fd.set("email", "a@b.co");
    expect(formDataToObject(fd)).toEqual({ email: "a@b.co" });
  });
});

describe("CSRF header", () => {
  it("accepts a token-shaped value and rejects the rest", () => {
    expect(v.csrfHeaderInput.safeParse("a".repeat(32)).success).toBe(true);
    for (const bad of ["short", "a".repeat(257), "has spaces!", "with/slash"]) {
      expect(v.csrfHeaderInput.safeParse(bad).success).toBe(false);
    }
  });
});
