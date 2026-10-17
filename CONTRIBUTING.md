# Contributing to Henna

**[English](../CONTRIBUTING.md) | [简体中文](../CONTRIBUTING.zh-CN.md)**

Thanks for helping. Henna is security-sensitive software, so this document is
mostly about what *not* to do.

---

## Getting set up

```bash
npm install
cp .env.example .env      # fill in DOMAIN, ADMIN, jwt_secret, HENNA_CREDENTIAL_KEY
createdb henna
npm run db:migrate
npm test
npm run dev
```

Before opening a pull request:

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

All four run in CI. A red result blocks the merge.

## Coding standards

**TypeScript is strict, and `any` is an error.** Not a warning — an error. If a
third-party type is wrong, narrow it with a Zod schema and infer from that.

**Every server input is parsed with Zod first.** Server Action arguments, request
bodies, query parameters, custom headers. Raw input reaching business logic is a
review blocker, even when you are sure the value is safe.

**SQL goes through Drizzle.** Parameterised queries only. No template strings, no
string concatenation, no `sql.raw` with interpolated input.

**Secrets come from `lib/config`, never `process.env` directly.** Nothing secret
may appear in a `NEXT_PUBLIC_*` variable; the boot check enforces this.

**Use `node:crypto`, not `Math.random()`**, for anything security-relevant.

**Compare secrets in constant time.** `safeEqual` in
`lib/crypto/constant-time.ts`.

---

## The rule that matters most

> **Authorisation decisions live in the DAL. Nowhere else.**

`lib/dal/` is the only place that may decide whether an action is allowed. Route
Handlers, Server Actions and Server Components call a guard and use what it
returns.

This means:

- Do not check a role in a page, a component, or a route handler.
- Do not trust a value carried in a cookie, a JWT claim or a form field as proof
  of identity. The DAL re-reads the session and the user row.
- Do not add an access control to `middleware.ts`. On Cloudflare Workers, Node.js
  middleware does not run at all, so anything that depends on it is silently
  absent in production.

If you find yourself writing `if (session.user.role === 'admin')` outside
`lib/dal/`, stop and add a DAL function instead.

---

## Review requirements

Changes touching any of these paths need **two approving reviewers**, at least one
of whom is a maintainer:

- `lib/dal/` — authorisation
- `lib/storage/` — object storage signing and keys
- `lib/crypto/` — encryption, key management, randomness
- `lib/auth/` — authentication, sessions, TOTP, codes
- `middleware.ts` — request filtering
- `lib/security/` — CSRF, headers, sanitisation
- `db/schema.ts` and `db/migrations/` — the data model
- Any GitHub OAuth callback code

Reviewers on those paths should be looking specifically for:

1. An input that reaches logic without Zod.
2. A decision made outside the DAL.
3. A secret that could reach a log, an error message, or a browser bundle.
4. A control that exists only in middleware or only in the UI.
5. A comparison that is not constant time.
6. A rate limit that is missing on a new authentication or decryption path.

---

## Things Henna will not accept

Please do not spend your time building these; they will be declined.

- **Any OAuth or OIDC provider other than GitHub.** No Google, Microsoft, Apple,
  generic OIDC, or mailbox-provider OAuth. This is a deliberate constraint.
- **Anything that stores mail content server-side.** No message table, no
  attachment table, no server-side full-text index. This is the architecture.
- **Anything that moves attachment bytes through the server.** Uploads and
  downloads go browser ↔ bucket via presigned URLs; a change that makes Henna
  receive or retain a file body will be rejected.
- **Magic-link sign-in as a primary method**, or username/password flows that
  bypass the password policy.
- **Disabling or weakening Next.js's Server Action CSRF protection.**
- **`any` casts**, `@ts-ignore`, or `eslint-disable` in a security-critical path.
- **A dependency that pulls a native addon into the Workers bundle** — Workers
  needs `nodejs_compat`-compatible packages. This is why scrypt, not Argon2id.
- **A control that only exists client-side.**

---

## Tests are part of the change

- **New logic in `lib/crypto/`, `lib/auth/`, `lib/dal/` or
  `lib/validation/` comes with unit tests.** The pure rules are deliberately
  separated from the database-touching code so they can be tested without
  PostgreSQL; keep them that way.
- **New authentication, authorisation or CSRF surface comes with an E2E test.**
  Test the refusal, not just the happy path: the interesting assertion is that
  the request was denied.
- **Bug fixes get a regression test.** If a test would not have caught the bug,
  the fix is not finished.

## Commit and PR conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`,
  `security:` (use `security:` for anything that closes a vulnerability).
- Describe *why*, not just *what*. For security changes, state the threat.
- Keep PRs focused. A 200-line security change gets reviewed properly; a
  2,000-line one gets skimmed.
- Note in the description if you touched a protected path, so review is routed
  correctly.

## Reporting security issues

Do not open a public issue. See
[docs/security.md](docs/security.md#reporting-a-vulnerability).

## Licence

By contributing you agree that your work is licensed under AGPL-3.0-or-later, the
same licence as the project.
