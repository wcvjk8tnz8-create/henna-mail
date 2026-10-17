import { describe, expect, it } from "vitest";
import {
  canonicalQuery,
  formatAmzDate,
  formatDateStamp,
  sha256Hex,
  toHex,
  uriEncode,
  uriEncodePath,
} from "@/lib/storage/sigv4";
import { clampTtl, isSafeContentType, presign, MAX_PRESIGN_TTL_SECONDS } from "@/lib/storage/presign";
import {
  buildObjectKey,
  isValidObjectKey,
  keyBelongsToUser,
  sanitizeFilename,
  userPrefix,
} from "@/lib/storage/keys";
import {
  DEFAULT_STORAGE_CONFIG,
  effectiveRegion,
  isStorageReady,
  resolveStorageEndpoint,
  storageConfigIssues,
  type StorageConfig,
} from "@/lib/storage/config";

describe("sigv4 encoding", () => {
  it("leaves unreserved characters alone", () => {
    expect(uriEncode("aZ0-_.~")).toBe("aZ0-_.~");
  });

  it("percent-encodes everything else, upper case", () => {
    expect(uriEncode("a b")).toBe("a%20b");
    expect(uriEncode("/")).toBe("%2F");
    expect(uriEncode("+")).toBe("%2B");
    expect(uriEncode("=")).toBe("%3D");
  });

  it("encodes UTF-8 byte by byte", () => {
    // 报 = E6 8A A5
    expect(uriEncode("报告.pdf")).toBe("%E6%8A%A5%E5%91%8A.pdf");
  });

  it("keeps slash as a separator when encoding a path", () => {
    expect(uriEncodePath("users/1/attachment/a b")).toBe("users/1/attachment/a%20b");
  });

  it("sorts canonical query parameters by encoded key", () => {
    const query = canonicalQuery([
      ["X-Amz-SignedHeaders", "host"],
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Expires", "300"],
    ]);
    expect(query).toBe(
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-SignedHeaders=host",
    );
  });

  it("hashes to lower-case hex", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("formats SigV4 timestamps", () => {
    const date = new Date("2026-01-02T03:04:05Z");
    expect(formatAmzDate(date)).toBe("20260102T030405Z");
    expect(formatDateStamp(date)).toBe("20260102");
  });

  it("renders bytes as hex", () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe("000fff");
  });
});

