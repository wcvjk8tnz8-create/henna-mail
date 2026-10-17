import { z } from "zod";

/**
 * Storage configuration.
 *
 * Henna talks to object storage through one abstraction with two faces:
 *
 *  - **Cloudflare R2** — same S3 wire protocol, region is always `auto`, and the
 *    endpoint is `https://<account-id>.r2.cloudflarestorage.com`. R2 has no
 *    egress fee, which is why it is the default recommendation.
 *  - **Any S3-compatible service** — AWS S3, MinIO, Backblaze B2, Ceph,
 *    Hetzner, Wasabi. Same signing code, different endpoint and region.
 *
 * The bucket credentials are secrets and are stored encrypted. Everything in
 * this file is pure: no database, no network.
 */

export const storageProviderSchema = z.enum(["r2", "s3"]);
export type StorageProvider = z.infer<typeof storageProviderSchema>;

/** An origin, and nothing else: scheme plus host, no path, no trailing slash. */
export const originSchema = z
  .string()
  .trim()
  .max(512)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Endpoint must be a full URL" });
      return;
    }
    if (url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "Endpoint must use https" });
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      ctx.addIssue({ code: "custom", message: "Endpoint must be an origin with no path" });
    }
  });

/** Cloudflare account ids are 32 hex characters. */
export const r2AccountIdSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[a-f0-9]{32}$/i, "R2 account id must be 32 hexadecimal characters");

export const bucketNameSchema = z
  .string()
  .trim()
  .min(3, "Bucket name must be at least 3 characters")
  .max(63, "Bucket name must be at most 63 characters")
  .regex(
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
    "Bucket names allow lowercase letters, digits, dots and hyphens only",
  );

export const storageConfigSchema = z.object({
  provider: storageProviderSchema.default("r2"),
  enabled: z.boolean().default(false),

  /** Explicit origin. When empty, R2 derives it from the account id. */
  endpoint: originSchema.nullable().default(null),
  /** Used to derive the R2 endpoint when `endpoint` is empty. */
  r2AccountId: r2AccountIdSchema.nullable().default(null),
  /** `auto` for R2; the real region for S3 and most S3-compatible services. */
  region: z.string().trim().min(2).max(64).default("auto"),
  bucket: bucketNameSchema.nullable().default(null),

  /** Stored encrypted; never returned inside a settings payload as plaintext. */
  accessKeyId: z.string().trim().max(256).nullable().default(null),
  secretAccessKey: z.string().max(256).nullable().default(null),

  /** R2 and MinIO are path-style; AWS S3 prefers virtual-host style. */
  forcePathStyle: z.boolean().default(true),

  /** Advisory cap enforced when an upload URL is issued. */
  maxUploadBytes: z.number().int().min(1024).max(5368709120).default(26214400),
  /** Presigned URLs should be short-lived: long enough to upload, not to share. */
  signedUrlTtlSeconds: z.number().int().min(30).max(3600).default(300),

  /** Optional CDN or custom domain in front of the bucket, for public reads. */
  publicBaseUrl: originSchema.nullable().default(null),
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;

/** Parsed once so nested defaults are materialised rather than left empty. */
export const DEFAULT_STORAGE_CONFIG: StorageConfig = storageConfigSchema.parse({
  provider: "r2",
  enabled: false,
  endpoint: null,
  r2AccountId: null,
  region: "auto",
  bucket: null,
  accessKeyId: null,
  secretAccessKey: null,
  forcePathStyle: true,
  maxUploadBytes: 26214400,
  signedUrlTtlSeconds: 300,
  publicBaseUrl: null,
});

/** The endpoint to sign against, or null when it cannot be determined. */
export function resolveStorageEndpoint(config: StorageConfig): string | null {
  if (config.endpoint) return config.endpoint;
  if (config.provider === "r2" && config.r2AccountId) {
    return `https://${config.r2AccountId}.r2.cloudflarestorage.com`;
  }
  return null;
}

/**
 * Whether uploads and downloads can actually be signed.
 *
 * Every field is required: an enabled switch with no bucket is a
 * misconfiguration, and Henna reports it rather than failing per request.
 */
export function isStorageReady(config: StorageConfig): boolean {
  return (
    config.enabled &&
    Boolean(config.bucket) &&
    Boolean(config.accessKeyId) &&
    Boolean(config.secretAccessKey) &&
    resolveStorageEndpoint(config) !== null
  );
}

/** Why the configuration is not usable, for the admin UI and /api/health. */
export function storageConfigIssues(config: StorageConfig): readonly string[] {
  if (!config.enabled) return ["storage is disabled"];
  const issues: string[] = [];
  if (!config.bucket) issues.push("bucket is not set");
  if (!config.accessKeyId) issues.push("access key id is not set");
  if (!config.secretAccessKey) issues.push("secret access key is not set");
  if (resolveStorageEndpoint(config) === null) {
    issues.push("endpoint is unknown: set it directly, or provide the R2 account id");
  }
  return issues;
}

/** R2 ignores region for signing purposes but still expects a value. */
export function effectiveRegion(config: StorageConfig): string {
  return config.provider === "r2" ? "auto" : config.region;
}

/**
 * A partial update submitted from the admin form.
 *
 * The bucket credentials are typed as plain strings here because they arrive
 * from a form; the DAL encrypts them before anything is written.
 */
export const storageConfigPatchSchema = z.object({
  provider: storageProviderSchema.optional(),
  enabled: z.boolean().optional(),
  endpoint: originSchema.nullable().optional(),
  r2AccountId: r2AccountIdSchema.nullable().optional(),
  region: z.string().trim().min(2).max(64).optional(),
  bucket: bucketNameSchema.nullable().optional(),
  accessKeyId: z.string().trim().max(256).optional(),
  secretAccessKey: z.string().max(256).optional(),
  forcePathStyle: z.boolean().optional(),
  maxUploadBytes: z.number().int().min(1024).max(5368709120).optional(),
  signedUrlTtlSeconds: z.number().int().min(30).max(3600).optional(),
  publicBaseUrl: originSchema.nullable().optional(),
});

export type StorageConfigPatch = z.infer<typeof storageConfigPatchSchema>;
