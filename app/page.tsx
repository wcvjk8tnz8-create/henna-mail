import { redirect } from "next/navigation";
import { resolveSessionFromCookies } from "@/lib/dal/session";

/** Send visitors to the right place; the DAL makes the real decision. */
export default async function HomePage() {
  const resolved = await resolveSessionFromCookies();
  if (!resolved) redirect("/login");
  redirect(resolved.principal.mfaSatisfied ? "/inbox" : "/mfa");
}
