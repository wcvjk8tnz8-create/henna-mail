# Deploying Henna to Cloudflare Workers

**[English](cloudflare-deployment.md) | [简体中文](cloudflare-deployment.zh-CN.md)**

Henna deploys to Workers through [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare).
This document covers the adapter, Hyperdrive, Workers secrets, Resend DNS, and
the GitHub Actions pipeline.

---

## Dashboard deployment (no CLI at all)

This is the path that needs nothing but a browser. It is modelled on how Cloud
Mail is deployed, and it is the one most people should follow.

### 1. Get the repository into your GitHub account

Fork `https://github.com/wcvjk8tnz8-create/henna`. Cloudflare builds from *your*
fork, so the fork is the thing you will point it at.

### 2. Create the Worker

*Cloudflare dashboard → Compute (Workers) → Workers & Pages → Create →
Connect to Git* and pick your fork.

Leave everything at its default. **Do not set a root directory** — Henna is a
single Next.js project at the repository root, unlike Cloud Mail where the
Worker lives in a subdirectory.

Click **Deploy**.

### 3. Add the three variables

*Worker → Settings → Variables and Secrets → Add*

| Name | Type | Value |
| --- | --- | --- |
| `DOMAIN` | JSON | `["example.com"]` — a JSON array, even for one domain |
| `ADMIN` | Text | Your email address; this becomes the first administrator |
| `jwt_secret` | Secret | Any random letters and digits, no punctuation |

```bash
openssl rand -hex 24    # paste the output as jwt_secret
```

`DOMAIN` must be **JSON**, not text: a bare `example.com` will be rejected at
boot. `jwt_secret` accepts letters and digits only — no punctuation, because
the value travels through CI secret stores and shell scripts.

Then **redeploy** so the Worker picks up the new values.

### 4. Database and attachments are already done

This is the one place Henna differs from Cloud Mail, and it is worth being
explicit about, because the Cloud Mail instructions will tell you to create and
bind a D1 database by hand:

| | Cloud Mail | Henna |
| --- | --- | --- |
| D1 database | Create in the dashboard, copy the id, bind as `db` | Declared **by name** in `wrangler.jsonc`; created on first deploy |
| KV namespace | Create and bind as `kv` | Not used |
| R2 bucket | Create, bind as `r2`, set a custom domain | Declared by name; created on first deploy |
| Schema | Visit `/api/init/<jwt_secret>` | Created automatically on the first request |
| Variables | 3 in the dashboard | 3 in the dashboard |

There is no id to copy and no `/api/init/…` URL to visit. `ensureSchema()` in
`db/index.ts` runs on the first request and every statement is `IF NOT EXISTS`,
so it is idempotent.

### 5. Sign in

1. Open the `*.workers.dev` URL (or your custom domain once you attach one).
2. Request a code with the `ADMIN` address.
3. No mail service is configured yet, so the code is printed to the log — read
   it with `npx wrangler tail`, or in *Workers → Logs*.
4. Set a password and turn on TOTP. Administrators must.
5. Configure Resend, GitHub OAuth and object storage in `/admin/settings`.

If you would rather not touch a terminal at all, the log is also visible in the
Cloudflare dashboard under your Worker's **Logs** tab.

### 6. Optional: custom domain

*Worker → Settings → Domains & Routes → Add → Custom domain*. Cloudflare
issues the certificate; there is nothing to buy and no DNS record to write by
hand.

---
## One-click deployment

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wcvjk8tnz8-create/henna)

This is the path most people should take. Cloudflare forks the repository,
creates the D1 database and the R2 bucket automatically, and asks for three
values. There is no `wrangler.jsonc` to edit and no migration to run.

| Field | What to enter |
| --- | --- |
| `DOMAIN` | JSON array of the mail domains you serve, e.g. `["example.com"]` |
| `ADMIN` | Your email address. This becomes the first administrator. |
| `jwt_secret` | Any random letters and digits, no punctuation |

```bash
openssl rand -hex 24    # paste the output as jwt_secret
```

### Why only three

Everything else has a working default. `HENNA_CREDENTIAL_KEY` is derived from
`jwt_secret` by HKDF when absent. The D1 database and the R2 bucket are declared
by *name* in `wrangler.jsonc`, so Cloudflare creates them on first deploy — that
is why no id or connection string appears anywhere. The schema is created on the
first request (`ensureSchema()` in `db/index.ts`, every statement `IF NOT
EXISTS`).

### Two things worth knowing before you click

**The fork's GitHub Actions workflow will fail.** It needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, which the one-click flow
does not set. That workflow is for the CI/CD path described in §8 below; the
one-click deployment uses Cloudflare's own build system and does not depend on
it. Either ignore the red check, or disable Actions in the fork
(*Settings → Actions → Disable*).

**If Cloudflare does not detect your build command**, set it manually:

