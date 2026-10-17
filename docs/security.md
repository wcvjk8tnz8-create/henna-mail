# Henna security model

**[English](security.md) | [简体中文](security.zh-CN.md)**

This document states what Henna protects against, how, and — just as importantly
— what it does not.

---

## Threat model

### Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Mail content | Browser memory, local IndexedDB, upstream server | The whole point |
| Upstream credentials | PostgreSQL, AES-256-GCM encrypted | Read access to a mailbox |
| TOTP secrets | PostgreSQL, AES-256-GCM encrypted | Second-factor bypass |
| Recovery codes | PostgreSQL, keyed digests only | Second-factor bypass |
| `HENNA_CREDENTIAL_KEY` | Environment / Workers secret | Unlocks the above |
| `jwt_secret` | Environment / Workers secret | Session forgery |
| Audit log | PostgreSQL, append-only | Detects and reconstructs incidents |

### Adversaries

1. **Remote attacker with no credentials** — probing the login surface, trying to
   enumerate accounts, forging CSRF, injecting content into a rendered message.
2. **Someone with a stolen session** — trying to escalate to administrator, reach
   another user's settings, or switch the second factor off.
3. **Compromised administrator account** — trying to read other users' mail.
4. **Full server compromise** — an attacker holding the host, the environment and
   the database.
5. **Malicious mail sender** — trying to execute script, track the reader, or
   impersonate a sender.

### What holds, and what does not

Against (1), (2) and (5), Henna's controls are strong: see the checklist below.

Against (3), the design is deliberate — **an administrator cannot read another
user's mail through Henna.** Credential decryption requires ownership, not the
admin role, and mail never touches the server at all. An administrator *can*
change instance settings and lock users out, which is why every administrative
action is audited.

Against (4), be honest: an attacker who owns the host owns
`HENNA_CREDENTIAL_KEY`, and can therefore decrypt stored upstream credentials.
What they still cannot do is read mail *from Henna's database*, because it is not
there. They would have to use the credentials against the upstream server, which
leaves a trail on that server and requires live access to Henna's environment.
This is the best a credential-coordinating architecture can offer, and it is a
materially smaller blast radius than a mail-storing server.

---

## Control checklist

### Authorisation

- [x] The DAL is the single enforcement point. Route Handlers, Server Actions and
      Server Components call `requirePrincipal()`, `requireAdmin()` or
      `requireOwnershipOrAdmin()`.
- [x] `requireMfaIfRequired()` decides, per instance policy and per user, whether
      a session may be used before the second factor is satisfied.
- [x] Middleware performs optimistic redirects only. On Cloudflare Workers it does
      not even run, and nothing depends on it.
- [x] Denials are audited at the point of decision, with a reason.
- [x] `github_user_id` carries a unique constraint, so one GitHub identity cannot
      be bound to two Henna accounts.
- [x] Administrators cannot access another user's upstream credentials.

### Authentication

- [x] Three methods only: password (scrypt), GitHub OAuth, email code. No other
      OAuth or OIDC provider exists in the codebase.
- [x] Passwords: minimum 12, maximum 128, never silently truncated, checked
      against a weak-password list before hashing.
- [x] Email codes: 6 digits, 10 minute lifetime, single use, hashed at rest,
      maximum 5 attempts, rate limited on both send and verify.
- [x] GitHub: authorization code flow; constant-time `state` comparison;
      exact-match `redirect_uri`; a primary **and verified** email or refusal;
      `github_user_id` as the binding key.
- [x] An email that matches an existing account never silently takes it over —
      the user must sign in first and link GitHub explicitly.
- [x] Login responses are identical for "no such account" and "wrong password".
- [x] Rate limiting on two independent axes (source IP and account).

### Sessions

- [x] Access tokens live at most 15 minutes.
- [x] Refresh tokens rotate on every use; the previous one dies immediately.
- [x] Refresh-token reuse revokes the entire rotation family.
- [x] The session identifier is rotated when MFA completes, so a pre-MFA token
      cannot be replayed.
- [x] Cookies are `HttpOnly`, `Secure` in production, `SameSite=Lax` (`Strict`
      for the CSRF cookie).
- [x] Password reset revokes every existing session.

### Request forgery

- [x] Server Actions keep Next.js's built-in CSRF protection; nothing disables it.
- [x] Custom Route Handlers check a double-submit token: cookie versus
      `x-csrf-token`, compared in constant time, bound to the session id.
- [x] Missing or mismatched token → `403`, and the attempt is audited.

### Input and injection

- [x] Every server input — Server Action arguments, request bodies, query
      parameters, custom headers — is parsed with Zod before use.
- [x] SQL goes through Drizzle parameterised queries only. No concatenation.
- [x] Redirect targets must be a single-leading-slash local path; protocol-relative
      URLs are refused.
