# Dependency licences

**[English](licenses.md) | [简体中文](licenses.zh-CN.md)**

Henna is licensed under **AGPL-3.0-or-later**. Every dependency below is
redistribution-compatible with it. This document records that review.

---

## Why this file exists

AGPL-3.0 is strong copyleft. Adding a dependency whose terms conflict with it is
not a paperwork problem — it changes what everyone downstream is allowed to do
with Henna. So the licence of each dependency is checked before it is added, and
recorded here.

## Runtime dependencies

| Package | Licence | Notes |
| --- | --- | --- |
| `next` | MIT | Framework, App Router |
| `react`, `react-dom` | MIT | UI runtime |
| `drizzle-orm` | Apache-2.0 | Database access; parameterised queries only |
| `pg` | MIT | PostgreSQL driver (Node.js path) |
| `zod` | MIT | Input validation and type inference |
| `jose` | MIT | Session token signing and verification |
| `otpauth` | MIT | TOTP generation and validation. Pure TypeScript — no native code, so it runs on Workers |
| `next-auth` | ISC | Auth.js v5 session plumbing |
| `resend` | MIT | Transactional email delivery |
| `jmap-kit` | MIT | JMAP client used by the browser path |
| `framer-motion` | MIT | Layered page transitions |

### A note on SigV4

Attachment signing deliberately does **not** use the AWS SDK.
`@aws-sdk/s3-request-presigner` pulls a dependency tree that leans heavily on
Node.js built-ins, is awkward on Cloudflare Workers, and is far more than Henna
needs. Query-string SigV4 presigning is essentially HMAC plus hex encoding —
about a hundred lines — and both primitives exist everywhere Henna runs. The
implementation is cross-checked against the independent `aws4` signer in the
test suite.

## Development dependencies

| Package | Licence | Notes |
| --- | --- | --- |
| `typescript` | Apache-2.0 | Language and typechecker |
| `vitest` | MIT | Unit test runner |
| `@playwright/test` | Apache-2.0 | End-to-end tests |
| `@biomejs/biome` | MIT | Lint and format; replaces the deprecated `next lint` |
| `@opennextjs/cloudflare` | MIT | Workers adapter |
| `wrangler` | MIT (Apache-2.0 components) | Workers CLI |
| `drizzle-kit` | Apache-2.0 | Migrations |
| `tailwindcss`, `@tailwindcss/postcss` | MIT | Styling |
| `@types/*` | MIT | Type definitions |
| `@cloudflare/workers-types` | MIT | Workers ambient types |

## Adding a dependency

Two checks before you add one:

1. **Licence compatibility.** MIT, Apache-2.0, ISC and BSD all work. Anything
   with terms that conflict with AGPL-3.0 does not. If you are unsure, open an
   issue rather than guessing.
2. **Workers compatibility.** Cloudflare Workers cannot load native addons. This
   is why Henna uses `node:crypto`'s **scrypt** rather than Argon2id, and why
   TOTP comes from `otpauth` rather than a package with a native binding. A
   dependency that pulls a `.node` file into the bundle will build locally and
   fail in production.

## Regenerating this review

```bash
npx license-checker --production --summary
npx license-checker --development --summary
```

If the output does not match the tables above, update this file in the same
pull request as the dependency change.

## Henna's own licence

See [LICENSE](../LICENSE) at the repository root.
