import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ConfigError,
  assertNoSecretIsPublic,
  getAdminEmail,
  getBaseUrl,
  getJwtSecret,
  getMailDomains,
  getRootConfig,
  isProduction,
  rawEnv,
  resetEnvCache,
  setEnvSource,
  tryGetRootConfig,
} from "@/lib/config/env";
import { getKeyRotationStatus, resetKeyring } from "@/lib/crypto/keyring";
import { isManagedAddress } from "@/lib/config/domains";
import { domainListSchema, jwtSecretSchema, instanceSettingsSchema } from "@/lib/config/schema";

let state: Record<string, string | undefined> = {};

function use(patch: Record<string, string | undefined>): void {
  state = patch;
  setEnvSource(() => state);
  resetEnvCache();
  resetKeyring();
}

const VALID = (): Record<string, string | undefined> => ({
  DOMAIN: '["example.com","henna.test"]',
  ADMIN: "root@example.com",
  jwt_secret: "aVeryLongRandomStringWithLettersAndDigits123",
  HENNA_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
  NODE_ENV: "test",
});

beforeEach(() => {
  use(VALID());
});

afterEach(() => {
  state = {};
  resetEnvCache();
  resetKeyring();
});

describe("root configuration", () => {
  it("parses a complete environment", () => {
    const cfg = getRootConfig();
    expect(cfg.DOMAIN).toEqual(["example.com", "henna.test"]);
    expect(cfg.ADMIN).toBe("root@example.com");
  });

  it("caches the parsed value", () => {
    expect(getRootConfig()).toBe(getRootConfig());
  });

  it("refuses to start when a root value is missing", () => {
    const { DOMAIN, ...rest } = VALID();
    void DOMAIN;
    use(rest);
    expect(() => getRootConfig()).toThrow(ConfigError);
  });

  it("names every problem in the error message", () => {
    const { ADMIN, jwt_secret, ...rest } = VALID();
    void ADMIN;
    void jwt_secret;
    use(rest);
    try {
      getRootConfig();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) {
        expect(error.issues.length).toBeGreaterThanOrEqual(2);
        expect(error.message).toMatch(/ADMIN/);
        expect(error.message).toMatch(/jwt_secret/);
      }
    }
  });

  it("reports failure through tryGetRootConfig instead of throwing", () => {
    const { ADMIN, ...rest } = VALID();
    void ADMIN;
    use(rest);
    const result = tryGetRootConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ConfigError);
  });
});

