# Attachment storage (R2 and S3-compatible)

**[English](storage.md) | [简体中文](storage.zh-CN.md)**

Henna stores attachments in object storage. **Cloudflare R2** is the default
recommendation; **any S3-compatible service** works too. One implementation
covers both, because both speak the same presigned SigV4 protocol.

---

## The rule this design protects

> Henna's server never handles an attachment. It signs a URL; the browser moves
> the bytes.

This is not a policy statement — it is the shape of the code. There is no
function that accepts a file body, no buffer that holds one, and no column that
could. The server sees a filename and a size, and that is all.

```
Browser ──PUT (presigned)──► R2 / S3 bucket        ← attachment bytes
   │
   └──Server Action──► Henna server ──► sign URL, write audit row
                            │
                            └──► PostgreSQL (key, size, type — never content)
```

## Supported backends

| Backend | Endpoint | Region | Path style |
| --- | --- | --- | --- |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | Yes |
| AWS S3 | `https://s3.<region>.amazonaws.com` | real region | No (virtual-host) |
| MinIO | `https://minio.example.com` | usually `us-east-1` | Yes |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | real region | Yes |
| Hetzner / Wasabi / Ceph | as provided | as provided | Usually yes |

"Path style" means the bucket is in the URL path (`/bucket/key`) rather than the
hostname. R2 and MinIO require it; AWS S3 prefers virtual-host style.

## How an upload works

1. The browser calls a Server Action with a **filename and a size only**.
2. `requirePrincipal()` authorises the caller.
3. The DAL checks the size against the instance cap and applies a rate limit.
4. A key is generated server-side as
   `users/<userId>/attachment/<uuid>/<safe-filename>`. The caller cannot choose
   it, so a filename can never steer a write into someone else's namespace.
5. A PUT URL is signed with a short lifetime (default 300 s).
6. The browser PUTs the file directly to the bucket with the required headers.
7. The event is written to the audit log: who, what size, what type, when.

Downloads are the same in reverse: the DAL looks up the row, checks that the key
sits under the caller's prefix, and signs a short-lived GET.


## Which token is which, and what each may do

Three tokens appear in a Henna deployment. They are created in different places
and must not be substituted for one another.

| Token | Created in | Given to | Minimum permission |
| --- | --- | --- | --- |
| Cloudflare API token | *My Profile → API Tokens* | GitHub Actions (`CLOUDFLARE_API_TOKEN`) | `Workers Scripts:Edit`, `D1:Edit`, `Workers R2 Storage:Edit`, `Workers Observability:Edit`, `Account Settings:Read`, `User Details:Read` |
| R2 S3 token | *R2 → Manage R2 API tokens* | `/admin/settings → Object storage` | `Object Read & Write`, scoped to one bucket |
| JMAP API token | Your own mail server | `/settings → Mail accounts` | Mail read + submission for one account |

### The R2 token in detail

| Setting | Value | Why |
| --- | --- | --- |
| Permissions | `Object Read & Write` | Presigned URLs need put, get and delete on objects — nothing else |
| — not — | `Admin Read & Write` | Would allow creating and deleting buckets |
| Bucket scope | One bucket only | A token scoped to one bucket cannot reach any other |

What `Object Read & Write` can and cannot do, worth knowing before you grant it:

- **Can**: `PutObject`, `GetObject`, `DeleteObject`, `HeadObject`, `ListObjects`
  inside the bucket it is scoped to.
- **Cannot**: list buckets, create or delete a bucket, read or write another
  bucket, change bucket settings.

That is precisely the surface Henna's presigning flow uses. If a provider only
offers an all-buckets token, scope it yourself by creating a dedicated bucket for
Henna and never reusing that key elsewhere.

### The JMAP token

Henna does not define this one — your mail server does, and it is worth checking
what yours grants. Henna needs the `core`, `mail` and `submission` capabilities,
and nothing more:

- **Read** mailboxes and messages (for the inbox, and for local indexing).
- **Submit** messages (for sending).
- **Not** account administration, not other users' mail, not vacation or sieve
  management.

Issue a per-account token rather than a server-wide one, and revoke it by
deleting the credential in `/settings` — the upstream token dies with it.

## Setting up Cloudflare R2