| Setting | Value |
| --- | --- |
| Build command | `npx opennextjs-cloudflare build` |
| Deploy command | `npx wrangler deploy` |

### First sign-in

No mail service is configured yet, so a code cannot be emailed to you. Henna
prints the code to the server log instead, **once**, and only while the instance
is still untouched:

```bash
npx wrangler tail
# [henna] BOOTSTRAP sign-in code for you@example.com: 123456 (single use, expires in 10 minutes)
```

This is a deliberate, narrowly scoped exception to "never log a code". It
applies only to the `ADMIN` address and only while no user has a verified email
— as soon as you sign in, it stops and mail must be configured properly. The
code is still single-use, 10-minute and rate limited.

After that first sign-in: set a password, turn on TOTP (mandatory for
administrators), then configure Resend, GitHub OAuth and object storage in
`/admin/settings`.

---

## 1. What works on Workers, and what does not

| Component | On Workers | Notes |
| --- | --- | --- |
| Next.js App Router (SSR, Server Actions, Route Handlers) | Yes | Via OpenNext |
| `node:crypto` — scrypt, AES-256-GCM, HMAC | Yes | Requires `nodejs_compat` |
| TOTP (`otpauth`) | Yes | Pure TypeScript, no native code |
| PostgreSQL via Hyperdrive | Yes | See §3 |
| JMAP from the browser | Yes | The browser talks to upstream directly |
| IMAP/SMTP from the server | **No** | Workers has no raw TCP sockets |
| Node.js Middleware | **No** | See §2 — it is not a security boundary anyway |

**The IMAP/SMTP trade-off, stated plainly.** Workers cannot open a TCP socket, so
`imapflow` and `nodemailer` cannot run there. Rather than fake it, Henna scopes
the fallback honestly:

- On **Workers**, JMAP is the supported path. The IMAP/SMTP option is hidden, and
  the UI says why.
- On **self-hosted Node.js**, both paths are available, SMTP is restricted to
  587/465, and port 25 is refused outright.

`lib/mail/protocol.ts` exposes `supportsImapFallback(runtime)` so this decision
lives in one place.

## 2. Why Middleware is not the gate

Next.js Node.js middleware does not run on Workers. Henna never relied on it for
security, which is why this is a non-issue rather than a migration:

- Every protected Server Action, Route Handler and Server Component calls a DAL
  guard (`requirePrincipal`, `requireAdmin`, `requireOwnershipOrAdmin`).
- `middleware.ts` exists only for optimistic redirects — it saves an
  authenticated visitor a wasted render. Delete it and security is unchanged.

This is worth repeating for anyone reviewing the code: **if you find an access
control that only exists in middleware, it is a bug.**

## 3. Hyperdrive

Workers cannot use a long-lived `pg` pool the way Node.js can, so Henna connects
through Hyperdrive.

```bash
npx wrangler hyperdrive create henna-db \
  --connection-string="postgres://user:pass@db.example.com:5432/henna"
```

Put the returned ID into `wrangler.jsonc`:

```jsonc
"hyperdrive": [
  {
    "binding": "HYPERDRIVE",
    "id": "<HYPERDRIVE_CONFIG_ID>"
  }
]
```

Henna reads `env.HYPERDRIVE.connectionString` and, critically, **never calls
`pool.end()`** — the platform owns the socket lifecycle. `db/index.ts` switches
between Hyperdrive and `DATABASE_URL` with one factory function.

## 4. `wrangler.jsonc`

```jsonc
{
  "name": "henna",
  "main": ".open-next/worker.js",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "vars": {
    "DOMAIN": "[\"example.com\"]",
    "ADMIN": "root@example.com",
    "HENNA_TRUST_PROXY": "1"
  },
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<HYPERDRIVE_CONFIG_ID>" }]
}
```

`compatibility_date` must be **2024-09-23 or later**, and `nodejs_compat` must be
on — without it, `node:crypto`'s scrypt is unavailable and every password
operation fails.

## 5. Workers secrets

Plain variables go in `vars`. Secrets never do:

```bash
npx wrangler secret put jwt_secret
npx wrangler secret put HENNA_CREDENTIAL_KEY
# Optional if you will configure them in /admin/settings:
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put RESEND_API_KEY
```

Values pasted here are encrypted by Cloudflare and injected at runtime. They are
not in your repository and not in your build output.

## 6. Resend and DNS

1. Add your sending domain in Resend.
2. Add the DNS records it gives you:
   - **SPF** — a `TXT` record authorising Resend.
   - **DKIM** — a `CNAME` (or `TXT`) record for the selector Resend specifies.
   - **DMARC** — a `TXT` record at `_dmarc`, starting at `p=none` and tightening
     once you have confirmed legitimate mail is aligned.
3. Wait for verification (usually a few minutes, occasionally a few hours).
4. Put the API key and `From` address in `/admin/settings`.