describe("presigning", () => {
  /**
   * AWS's own SigV4 query-string test vector. If this passes, the signing
   * chain — canonical request, string to sign, key derivation — is right, not
   * merely self-consistent.
   */
  it("matches the AWS documented signature for a presigned GET", async () => {
    const signed = await presign({
      method: "GET",
      endpoint: "https://s3.amazonaws.com",
      bucket: "examplebucket",
      key: "test.txt",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      expiresInSeconds: 86400,
      forcePathStyle: false,
      now: new Date("2013-05-24T00:00:00Z"),
    });

    expect(signed.url).toContain(
      "X-Amz-Signature=3ed0be64024db54d5574a27da223529635c383f911f80e636f0ccc13890053d2",
    );
    expect(signed.url).toContain("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request");
    expect(signed.url).toContain("X-Amz-Expires=86400");
  });

  it("uses path style for R2 by default", async () => {
    const signed = await presign({
      method: "GET",
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "henna",
      key: "users/1/attachment/x/报告.pdf",
      region: "auto",
      accessKeyId: "kid",
      secretAccessKey: "skey",
      expiresInSeconds: 300,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(signed.url.startsWith("https://abc123.r2.cloudflarestorage.com/henna/users/1/attachment/x/")).toBe(true);
    expect(signed.url).toContain("%2Fs3%2Faws4_request");
    expect(signed.requiredHeaders).toEqual({});
  });

  it("requires the payload hash header on upload so the signature is verifiable", async () => {
    const signed = await presign({
      method: "PUT",
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "henna",
      key: "users/1/attachment/x/a.txt",
      region: "auto",
      accessKeyId: "kid",
      secretAccessKey: "skey",
      expiresInSeconds: 300,
      contentType: "application/pdf",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(signed.requiredHeaders["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(signed.requiredHeaders["content-type"]).toBe("application/pdf");
    expect(signed.url).toContain("X-Amz-SignedHeaders=content-type%3Bhost%3Bx-amz-content-sha256");
  });

  it("produces different signatures for different keys", async () => {
    const base = {
      method: "GET" as const,
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "henna",
      region: "auto",
      accessKeyId: "kid",
      secretAccessKey: "skey",
      expiresInSeconds: 300,
      now: new Date("2026-01-01T00:00:00Z"),
    };
    const a = await presign({ ...base, key: "users/1/a" });
    const b = await presign({ ...base, key: "users/1/b" });
    expect(a.url).not.toBe(b.url);
  });

  it("refuses an endpoint that is not an origin", async () => {
    await expect(
      presign({
        method: "GET",
        endpoint: "https://example.com/prefix",
        bucket: "henna",
        key: "a",
        region: "auto",
        accessKeyId: "kid",
        secretAccessKey: "skey",
        expiresInSeconds: 300,
      }),
    ).rejects.toThrow(/origin/i);
  });

  it("clamps the lifetime to SigV4's maximum", () => {
    expect(clampTtl(10)).toBe(10);
    expect(clampTtl(-5)).toBe(300);
    expect(clampTtl(99999999)).toBe(MAX_PRESIGN_TTL_SECONDS);
  });
});

describe("object keys", () => {
  it("strips directories and leading dots from a filename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeFilename("a/b\\c.txt")).toBe("abc.txt");
    expect(sanitizeFilename("...hidden")).toBe("hidden");
  });

  it("keeps unicode filenames readable", () => {
    expect(sanitizeFilename("季度报告 final.pdf")).toBe("季度报告 final.pdf");
  });

  it("falls back to a usable name when nothing is left", () => {
    expect(sanitizeFilename("   ")).toBe("attachment");
    expect(sanitizeFilename("///")).toBe("attachment");
  });

  it("rejects traversal, absolute and empty keys", () => {
    expect(isValidObjectKey("users/1/../2/a")).toBe(false);
    expect(isValidObjectKey("/users/1/a")).toBe(false);
    expect(isValidObjectKey("users/1/a/")).toBe(false);
    expect(isValidObjectKey("users//a")).toBe(false);
    expect(isValidObjectKey("users/1/a")).toBe(true);
  });

  it("namespaces every generated key under the owner", () => {
    const key = buildObjectKey({ userId: "user-1", purpose: "attachment", filename: "a.pdf" });
    expect(key.startsWith(userPrefix("user-1"))).toBe(true);
    expect(key).toMatch(/^users\/user-1\/attachment\/[0-9a-f-]{36}\/a\.pdf$/);
  });

  it("never generates the same key twice", () => {
    const a = buildObjectKey({ userId: "user-1", purpose: "attachment", filename: "a.pdf" });
    const b = buildObjectKey({ userId: "user-1", purpose: "attachment", filename: "a.pdf" });
    expect(a).not.toBe(b);
  });

  it("refuses a key outside the owner's prefix", () => {
    expect(keyBelongsToUser("users/1/a", "1")).toBe(true);
    expect(keyBelongsToUser("users/2/a", "1")).toBe(false);
    expect(keyBelongsToUser("users/1/../2/a", "1")).toBe(false);
  });
});

describe("storage configuration", () => {
  const withConfig = (over: Partial<StorageConfig>): StorageConfig => ({
    ...DEFAULT_STORAGE_CONFIG,
    ...over,
  });

  it("derives the R2 endpoint from the account id", () => {
    const config = withConfig({ provider: "r2", r2AccountId: "a".repeat(32) });
    expect(resolveStorageEndpoint(config)).toBe(`https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
  });

  it("prefers an explicit endpoint over the derived one", () => {
    const config = withConfig({
      provider: "r2",
      r2AccountId: "a".repeat(32),
      endpoint: "https://storage.example.com",
    });
    expect(resolveStorageEndpoint(config)).toBe("https://storage.example.com");
  });

  it("is not ready until bucket, credentials and endpoint are all present", () => {
    expect(isStorageReady(withConfig({ enabled: true }))).toBe(false);
    expect(
      isStorageReady(
        withConfig({ enabled: true, bucket: "henna", endpoint: "https://s.example.com" }),
      ),
    ).toBe(false);
    expect(
      isStorageReady(
        withConfig({
          enabled: true,
          bucket: "henna",
          endpoint: "https://s.example.com",
          accessKeyId: "kid",
          secretAccessKey: "skey",
        }),
      ),
    ).toBe(true);
  });

  it("reports every missing piece rather than only the first", () => {
    const issues = storageConfigIssues(withConfig({ enabled: true }));
    expect(issues).toContain("bucket is not set");
    expect(issues).toContain("access key id is not set");
    expect(issues).toContain("endpoint is unknown: set it directly, or provide the R2 account id");
  });

  it("forces region auto for R2 regardless of what was typed", () => {
    expect(effectiveRegion(withConfig({ provider: "r2", region: "us-east-1" }))).toBe("auto");
    expect(effectiveRegion(withConfig({ provider: "s3", region: "eu-west-1" }))).toBe("eu-west-1");
  });
});

describe("content type safety", () => {
  it("accepts ordinary media types", () => {
    expect(isSafeContentType("application/pdf")).toBe(true);
    expect(isSafeContentType("text/plain; charset=utf-8")).toBe(true);
    expect(isSafeContentType("image/svg+xml")).toBe(true);
  });

  it("rejects header injection attempts", () => {
    // A newline here would break the signed header block wide open.
    expect(isSafeContentType("application/pdf\r\nx-amz-acl: public-read")).toBe(false);
    expect(isSafeContentType("application/pdf\nhost: evil")).toBe(false);
    expect(isSafeContentType("")).toBe(false);
  });
});
