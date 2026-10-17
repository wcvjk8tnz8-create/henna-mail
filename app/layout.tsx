import { ensureSchema } from "@/db";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Henna",
    template: "%s · Henna",
  },
  description:
    "Henna is a security-first, self-hostable webmail frontend. Your mail never touches Henna's server.",
  // Mail content must never be indexed or previewed by a crawler.
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdf6f3" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Creates the schema on first request when running on D1, so a deploy that
  // skipped the migration step still comes up working.
  await ensureSchema();

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
