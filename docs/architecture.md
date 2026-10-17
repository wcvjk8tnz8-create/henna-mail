# Henna architecture

**[English](architecture.md) | [简体中文](architecture.zh-CN.md)**

## The boundary, stated once

> **Mail content never passes through Henna's server.** Not message bodies, not
> attachments, not list queries, not search.

Everything below is an elaboration of that sentence.

---

## Data flow

```
                      ┌──────────────────────────────────────┐
                      │            Browser (client)          │
                      │                                      │
                      │  • holds the JMAP API token          │
                      │  • renders mail in a sandboxed iframe │
                      │  • keeps a local IndexedDB index     │
                      │  • runs search locally               │
                      └───┬──────────────────────────┬───────┘
                          │                          │
              (A) mail    │                          │  (B) identity,
                  traffic │                          │      settings,
                          ▼                          ▼      audit
        ┌─────────────────────────────┐   ┌──────────────────────────┐
        │   Upstream mail server      │   │      Henna server        │
        │   JMAP (RFC 8620/8621)      │   │  (Workers or Node.js)    │
        │   or IMAP/SMTP fallback     │   │                          │
        └─────────────────────────────┘   │  • GitHub OAuth          │
                                          │  • password / email code │
                                          │  • TOTP + recovery codes │
                                          │  • credential encryption │
                                          │  • settings              │
                                          │  • audit log             │
                                          └────────────┬─────────────┘
                                                       │
                                                       ▼
                                            ┌──────────────────────┐
                                            │     PostgreSQL       │
                                            │  (Hyperdrive on CF)  │
                                            └──────────────────────┘
```

**(A)** carries mail. **(B)** carries identity and configuration. They do not
meet. There is no arrow from the Henna server to the upstream server for message
data, and there is no table in PostgreSQL that could hold a message.

### Why this is more than a policy

It is enforced structurally:

- `db/schema.ts` has no table for messages, bodies, attachments or indexes. Adding
  one would be a visible schema change, not a refactor.
- The server has no code path that fetches a message. There is no function to
  call.
- The CSP's `connect-src` is widened only for allow-listed upstream origins, so
  the browser can reach the mail server — not so Henna can.

---

## JMAP path (primary)

1. The user adds a JMAP account: session URL plus an API token.
2. The token is encrypted with AES-256-GCM and stored. The browser also holds it
   for the session.
3. The browser calls the JMAP endpoint directly. Henna's server is not in the
   request path, so there is nothing for it to log.

```
Browser ──Bearer token──► https://jmap.example.com/jmap
```

Attachments take a similar route of their own: the browser asks Henna to sign a
short-lived URL, then reads and writes the bucket directly. See
[storage.md](storage.md).

Fallback discovery uses `/.well-known/jmap`, restricted to hosts on the instance
allow-list — Henna will not probe a hostname a user typed.

## IMAP/SMTP path (fallback)

Raw sockets are impossible on Cloudflare Workers, so this path is scoped
honestly:

| Runtime | IMAP/SMTP |
| --- | --- |
| Cloudflare Workers | Not available. JMAP only, and the UI says so. |
| Self-hosted Node.js | Available. Ports 993/587/465. Port 25 refused. |

Where it is available, the credential is decrypted in memory for the duration of
one connection and discarded. It is never written to disk, never logged, and the
decryption is rate limited and audited.

---

## Authentication

### Three methods, and only three

```
┌─────────────┐   ┌──────────────┐   ┌────────────────┐
│  Password   │   │ GitHub OAuth │   │  Email code    │
│  scrypt     │   │  code flow   │   │  6 digits/10m  │
└──────┬──────┘   └──────┬───────┘   └───────┬────────┘
       │                 │                   │
       └─────────────────┼───────────────────┘
                         ▼
              ┌───────────────────────┐
              │  requireMfaIfRequired │
              │  (policy × role)      │
              └──────────┬────────────┘
                         ▼
              ┌───────────────────────┐
              │  Session (rotated id) │
              └───────────────────────┘
```

**OAuth: GitHub, and nothing else.** Henna will not add Google, Microsoft, a
generic OIDC provider, or a mailbox-provider OAuth flow. This is a design
decision, not an oversight: every additional provider is another identity system
whose semantics must be modelled correctly, and "verified email" means something
different in each one.

GitHub specifics that matter:

- Authorization code flow. PKCE only when verified end to end — Henna will not
  send a `code_challenge` the server ignores, because that is security theatre.
- Compensating controls instead: single-use `state` compared in constant time,
  exact-match `redirect_uri`, server-side `client_secret`, one-shot code exchange.