Henna displays the upstream SPF/DKIM/DMARC verdicts on incoming messages and does
not soften a failure. That display is only as good as your domain's records —
with no DMARC policy, there is no policy to pass.

## 7. GitHub Actions pipeline

`.github/workflows/deploy.yml` runs on every push to `main`:

```
install → tsc --noEmit → biome → unit tests → Playwright E2E
                                                    ↓ (only if green)
                                    opennextjs-cloudflare build → wrangler deploy
```

The `deploy` job declares `needs: quality`. A failed typecheck, a lint error or a
red test means nothing ships.

**Two different "API tokens" exist here, and mixing them up is the usual
mistake.** One deploys the app (a Cloudflare API token, stored as a GitHub
secret). The other lets Henna read and write attachments (an R2 S3 token,
entered in `/admin/settings`). They are created in different places and need
different permissions.

#### a) Cloudflare API token — used by `wrangler deploy` in CI

Do **not** use the *Edit Cloudflare Workers* template. It covers Workers
Scripts but **not D1 or R2**, so the deploy fails halfway: the Worker uploads
and then cannot create the database or the bucket.

Create a **custom token** (*My Profile → API Tokens → Create Custom Token*)
with:

| Scope | Permission | Why |
| --- | --- | --- |
| Account | `Workers Scripts:Edit` | Upload the Worker bundle |
| Account | `D1:Edit` | Create `henna-db` and apply migrations |
| Account | `Workers R2 Storage:Edit` | Create the `henna-attachments` bucket |
| Account | `Workers Observability:Edit` | `observability` is enabled in `wrangler.jsonc` |
| Account | `Account Settings:Read` | Read account metadata during deploy |
| User | `User Details:Read` | `wrangler` verifies the token |
| Zone | `Workers Routes:Edit` | Only if you attach a custom domain |

Leave everything else off. In particular, no `D1:Delete`, no
`Workers R2 Storage:Delete`, and no billing permission — a CI token that can
destroy data is a bad trade for convenience.

> **You do not need to run `wrangler d1 migrations apply`.** Henna creates its
> schema on the first request (see `ensureSchema()` in `db/index.ts`), and every
> statement is `IF NOT EXISTS`. Running the migration explicitly is still
> recommended in CI, but skipping it does not leave you with a broken instance.

#### b) R2 token — used by Henna at runtime for attachments

Created in *R2 → Manage R2 API tokens*, **not** under *My Profile*:

| Setting | Value | Why |
| --- | --- | --- |
| Permissions | `Object Read & Write` | PUT and GET objects; that is all presigning needs |
| — not — | `Admin Read & Write` | Would allow creating and deleting buckets |
| Bucket scope | `henna-attachments` only | One bucket, nothing else in the account |

`Object Read & Write` can put, get and delete objects. It cannot list buckets,
cannot create or destroy one, and cannot touch another bucket. That is exactly
the surface Henna needs, and nothing more.

**Repository secrets** (*Settings → Secrets and variables → Actions*):

| Secret | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Yes | Deployment credential, CI only |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Target account |
| `DOMAIN` | Yes | JSON array of mail domains |
| `ADMIN` | Yes | Bootstrap administrator |
| `JWT_SECRET` | Yes | Session signing key |
| `HENNA_CREDENTIAL_KEY` | Yes | Credential encryption key |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | No | Use `/admin/settings` instead |
| `RESEND_API_KEY` / `HENNA_EMAIL_FROM` | No | Use `/admin/settings` instead |

The deployment step uses `cloudflare/wrangler-action@v4`.

## 8. First boot on Workers

1. Visit `https://your-worker.workers.dev/api/health`. A `503` with an `issues`
   array tells you exactly which root variable is missing.
2. Fix it, redeploy, refresh. You want `"status": "ok"`.
3. Sign in as `ADMIN` with an email code, set a password, enable TOTP.
4. Configure GitHub OAuth and Resend in `/admin/settings`.
5. Set `AUTH_URL` to your real origin — the GitHub callback URL is derived from
   it and must match the OAuth app exactly.

## 9. Local development against Workers

```bash
cp .dev.vars.example .dev.vars   # fill in
npm run preview                  # opennextjs-cloudflare build && wrangler dev
```

`wrangler dev` runs the Worker locally with bindings, so you can exercise the
Hyperdrive path before deploying. For pure UI work, `npm run dev` (plain Next.js)
is faster.

## 10. Rollback

Workers keeps previous deployments. To roll back, re-run the workflow from an
earlier commit, or deploy a known-good build:

```bash
git checkout <known-good-sha>
npm run deploy
```

If the bad deployment involved a credential key change, remember that rolling
back the *code* does not roll back the *key*. Keep the previous key in
`HENNA_CREDENTIAL_KEY` until you are sure you do not need to roll back.