- [x] SSRF: endpoint discovery only probes hosts from the instance allow-list.

### Attachment storage

- [x] Attachment bytes never reach the server: the browser uses presigned URLs
      against the bucket directly.
- [x] Keys are generated server-side under `users/<userId>/` and re-checked
      before every download.
- [x] Path traversal and absolute keys are rejected; filenames are sanitised;
      content types are validated against a strict grammar, because a newline
      would be header injection into the signed request.
- [x] URL issuance is rate limited, and every grant and denial is audited.
- [x] Bucket credentials are encrypted at rest, in dedicated columns.

### Mail rendering

- [x] Message HTML is sanitised against a tag and attribute allow-list.
- [x] Rendered in an iframe with `sandbox="allow-popups
      allow-popups-to-escape-sandbox"`. `allow-scripts` and `allow-same-origin`
      are never combined.
- [x] Remote images blocked by default; per-message opt-in.
- [x] Attachment MIME type checked against the file's magic bytes before download.
- [x] Mail HTML is never server-rendered into the page.

### Headers

- [x] `Content-Security-Policy` — `default-src 'self'`, no inline script without a
      nonce, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
      `form-action 'self' https://github.com`.
- [x] `connect-src` and `frame-src` widen only for allow-listed upstream origins.
- [x] `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
      in production.
- [x] `X-Content-Type-Options: nosniff`,
      `Referrer-Policy: strict-origin-when-cross-origin`, minimum
      `Permissions-Policy`.

### Cryptography

- [x] AES-256-GCM for stored secrets, output as `iv:authTag:ciphertext`.
- [x] The auth tag is verified before any plaintext is returned; failure is
      audited, never guessed around.
- [x] scrypt for passwords, with parameters stored alongside the hash so they can
      be raised; N = 2^15, r = 8, p = 1 by default.
- [x] All randomness from `node:crypto`. No `Math.random()` in a security path.
- [x] All secret comparisons in constant time.
- [x] Key rotation with a supporting UI and a completion report.

### Auditing

- [x] Append-only, enforced by a database trigger as well as by convention.
- [x] Covers sign-in success and failure, denials, code issue and verification,
      password reset, TOTP lifecycle, recovery-code use, credential decryption,
      storage URL issuance, administrative actions, key rotation.
- [x] Never records a password, a code, a TOTP value or a decrypted credential.
      `writeAudit` redacts a denylist of metadata keys as a backstop.
- [x] Stores hashed IP and user-agent, never the raw values.
- [x] No delete path exists in the application.

---

## Known limitations

1. **Server compromise exposes credentials, not mail.** As described above. If
   your threat model requires that a full server compromise reveal nothing at
   all, you need an architecture where the server never holds a decryption key —
   which Henna is not, because it must decrypt credentials to use them.
2. **IMAP/SMTP is unavailable on Cloudflare Workers.** Workers has no raw TCP.
   The fallback is self-hosted Node.js only, and the UI says so.
3. **Metadata still transits the upstream server.** Henna does not change what
   your mail provider can see.
4. **S/MIME private keys are a hard problem.** Verification of signatures is
   straightforward; decryption requires key custody Henna does not try to solve
   in this release. Private keys should stay in the browser via WebCrypto.
5. **Rate-limit counters live in PostgreSQL.** That is correct for correctness
   across isolates, but it means a database outage also disables rate limiting.
   Henna fails closed: if the counter cannot be read, the request is refused.
6. **The attachment size cap is advisory at the protocol level.** A
   query-string presigned URL cannot carry a `content-length-range`; see
   [storage.md](storage.md#known-limitations).
7. **`jwt_secret` rotation logs everyone out.** This is intentional. Plan it.
8. **No WebAuthn/passkeys yet.** GitHub OAuth plus TOTP is the ceiling today.

---

## Reporting a vulnerability

Please **do not** open a public issue for a live vulnerability.

1. Email **security@henna.example** (replace with your instance's real address,
   or use GitHub's private security advisory on the repository).
2. Include: what you found, how to reproduce it, the affected version or commit,
   and the impact as you see it.
3. You will get an acknowledgement within 72 hours, and an assessment with a
   remediation plan within 7 days.
4. We will credit you in the release notes unless you prefer otherwise.
5. Please give us a reasonable window to ship a fix before disclosing publicly.

We will not pursue legal action against researchers who act in good faith, avoid
privacy violations, and do not disrupt service.

## Verifying the controls yourself

```bash
npm run typecheck     # types are part of the security posture
npm run lint          # Biome, with no-explicit-any as an error
npm test              # unit tests for crypto, DAL, TOTP, validation
npm run test:e2e      # Playwright: auth, authorisation, CSRF, MFA
```

Every one of those runs in CI, and a red result blocks the merge.