1. *Cloudflare dashboard → R2 → Create bucket*. Note the bucket name.
2. *R2 → Manage R2 API tokens → Create API token*.
3. Give it **Object Read & Write**, scoped to that one bucket. Not admin.
4. Copy the Access Key ID and Secret Access Key — they are shown once.
5. In Henna, open `/admin/settings → Object storage`:
   - Provider: **Cloudflare R2**
   - Account ID: your 32-character Cloudflare account id (the endpoint is
     derived from it), or set the endpoint explicitly
   - Bucket, Access Key ID, Secret Access Key
   - Leave **Path-style URLs** ticked

### CORS

The browser uploads cross-origin, so the bucket needs a CORS rule. Allow your
Henna origin, and the methods `PUT` and `GET`:

```json
[
  {
    "AllowedOrigins": ["https://mail.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

`AllowedHeaders: ["*"]` is safe here because the request is authenticated by the
signature in the URL, not by the headers.

## Setting up an S3-compatible service

Provider: **S3-compatible**. Then:

- **Endpoint** — the origin only, no path, e.g. `https://minio.example.com`.
- **Region** — the region your service expects. MinIO defaults to `us-east-1`;
  R2 is always `auto` and ignores it.
- **Path style** — on for MinIO and most self-hosted services, off for AWS S3.
- **Bucket and credentials** — as provided by the service.

## The CSP prerequisite, and why it exists

Henna's Content-Security-Policy is emitted **statically**, because Cloudflare
Workers has no per-request middleware to build it in. `connect-src` therefore
needs to know your bucket origin at build time:

```env
# Either list the origin directly...
HENNA_STORAGE_ORIGINS=https://<account>.r2.cloudflarestorage.com

# ...or give the account id and let Henna derive it.
HENNA_R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef
```

If you configure storage **only** through `/admin/settings`, set one of these
and redeploy — otherwise the browser will refuse to reach the bucket, and the
upload will fail with a CSP error in the console. This is the one place where
storage configuration touches the build, and it is called out in both
[cloudflare-deployment.md](cloudflare-deployment.md) and
[self-hosting.md](self-hosting.md).

## What is enforced

| Control | Where |
| --- | --- |
| Ownership: key must start with `users/<userId>/` | `keyBelongsToUser`, checked twice |
| Path traversal and absolute keys rejected | `isValidObjectKey` |
| Filename sanitised (separators, control chars, leading dots) | `sanitizeFilename` |
| Content type validated against a strict grammar | `isSafeContentType` — a newline would be header injection into the signed request |
| Size cap per instance | `maxUploadBytes`, checked before signing |
| Rate limit on URL issuance | `RATE_LIMIT_RULES.storageUrl` |
| Audit on every grant and denial | `storage.*` audit actions |
| Credentials encrypted at rest | AES-256-GCM, dedicated columns |

## Secrets and rotation

The Access Key ID and Secret Access Key are encrypted with the same
`HENNA_CREDENTIAL_KEY` keyring as mail credentials. Rotating that key
re-encrypts them along with everything else — see
[self-hosting.md](self-hosting.md#9-rotating-henna_credential_key).

Rotating the **bucket** credentials is independent: create a new token in R2 or
your S3 provider, paste it into `/admin/settings`, and revoke the old one. The
change is audited (the values never are).

## Known limitations

1. **The size cap is advisory at the protocol level.** A query-string presigned
   URL cannot carry a `content-length-range` condition; enforcing that properly
   needs a presigned POST policy. The cap is checked when the URL is issued and
   by the client, so an ordinary upload is bounded — but a hand-crafted request
   against a valid URL could exceed it until the row is reconciled.
2. **A presigned URL is a capability.** Anyone holding one can use it until it
   expires. Lifetimes are short by default (300 s), and they are never logged.
3. **Deleting an account deletes the metadata, and Henna issues a DELETE for the
   object.** If the bucket is unreachable at that moment the row is still
   removed and the audit records the failure, so an orphan may remain.
4. **CORS is your responsibility.** Henna cannot configure the bucket for you.

## Applying the migration

```bash
psql "$DATABASE_URL" -f db/migrations/0001_storage.sql
```

It adds `storage_config` (one row, encrypted credentials) and `storage_objects`
(key, size, type — no content).
