"use client";

import { useRef, useState, useTransition } from "react";
import {
  getAttachmentDownloadUrl,
  refreshAttachments,
  removeAttachment,
  requestAttachmentUpload,
} from "./storage-actions";

export interface AttachmentsPanelProps {
  readonly enabled: boolean;
  readonly maxUploadBytes: number;
  readonly initial: readonly {
    readonly id: string;
    readonly filename: string;
    readonly contentType: string | null;
    readonly sizeBytes: number | null;
    readonly createdAt: string;
  }[];
}

/**
 * Attachments.
 *
 * The upload is a two-step dance by design: the browser asks Henna to sign a
 * URL, then PUTs the file to the bucket itself. Henna never receives the bytes,
 * so a compromise of this server does not expose anyone's attachments.
 */
export function AttachmentsPanel(props: AttachmentsPanelProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [items, setItems] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onUpload(file: File) {
    setMessage(null);
    if (file.size > props.maxUploadBytes) {
      setMessage(`That file is larger than ${Math.floor(props.maxUploadBytes / 1048576)} MiB.`);
      return;
    }

    setBusy(true);
    try {
      const grant = await requestAttachmentUpload({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      });

      if (!grant.ok || !grant.uploadUrl || !grant.objectId) {
        setMessage(grant.message);
        return;
      }

      // Straight to the bucket. The signed headers must match exactly.
      const response = await fetch(grant.uploadUrl, {
        method: "PUT",
        headers: { ...(grant.uploadHeaders ?? {}) },
        body: file,
      });

      if (!response.ok) {
        setMessage(`The upload failed (HTTP ${response.status}).`);
        return;
      }

      setItems(await refreshAttachments().then((rows) => rows.map(toRow)));
      setMessage("Uploaded.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function onDownload(id: string) {
    startTransition(async () => {
      const result = await getAttachmentDownloadUrl(id);
      if (result.ok && result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        setMessage(result.message);
      }
    });
  }

  function onRemove(id: string) {
    startTransition(async () => {
      const result = await removeAttachment(id);
      setMessage(result.message);
      if (result.ok) setItems(await refreshAttachments().then((rows) => rows.map(toRow)));
    });
  }

  if (!props.enabled) {
    return (
      <section className="henna-enter">
        <h2 className="mb-3 text-lg font-medium">Attachments</h2>
        <p className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
          Object storage is not configured on this instance. An administrator can enable it under
          Admin → Instance settings.
        </p>
      </section>
    );
  }

  return (
    <section className="henna-enter">
      <h2 className="mb-3 text-lg font-medium">Attachments</h2>

      <div className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">
            Add a file (up to {Math.floor(props.maxUploadBytes / 1048576)} MiB)
          </span>
          <input
            ref={inputRef}
            type="file"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onUpload(file);
            }}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-henna-600 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white"
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Uploaded directly to the bucket with a short-lived signed URL.
          </span>
        </label>

        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing uploaded yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{item.filename}</span>
                  <span className="block text-xs text-neutral-500">
                    {formatSize(item.sizeBytes)} · {item.createdAt.slice(0, 10)}
                  </span>
                </span>
                <span className="flex shrink-0 gap-3">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onDownload(item.id)}
                    className="text-henna-700 underline dark:text-henna-400"
                  >
                    Download
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onRemove(item.id)}
                    className="text-red-700 underline dark:text-red-300"
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {message ? (
          <p role="status" className="text-sm text-neutral-700 dark:text-neutral-300">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function toRow(row: {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
