/**
 * The single configuration entry point.
 *
 * Application code imports from `lib/config` and never touches `process.env`
 * directly. That keeps the "environment for root secrets, database for
 * everything else" split verifiable in one place, and it gives tests a single
 * seam to stub.
 */

export {
  ConfigError,
  getAdminEmail,
  getBaseUrl,
  getCredentialKeyRaw,
  getJwtSecret,
  getMailDomains,
  getRootConfig,
  isProduction,
  rawEnv,
  resetEnvCache,
  setEnvSource,
  tryGetRootConfig,
  assertNoSecretIsPublic,
} from "./env";

export {
  getInstanceSecrets,
  getInstanceSettings,
  getPublicInstanceSettings,
  getSecretKeyIds,
  resetSettingsCache,
  updateInstanceSettings,
  SettingsValidationError,
  type InstanceSecrets,
  type PublicInstanceSettings,
} from "./settings";

export {
  DEFAULT_INSTANCE_SETTINGS,
  authMethodSchema,
  domainListSchema,
  emailSchema,
  instanceSettingsSchema,
  jwtSecretSchema,
  registrationModeSchema,
  totpPolicySchema,
  updateSettingsSchema,
  type AuthMethod,
  type InstanceSettings,
  type RegistrationMode,
  type RootEnv,
  type TotpPolicy,
  type UpdateSettingsInput,
} from "./schema";

import { getInstanceSettings, type InstanceSettings } from "./settings";
import type { TotpPolicy } from "./schema";

export { isManagedAddress, domainOf, normaliseEmail } from "./domains";

export async function getTotpPolicy(): Promise<TotpPolicy> {
  const settings: InstanceSettings = await getInstanceSettings();
  return settings.totpPolicy;
}

export async function isAuthMethodEnabled(
  method: InstanceSettings["authMethods"][number],
): Promise<boolean> {
  const settings = await getInstanceSettings();
  return settings.authMethods.includes(method);
}
