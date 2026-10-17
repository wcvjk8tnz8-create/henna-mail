import { randomBytes } from "node:crypto";
import { resetEnvCache, setEnvSource } from "@/lib/config/env";
import { resetKeyring } from "@/lib/crypto/keyring";

/**
 * Test fixtures for the root configuration layer.
 *
 * `HENNA_CREDENTIAL_KEY` is read through `lib/config`, which validates the
 * whole root environment before handing anything over. Tests therefore install
 * a complete, valid root configuration rather than poking at one variable.
 */

let state: Record<string, string | undefined> = {};

export function installTestEnv(overrides: Record<string, string | undefined> = {}): void {
  state = {
    DOMAIN: '["example.com","henna.test"]',
    ADMIN: "root@example.com",
    jwt_secret: "testjwtsecretvalue0123456789abcdef",
    HENNA_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
    NODE_ENV: "test",
    ...overrides,
  };
  setEnvSource(() => state);
  resetEnvCache();
  resetKeyring();
}

export function patchTestEnv(patch: Record<string, string | undefined>): void {
  state = { ...state, ...patch };
  resetEnvCache();
  resetKeyring();
}

export function clearTestEnv(): void {
  state = {};
  resetEnvCache();
  resetKeyring();
}

export function currentTestEnv(): Record<string, string | undefined> {
  return { ...state };
}
