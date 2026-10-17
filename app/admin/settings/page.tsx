import { redirect } from "next/navigation";
import { requireAdmin, AuthzError, redirectTargetFor } from "@/lib/dal/guards";
import { getInstanceSettings, getSecretKeyIds } from "@/lib/config/settings";
import { getKeyRotationStatus } from "@/lib/crypto/keyring";
import { getAdminEmail, getMailDomains } from "@/lib/config/env";
import { AdminSettingsForm } from "./admin-settings-form";
import { StorageForm } from "./storage-form";
import { getStorageStatus } from "@/lib/dal/storage";

export const metadata = { title: "Instance settings" };

/**
 * Instance configuration.
 *
 * Reaching this page requires an administrator whose second factor has been
 * satisfied — `requireAdmin()` enforces both. Root settings (DOMAIN, ADMIN,
 * jwt_secret, HENNA_CREDENTIAL_KEY) are environment-only and are displayed as
 * read-only, because changing them requires a redeploy by design.
 */
export default async function AdminSettingsPage() {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AuthzError) redirect(redirectTargetFor(error));
    throw error;
  }

  const [settings, secretKeyIds, rotation, storage] = await Promise.all([
    getInstanceSettings(),
    getSecretKeyIds(),
    Promise.resolve(getKeyRotationStatus()),
    getStorageStatus(),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Instance settings</h1>
        <a href="/inbox" className="ml-auto text-sm underline">
          Back to mail
        </a>
        <a href="/admin/audit" className="text-sm underline">
          Audit log
        </a>
      </header>

      <section className="mb-8 rounded-lg border border-neutral-300 bg-neutral-50 p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900">
        <h2 className="mb-2 font-medium">Root configuration (environment only)</h2>
        <dl className="grid gap-1 font-mono text-xs">
          <div className="flex justify-between">
            <dt>DOMAIN</dt>
            <dd>{getMailDomains().join(", ")}</dd>
          </div>
          <div className="flex justify-between">
            <dt>ADMIN</dt>
            <dd>{getAdminEmail()}</dd>
          </div>
          <div className="flex justify-between">
            <dt>jwt_secret</dt>
            <dd>•••••••• (never displayed)</dd>
          </div>
          <div className="flex justify-between">
            <dt>active credential key</dt>
            <dd>{rotation.activeKeyId}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-neutral-500">
          These values come from the environment and cannot be changed here — that is what makes
          them trustworthy. See docs/self-hosting.md for rotation.
        </p>
      </section>

      <AdminSettingsForm
        initial={{
          authMethods: [...settings.authMethods],
          githubClientId: settings.githubClientId,
          githubAllowedUsers: [...settings.githubAllowedUsers],
          githubAllowedOrgs: [...settings.githubAllowedOrgs],
          emailFrom: settings.emailFrom,
          registrationMode: settings.registrationMode,
          totpPolicy: settings.totpPolicy,
          passwordMinLength: settings.passwordMinLength,
          passwordRequireComplexity: settings.passwordRequireComplexity,
          otpTtlSeconds: settings.otpTtlSeconds,
          otpMaxAttempts: settings.otpMaxAttempts,
          otpResendCooldownSeconds: settings.otpResendCooldownSeconds,
          transitionsEnabled: settings.transitionsEnabled,
          respectReducedMotion: settings.respectReducedMotion,
          allowedMailOrigins: [...settings.allowedMailOrigins],
        }}
        githubSecretSet={secretKeyIds.githubClientSecretKeyId !== null}
        resendKeySet={secretKeyIds.resendApiKeyKeyId !== null}
        rotation={{
          activeKeyId: rotation.activeKeyId,
          keyCount: rotation.keyCount,
          healthy: rotation.healthy,
        }}
        actorId={admin.userId}
      />

      <hr className="my-10 border-neutral-200 dark:border-neutral-800" />

      <StorageForm initial={storage} />
    </main>
  );
}
