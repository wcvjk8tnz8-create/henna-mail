import { randomUUID } from "node:crypto";

/**
 * Object key construction and validation.
 *
 * Two rules the storage layer depends on:
 *
 *  1. Every key is namespaced under `users/<userId>/`. The DAL refuses to sign
 *     any key that does not start with the caller's own prefix, so a signed URL
 *     can never reach someone else's objects.
 *  2. A key is checked before it is signed. Path traversal (`..`), absolute
 *     paths and control characters are rejected rather than sanitised quietly --
 *     a caller that produces those is buggy and should fail loudly.
 */

export const MAX_KEY_LENGTH = 900;
export const MAX_FILENAME_LENGTH = 180;

export type StoragePurpose = "attachment" | "avatar";

// Control characters (0x00-0x1F, 0x7F) plus the two directory separators.
const CONTROL_AND_SEPARATORS = /[\u0000-\u001f\u007f/\\]/g;
const CONTROL_ONLY = /[\u0000-\u001f\u007f]/;

/**
 * Reduce a user-supplied filename to something safe to store.
 *
 * Directory separators and control characters are removed, a leading dot is
 * dropped (so the name cannot become a hidden file or a traversal), and the
 * result is trimmed to a sane length. Unicode is preserved: people do attach
 * files with Chinese, Japanese or Cyrillic names.
 */
export function sanitizeFilename(name: string): string {
  const stripped = name
    .normalize("NFC")
    .replace(CONTROL_AND_SEPARATORS, "")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped === "") return "attachment";

  // Keep the extension if there is one, so the stored name is still useful.
  const clipped = stripped.slice(0, MAX_FILENAME_LENGTH);
  return clipped === "" ? "attachment" : clipped;
}

/** Reject, rather than repair, a malformed key. */
export function isValidObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (key.startsWith("/") || key.endsWith("/")) return false;
  if (key.includes("\\")) return false;
  if (CONTROL_ONLY.test(key)) return false;
  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return true;
}

/** The prefix every key for this user must carry. */
export function userPrefix(userId: string): string {
  return `users/${userId}/`;
}

/**
 * Build a key for an object owned by `userId`.
 *
 * A UUID sits between the purpose and the filename, so two attachments with the
 * same name never collide and the key cannot be guessed from the filename.
 */
export function buildObjectKey(input: {
  readonly userId: string;
  readonly purpose: StoragePurpose;
  readonly filename: string;
}): string {
  const safe = sanitizeFilename(input.filename);
  return `${userPrefix(input.userId)}${input.purpose}/${randomUUID()}/${safe}`;
}

/**
 * Enforce ownership on a key.
 *
 * Called before any signing operation. Returns false rather than throwing so the
 * DAL can turn it into an audited denial.
 */
export function keyBelongsToUser(key: string, userId: string): boolean {
  if (!isValidObjectKey(key)) return false;
  return key.startsWith(userPrefix(userId));
}
