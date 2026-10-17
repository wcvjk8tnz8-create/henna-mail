"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeMailHtml, mailPreview } from "@/lib/mail/sanitize";
import { MAIL_IFRAME_SANDBOX } from "@/lib/security/headers";
import type { CredentialDto } from "@/lib/dal/credentials";
import type { UserSettingsDto } from "@/lib/dal/settings";

/**
 * Mail shell.
 *
 * Everything message-shaped here is held in browser state or IndexedDB. The
 * JMAP requests below are issued **by the browser** straight to the upstream
 * endpoint; Henna's server is not in the path.
 */

interface MailShellProps {
  readonly email: string;
  readonly role: string;
  readonly settings: UserSettingsDto;
  readonly hasCredential: boolean;
  readonly credential: CredentialDto | null;
}

interface MessageSummary {
  readonly id: string;
  readonly subject: string;
  readonly from: string;
  readonly receivedAt: string;
  readonly unread: boolean;
  readonly preview: string;
  readonly html: string;
}

export function MailShell(props: MailShellProps) {
  const [messages, setMessages] = useState<readonly MessageSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(
    props.hasCredential ? "Connecting…" : "Add a mail account in Settings to get started.",
  );
  const [query, setQuery] = useState("");

  // A local index is the only place mail is stored for search. The query never
  // leaves the browser.
  const index = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      map.set(message.id, `${message.subject} ${message.from} ${message.preview}`.toLowerCase());
    }
    return map;
  }, [messages]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return messages;
    return messages.filter((message) => (index.get(message.id) ?? "").includes(needle));
  }, [messages, query, index]);

  const selectedMessage = visible.find((message) => message.id === selected) ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <span className="font-semibold">Henna</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search this device"
          aria-label="Search mail on this device"
          className="ml-auto w-64 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <span className="text-sm text-neutral-600 dark:text-neutral-400">{props.email}</span>
        <a href="/settings" className="text-sm underline">
          Settings
        </a>
        {props.role === "admin" ? (
          <a href="/admin/settings" className="text-sm underline">
            Admin
          </a>
        ) : null}
      </header>

      <div className="flex flex-1 overflow-hidden">
        <nav aria-label="Folders" className="w-40 shrink-0 border-r border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <ul className="space-y-1">
            {["Inbox", "Sent", "Drafts", "Archive", "Trash"].map((folder) => (
              <li key={folder}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  {folder}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-neutral-500">
            {props.credential
              ? `${props.credential.protocol.toUpperCase()} · ${props.credential.endpoint}`
              : "No account"}
          </p>
        </nav>

        <section aria-label="Message list" className="w-80 shrink-0 overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-neutral-500">{status}</p>
          ) : (
            <ul>
              {visible.map((message) => (
                <li key={message.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(message.id)}
                    aria-current={selected === message.id}
                    className={`block w-full border-b border-neutral-100 px-3 py-2 text-left hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900 ${
                      selected === message.id ? "bg-neutral-100 dark:bg-neutral-900" : ""
                    }`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className={message.unread ? "font-semibold" : ""}>{message.from}</span>
                      <span className="ml-auto text-xs text-neutral-500">{message.receivedAt}</span>
                    </span>
                    <span className="block text-sm">{message.subject}</span>
                    <span className="block truncate text-xs text-neutral-500">{message.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Message" className="henna-enter flex-1 overflow-y-auto p-4">
          {selectedMessage ? (
            <article>
              <h1 className="text-lg font-semibold">{selectedMessage.subject}</h1>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {selectedMessage.from} · {selectedMessage.receivedAt}
              </p>
              <MailBody
                html={selectedMessage.html}
                blockRemoteImages={props.settings.blockRemoteImages}
              />
            </article>
          ) : (
            <p className="text-sm text-neutral-500">Select a message to read it.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Mail body renderer.
 *
 * The message is sanitised and then rendered inside an iframe whose sandbox
 * forbids scripts. `allow-scripts` and `allow-same-origin` are never combined —
 * together they would let the message reach Henna's own origin.
 */
function MailBody({
  html,
  blockRemoteImages,
}: {
  readonly html: string;
  readonly blockRemoteImages: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);

  const document = useMemo(() => {
    const clean = sanitizeMailHtml(html, {
      blockRemoteResources: blockRemoteImages,
      allowInlineImages: true,
    });
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:12px;word-wrap:break-word}
      img{max-width:100%;height:auto}
      a{color:inherit}
      blockquote{border-left:2px solid #ccc;margin:0;padding-left:12px;color:#666}
    </style></head><body>${clean}</body></html>`;
  }, [html, blockRemoteImages]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const onLoad = () => {
      try {
        const doc = frame.contentDocument;
        if (doc?.body) setHeight(Math.min(doc.body.scrollHeight + 24, 4000));
      } catch {
        // Cross-origin by design; leave the default height.
      }
    };
    frame.addEventListener("load", onLoad);
    return () => frame.removeEventListener("load", onLoad);
  }, [document]);

  return (
    <iframe
      ref={ref}
      title="Message body"
      sandbox={MAIL_IFRAME_SANDBOX}
      srcDoc={document}
      style={{ width: "100%", height, border: 0 }}
      // No referrer leaks the instance URL to a remote image host.
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
}

/** Exported for the local index and tests. */
export { mailPreview };
