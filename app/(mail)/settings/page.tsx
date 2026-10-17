import { redirect } from "next/navigation";
import { requirePrincipal, AuthzError, redirectTargetFor } from "@/lib/dal/guards";
import { getTotpStatus } from "@/lib/dal/totp";
import { getUserSettings } from "@/lib/dal/settings";
import { listCredentials } from "@/lib/dal/credentials";
import { getOwnProfile } from "@/lib/dal/users";
import { getMailDomains } from "@/lib/config/env";
import { SecurityPanel } from "./security-panel";
import { CredentialPanel } from "./credential-panel";
import { AttachmentsPanel } from "./attachments-panel";
import { getPublicStorageStatus, listStorageObjects } from "@/lib/dal/storage";
import { PreferencePanel } from "./preference-panel";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  let principal;
  try {
    principal = await requirePrincipal();
  } catch (error) {
    if (error instanceof AuthzError) redirect(redirectTargetFor(error));
    throw error;
  }

  const [profile, totp, settings, credentials, storage, objects] = await Promise.all([
    getOwnProfile(principal),
    getTotpStatus(principal),
    getUserSettings(principal),
    listCredentials(principal),
    getPublicStorageStatus(),
    listStorageObjects(principal),
  ]);

  if (!profile) redirect("/login");

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <span className="text-sm text-neutral-500">{profile.email}</span>
        <a href="/inbox" className="ml-auto text-sm underline">
          Back to mail
        </a>
      </header>

      <PreferencePanel
        signature={settings.signature}
        theme={settings.theme}
        messagesPerPage={settings.messagesPerPage}
        blockRemoteImages={settings.blockRemoteImages}
        transitionsEnabled={settings.transitionsEnabled}
      />

      <SecurityPanel
        enrolled={totp.enrolled}
        confirmed={totp.confirmed}
        recoveryCodesRemaining={totp.recoveryCodesRemaining}
        shouldRegenerate={totp.shouldRegenerateRecoveryCodes}
        isAdmin={profile.role === "admin"}
        githubLinked={profile.githubLinked}
        hasPassword={profile.hasPassword}
      />

      <CredentialPanel
        credentials={credentials.map((c) => ({
          id: c.id,
          label: c.label,
          protocol: c.protocol,
          endpoint: c.endpoint,
          port: c.port,
          username: c.username,
        }))}
        mailDomains={[...getMailDomains()]}
      />

      <AttachmentsPanel
        enabled={storage.enabled}
        maxUploadBytes={storage.maxUploadBytes}
        initial={objects.map((object) => ({
          id: object.id,
          filename: object.filename,
          contentType: object.contentType,
          sizeBytes: object.sizeBytes,
          createdAt: object.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
