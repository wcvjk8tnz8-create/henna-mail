"use client";

import { useState, useTransition } from "react";
import { saveStorageConfig } from "./actions";
import type { StorageStatus } from "@/lib/dal/storage";

/**
 * Object storage configuration.
 *
 * R2 and S3-compatible services share one form because they share one wire
 * protocol: presigned SigV4 requests. The only differences are the endpoint,
 * the region and whether the bucket goes in the path or the hostname.
 */
export function StorageForm(props: { readonly initial: StorageStatus }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [provider, setProvider] = useState<"r2" | "s3">(
    props.initial.provider === "s3" ? "s3" : "r2",
  );

  return (
    <section className="henna-enter">
      <h2 className="mb-3 text-lg font-medium">Object storage</h2>
      <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
        Attachments move between the browser and the bucket through short-lived presigned URLs.
        Henna signs the request and never sees the bytes.
      </p>

      <div
        className={`mb-4 rounded-md border px-3 py-2 text-sm ${
          props.initial.ready
            ? "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
            : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        }`}
      >
        {props.initial.ready ? (
          <>Connected to <code>{props.initial.bucket}</code> at {props.initial.endpoint}.</>
        ) : (
          <>
            Not usable yet.
            {props.initial.issues.length > 0 ? (
              <ul className="mt-1 list-inside list-disc text-xs">
                {props.initial.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>

      <form
        action={(formData) =>
          startTransition(async () => {
            const result = await saveStorageConfig(formData);
            setMessage(result.ok ? "Storage settings saved." : result.message);
          })
        }
        className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="flex gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-900">
          {(["r2", "s3"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setProvider(option)}
              aria-pressed={provider === option}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                provider === option
                  ? "bg-white shadow-sm dark:bg-neutral-800"
                  : "text-neutral-600 dark:text-neutral-400"
              }`}
            >
              {option === "r2" ? "Cloudflare R2" : "S3-compatible"}
            </button>
          ))}
        </div>
        <input type="hidden" name="provider" value={provider} />

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={props.initial.enabled}
            className="h-4 w-4"
          />
          <span className="text-sm">Enable attachments</span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">
              {provider === "r2" ? "Account ID (optional)" : "Endpoint"}
            </span>
            <input
              name={provider === "r2" ? "r2AccountId" : "endpoint"}
              defaultValue={provider === "r2" ? "" : (props.initial.endpoint ?? "")}
              placeholder={
                provider === "r2" ? "32 hex characters" : "https://s3.eu-west-1.amazonaws.com"
              }
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
            />
            {provider === "r2" ? (
              <span className="mt-1 block text-xs text-neutral-500">
                Leave the endpoint empty and this derives{" "}
                <code>https://&lt;account&gt;.r2.cloudflarestorage.com</code>.
              </span>
            ) : null}
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Bucket</span>
            <input
              name="bucket"
              defaultValue={props.initial.bucket ?? ""}
              placeholder="henna-attachments"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Region</span>
            <input
              name="region"
              defaultValue="auto"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <span className="mt-1 block text-xs text-neutral-500">
              Always <code>auto</code> for R2.
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Max upload (MB)</span>
            <input
              name="maxUploadBytesMb"
              type="number"
              min={1}
              max={5120}
              defaultValue={Math.floor(props.initial.maxUploadBytes / 1048576)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Access key ID</span>
            <input
              name="accessKeyId"
              autoComplete="off"
              placeholder={props.initial.credentialsSet ? "•••••••• (saved)" : "Not set"}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Secret access key</span>
            <input
              name="secretAccessKey"
              type="password"
              autoComplete="new-password"
              placeholder={props.initial.credentialsSet ? "•••••••• (saved)" : "Not set"}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
            />
            <span className="mt-1 block text-xs text-neutral-500">
              Encrypted at rest. Leave blank to keep the saved value.
            </span>
          </label>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" name="forcePathStyle" defaultChecked className="h-4 w-4" />
          <span className="text-sm">
            Path-style URLs (<code>/bucket/key</code>) — required by R2 and MinIO
          </span>
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-henna-600 px-4 py-2 text-sm font-semibold text-white hover:bg-henna-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save storage settings"}
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
