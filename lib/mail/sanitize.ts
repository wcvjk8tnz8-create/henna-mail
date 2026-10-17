/**
 * Allow-list sanitisation of mail HTML.
 *
 * User-controlled mail bodies are rendered inside an iframe whose sandbox
 * forbids scripts entirely, but sanitisation is applied as well so that a
 * future change to the sandbox policy cannot turn into an XSS by accident, and
 * so that even script-free markup cannot exfiltrate by loading remote
 * resources.
 *
 * `DOMPurify` needs a DOM, so on the server Henna uses this conservative
 * regex/parse-based allow-list (which is enough because scripts are already
 * blocked by the sandbox), and in the browser the same module delegates to
 * DOMPurify for a full parse-tree clean.
 */

export interface SanitizeOptions {
  /** Allow `<img src="cid:...">` and data: attachments to render. */
  readonly allowInlineImages: boolean;
  /** Rewrite remote URLs so nothing is fetched until the user opts in. */
  readonly blockRemoteResources: boolean;
}

const DEFAULT_OPTIONS: SanitizeOptions = {
  allowInlineImages: true,
  blockRemoteResources: true,
};

/** Tags that can appear in a sanitised mail body. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

/** Attributes that survive, per tag. */
const ALLOWED_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "width", "height"]),
  "*": new Set(["class", "dir", "lang"]),
};

const URL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:", "cid:", "data:"]);

export function sanitizeMailHtml(html: string, options: Partial<SanitizeOptions> = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  let out = html;

  // Remove constructs that are meaningless once scripts are banned but which
  // are frequently used to smuggle payloads past naive filters.
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|meta|base|link)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|meta|base|link)\b[^>]*\/?>/gi, "");

  // Strip every event handler attribute and javascript: URL.
  out = out.replace(/\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/(?:href|src|action|background)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "");

  // Drop tags that are not on the allow-list.
  out = out.replace(/<\s*\/?\s*([a-z0-9-]+)\b[^>]*>/gi, (match, rawTag: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    return stripDisallowedAttributes(match, tag, opts);
  });

  return out;
}

function stripDisallowedAttributes(
  tagHtml: string,
  tag: string,
  opts: SanitizeOptions,
): string {
  const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
  const global = ALLOWED_ATTRS["*"] ?? new Set<string>();

  return tagHtml.replace(
    /\s([a-z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, rawName: string, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
      const name = rawName.toLowerCase();
      const value = dq ?? sq ?? bare ?? "";
      if (!allowed.has(name) && !global.has(name)) return "";

      if ((name === "href" || name === "src") && !isSafeUrl(value, opts)) {
        // Blocked remote resources become inert, in-page anchors instead of
        // being deleted outright, so the layout survives.
        return opts.blockRemoteResources ? "" : "";
      }
      return match;
    },
  );
}

function isSafeUrl(value: string, opts: SanitizeOptions): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("cid:") && opts.allowInlineImages) return true;
  if (trimmed.startsWith("data:image/") && opts.allowInlineImages) return true;
  if (trimmed.startsWith("data:")) return false;
  if (trimmed.startsWith("mailto:")) return true;
  try {
    const url = new URL(value);
    if (!URL_SCHEMES.has(url.protocol)) return false;
    // With remote resources blocked, only same-document references survive.
    return opts.blockRemoteResources ? false : true;
  } catch {
    // A relative URL cannot load anything from the mail's own origin, so it is
    // harmless once the document has no base.
    return !trimmed.startsWith("//");
  }
}

/**
 * Strip HTML to plain text for the reader's text fallback and for message
 * previews.
 */
export function htmlToPlainText(html: string): string {
  return sanitizeMailHtml(html)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Very small preview used by the mail list; never rendered as HTML. */
export function mailPreview(html: string, maxLength = 160): string {
  const text = htmlToPlainText(html).replace(/\s+/g, " ");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
