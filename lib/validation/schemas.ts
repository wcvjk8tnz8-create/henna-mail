import { z } from "zod";

/**
 * Every server-side input in Henna is parsed with one of these schemas.
 *
 * The rule enforced by review (and by `lib/validation/index.ts`'s helpers) is
 * that raw `formData`, JSON bodies, query parameters and custom headers never
 * reach business logic: they are parsed first, and a parse failure is a
 * rejected request, never a coerced one.
 */

/* ----------------------------------------------------------------- shared */

export const emailInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Email is required")
  .max(320, "Email is too long")
  .regex(/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Enter a valid email address");

export const passwordInput = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(128, "Password must be at most 128 characters");

export const totpCodeInput = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator");

export const otpCodeInput = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code sent to your email");

export const recoveryCodeInput = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/, "Recovery codes look like abcd-1234-efgh");

export const uuidInput = z.string().uuid();

export const csrfHeaderInput = z
  .string()
  .min(16, "Missing CSRF token")
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, "Malformed CSRF token");

/* ------------------------------------------------------------- auth forms */

export const passwordLoginSchema = z.object({
  email: emailInput,
  password: passwordInput,
  /** Optional explicit redirect; must stay on this origin. */
  next: z
    .string()
    .max(512)
    .refine(
      (value) =>
        // A single leading slash only: `//evil.example.com` is a
        // protocol-relative URL and must never be accepted as a redirect.
        value.startsWith("/") &&
        !value.startsWith("//") &&
        !value.startsWith("/\\") &&
        /^\/[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=%]*$/.test(value),
      "Invalid redirect target",
    )
    .optional(),
});
export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;

export const passwordResetRequestSchema = z.object({ email: emailInput });
export const passwordResetConfirmSchema = z.object({
  email: emailInput,
  code: otpCodeInput,
  password: passwordInput,
});
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>;

export const passwordChangeSchema = z.object({
  currentPassword: passwordInput,
  newPassword: passwordInput,
});
export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;

export const emailOtpRequestSchema = z.object({ email: emailInput });
export const emailOtpVerifySchema = z.object({
  email: emailInput,
  code: otpCodeInput,
});
export type EmailOtpVerifyInput = z.infer<typeof emailOtpVerifySchema>;

export const totpVerifySchema = z.object({
  code: totpCodeInput,
  /** Set when the user is falling back to a recovery code. */
  recoveryCode: recoveryCodeInput.optional(),
});
export type TotpVerifyInput = z.infer<typeof totpVerifySchema>;

export const totpDisableSchema = z.object({
  code: totpCodeInput.optional(),
  recoveryCode: recoveryCodeInput.optional(),
});
export type TotpDisableInput = z.infer<typeof totpDisableSchema>;

/** GitHub OAuth callback query string. */
export const githubCallbackSchema = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(128).optional(),
  error_description: z.string().max(512).optional(),
});
export type GithubCallbackInput = z.infer<typeof githubCallbackSchema>;

/* ------------------------------------------------------------ credentials */

const hostnameInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    "Enter a valid hostname such as mail.example.com",
  );

export const jmapCredentialSchema = z.object({
  label: z.string().trim().min(1).max(64).default("Primary"),
  protocol: z.literal("jmap"),
  endpoint: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        // JMAP over plain HTTP is only acceptable on loopback for local testing.
        return url.protocol === "https:" || url.hostname === "localhost";
      } catch {
        return false;
      }
    }, "JMAP endpoint must be an https:// URL"),
  username: z.string().trim().min(1).max(320),
  token: z.string().min(8, "API token looks too short").max(2048),
});
export type JmapCredentialInput = z.infer<typeof jmapCredentialSchema>;

export const imapCredentialSchema = z.object({
  label: z.string().trim().min(1).max(64).default("Primary"),
  protocol: z.literal("imap"),
  endpoint: hostnameInput,
  // Port 25 is refused: Henna never speaks unauthenticated submission SMTP.
  port: z.number().int().min(1).max(65535).refine((p) => p !== 25, "Port 25 is not permitted"),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1, "Password is required").max(1024),
});
export type ImapCredentialInput = z.infer<typeof imapCredentialSchema>;

export const mailCredentialSchema = z.discriminatedUnion("protocol", [
  jmapCredentialSchema,
  imapCredentialSchema,
]);
export type MailCredentialInput = z.infer<typeof mailCredentialSchema>;

/* --------------------------------------------------------------- settings */

export const userSettingsSchema = z.object({
  signature: z.string().max(4096).default(""),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  messagesPerPage: z.number().int().min(10).max(100).default(25),
  blockRemoteImages: z.boolean().default(true),
  transitionsEnabled: z.boolean().default(true),
});
export type UserSettingsInput = z.infer<typeof userSettingsSchema>;

export const adminSettingsSchema = z.object({
  authMethods: z.array(z.enum(["password", "github", "email_otp"])).min(1).max(3),
  githubClientId: z.string().max(256).nullable(),
  githubClientSecret: z.string().max(256).nullable(),
  githubAllowedUsers: z.array(z.string().max(64)).max(1000),
  githubAllowedOrgs: z.array(z.string().max(64)).max(1000),
  resendApiKey: z.string().max(256).nullable(),
  emailFrom: emailInput.nullable(),
  registrationMode: z.enum(["closed", "invite-only", "allowlist"]),
  totpPolicy: z.enum(["optional", "required", "admin-only"]),
  passwordMinLength: z.number().int().min(12).max(128),
  passwordRequireComplexity: z.boolean(),
  otpTtlSeconds: z.number().int().min(60).max(3600),
  otpMaxAttempts: z.number().int().min(3).max(10),
  otpResendCooldownSeconds: z.number().int().min(30).max(3600),
  transitionsEnabled: z.boolean(),
  respectReducedMotion: z.boolean(),
  allowedMailOrigins: z.array(z.string().max(253)).max(100),
});
export type AdminSettingsInput = z.infer<typeof adminSettingsSchema>;

export const auditQuerySchema = z.object({
  actorId: uuidInput.optional(),
  action: z.string().max(128).optional(),
  result: z.enum(["success", "denied", "error"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Clamped rather than rejected: a caller asking for 10_000 rows gets 500. */
  limit: z.coerce
    .number()
    .int()
    .default(50)
    .transform((value) => Math.min(Math.max(value, 1), 500)),
  offset: z.coerce
    .number()
    .int()
    .default(0)
    .transform((value) => Math.max(value, 0)),
});
export type AuditQueryInput = z.infer<typeof auditQuerySchema>;

/* ------------------------------------------------------------------ parse */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Parse or collect human-readable issues. Never throws. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}

/** Parse or throw a `ValidationError` with joined issues. */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(issues.join("; "));
    this.issues = issues;
  }
}

export function parseInputOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = parseInput(schema, input);
  if (!result.ok) throw new ValidationError(result.issues);
  return result.value;
}

/** Turn `URLSearchParams` into an object for Zod to parse. */
export function paramsToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

/** Turn `FormData` into an object for Zod to parse. */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `forEach` rather than the iterator: it is available on every FormData
  // implementation (DOM, undici, and the Workers runtime) without depending on
  // which `lib` the ambient types happen to come from.
  formData.forEach((value, key) => {
    out[key] = typeof value === "string" ? value : value.name;
  });
  return out;
}
