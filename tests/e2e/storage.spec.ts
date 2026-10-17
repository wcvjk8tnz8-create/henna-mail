import { expect, test } from "@playwright/test";

/**
 * Object storage boundaries.
 *
 * Presigned URLs are capabilities, so what matters here is that an anonymous or
 * cross-user caller cannot obtain one, and that the health endpoint reports
 * storage state without ever echoing a bucket credential.
 */

test.describe("storage configuration surface", () => {
  test("the health endpoint reports storage state with no secrets", async ({ request }) => {
    const response = await request.get("/api/health");
    if (!response.ok()) {
      // A misconfigured instance answers 503; either way the body must be safe.
      expect(response.status()).toBe(503);
    }
    const body = await response.text();
    expect(body).not.toMatch(/secretAccessKey|accessKeyId|secret_access_key/i);
    expect(body).toMatch(/"storage"/);
  });

  test("the settings page does not leak bucket credentials", async ({ request }) => {
    const response = await request.get("/admin/settings", { maxRedirects: 0 });
    // Anonymous callers are redirected; the point is that nothing is rendered.
    expect([302, 303, 307, 401, 403]).toContain(response.status());
  });
});

test.describe("attachment URL issuance", () => {
  test("an unauthenticated caller cannot obtain an upload URL", async ({ request }) => {
    const response = await request.post("/settings", {
      form: { action: "requestAttachmentUpload", filename: "a.txt", sizeBytes: "10" },
      maxRedirects: 0,
    });
    // Either refused outright or redirected to sign in — never a signed URL.
    expect(response.status()).not.toBe(200);
  });

  test("an oversized upload request is refused rather than signed", async ({ request }) => {
    const response = await request.post("/settings", {
      form: {
        action: "requestAttachmentUpload",
        filename: "huge.bin",
        sizeBytes: String(9_999_999_999),
      },
      maxRedirects: 0,
    });
    expect(response.status()).not.toBe(200);
  });

  test("a traversal filename is never reflected into a signed URL", async ({ request }) => {
    const response = await request.post("/settings", {
      form: {
        action: "requestAttachmentUpload",
        filename: "../../../etc/passwd",
        sizeBytes: "10",
      },
      maxRedirects: 0,
    });
    if (response.ok()) {
      const body = await response.text();
      expect(body).not.toContain("X-Amz-Signature");
    }
  });
});
