# Henna

**[English](README.md) | [简体中文](README.zh-CN.md)**

Henna is a security-first, self-hostable webmail frontend. It is a mail *client*
and a thin credential coordinator — not a mail store. Your messages, attachments
and search index never land on Henna's server.

Built on Next.js (App Router), TypeScript in strict mode, Tailwind CSS, Drizzle
ORM over PostgreSQL, and Auth.js v5. Deploys to Cloudflare Workers through
OpenNext, or to any Node.js host. Licensed under AGPL-3.0.

---

## Why Henna

Most self-hosted webmail stacks put a server in the middle of your mail: it
fetches, stores, indexes and serves every message. That server becomes the single
most valuable target in your infrastructure, and it holds a copy of everything.

Henna takes the opposite approach. The server handles identity, encrypted
credentials, settings and auditing. Mail moves between your browser and your
upstream mail server — JMAP where possible, IMAP/SMTP as a fallback — and nothing
in between keeps a copy.

## Features

**Sign-in, three ways, and only three**

- Password — scrypt hashed, minimum 12 characters, never silently truncated.
- GitHub OAuth — the one and only OAuth provider Henna will ever support.
- Email code — a 6-digit code, valid for 10 minutes, single use, hashed at rest.

**Second factor that means something**

- TOTP with a ±1 step window and replay protection.
- One-time recovery codes, stored only as keyed digests.
- Administrators are *always* required to use it, whatever the instance policy.
- Turning it off requires proving a current code first.

**Credentials handled properly**

- AES-256-GCM with a rotatable key ring.
- Every decryption is rate limited and written to the audit log.
- Rotation that you can actually complete: add a key, re-encrypt, drop the old one.

**An audit log that is real**

- Append-only, enforced by a database trigger, not by convention.
- Covers sign-ins, denials, password resets, TOTP events, credential decryption
  and administrative actions.
- Never contains a password, a code or a decrypted secret.

**Attachments that never touch the server**

- Cloudflare R2 by default, any S3-compatible bucket if you prefer.
- The browser uploads and downloads through short-lived presigned URLs. Henna
  signs the request; the bytes go browser ↔ bucket and nowhere else.
- Every URL is scoped to one user's key prefix, rate limited and audited.

**Mail that stays yours**

- JMAP first; IMAP/SMTP only as a documented fallback.
- Message HTML rendered in a sandboxed iframe that forbids scripts.
- Remote images blocked until you allow them.
- Search runs locally, against a browser-side index. The query never leaves your
  device.

## Architecture at a glance

```
Browser ──JMAP────────────────► Upstream mail server
   │                              (mail content, direct)
   │
   ├── HTTPS ──► Henna server ──► PostgreSQL
                 (identity, encrypted
                  credentials, settings, audit)
```

Mail payloads are on the top line only. The Henna server is on the bottom line
only. The two never mix. See [docs/architecture.md](docs/architecture.md).

## Deploy in one click

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wcvjk8tnz8-create/henna)

Cloudflare forks this repository, creates the D1 database and the R2 bucket for
you, and asks for **three values**. That is the whole setup — there is no
`wrangler.jsonc` to edit and no migration to run.

| Field | What to enter |
| --- | --- |
| `DOMAIN` | JSON array of the mail domains you serve, e.g. `["example.com"]` |
| `ADMIN` | Your email address. This becomes the first administrator. |
| `jwt_secret` | Any random letters and digits, no punctuation |

```bash
openssl rand -hex 24    # paste the output as jwt_secret
```

