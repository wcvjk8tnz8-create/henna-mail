"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requirePrincipal } from "@/lib/dal/guards";
import {
  deleteStorageObject,
  listStorageObjects,
  requestDownloadUrl,
  requestUploadUrl,
} from "@/lib/dal/storage";
import { buildRequestContext } from "@/lib/request";

/**
 * Attachment Server Actions.
 *
 * Authorisation comes from `requirePrincipal()`; the DAL then re-checks that the
 * object belongs to the caller before signing anything. The file itself is
 * uploaded by the browser straight to the bucket — it never passes through
 * Henna, which is why these functions accept a filename and a size rather than
 * a body.
 */

export interface UploadGrantResult {
  readonly ok: boolean;
  readonly message: string;
  readonly objectId?: string;
  /** The presigned URL the browser PUTs to. */
  readonly uploadUrl?: string;
  /** Headers the browser must send verbatim, or the signature will not match. */
  readonly uploadHeaders?: Readonly<Record<string, string>>;
}

export async function requestAttachmentUpload(input: {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}): Promise<UploadGrantResult> {
  const principal = await requirePrincipal();
  const context = buildRequestContext(await headers());

  try {
    const grant = await requestUploadUrl(principal, input, context);
    return {
      ok: true,
      message: "Upload URL issued.",
      objectId: grant.objectId,
      uploadUrl: grant.upload.url,
      uploadHeaders: grant.upload.requiredHeaders,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "That upload could not be started.",
    };
  }
}

export async function getAttachmentDownloadUrl(
  objectId: string,
): Promise<{ ok: boolean; message: string; url?: string }> {
  const principal = await requirePrincipal();
  const context = buildRequestContext(await headers());

  try {
    const signed = await requestDownloadUrl(principal, objectId, context);
    return { ok: true, message: "Download URL issued.", url: signed.url };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "That file is not available.",
    };
  }
}

export async function removeAttachment(
  objectId: string,
): Promise<{ ok: boolean; message: string }> {
  const principal = await requirePrincipal();
  const context = buildRequestContext(await headers());
  const result = await deleteStorageObject(principal, objectId, context);
  revalidatePath("/settings");
  return result.ok ? { ok: true, message: "Removed." } : { ok: false, message: result.reason };
}

export async function refreshAttachments() {
  const principal = await requirePrincipal();
  return listStorageObjects(principal);
}
