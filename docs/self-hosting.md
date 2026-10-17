# Self-hosting Henna

**[English](self-hosting.md) | [简体中文](self-hosting.zh-CN.md)**

This guide covers running Henna on your own Node.js host. For Cloudflare
Workers, see [cloudflare-deployment.md](cloudflare-deployment.md).

---

## 1. What you need

- Node.js 20.9 or newer.
- PostgreSQL 14 or newer.
- A TLS certificate in front of Henna (Caddy, nginx, or a platform ingress).
  Henna sets `Secure` cookies and HSTS in production, so it expects HTTPS.
- An outbound connection to your upstream mail server (JMAP over HTTPS, or
  IMAP/SMTP on 993/587/465).
- Optionally: a Resend account, for email codes and password resets.

## 2. Configuration layers

Henna splits configuration in two, deliberately.

**Root configuration — environment only, never editable in the UI.**
These four define the instance itself. Missing or malformed, Henna refuses to
start and tells you exactly which one is wrong.

| Variable | Format | Why it is environment-only |
| --- | --- | --- |
| `DOMAIN` | JSON array, e.g. `["example.com","example2.com"]` | Decides which addresses this instance serves |
| `ADMIN` | Email address | Bootstraps the first administrator |
| `jwt_secret` | Letters and digits only, no punctuation | Signs session tokens. Also seeds the credential key when `HENNA_CREDENTIAL_KEY` is unset — `openssl rand -hex 24` is recommended, though not enforced. |
| `HENNA_CREDENTIAL_KEY` | base64 of 32 random bytes (comma-separated list during rotation) | Encrypts stored secrets |

**Instance configuration — database-backed, editable at `/admin/settings`.**
Authentication switches, GitHub OAuth credentials, Resend settings, TOTP policy,
registration control, password rules, code lifetimes, transitions. Secrets here
are AES-256-GCM encrypted in their own columns before they are written.

The split matters: root values cannot be changed by someone who compromises an
administrator session, because changing them requires a redeploy.

## 3. Environment variables

```env
# --- Root (required) --------------------------------------------------------
DOMAIN=["example.com"]
ADMIN=root@example.com
jwt_secret=anyRandomLettersAndDigits
HENNA_CREDENTIAL_KEY=base64-of-32-random-bytes

# --- Database ---------------------------------------------------------------
DATABASE_URL=postgresql://henna:henna@localhost:5432/henna

# --- Public origin ----------------------------------------------------------
AUTH_URL=https://mail.example.com
AUTH_SECRET=a-long-random-string-for-authjs

# --- Optional: set here, or later in /admin/settings ------------------------
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
RESEND_API_KEY=
HENNA_EMAIL_FROM=Henna <no-reply@example.com>
HENNA_REGISTRATION_MODE=closed
HENNA_TOTP_POLICY=admin-only
```

Rules that are enforced, not just advised:

- `jwt_secret` accepts letters and digits only. Special characters break CI
  secret stores and shell quoting; refusing them removes the whole class of bug.
- No `NEXT_PUBLIC_*` variable may contain a secret. Henna checks this at boot and
  refuses to start if one does.
- `DATABASE_URL`, `jwt_secret`, `GITHUB_CLIENT_SECRET` and
  `HENNA_CREDENTIAL_KEY` are read server-side only.

## 4. Which values are secret

| Value | Secret? | If it leaks |
| --- | --- | --- |
| `jwt_secret` | **Yes** | Session forgery. Rotate immediately; all sessions die. |
| `HENNA_CREDENTIAL_KEY` | **Yes** | Stored credentials become readable. Rotate and re-encrypt. |
| `GITHUB_CLIENT_SECRET` | **Yes** | OAuth impersonation. Rotate in GitHub, then update settings. |
| `RESEND_API_KEY` | **Yes** | Sending abuse. Rotate in Resend. |
| `DATABASE_URL` | **Yes** | Full read access to accounts and the audit log. |
| `ADMIN` | No | It is just an address. |
| `DOMAIN` | No | Public information. |
| `GITHUB_CLIENT_ID` | No | Public by design. |

