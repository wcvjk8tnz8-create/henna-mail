"use client";

import { useState, useTransition } from "react";
import { beginEnrollment, disableTotp, regenerateCodes, savePreferences } from "./actions";

/** Preferences, signature and display options. */
export function PreferencePanel(props: {
  readonly signature: string;
  readonly theme: string;
  readonly messagesPerPage: number;
  readonly blockRemoteImages: boolean;
  readonly transitionsEnabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <section className="henna-enter mb-10">
      <h2 className="mb-3 text-lg font-medium">Preferences</h2>
      <form
        action={(formData) =>
          startTransition(async () => {
            await savePreferences(formData);
            setSaved(true);
          })
        }
        className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Signature</span>
          <textarea
            name="signature"
            defaultValue={props.signature}
            rows={3}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Theme</span>
            <select
              name="theme"
              defaultValue={props.theme}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Messages per page</span>
            <input
              name="messagesPerPage"
              type="number"
              min={10}
              max={100}
              defaultValue={props.messagesPerPage}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>

        <Toggle
          name="blockRemoteImages"
          defaultChecked={props.blockRemoteImages}
          label="Block remote images"
          hint="Recommended. Images are only loaded when you allow them for a message."
        />
        <Toggle
          name="transitionsEnabled"
          defaultChecked={props.transitionsEnabled}
          label="Page transitions"
          hint="Animations are always skipped when your system asks for reduced motion."
        />

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-henna-600 px-4 py-2 text-sm font-semibold text-white hover:bg-henna-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save preferences"}
        </button>
        {saved ? (
          <span role="status" className="ml-3 text-sm text-neutral-600 dark:text-neutral-400">
            Saved.
          </span>
        ) : null}
      </form>
    </section>
  );
}

/** TOTP, recovery codes and account bindings. */
export function SecurityPanel(props: {
  readonly enrolled: boolean;
  readonly confirmed: boolean;
  readonly recoveryCodesRemaining: number;
  readonly shouldRegenerate: boolean;
  readonly isAdmin: boolean;
  readonly githubLinked: boolean;
  readonly hasPassword: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    uri: string;
    recoveryCodes: string[];
  } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  return (
    <section className="henna-enter mb-10">
      <h2 className="mb-3 text-lg font-medium">Security</h2>
      <div className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Two-factor authentication</p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {props.confirmed
                ? "Enabled — a code is required at every sign-in."
                : props.enrolled
                  ? "Enrolled but not yet confirmed."
                  : "Not enabled."}
            </p>
          </div>
          {!props.enrolled ? (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await beginEnrollment();
                  if (result.ok && result.secret) {
                    setEnrollment({
                      secret: result.secret,
                      uri: result.uri ?? "",
                      recoveryCodes: result.recoveryCodes ?? [],
                    });
                  } else {
                    setMessage(result.message);
                  }
                })
              }
              className="rounded-md border border-henna-600 px-3 py-1.5 text-sm font-medium text-henna-700 dark:text-henna-400"
            >
              Enable
            </button>
          ) : null}
        </div>

        {enrollment ? (
          <div className="rounded-md border border-henna-400 bg-henna-50 p-4 text-sm dark:bg-henna-900/30">
            <p className="font-medium">Your new secret</p>
            <code className="mt-1 block break-all text-xs">{enrollment.secret}</code>
            <p className="mt-3 font-medium">Recovery codes</p>
            <ul className="mt-1 grid grid-cols-2 gap-1 font-mono text-xs">
              {enrollment.recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs">Store these somewhere safe — they will not be shown again.</p>
          </div>
        ) : null}

        {props.enrolled && !props.isAdmin ? (
          <form
            action={(formData) =>
              startTransition(async () => {
                const result = await disableTotp(formData);
                setMessage(result.ok ? "Two-factor authentication is now off." : result.message);
              })
            }
            className="space-y-2 border-t border-neutral-200 pt-4 dark:border-neutral-800"
          >
            <p className="text-sm">
              Turning this off requires your current code or a recovery code, so a stolen session
              cannot disable it.
            </p>
            <div className="flex gap-2">
              <input
                name="code"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                aria-label="Current code"
                className="w-32 rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <input
                name="recoveryCode"
                placeholder="abcd-1234-efgh"
                aria-label="Or a recovery code"
                className="w-44 rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                type="submit"
                disabled={pending}
                className="rounded-md border border-red-400 px-3 py-2 text-sm text-red-700 dark:text-red-300"
              >
                Disable
              </button>
            </div>
          </form>
        ) : null}

        {props.isAdmin ? (
          <p className="border-t border-neutral-200 pt-4 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
            Administrators must keep two-factor authentication enabled.
          </p>
        ) : null}

        <div className="flex items-center justify-between border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <div>
            <p className="font-medium">Recovery codes</p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {props.recoveryCodesRemaining} unused.
            </p>
          </div>
          {props.enrolled ? (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await regenerateCodes();
                  if (result.ok && result.recoveryCodes) setCodes(result.recoveryCodes);
                  else setMessage(result.message);
                })
              }
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              Generate new set
            </button>
          ) : null}
        </div>

        {props.shouldRegenerate ? (
          <p
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            You have used most of your recovery codes. Generate a fresh set.
          </p>
        ) : null}

        {codes ? (
          <div className="rounded-md border border-neutral-300 p-4 dark:border-neutral-700">
            <p className="mb-2 text-sm font-medium">New recovery codes</p>
            <ul className="grid grid-cols-2 gap-1 font-mono text-xs">
              {codes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <dl className="grid gap-2 border-t border-neutral-200 pt-4 text-sm dark:border-neutral-800">
          <div className="flex justify-between">
            <dt className="text-neutral-600 dark:text-neutral-400">Password</dt>
            <dd>{props.hasPassword ? "Set" : "Not set"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-600 dark:text-neutral-400">GitHub account</dt>
            <dd>{props.githubLinked ? "Linked" : "Not linked"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-600 dark:text-neutral-400">Your audit log</dt>
            <dd>
              <a className="underline" href="/settings/audit">
                View
              </a>
            </dd>
          </div>
        </dl>

        {message ? (
          <p role="status" className="text-sm text-neutral-700 dark:text-neutral-300">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Toggle(props: {
  readonly name: string;
  readonly defaultChecked: boolean;
  readonly label: string;
  readonly hint: string;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        name={props.name}
        defaultChecked={props.defaultChecked}
        className="mt-1 h-4 w-4"
      />
      <span>
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="block text-xs text-neutral-500">{props.hint}</span>
      </span>
    </label>
  );
}
