import type { PrimaryAuthMethod } from "@/lib/auth/session";
import type { UserRole } from "./policy";

/**
 * Shared DAL vocabulary.
 *
 * The DAL is the *only* place in Henna where an authorisation decision is made.
 * Route Handlers, Server Actions and Server Components receive a `Principal`
 * from a DAL guard — they never re-derive identity from a cookie, a JWT or a
 * request body, and they never check roles themselves.
 */

export type AuthzFailure =
  /** No usable session cookie, or the token failed verification. */
  | "unauthenticated"
  /** The session row is revoked or past its absolute lifetime. */
  | "session-expired"
  /** Primary authentication succeeded; the second factor has not. */
  | "mfa-required"
  /** Authenticated, but not allowed to touch this resource. */
  | "forbidden"
  | "account-disabled"
  | "account-locked";

export class AuthzError extends Error {
  override readonly name = "AuthzError";
  readonly kind: AuthzFailure;

  constructor(kind: AuthzFailure, message?: string) {
    super(message ?? kind);
    this.kind = kind;
  }
}

/**
 * The minimum identity a caller needs. Deliberately narrow: a DTO, not a
 * database row, so that widening what a page can see is a conscious change to
 * this interface (and to its DAL constructor), not an accident.
 */
export interface Principal {
  readonly userId: string;
  readonly email: string;
  readonly role: UserRole;
  readonly sessionId: string;
  /** Which primary method established the session. */
  readonly amr: readonly PrimaryAuthMethod[];
  /** True only when the second factor has been satisfied for this session. */
  readonly mfaSatisfied: boolean;
  readonly emailVerified: boolean;
}

/** A row that belongs to exactly one user. */
export interface Owned {
  readonly userId: string;
}

export { UserRole };
