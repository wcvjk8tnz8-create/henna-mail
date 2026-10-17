"use client";

import { useState, useTransition } from "react";
import { saveInstanceSettings, rotateCredentials } from "./actions";

export interface AdminSettingsFormProps {
  readonly initial: {
    readonly authMethods: string[];
    readonly githubClientId: string | null;
    readonly githubAllowedUsers: string[];
    readonly githubAllowedOrgs: string[];
    readonly emailFrom: string | null;
    readonly registrationMode: string;
    readonly totpPolicy: string;
    readonly passwordMinLength: number;
    readonly passwordRequireComplexity: boolean;
    readonly otpTtlSeconds: number;
    readonly otpMaxAttempts: number;
    readonly otpResendCooldownSeconds: number;
    readonly transitionsEnabled: boolean;
    readonly respectReducedMotion: boolean;
    readonly allowedMailOrigins: string[];
  };
  readonly githubSecretSet: boolean;
  readonly resendKeySet: boolean;
  readonly rotation: { readonly activeKeyId: string; readonly keyCount: number; readonly healthy: boolean };
  readonly actorId: string;
}

const ALL_METHODS = ["password", "github", "email_otp"] as const;

export function AdminSettingsForm(props: AdminSettingsFormProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [methods, setMethods] = useState<string[]>(props.initial.authMethods);

  function toggleMethod(method: string) {
    setMethods((current) => {
      const next = current.includes(method)
        ? current.filter((m) => m !== method)
        : [...current, method];
      // At least one method must stay enabled, or nobody can sign in.
      return next.length === 0 ? current : next;
    });
  }

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          const result = await saveInstanceSettings(formData);
          setMessage(result.ok ? "Settings saved." : result.message);
        })
      }
      className="henna-enter space-y-8"
    >
      <input type="hidden" name="authMethods" value={methods.join(",")} />

      <section>
        <h2 className="mb-3 text-lg font-medium">Authentication</h2>
        <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Enabled methods</legend>
            <div className="flex flex-wrap gap-2">
              {ALL_METHODS.map((method) => (
                <label
                  key={method}
                  className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                    methods.includes(method)
                      ? "border-henna-600 text-henna-700 dark:text-henna-400"
                      : "border-neutral-300 dark:border-neutral-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={methods.includes(method)}
                    onChange={() => toggleMethod(method)}
                    className="h-4 w-4"
                  />
                  {labelFor(method)}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              GitHub is the only OAuth provider Henna supports and the only one it will ever
              support.
            </p>
          </fieldset>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">GitHub OAuth</h2>
        <div className="grid gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Client ID</span>
            <input
              name="githubClientId"
              defaultValue={props.initial.githubClientId ?? ""}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Client secret</span>
            <input
              name="githubClientSecret"
              type="password"
              autoComplete="new-password"
              placeholder={props.githubSecretSet ? "•••••••• (saved)" : "Not set"}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Allowed users</span>
            <input
              name="githubAllowedUsers"
              defaultValue={props.initial.githubAllowedUsers.join(",")}
              placeholder="alice,bob"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Allowed organisations</span>
            <input
              name="githubAllowedOrgs"
              defaultValue={props.initial.githubAllowedOrgs.join(",")}
              placeholder="my-org"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <p className="text-xs text-neutral-500 sm:col-span-2">
            Callback URL must be exactly <code>/api/auth/callback/github</code> on this instance.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Email delivery (Resend)</h2>
        <div className="grid gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">API key</span>
            <input
              name="resendApiKey"
              type="password"
              autoComplete="new-password"
              placeholder={props.resendKeySet ? "•••••••• (saved)" : "Not set"}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">From address</span>
            <input
              name="emailFrom"
              type="email"
              defaultValue={props.initial.emailFrom ?? ""}
              placeholder="Henna <no-reply@example.com>"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Registration and second factor</h2>
        <div className="grid gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Registration</span>
            <select
              name="registrationMode"
              defaultValue={props.initial.registrationMode}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="closed">Closed</option>
              <option value="invite-only">Invite only</option>
              <option value="allowlist">Allowlist</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">TOTP policy</span>
            <select
              name="totpPolicy"
              defaultValue={props.initial.totpPolicy}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="admin-only">Administrators only (default)</option>
              <option value="required">Everyone</option>
              <option value="optional">Optional</option>
            </select>
          </label>
          <p className="text-xs text-neutral-500 sm:col-span-2">
            Administrators are always required to use TOTP, whatever this setting says.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Passwords and codes</h2>
        <div className="grid gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Minimum length</span>
            <input
              name="passwordMinLength"
              type="number"
              min={12}
              max={128}
              defaultValue={props.initial.passwordMinLength}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Code lifetime (s)</span>
            <input
              name="otpTtlSeconds"
              type="number"
              min={60}
              max={3600}
              defaultValue={props.initial.otpTtlSeconds}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Max attempts</span>
            <input
              name="otpMaxAttempts"
              type="number"
              min={3}
              max={10}
              defaultValue={props.initial.otpMaxAttempts}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Resend cooldown (s)</span>
            <input
              name="otpResendCooldownSeconds"
              type="number"
              min={30}
              max={3600}
              defaultValue={props.initial.otpResendCooldownSeconds}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="passwordRequireComplexity"
              defaultChecked={props.initial.passwordRequireComplexity}
              className="h-4 w-4"
            />
            <span className="text-sm">Require mixed characters</span>
          </label>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Experience</h2>
        <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="transitionsEnabled"
              defaultChecked={props.initial.transitionsEnabled}
              className="h-4 w-4"
            />
            <span className="text-sm">Page transitions</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="respectReducedMotion"
              defaultChecked={props.initial.respectReducedMotion}
              className="h-4 w-4"
            />
            <span className="text-sm">Respect prefers-reduced-motion</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Allowed mail origins</span>
            <input
              name="allowedMailOrigins"
              defaultValue={props.initial.allowedMailOrigins.join(",")}
              placeholder="https://jmap.example.com"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <span className="mt-1 block text-xs text-neutral-500">
              Added to connect-src and frame-src so the browser can reach your mail server directly.
            </span>
          </label>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Key rotation</h2>
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <p>
            Active key <code>{props.rotation.activeKeyId}</code> · {props.rotation.keyCount} key(s)
            in the ring · {props.rotation.healthy ? "healthy" : "misconfigured"}
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await rotateCredentials();
                setMessage(result.message);
              })
            }
            className="mt-3 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
          >
            Re-encrypt stored credentials under the active key
          </button>
          <p className="mt-2 text-xs text-neutral-500">
            Prepend the new key to HENNA_CREDENTIAL_KEY, redeploy, then press the button. Once the
            report shows zero remaining rows on old keys, drop them from the variable.
          </p>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-henna-600 px-4 py-2 text-sm font-semibold text-white hover:bg-henna-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
        {message ? (
          <span role="status" className="text-sm text-neutral-700 dark:text-neutral-300">
            {message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function labelFor(method: string): string {
  switch (method) {
    case "password":
      return "Password";
    case "github":
      return "GitHub";
    case "email_otp":
      return "Email code";
    default:
      return method;
  }
}