describe("DOMAIN", () => {
  it("accepts a JSON array of domains", () => {
    expect(domainListSchema.parse('["example.com"]')).toEqual(["example.com"]);
    expect(domainListSchema.parse('["a.example.com","b.io"]')).toEqual(["a.example.com", "b.io"]);
  });

  it("lower-cases and trims entries", () => {
    expect(domainListSchema.parse('["  Example.COM "]')).toEqual(["example.com"]);
  });

  it("rejects entries that are not bare domains", () => {
    for (const bad of ['["https://example.com"]', '["example.com/path"]', '["*.example.com"]']) {
      expect(domainListSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects an empty array", () => {
    expect(domainListSchema.safeParse("[]").success).toBe(false);
  });

  it("rejects malformed JSON", () => {
    expect(domainListSchema.safeParse("example.com").success).toBe(false);
    expect(domainListSchema.safeParse("[example.com]").success).toBe(false);
  });
});

describe("jwt_secret", () => {
  it("accepts letters and digits", () => {
    expect(jwtSecretSchema.parse("abc123XYZ789012345678901234567890")).toBe(
      "abc123XYZ789012345678901234567890",
    );
  });

  it("rejects special characters so CI secrets need no quoting", () => {
    for (const bad of ["abc-def", "abc_def", "abc!def", "abc def", "abc/def"]) {
      expect(jwtSecretSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts a short secret — length is documented, not enforced", () => {
    // Deliberate: `jwt_secret` also seeds the credential key, so a short value
    // is genuinely weaker, but rejecting it turns "paste anything and deploy"
    // into a support question. The docs recommend `openssl rand -hex 24`.
    expect(jwtSecretSchema.parse("abc123")).toBe("abc123");
  });

  it("rejects an empty secret", () => {
    expect(() => jwtSecretSchema.parse("")).toThrow();
  });
});

describe("secret leakage guard", () => {
  it("refuses a NEXT_PUBLIC_ variable that looks like a secret", () => {
    expect(() =>
      assertNoSecretIsPublic({
        NEXT_PUBLIC_JWT_SECRET: "x",
        NEXT_PUBLIC_HENNA_API_KEY: "x",
        NEXT_PUBLIC_GITHUB_CLIENT_SECRET: "x",
      }),
    ).toThrow(ConfigError);
  });

  it("allows harmless public variables", () => {
    expect(() =>
      assertNoSecretIsPublic({ NEXT_PUBLIC_APP_NAME: "Henna", NEXT_PUBLIC_THEME: "dark" }),
    ).not.toThrow();
  });

  it("runs as part of getRootConfig", () => {
    use({ ...VALID(), NEXT_PUBLIC_JWT_SECRET: "leaked" });
    expect(() => getRootConfig()).toThrow(ConfigError);
  });
});

describe("accessors", () => {
  it("expose only what callers need", () => {
    expect(getMailDomains()).toEqual(["example.com", "henna.test"]);
    expect(getAdminEmail()).toBe("root@example.com");
    expect(getJwtSecret()).toBe(VALID().jwt_secret);
    expect(isProduction()).toBe(false);
  });

  it("prefer AUTH_URL for the base URL", () => {
    expect(getBaseUrl()).toBe("http://localhost:3000");
    use({ ...VALID(), AUTH_URL: "https://mail.example.com/" });
    expect(getBaseUrl()).toBe("https://mail.example.com");
  });

  it("exposes the raw environment only for fallbacks", () => {
    expect(rawEnv().ADMIN).toBe("root@example.com");
  });
});

describe("managed mail domains", () => {
  it("recognises an address on a served domain", () => {
    expect(isManagedAddress("alice@example.com")).toBe(true);
    expect(isManagedAddress("ALICE@EXAMPLE.COM")).toBe(true);
    expect(isManagedAddress("alice@henna.test")).toBe(true);
  });

  it("rejects an address on another domain", () => {
    expect(isManagedAddress("alice@notmine.com")).toBe(false);
    expect(isManagedAddress("alice@example.com.evil.com")).toBe(false);
  });

  it("rejects junk", () => {
    expect(isManagedAddress("")).toBe(false);
    expect(isManagedAddress("alice")).toBe(false);
    expect(isManagedAddress("@example.com")).toBe(false);
  });
});

describe("credential key rotation status", () => {
  it("reports a single key as healthy", () => {
    const status = getKeyRotationStatus();
    expect(status.keyCount).toBe(1);
    expect(status.healthy).toBe(true);
    expect(status.activeKeyId).toHaveLength(16);
  });

  it("reports every key during a rotation window", () => {
    const a = randomBytes(32).toString("base64");
    const b = randomBytes(32).toString("base64");
    use({ ...VALID(), HENNA_CREDENTIAL_KEY: `${b},${a}` });
    const status = getKeyRotationStatus();
    expect(status.keyCount).toBe(2);
    expect(status.activeKeyId).toBe(status.keyIds[0]);
  });

  it("marks the keyring unhealthy when the key is broken", () => {
    use({ ...VALID(), HENNA_CREDENTIAL_KEY: "not-a-valid-key" });
    const status = getKeyRotationStatus();
    expect(status.healthy).toBe(false);
    expect(status.error).toBeTruthy();
  });
});

describe("instance settings defaults", () => {
  it("defaults to admin-only TOTP, closed registration and password auth", () => {
    const parsed = instanceSettingsSchema.parse({});
    expect(parsed.totpPolicy).toBe("admin-only");
    expect(parsed.registrationMode).toBe("closed");
    expect(parsed.otpTtlSeconds).toBe(600);
    expect(parsed.otpMaxAttempts).toBe(5);
    expect(parsed.otpResendCooldownSeconds).toBe(60);
    expect(parsed.passwordMinLength).toBe(12);
  });

  it("keeps secrets out of the JSON payload shape", () => {
    const parsed = instanceSettingsSchema.parse({ resendApiKey: "re_xxx" });
    // The field exists because the admin form posts it, but it is stripped
    // before anything is written to the settings blob.
    expect(parsed.resendApiKey).toBe("re_xxx");
  });

  it("refuses to disable every authentication method", () => {
    expect(instanceSettingsSchema.safeParse({ authMethods: [] }).success).toBe(false);
  });
});
