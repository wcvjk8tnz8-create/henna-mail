import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, AuthzError, redirectTargetFor } from "@/lib/dal/guards";
import { exportAuditLog, readAuditLog } from "@/lib/dal/audit";
import { parseInput, auditQuerySchema, paramsToObject } from "@/lib/validation/schemas";
import { validateCsrfToken, CSRF_COOKIE, CSRF_HEADER } from "@/lib/security/csrf";

/**
 * Audit log page and export endpoint.
 *
 * The page is a Server Component guarded by `requireAdmin()`. The export route
 * is a custom Route Handler, so it gets an explicit CSRF check on top — Next.js
 * only protects Server Actions automatically.
 */

export const metadata = { title: "Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AuthzError) redirect(redirectTargetFor(error));
    throw error;
  }

  const parsed = parseInput(auditQuerySchema, await searchParams);
  const query = parsed.ok ? parsed.value : { limit: 50, offset: 0 };
  const page = await readAuditLog(query);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-6 flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <span className="text-sm text-neutral-500">{page.total} events</span>
        <a href="/admin/settings" className="ml-auto text-sm underline">
          Instance settings
        </a>
      </header>

      <p className="mb-6 rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm dark:border-neutral-700 dark:bg-neutral-900">
        The log is append-only. Nothing in Henna can edit or delete an entry, and no entry ever
        contains a password, a code or a decrypted credential.
      </p>

      <form method="get" className="mb-6 flex flex-wrap gap-2">
        <input
          name="action"
          placeholder="Filter by action"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <select
          name="result"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">Any result</option>
          <option value="success">Success</option>
          <option value="denied">Denied</option>
          <option value="error">Error</option>
        </select>
        <input
          name="from"
          type="date"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          className="rounded-md bg-henna-600 px-3 py-1.5 text-sm font-semibold text-white"
        >
          Filter
        </button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Resource</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.id} className="border-t border-neutral-100 dark:border-neutral-900">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-500">
                  {row.timestamp.toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="px-3 py-2 text-xs">{row.actorEmail ?? row.actorId ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.action}</td>
                <td className="px-3 py-2 text-xs">
                  {row.resourceType}
                  {row.resourceId ? ` · ${row.resourceId.slice(0, 8)}` : ""}
                </td>
                <td className="px-3 py-2 text-xs">
                  <span
                    className={
                      row.result === "success"
                        ? "text-green-700 dark:text-green-400"
                        : row.result === "denied"
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-red-700 dark:text-red-400"
                    }
                  >
                    {row.result}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {page.rows.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No events match those filters.</p>
      ) : null}

      <p className="mt-6 text-xs text-neutral-500">
        Signed in as {admin.email}. Exports are recorded in the log as well — use the API endpoint
        with your CSRF token.
      </p>
    </main>
  );
}

/** CSV export. CSRF-protected because it is a custom Route Handler. */
export async function GET(request: NextRequest) {
  const parsed = parseInput(auditQuerySchema, paramsToObject(request.nextUrl.searchParams));
  const query = parsed.ok ? parsed.value : { limit: 500, offset: 0 };

  const cookie = request.cookies.get(CSRF_COOKIE)?.value ?? null;
  const header = request.headers.get(CSRF_HEADER);
  const sessionId = request.cookies.get("henna_session")?.value ?? null;

  if (!validateCsrfToken({ cookieValue: cookie, headerValue: header, sessionId })) {
    return NextResponse.json({ error: "csrf" }, { status: 403 });
  }

  const csv = await exportAuditLog(query);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="henna-audit.csv"',
      "cache-control": "no-store",
    },
  });
}