## 5. Database setup

```bash
createdb henna
psql "$DATABASE_URL" -f db/migrations/0000_init.sql
# or, once the app can connect:
npm run db:migrate
```

Then grant the application role the minimum it needs. The audit log is
append-only, and the database enforces it with a trigger — but the role should
not hold the permission anyway:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO henna_app;
REVOKE UPDATE, DELETE ON audit_log FROM henna_app;
```

First boot creates the administrator named by `ADMIN`, if that account does not
already exist. It never changes the role of an account that does.

## 6. TLS

Henna relies on the platform in front of it for TLS. Behind a proxy:

- Forward `X-Forwarded-For`. Henna trusts it only when `HENNA_TRUST_PROXY=1`,
  which you must set deliberately — otherwise client IP hashing falls back to
  null and rate limiting degrades to per-account only.
- Do **not** terminate TLS and then speak HTTP internally if you can avoid it.
  HSTS and `Secure` cookies are only emitted when `NODE_ENV=production`.

## 7. GitHub OAuth app

1. *GitHub → Settings → Developer settings → OAuth Apps → New OAuth App*.
2. **Homepage URL**: `https://mail.example.com`
3. **Authorization callback URL**:
   `https://mail.example.com/api/auth/callback/github` — exact, including the
   path. GitHub compares it literally.
4. Copy the client ID and generate a client secret.
5. Put them in `/admin/settings` (preferred, encrypted at rest) or in the
   environment.

Henna uses the authorization code flow. It sends a `state` parameter and compares
it in constant time on the way back. If your deployment has verified end-to-end
PKCE support, Henna can send `code_challenge` — it will never send one it cannot
verify, because a PKCE parameter the server ignores is worse than none.

## 8. Resend

1. Add and verify your sending domain in Resend (SPF, DKIM and a DMARC record).
2. Create an API key.
3. Put the key and the `From` address in `/admin/settings`.

Codes are delivered server-side. The API key never reaches a browser.

## 9. Rotating `HENNA_CREDENTIAL_KEY`

Rotation is three steps, and the UI tells you when you are done.

```bash
# 1. Prepend a new key, keeping the old one for reading.
#    The FIRST key encrypts; every key can decrypt.
NEW=$(openssl rand -base64 32)
HENNA_CREDENTIAL_KEY="$NEW,$OLD_KEY"
```

Redeploy, then open `/admin/settings → Key rotation` and press **Re-encrypt**.
The report tells you how many rows moved and how many were already current.

```bash
# 3. Once nothing remains on the old key, drop it.
HENNA_CREDENTIAL_KEY="$NEW"
```

Do not skip step 3 too early: removing a key before re-encrypting makes those
rows permanently unreadable, and Henna reports them as `tampered` rather than
guessing.

If `jwt_secret` leaks, rotate it too — every session is invalidated, which is
exactly what you want.

## 10. Backups

Back up the database. That is the whole state:

```bash
pg_dump --format=custom --file=henna-$(date +%F).dump "$DATABASE_URL"
```

There is no mail to back up, because there is no mail on the server.

To restore:

```bash
createdb henna_restored
pg_restore --dbname=henna_restored henna-2026-01-01.dump
```

The dump contains encrypted credentials and TOTP secrets. Restoring it without
the matching `HENNA_CREDENTIAL_KEY` gives you an instance where every credential
decryption fails loudly — by design, not by accident. Store dumps encrypted.

## 11. After deployment

1. Sign in as `ADMIN` with an email code.
2. Set a password and enable TOTP. Administrators must.
3. Save your recovery codes somewhere that is not the same device as your
   authenticator.
4. Open `/admin/settings` and set the registration mode. The default is
   `closed`, which is the safe one.
5. Check `/api/health` — it reports missing root configuration instead of
   crashing.
