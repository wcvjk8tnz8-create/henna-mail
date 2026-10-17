import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { storageConfig, storageObjects } from "@/db/schema";
import { getKeyring } from "@/lib/crypto/keyring";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { consumeRateLimit, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import type { RequestContext } from "@/lib/request";
import { AuthzError } from "./types";
import type { Principal } from "./types";
import {
  DEFAULT_STORAGE_CONFIG,
  effectiveRegion,
  isStorageReady,
  resolveStorageEndpoint,
  storageConfigIssues,
  type StorageConfig,
} from "@/lib/storage/config";
import { isSafeContentType, presign, type PresignedRequest } from "@/lib/storage/presign";
import { buildObjectKey, keyBelongsToUser, sanitizeFilename, type StoragePurpose } from "@/lib/storage/keys";

/**
 * Object storage data access.
 *
 * The rule this module exists to protect: **the server never sees an
 * attachment.** It mints a short-lived presigned URL and hands it to the
 * browser, which talks to the bucket directly. The bytes travel
 * browser <-> R2 (or S3), never through Henna.
 *
 * That is why every function below is about *authorising* a key rather than
 * moving data, and why each one writes an audit record: a presigned URL is a
 * capability, and capabilities need to be traceable.
 */

/* ------------------------------------------------------------ configuration */

/** Read and decrypt the bucket configuration. Internal; no authorisation. */
export async function readStorageConfig(): Promise<StorageConfig> {
  const db = getDb();
  const [row] = await db.select().from(storageConfig).where(eq(storageConfig.id, 1));
  if (!row) return DEFAULT_STORAGE_CONFIG;

  const keyring = getKeyring();
  return {
    provider: row.provider === "s3" ? "s3" : "r2",
    enabled: row.enabled === 1,
    endpoint: row.endpoint,
    r2AccountId: row.r2AccountId,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.accessKeyIdEnc
      ? keyring.decrypt(row.accessKeyIdEnc, "storage_access_key_id")
      : null,
    secretAccessKey: row.secretAccessKeyEnc
      ? keyring.decrypt(row.secretAccessKeyEnc, "storage_secret_access_key")
      : null,
    forcePathStyle: row.forcePathStyle === 1,
    maxUploadBytes: row.maxUploadBytes,
    signedUrlTtlSeconds: row.signedUrlTtlSeconds,
    publicBaseUrl: row.publicBaseUrl,
  };
}

export interface StorageStatus {
  readonly provider: string;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly bucket: string | null;
  readonly endpoint: string | null;
  readonly maxUploadBytes: number;
  readonly issues: readonly string[];
  readonly credentialsSet: boolean;
}

/**
 * Status for the admin UI and /api/health.
 *
 * Deliberately omits everything secret: whether credentials are configured is
 * reported as a boolean, never as the values themselves.
 */
export async function getStorageStatus(): Promise<StorageStatus> {
  const config = await readStorageConfig();
  return {
    provider: config.provider,
    enabled: config.enabled,
    ready: isStorageReady(config),
    bucket: config.bucket,
    endpoint: resolveStorageEndpoint(config),
    maxUploadBytes: config.maxUploadBytes,
    issues: storageConfigIssues(config),
    credentialsSet: Boolean(config.accessKeyId && config.secretAccessKey),
  };
}

/** Public, unauthenticated shape: is storage on, and how big may a file be. */
export async function getPublicStorageStatus(): Promise<{
  readonly enabled: boolean;
  readonly maxUploadBytes: number;
}> {
  const config = await readStorageConfig();
  return {
    enabled: isStorageReady(config),
    maxUploadBytes: config.maxUploadBytes,
  };
}

export interface StorageConfigPatch {
  readonly provider?: "r2" | "s3";
  readonly enabled?: boolean;
  readonly endpoint?: string | null;
  readonly r2AccountId?: string | null;
  readonly region?: string;
  readonly bucket?: string | null;
  /** Present only when the admin typed a new one; absent means "keep". */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
  readonly maxUploadBytes?: number;
  readonly signedUrlTtlSeconds?: number;
  readonly publicBaseUrl?: string | null;
}

/** Update bucket configuration. Administrator only; secrets are encrypted. */
export async function updateStorageConfig(
  actor: Principal,
  patch: StorageConfigPatch,
  context: RequestContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (actor.role !== "admin") {
    await writeAudit({
      action: AUDIT_ACTIONS.STORAGE_CONFIG_UPDATED,
      result: "denied",
      actorId: actor.userId,
      actorEmail: actor.email,
      actorRole: actor.role,
      resourceType: "storage",
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { reason: "not-admin" },
    });
    return { ok: false, reason: "Administrator access is required" };
  }

  const db = getDb();
  const keyring = getKeyring();
  const current = await readStorageConfig();

  const secretPatch: Record<string, unknown> = {};
  if (patch.accessKeyId !== undefined) {
    secretPatch.accessKeyIdEnc = patch.accessKeyId
      ? keyring.encrypt(patch.accessKeyId, "storage_access_key_id")
      : null;
    secretPatch.accessKeyIdKeyId = patch.accessKeyId ? keyring.activeKeyId : null;
  }
  if (patch.secretAccessKey !== undefined) {
    secretPatch.secretAccessKeyEnc = patch.secretAccessKey
      ? keyring.encrypt(patch.secretAccessKey, "storage_secret_access_key")
      : null;
    secretPatch.secretAccessKeyKeyId = patch.secretAccessKey ? keyring.activeKeyId : null;
  }

  const values: Record<string, unknown> = {
    provider: patch.provider ?? current.provider,
    enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
    endpoint: patch.endpoint !== undefined ? patch.endpoint : current.endpoint,
    r2AccountId: patch.r2AccountId !== undefined ? patch.r2AccountId : current.r2AccountId,
    region: patch.region ?? current.region,
    bucket: patch.bucket !== undefined ? patch.bucket : current.bucket,
    forcePathStyle: (patch.forcePathStyle ?? current.forcePathStyle) ? 1 : 0,
    maxUploadBytes: patch.maxUploadBytes ?? current.maxUploadBytes,
    signedUrlTtlSeconds: patch.signedUrlTtlSeconds ?? current.signedUrlTtlSeconds,
    publicBaseUrl: patch.publicBaseUrl !== undefined ? patch.publicBaseUrl : current.publicBaseUrl,
    updatedBy: actor.userId,
    updatedAt: new Date(),
    ...secretPatch,
  };

  await db
    .insert(storageConfig)
    .values({ id: 1, ...values } as never)
    .onConflictDoUpdate({ target: storageConfig.id, set: values });

  await writeAudit({
    action: AUDIT_ACTIONS.STORAGE_CONFIG_UPDATED,
    result: "success",
    actorId: actor.userId,
    actorEmail: actor.email,
    actorRole: actor.role,
    resourceType: "storage",
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: {
      // Which knobs moved, never their values: the bucket credentials are the
      // crown jewels of this table.
      changed: Object.keys(patch).filter(
        (key) => key !== "accessKeyId" && key !== "secretAccessKey",
      ),
      credentialsUpdated:
        patch.accessKeyId !== undefined || patch.secretAccessKey !== undefined,
    },
  });

  return { ok: true };
}

/* ----------------------------------------------------------- presigning */

export interface StorageObjectDto {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly createdAt: Date;
}

function toDto(row: typeof storageObjects.$inferSelect): StorageObjectDto {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

export async function listStorageObjects(principal: Principal): Promise<readonly StorageObjectDto[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(storageObjects)
    .where(eq(storageObjects.userId, principal.userId))
    .orderBy(desc(storageObjects.createdAt));
  return rows.map(toDto);
}

export interface UploadGrant {
  readonly objectId: string;
  readonly key: string;
  readonly upload: PresignedRequest;
  readonly download: PresignedRequest;
}

/**
 * Issue an upload URL.
 *
 * The key is generated server-side under the caller's own prefix, so the
 * filename cannot steer the write into someone else's namespace, and the size
 * is checked against the instance cap before any signature is produced.
 */
export async function requestUploadUrl(
  principal: Principal,
  input: { readonly filename: string; readonly contentType: string; readonly sizeBytes: number },
  context: RequestContext,
): Promise<UploadGrant> {
  const config = await readStorageConfig();
  const deny = async (reason: string) => {
    await writeAudit({
      action: AUDIT_ACTIONS.STORAGE_URL_DENIED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      actorRole: principal.role,
      resourceType: "storage",
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { operation: "upload", reason },
    });
  };

  if (!isStorageReady(config)) {
    await deny("storage-not-configured");
    throw new AuthzError("forbidden", "Object storage is not configured on this instance");
  }

  const limit = await consumeRateLimit(RATE_LIMIT_RULES.storageUrl, principal.userId);
  if (!limit.allowed) {
    await deny("rate-limited");
    throw new AuthzError("forbidden", "Too many storage requests; slow down");
  }

  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    await deny("invalid-size");
    throw new AuthzError("forbidden", "That file size is not valid");
  }
  if (sizeBytes > config.maxUploadBytes) {
    await deny("too-large");
    throw new AuthzError(
      "forbidden",
      `That file exceeds the ${Math.floor(config.maxUploadBytes / 1048576)} MiB limit`,
    );
  }

  const contentType = isSafeContentType(input.contentType)
    ? input.contentType
    : "application/octet-stream";

  const endpoint = resolveStorageEndpoint(config);
  if (!endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    await deny("incomplete-configuration");
    throw new AuthzError("forbidden", "Object storage is not configured on this instance");
  }

  const filename = sanitizeFilename(input.filename);
  const key = buildObjectKey({ userId: principal.userId, purpose: "attachment", filename });
  const region = effectiveRegion(config);

  const [upload, download] = await Promise.all([
    presign({
      method: "PUT",
      endpoint,
      bucket: config.bucket,
      key,
      region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresInSeconds: config.signedUrlTtlSeconds,
      forcePathStyle: config.forcePathStyle,
      contentType,
    }),
    presign({
      method: "GET",
      endpoint,
      bucket: config.bucket,
      key,
      region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresInSeconds: config.signedUrlTtlSeconds,
      forcePathStyle: config.forcePathStyle,
    }),
  ]);

  const db = getDb();
  const [row] = await db
    .insert(storageObjects)
    .values({
      userId: principal.userId,
      objectKey: key,
      purpose: "attachment",
      filename,
      contentType,
      sizeBytes: Math.round(sizeBytes),
    })
    .returning();

  if (!row) throw new Error("Failed to record the storage object");

  await writeAudit({
    action: AUDIT_ACTIONS.STORAGE_UPLOAD_URL_ISSUED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    actorRole: principal.role,
    resourceType: "storage",
    resourceId: row.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: {
      // The key is recorded, not the bytes. Size and type only.
      contentType,
      sizeBytes: Math.round(sizeBytes),
      expiresInSeconds: config.signedUrlTtlSeconds,
    },
  });

  return { objectId: row.id, key, upload, download };
}

/**
 * Issue a download URL for one of the caller's own objects.
 *
 * Ownership is checked twice: once on the database row, and once on the key
 * itself, in case a row ever appears with a key outside its owner's prefix.
 */
export async function requestDownloadUrl(
  principal: Principal,
  objectId: string,
  context: RequestContext,
): Promise<PresignedRequest> {
  const config = await readStorageConfig();
  const deny = async (reason: string) => {
    await writeAudit({
      action: AUDIT_ACTIONS.STORAGE_URL_DENIED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      actorRole: principal.role,
      resourceType: "storage",
      resourceId: objectId,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { operation: "download", reason },
    });
  };

  if (!isStorageReady(config)) {
    await deny("storage-not-configured");
    throw new AuthzError("forbidden", "Object storage is not configured on this instance");
  }

  const limit = await consumeRateLimit(RATE_LIMIT_RULES.storageUrl, principal.userId);
  if (!limit.allowed) {
    await deny("rate-limited");
    throw new AuthzError("forbidden", "Too many storage requests; slow down");
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(storageObjects)
    .where(and(eq(storageObjects.id, objectId), eq(storageObjects.userId, principal.userId)));

  if (!row) {
    await deny("not-found-or-not-owner");
    throw new AuthzError("forbidden", "That object is not available");
  }

  if (!keyBelongsToUser(row.objectKey, principal.userId)) {
    await deny("key-outside-owner-prefix");
    throw new AuthzError("forbidden", "That object is not available");
  }

  const endpoint = resolveStorageEndpoint(config);
  if (!endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    await deny("incomplete-configuration");
    throw new AuthzError("forbidden", "Object storage is not configured on this instance");
  }

  const signed = await presign({
    method: "GET",
    endpoint,
    bucket: config.bucket,
    key: row.objectKey,
    region: effectiveRegion(config),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expiresInSeconds: config.signedUrlTtlSeconds,
    forcePathStyle: config.forcePathStyle,
  });

  await writeAudit({
    action: AUDIT_ACTIONS.STORAGE_DOWNLOAD_URL_ISSUED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    actorRole: principal.role,
    resourceType: "storage",
    resourceId: row.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: { expiresInSeconds: config.signedUrlTtlSeconds },
  });

  return signed;
}

/**
 * Delete an object: remove it from the bucket, then forget the row.
 *
 * The DELETE carries no body, so the server performing it does not contradict
 * the "no content through Henna" rule — and it means a deleted attachment is
 * actually gone rather than orphaned in the bucket.
 */
export async function deleteStorageObject(
  principal: Principal,
  objectId: string,
  context: RequestContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const config = await readStorageConfig();
  const db = getDb();
  const [row] = await db
    .select()
    .from(storageObjects)
    .where(and(eq(storageObjects.id, objectId), eq(storageObjects.userId, principal.userId)));

  if (!row || !keyBelongsToUser(row.objectKey, principal.userId)) {
    await writeAudit({
      action: AUDIT_ACTIONS.STORAGE_URL_DENIED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      actorRole: principal.role,
      resourceType: "storage",
      resourceId: objectId,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { operation: "delete", reason: "not-found-or-not-owner" },
    });
    return { ok: false, reason: "That object is not available" };
  }

  if (isStorageReady(config)) {
    const endpoint = resolveStorageEndpoint(config);
    if (endpoint && config.bucket && config.accessKeyId && config.secretAccessKey) {
      try {
        const signed = await presign({
          method: "DELETE",
          endpoint,
          bucket: config.bucket,
          key: row.objectKey,
          region: effectiveRegion(config),
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          expiresInSeconds: 60,
          forcePathStyle: config.forcePathStyle,
        });
        await fetch(signed.url, { method: "DELETE", cache: "no-store" });
      } catch {
        // The bucket may be unreachable or already cleaned up. The row is still
        // removed so the UI stays truthful; the orphan is noted in the audit.
        await writeAudit({
          action: AUDIT_ACTIONS.STORAGE_URL_DENIED,
          result: "error",
          actorId: principal.userId,
          actorEmail: principal.email,
          resourceType: "storage",
          resourceId: objectId,
          ipHash: context.ipHash,
          userAgentHash: context.userAgentHash,
          metadata: { operation: "delete", reason: "bucket-request-failed" },
        });
      }
    }
  }

  await db.delete(storageObjects).where(eq(storageObjects.id, objectId));

  await writeAudit({
    action: AUDIT_ACTIONS.STORAGE_OBJECT_DELETED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    actorRole: principal.role,
    resourceType: "storage",
    resourceId: objectId,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  });

  return { ok: true };
}

export type { StoragePurpose };
