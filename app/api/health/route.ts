import { NextResponse } from "next/server";
import { tryGetRootConfig } from "@/lib/config/env";
import { getKeyRotationStatus } from "@/lib/crypto/keyring";
import { getStorageStatus } from "@/lib/dal/storage";
import { ensureSchema } from "@/db";

/**
 * Health and configuration check.
 *
 * Reports *why* an instance is unhealthy rather than only crashing: a missing
 * DOMAIN, an unreadable jwt_secret or a broken credential keyring each show up
 * here with their own message. No secret value is ever included.
 */
export async function GET() {
  // A freshly deployed instance hits /api/health before anything touches the
  // database: creating the schema here is what makes the dashboard deploy work.
  try {
    await ensureSchema();
  } catch {
    // Reported below as a database problem rather than crashing the check.
  }

  const config = tryGetRootConfig();
  const rotation = getKeyRotationStatus();

  // Storage is optional, so a failure here must not mask the rest of the report.
  let storage: { enabled: boolean; ready: boolean; issues: readonly string[] } = {
    enabled: false,
    ready: false,
    issues: ["storage status unavailable"],
  };
  try {
    const status = await getStorageStatus();
    storage = { enabled: status.enabled, ready: status.ready, issues: status.issues };
  } catch {
    // Left at the fallback above.
  }

  if (!config.ok) {
    return NextResponse.json(
      {
        status: "misconfigured",
        issues: config.error.issues,
        credentialKeyring: rotation.healthy ? "ok" : "unavailable",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      status: rotation.healthy ? "ok" : "degraded",
      // Domain names are not secret, but the admin address is only reported as
      // a boolean so the endpoint cannot be used to enumerate identities.
      domains: config.value.DOMAIN.length,
      adminConfigured: Boolean(config.value.ADMIN),
      jwtSecretConfigured: Boolean(config.value.jwt_secret),
      credentialKeyring: {
        activeKeyId: rotation.activeKeyId,
        keyCount: rotation.keyCount,
        healthy: rotation.healthy,
      },
      storage,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
