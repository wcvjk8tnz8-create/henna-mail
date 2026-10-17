import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveSessionFromCookies } from "@/lib/dal/session";
import { getTotpStatus } from "@/lib/dal/totp";
import { getInstanceSettings } from "@/lib/config/settings";
import { MfaForm } from "./mfa-form";

export const metadata = { title: "Two-factor verification" };

/**
 * Second-factor page.
 *
 * Reached only with a `pending_mfa` session. The session identifier is replaced
 * when the code is accepted, so the pre-MFA token stops working immediately.
 */
export default async function MfaPage() {
  const resolved = await resolveSessionFromCookies();
  if (!resolved) redirect("/login");
  if (resolved.principal.mfaSatisfied) redirect("/inbox");

  const status = await getTotpStatus(resolved.principal);
  const settings = await getInstanceSettings();
  const jar = await cookies();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="henna-enter">
        <h1 className="text-2xl font-semibold tracking-tight">
          {status.enrolled ? "Enter your code" : "Set up two-factor authentication"}
        </h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {status.enrolled
            ? "Enter the 6-digit code from your authenticator app, or use a recovery code."
            : "This account requires a second factor. Scan the code below to enrol, then confirm."}
        </p>

        <MfaForm
          enrolled={status.enrolled && status.confirmed}
          pendingEnrollment={status.enrolled && !status.confirmed}
          recoveryCodesRemaining={status.recoveryCodesRemaining}
          policy={settings.totpPolicy}
          email={resolved.principal.email}
          hasPendingSession={Boolean(jar.get("henna_pending_mfa")?.value)}
        />
      </div>
    </main>
  );
}
