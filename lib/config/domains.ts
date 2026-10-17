import { getMailDomains } from "./env";

/**
 * Mail-domain helpers.
 *
 * Kept free of any database import so that the "which addresses does this
 * instance serve" rule can be unit tested on its own, and so that pure
 * configuration modules never pull in a database driver.
 */

/** Normalise an address for comparison and lookup. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function domainOf(email: string): string | null {
  const at = normaliseEmail(email).lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return normaliseEmail(email).slice(at + 1);
}

/**
 * Whether an address belongs to one of the mail domains this instance serves.
 * Used to refuse OTP delivery (and account creation) for arbitrary addresses.
 */
export function isManagedAddress(email: string): boolean {
  const domain = domainOf(email);
  if (domain === null) return false;
  return getMailDomains().some((candidate) => candidate.toLowerCase() === domain);
}
