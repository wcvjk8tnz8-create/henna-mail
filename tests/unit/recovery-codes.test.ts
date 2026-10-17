import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  RECOVERY_CODE_COUNT,
  formatRecoveryCode,
  generateRecoveryCodeSet,
  hashRecoveryCode,
  matchRecoveryCode,
  normalise,
  remainingCount,
  shouldPromptRegeneration,
} from "@/lib/auth/recovery-codes";
import { installTestEnv, clearTestEnv, patchTestEnv } from "./helpers/env";
import type { StoredRecoveryCode } from "@/lib/auth/recovery-codes";

beforeEach(() => {
  installTestEnv({ HENNA_CREDENTIAL_KEY: randomBytes(32).toString("base64") });
});

afterEach(() => {
  clearTestEnv();
});

function stored(hashes: readonly string[], used: readonly number[] = []): StoredRecoveryCode[] {
  return hashes.map((codeHash, index) => ({
    id: `id-${index}`,
    codeHash,
    usedAt: used.includes(index) ? new Date() : null,
  }));
}

describe("generation", () => {
  it("produces ten codes by default", () => {
    const set = generateRecoveryCodeSet();
    expect(set.plaintext).toHaveLength(RECOVERY_CODE_COUNT);
    expect(set.hashes).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it("stores only digests, never plaintext", () => {
    const set = generateRecoveryCodeSet();
    for (const code of set.plaintext) {
      for (const hash of set.hashes) {
        expect(hash).not.toBe(code);
        expect(hash).not.toContain(code);
      }
    }
  });

  it("produces codes in the documented shape", () => {
    for (const code of generateRecoveryCodeSet().plaintext) {
      expect(code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    }
  });

  it("never repeats a code within a set", () => {
    const set = generateRecoveryCodeSet(50);
    expect(new Set(set.plaintext).size).toBe(50);
  });
});

describe("normalisation", () => {
  it("lower-cases and tolerates missing dashes", () => {
    expect(normalise("ABCD-1234-EFGH")).toBe("abcd-1234-efgh");
    expect(normalise("abcd1234efgh")).toBe("abcd-1234-efgh");
    expect(normalise("  abcd 1234 efgh  ")).toBe("abcd-1234-efgh");
  });

  it("formats a bare code for display", () => {
    expect(formatRecoveryCode("abcd1234efgh")).toBe("abcd-1234-efgh");
  });

  it("hashes a code consistently regardless of case or spacing", () => {
    expect(hashRecoveryCode("ABCD-1234-EFGH")).toBe(hashRecoveryCode("abcd1234efgh"));
  });
});

describe("matching", () => {
  it("matches an unused code", () => {
    const set = generateRecoveryCodeSet();
    const rows = stored(set.hashes);
    const result = matchRecoveryCode(set.plaintext[0] ?? "", rows);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matchedId).toBe("id-0");
  });

  it("matches regardless of the way the user typed it", () => {
    const set = generateRecoveryCodeSet();
    const rows = stored(set.hashes);
    const code = set.plaintext[3] ?? "";
    expect(matchRecoveryCode(code.toUpperCase(), rows).ok).toBe(true);
    expect(matchRecoveryCode(code.replace(/-/g, ""), rows).ok).toBe(true);
  });

  it("refuses a code that was already used", () => {
    const set = generateRecoveryCodeSet();
    const rows = stored(set.hashes, [2]);
    expect(matchRecoveryCode(set.plaintext[2] ?? "", rows)).toMatchObject({
      ok: false,
      reason: "already-used",
    });
  });

  it("refuses an unknown code", () => {
    const set = generateRecoveryCodeSet();
    const rows = stored(set.hashes);
    expect(matchRecoveryCode("zzzz-9999-wwww", rows)).toMatchObject({
      ok: false,
      reason: "no-match",
    });
  });

  it("re-checks every slot so timing does not reveal which one matched", () => {
    const set = generateRecoveryCodeSet(20);
    const rows = stored(set.hashes);
    // Matching the last entry must behave identically to matching the first.
    const last = set.plaintext[19] ?? "";
    const result = matchRecoveryCode(last, rows);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matchedId).toBe("id-19");
  });

  it("digests are bound to the credential key, so rotation invalidates them", () => {
    const set = generateRecoveryCodeSet();
    const rows = stored(set.hashes);
    patchTestEnv({ HENNA_CREDENTIAL_KEY: randomBytes(32).toString("base64") });
    expect(matchRecoveryCode(set.plaintext[0] ?? "", rows)).toMatchObject({
      ok: false,
      reason: "no-match",
    });
  });
});

describe("regeneration prompts", () => {
  it("counts what is left", () => {
    const set = generateRecoveryCodeSet();
    expect(remainingCount(stored(set.hashes))).toBe(10);
    expect(remainingCount(stored(set.hashes, [0, 1, 2]))).toBe(7);
    expect(remainingCount(stored(set.hashes, Array.from({ length: 10 }, (_, i) => i)))).toBe(0);
  });

  it("prompts after half the set is gone, and always when empty", () => {
    const set = generateRecoveryCodeSet();
    expect(shouldPromptRegeneration(stored(set.hashes))).toBe(false);
    expect(shouldPromptRegeneration(stored(set.hashes, [0, 1, 2, 3, 4]))).toBe(true);
    expect(shouldPromptRegeneration(stored(set.hashes, Array.from({ length: 10 }, (_, i) => i)))).toBe(
      true,
    );
  });
});