- `github_user_id` is the binding key. The email and the login can both be
  changed by their owner, so neither may identify an account.
- Only a **primary and verified** email is accepted. Anything else is refused.
- An email matching an existing account does **not** silently take it over.

### Second factor

| Policy | Ordinary user | Administrator |
| --- | --- | --- |
| `optional` (default off) | May enrol | **Must** enrol |
| `admin-only` (default) | May enrol | **Must** enrol |
| `required` | **Must** enrol | **Must** enrol |

Administrators are always subject to at least `admin-only`, regardless of the
setting. They cannot disable their own TOTP.

TOTP: ±1 step of 30 seconds, replay protection via a stored last-used step,
secret encrypted at rest, verification rate limited.

Recovery codes: 10 at a time, shown once, stored as keyed digests, single use,
with a prompt to regenerate once half are gone.

---

## Authorisation

The DAL is the only place a decision is made.

```
Server Action ─┐
Route Handler ─┼──► requirePrincipal() ──► requireMfaIfRequired()
Server Component┘         │                        │
                          │                        │
                          ▼                        ▼
                   requireAdmin()          minimum DTO returned
                   requireOwnershipOrAdmin()
```

- No route, page or UI component checks a role on its own.
- DAL functions return minimum DTOs — a `UserDto`, never a database row — so a
  password hash or a TOTP ciphertext cannot leak into a rendered page by
  accident.
- Denials are audited where they happen.

Sessions are re-read from PostgreSQL on every request. A JWT signature alone is
never sufficient: revoking a session takes effect immediately.

---

## Configuration

Two layers, on purpose.

| Layer | Values | Changed by |
| --- | --- | --- |
| Root (environment) | `DOMAIN`, `ADMIN`, `jwt_secret`, `HENNA_CREDENTIAL_KEY` | Redeploy |
| Instance (database) | Auth switches, OAuth credentials, Resend, TOTP policy, registration, password rules, code lifetimes, transitions | `/admin/settings` |

Root values cannot be changed by an attacker who compromises an administrator
session, because changing them requires redeploying. All application code reads
configuration through `lib/config` — `process.env` is not referenced in business
logic.

Instance secrets (GitHub client secret, Resend key) are encrypted in dedicated
columns, never inside the JSON settings blob, so exporting that row leaks
nothing.

---

## Auditing

Append-only, with a database trigger that rejects `UPDATE` and `DELETE` even if a
role were granted them by mistake.

Recorded: sign-in success and failure, denials, non-allow-listed attempts, code
issue and verification, password reset, TOTP enrol/disable/verify, recovery-code
use and regeneration, credential decryption, administrative actions, key
rotation.

Never recorded: passwords, codes, TOTP values, decrypted credentials. IP and
user-agent are stored as hashes.

---

## Rendering and Content Security Policy

Mail HTML goes through two independent barriers:

1. **Sanitisation** — a tag and attribute allow-list, with event handlers,
   `javascript:` URLs and remote resources stripped.
2. **Sandbox** — an iframe with
   `sandbox="allow-popups allow-popups-to-escape-sandbox"` and a CSP of
   `default-src 'none'` plus `script-src 'none'`.

`allow-scripts` and `allow-same-origin` are never combined. Together they would
let a message reach Henna's own origin; separately they cannot.

The page CSP is separate and strict: `default-src 'self'`, no inline script
without a per-request nonce, `form-action 'self' https://github.com`, and
`connect-src` widened only for allow-listed upstream origins.

---

## Page transitions

- Simple route changes use the **View Transitions API** — native to the App
  Router, no dependency, good for fades and shared-element moves.
- Layered transitions (list → reader, modals) use **Framer Motion's
  `AnimatePresence`**, waiting for the exit animation before entering, so nothing
  jumps.
- 150–300 ms, with a natural easing curve.
- `prefers-reduced-motion` is respected: animations are skipped, not shortened to
  a token duration.
- All client-side. Nothing about a transition blocks a form submission, a
  security check, or server rendering.
- Switchable per instance, and per user.

---

## Testing strategy

| Layer | Tool | Covers |
| --- | --- | --- |
| Pure rules | Vitest | crypto, scrypt, TOTP windows and replay, recovery codes, OTP lifetimes, DAL policy, Zod boundaries, config parsing |
| Boundaries | Playwright | three sign-in methods, password reset, OTP expiry/replay/exhaustion, non-allow-listed GitHub refusal, CSRF 403, administrator forced TOTP, credential-decryption auditing |
| Types | `tsc --noEmit` | strict mode, no `any` |
| Style | Biome | lint and format, with `noExplicitAny` as an error |

CI runs all four. A failure blocks the merge and, on `main`, blocks deployment.
