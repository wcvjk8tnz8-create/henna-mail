"use client";

import { useState, useTransition } from "react";
import { savePreferences } from "./actions";

export interface PreferencePanelProps {
  readonly signature: string;
  readonly theme: string;
  readonly messagesPerPage: number;
  readonly blockRemoteImages: boolean;
  readonly transitionsEnabled: boolean;
}

/** Display and composition preferences. Nothing here is security-relevant. */
export function PreferencePanel(props: PreferencePanelProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section className="henna-enter">
      <h2 className="mb-3 text-lg font-medium">Preferences</h2>
      <form
        action={(formData) =>
          startTransition(async () => {
            const result = await savePreferences(formData);
            setMessage(result.ok ? "Preferences saved." : result.message);
          })
        }
        className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Signature</span>
          <textarea
            name="signature"
            rows={3}
            defaultValue={props.signature}
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

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="blockRemoteImages"
            defaultChecked={props.blockRemoteImages}
            className="h-4 w-4"
          />
          <span className="text-sm">Block remote images by default</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="transitionsEnabled"
            defaultChecked={props.transitionsEnabled}
            className="h-4 w-4"
          />
          <span className="text-sm">Enable page transitions</span>
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-henna-600 px-4 py-2 text-sm font-semibold text-white hover:bg-henna-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save preferences"}
        </button>

        {message ? (
          <span role="status" className="ml-3 text-sm text-neutral-700 dark:text-neutral-300">
            {message}
          </span>
        ) : null}
      </form>
    </section>
  );
}
