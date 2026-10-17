import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { CSRF_HEADER, issueCsrfToken, validateCsrfToken, csrfCookieOptions } from "@/lib/security/csrf";
import { setEnvSource, resetEnvCache } from "@/lib/config/env";
import { buildContentSecurityPolicy, buildSecurityHeaders, MAIL_IFRAME_SANDBOX, mailIframeHeaders } from "@/lib/security/headers";
import { htmlToPlainText, mailPreview, sanitizeMailHtml } from "@/lib/mail/sanitize";

setEnvSource(() => ({
  DOMAIN: '["example.com"]',
  ADMIN: "root@example.com",
  jwt_secret: "aVeryLongRandomStringWithLettersAndDigits123",
  HENNA_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"),
  NODE_ENV: "test",
}));
resetEnvCache();

describe("CSRF tokens", () => {
  const sessionId = "11111111-2222-3333-4444-555555555555";

  it("accepts a token echoed back with the same session", () => {
    const token = issueCsrfToken(sessionId);
    expect(
      validateCsrfToken({ cookieValue: token, headerValue: token, sessionId }),
    ).toBe(true);
  });

  it("rejects a missing header", () => {
    const token = issueCsrfToken(sessionId);
    expect(validateCsrfToken({ cookieValue: token, headerValue: null, sessionId })).toBe(false);
  });

  it("rejects a missing cookie", () => {
    const token = issueCsrfToken(sessionId);
    expect(validateCsrfToken({ cookieValue: null, headerValue: token, sessionId })).toBe(false);
  });

  it("rejects a token that does not match the cookie", () => {
    const a = issueCsrfToken(sessionId);
    const b = issueCsrfToken(sessionId);
    expect(a).not.toBe(b);
    expect(validateCsrfToken({ cookieValue: a, headerValue: b, sessionId })).toBe(false);
  });

  it("rejects a token bound to a different session", () => {
    const token = issueCsrfToken(sessionId);
    expect(
      validateCsrfToken({
        cookieValue: token,
        headerValue: token,
        sessionId: "99999999-2222-3333-4444-555555555555",
      }),
    ).toBe(false);
  });

  it("rejects a forged signature", () => {
    const [nonce] = issueCsrfToken(sessionId).split(".") as [string, string];
    const forged = `${nonce}.${createHmac("sha256", "attacker-key").update("x").digest("base64url")}`;
    expect(validateCsrfToken({ cookieValue: forged, headerValue: forged, sessionId })).toBe(false);
  });

  it("rejects malformed and oversized tokens", () => {
    for (const bad of ["", "nodot", "a.b.c", "."]) {
      expect(validateCsrfToken({ cookieValue: bad, headerValue: bad, sessionId })).toBe(false);
    }
    const huge = "a".repeat(600);
    expect(validateCsrfToken({ cookieValue: huge, headerValue: huge, sessionId })).toBe(false);
  });

  it("sets the cookie as HttpOnly, Secure and SameSite=Strict in production", () => {
    expect(csrfCookieOptions(true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
  });

  it("documents the header name the client must send", () => {
    expect(CSRF_HEADER).toBe("x-csrf-token");
  });
});

describe("security headers", () => {
  it("sets a restrictive default CSP", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("only allows GitHub in form-action", () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("form-action 'self' https://github.com");
    expect(csp).not.toContain("https://accounts.google.com");
  });

  it("adds a nonce only when one is supplied", () => {
    expect(buildContentSecurityPolicy()).not.toContain("nonce-");
    expect(buildContentSecurityPolicy({ nonce: "abc123" })).toContain("'nonce-abc123'");
  });

  it("widens connect-src and frame-src for upstream mail origins", () => {
    const csp = buildContentSecurityPolicy({
      mailOrigins: ["https://jmap.example.com", "not-a-url"],
    });
    expect(csp).toContain("connect-src 'self' https://jmap.example.com");
    expect(csp).toContain("frame-src 'self' https://jmap.example.com");
    expect(csp).not.toContain("not-a-url");
  });

  it("sets HSTS only over HTTPS", () => {
    expect(buildSecurityHeaders({ secure: false }).get("Strict-Transport-Security")).toBeNull();
    expect(buildSecurityHeaders({ secure: true }).get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("sets the baseline headers on every response", () => {
    const h = buildSecurityHeaders({ secure: true });
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("Permissions-Policy")).toContain("camera=()");
  });
});

describe("mail iframe sandbox", () => {
  it("never combines allow-scripts with allow-same-origin", () => {
    const flags = MAIL_IFRAME_SANDBOX.split(" ");
    expect(flags).not.toContain("allow-scripts");
    expect(flags).not.toContain("allow-same-origin");
    expect(MAIL_IFRAME_SANDBOX).toBe("allow-popups allow-popups-to-escape-sandbox");
  });

  it("serves a CSP with no script or network permission", () => {
    const csp = mailIframeHeaders().get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(mailIframeHeaders().get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("mail HTML sanitisation", () => {
  it("keeps ordinary formatting", () => {
    const html = "<p>Hello <strong>world</strong></p><a href='https://example.com'>link</a>";
    expect(sanitizeMailHtml(html)).toContain("<strong>world</strong>");
  });

  it("removes script tags and inline handlers", () => {
    const dirty = `<div onmouseover="steal()">hi</div><script>fetch('//evil')</script><img src=x onerror=alert(1)>`;
    const clean = sanitizeMailHtml(dirty);
    expect(clean).not.toContain("onmouseover");
    expect(clean).not.toContain("onerror");
    expect(clean.toLowerCase()).not.toContain("script");
  });

  it("removes iframes, objects and forms", () => {
    for (const tag of ["iframe", "object", "embed", "form", "meta", "base", "link"]) {
      const clean = sanitizeMailHtml(`<${tag} src="x"></${tag}>`);
      expect(clean.toLowerCase()).not.toContain(`<${tag}`);
    }
  });

  it("strips javascript: URLs", () => {
    const clean = sanitizeMailHtml(`<a href="javascript:alert(1)">x</a>`);
    expect(clean).not.toContain("javascript:");
  });

  it("blocks remote resources by default", () => {
    const clean = sanitizeMailHtml(`<img src="https://tracker.example.com/pixel.gif">`);
    expect(clean).not.toContain("tracker.example.com");
  });

  it("keeps inline cid: images for attachments", () => {
    const clean = sanitizeMailHtml(`<img src="cid:attachment-1">`, { blockRemoteResources: true });
    expect(clean).toContain("cid:attachment-1");
  });

  it("removes unknown tags entirely", () => {
    expect(sanitizeMailHtml("<marquee>hi</marquee>")).not.toContain("marquee");
  });

  it("converts HTML to readable plain text", () => {
    const text = htmlToPlainText("<p>Hello</p><p>World</p>");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toContain("<p>");
  });

  it("decodes common entities in the text fallback", () => {
    expect(htmlToPlainText("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
  });

  it("produces a bounded preview with no markup", () => {
    const preview = mailPreview(`<p>${"x".repeat(500)}</p>`);
    expect(preview.length).toBeLessThanOrEqual(160);
    expect(preview).not.toContain("<");
  });
});
