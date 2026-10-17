"use client";

import { useState, useTransition } from "react";
import { saveCredential, removeCredential } from "./actions";

/**
 * Upstream mail account configuration.
 *
 * JMAP is the primary path and needs only an API token, which the browser keeps
 * and uses to call the upstream endpoint directly. IMAP/SMTP is the fallback and
 * is only offered where the runtime can open a socket.
 */
export function CredentialPanel(props: {
  readonly credentials: readonly {
    readonly id: string;
    readonly label: string;
    readonly protocol: string;
    readonly endpoint: string;
    readonly port: number | null;
    readonly username: string;
  }[];
  readonly mailDomains: readonly string[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<"jmap" | "imap">("jmap");

  return (
    <section className="henna-enter">
      <h2 className="mb-3 text-lg font-medium">Mail accounts</h2>

      {props.credentials.length > 0 ? (
        <ul className="mb-6 space-y-2">
          {props.credentials.map((credential) => (
            <li
              key={credential.id}
              className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
            >
              <span>
                <span className="font-medium">{credential.label}</span>{" "}
                <span className="text-neutral-500">
                  {credential.protocol.toUpperCase()} · {credential.endpoint}
                  {credential.port ? `:${credential.port}` : ""} · {credential.username}
                </span>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await removeCredential(credential.id);
                    setMessage(result.ok ? "Account removed." : result.message);
                  })
                }
                className="text-sm text-red-700 underline dark:text-red-300"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        action={(formData) =>
          startTransition(async () => {
            const result = await saveCredential(formData);
            setMessage(result.ok ? "Account saved." : result.message);
          })
        }
        className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="flex gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-900">
          {(["jmap", "imap"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setProtocol(option)}
              aria-pressed={protocol === option}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                protocol === option
                  ? "bg-white shadow-sm dark:bg-neutral-800"
                  : "text-neutral-600 dark:text-neutral-400"
              }`}
            >
              {option.toUpperCase()}
            </button>
          ))}
        </div>
        <input type="hidden" name="protocol" value={protocol} />

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Label</span>
          <input
            name="label"
            defaultValue="Primary"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">
            {protocol === "jmap" ? "JMAP session URL" : "IMAP host"}
          </span>
          <input
            name="endpoint"
            required
            placeholder={protocol === "jmap" ? "https://jmap.example.com" : "imap.example.com"}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Username</span>
            <input
              name="username"
              required
              autoComplete="off"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          {protocol === "imap" ? (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Port</span>
              <input
                name="port"
                type="number"
                defaultValue={993}
                min={1}
                max={65535}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <span className="mt-1 block text-xs text-neutral-500">
                Port 25 is never used. Use 993 (IMAPS) or 587/465 for sending.
              </span>
            </label>
          ) : null}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">
            {protocol === "jmap" ? "API token" : "Password"}
          </span>
          <input
            name="secret"
            type="password"
            required
            autoComplete="new-password"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Encrypted with AES-256-GCM before it is stored. {protocol === "jmap"
              ? "Your browser uses it to talk to the JMAP endpoint directly."
              : "Only decrypted in memory, for the duration of a connection."}
          </span>
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-henna-600 px-4 py-2 text-sm font-semibold text-white hover:bg-henna-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save account"}
        </button>

        {message ? (
          <p role="status" className="text-sm text-neutral-700 dark:text-neutral-300">
            {message}
          </p>
        ) : null}
      </form>

      <p className="mt-4 text-xs text-neutral-500">
        Served domains: {props.mailDomains.join(", ") || "none configured"}
      </p>
    </section>
  );
}