Prefer the dashboard over the button? See
[docs/cloudflare-deployment.md](docs/cloudflare-deployment.md#dashboard-deployment-no-cli-at-all)
— fork, create a Worker, add the same three values under
*Settings → Variables and Secrets*, redeploy.

Then sign in for the first time:

1. Open your `*.workers.dev` URL and request a code with the `ADMIN` address.
2. No mail service is configured yet, so **the code is printed to the server
   log**. Read it with `npx wrangler tail`.
3. Enter the code, set a password, and turn on TOTP — administrators must.
4. Configure Resend, GitHub OAuth and object storage in `/admin/settings`.

Step 2 is a deliberate, one-time exception: with no way to send mail, an
instance would otherwise be impossible to sign in to at all. It applies only
while nobody has completed a sign-in, and only for the `ADMIN` address. See
[docs/cloudflare-deployment.md](docs/cloudflare-deployment.md#one-click-deployment).

## Quick start (local)

```bash
git clone https://github.com/your-org/henna.git
cd henna
npm install
cp .env.example .env          # then fill in the four required values
npm run db:migrate
npm run dev
```

Generate the two secrets you need:

```bash
openssl rand -base64 32                    # HENNA_CREDENTIAL_KEY
openssl rand -hex 24 | tr -d '\n'          # jwt_secret (letters and digits only)
```

Open <http://localhost:3000>. The address in `ADMIN` is created as the first
administrator on first boot; sign in with an email code, then set a password and
enable TOTP.

## Deploying to Cloudflare Workers

The full walk-through is in
[docs/cloudflare-deployment.md](docs/cloudflare-deployment.md). The short version:

1. Create a Hyperdrive configuration pointing at your PostgreSQL instance.
2. Fill in `wrangler.jsonc` (name, `compatibility_date`, Hyperdrive binding).
3. Add repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `DOMAIN`, `ADMIN`, `JWT_SECRET`, `HENNA_CREDENTIAL_KEY`.
4. Push to `main`.

The workflow runs typecheck, lint, unit tests and Playwright E2E. If any step
fails, nothing is deployed.

### GitHub Actions, step by step

1. **Fork or create the repository** and push your `main` branch.
2. **Create a Cloudflare API token** — *My Profile → API Tokens → Create Custom
   Token*. Do **not** use the *Edit Cloudflare Workers* template: it lacks D1 and
   R2 permissions, so the deploy fails after the Worker uploads. Grant
   `Workers Scripts:Edit`, `D1:Edit`, `Workers R2 Storage:Edit`,
   `Workers Observability:Edit`, `Account Settings:Read` (account scope) and
   `User Details:Read` (user scope); add `Workers Routes:Edit` (zone scope) only
   if you use a custom domain. See
   [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md#8-github-actions-pipeline).
3. **Find your Account ID** on the Cloudflare dashboard sidebar.
4. **Add repository secrets** under *Settings → Secrets and variables → Actions*:

   | Secret | Purpose |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | Deployment credential, CI only |
   | `CLOUDFLARE_ACCOUNT_ID` | Which account to deploy into |
   | `DOMAIN` | JSON array of mail domains, e.g. `["example.com"]` |
   | `ADMIN` | Bootstrap administrator email |
   | `JWT_SECRET` | Session signing key, letters and digits only |
   | `HENNA_CREDENTIAL_KEY` | base64 of 32 random bytes |
   | `HENNA_STORAGE_ORIGINS` | Bucket origins allowed by the CSP (see § below) |
   | `HENNA_CREDENTIAL_KEY`*, `GITHUB_CLIENT_SECRET`, `RESEND_API_KEY` | Optional if you will configure them in `/admin/settings` |

5. **Push to `main`.** The `quality` job gates the `deploy` job; a red check means
   no deployment.

## Attachments and object storage

Henna uses object storage for attachments, with **Cloudflare R2** as the default
and **any S3-compatible service** (AWS S3, MinIO, Backblaze B2, Hetzner, Wasabi)
as a supported alternative. Both speak the same presigned SigV4 protocol, so one
implementation covers all of them.

The flow is deliberately narrow:

1. The browser asks Henna for an upload URL, sending only a filename and a size.
2. The DAL checks the size, generates a key under `users/<id>/…`, signs a PUT
   URL that expires in minutes, and records the audit event.
3. The browser PUTs the file straight to the bucket.

Henna never receives the bytes. See [docs/storage.md](docs/storage.md) for
bucket setup, CORS and the CSP prerequisite.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/self-hosting.md](docs/self-hosting.md) | Environment variables, TLS, migrations, backups, key rotation |
| [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md) | OpenNext, Hyperdrive, Workers secrets, Resend DNS |
| [docs/security.md](docs/security.md) | Threat model, control checklist, known limits, disclosure |
| [docs/architecture.md](docs/architecture.md) | Data-flow diagrams and the mail-content boundary |
| [docs/storage.md](docs/storage.md) | R2 and S3-compatible attachment storage |
| [docs/licenses.md](docs/licenses.md) | Dependency licences and compatibility review |
| [docs/README.md](docs/README.md) | Documentation index, in both languages |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Coding standards and review rules for security-critical paths |

## Security

Henna is designed so that a compromise of its server does not hand over your
mail: the server holds encrypted upstream credentials and an audit log, and
nothing else. See [docs/security.md](docs/security.md) for the threat model, the
full control checklist, and the known limitations — including the honest one,
which is that an attacker who owns the server can decrypt credentials for as long
as they hold the key ring.

To report a vulnerability, follow the disclosure process in
[docs/security.md](docs/security.md#reporting-a-vulnerability). Please do not
open a public issue for a live vulnerability.

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).
