import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { parseInputOrThrow, userSettingsSchema, type UserSettingsInput } from "@/lib/validation/schemas";
import type { Principal } from "./types";

/**
 * Per-user preferences.
 *
 * Stored server-side only so they follow the user between browsers. They are
 * preferences — never mail content.
 */

export interface UserSettingsDto {
  readonly signature: string;
  readonly theme: "system" | "light" | "dark";
  readonly messagesPerPage: number;
  readonly blockRemoteImages: boolean;
  readonly transitionsEnabled: boolean;
}

function toDto(row: typeof userSettings.$inferSelect): UserSettingsDto {
  return {
    signature: row.signature ?? "",
    theme: row.theme === "light" || row.theme === "dark" ? row.theme : "system",
    messagesPerPage: row.messagesPerPage,
    blockRemoteImages: row.blockRemoteImages === 1,
    transitionsEnabled: row.transitionsEnabled === 1,
  };
}

export const DEFAULT_USER_SETTINGS: UserSettingsDto = {
  signature: "",
  theme: "system",
  messagesPerPage: 25,
  blockRemoteImages: true,
  transitionsEnabled: true,
};

export async function getUserSettings(principal: Principal): Promise<UserSettingsDto> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, principal.userId));
  return row ? toDto(row) : DEFAULT_USER_SETTINGS;
}

export async function updateUserSettings(
  principal: Principal,
  input: unknown,
): Promise<UserSettingsDto> {
  const parsed: UserSettingsInput = parseInputOrThrow(userSettingsSchema, input);
  const db = getDb();

  await db
    .insert(userSettings)
    .values({
      userId: principal.userId,
      signature: parsed.signature,
      theme: parsed.theme,
      messagesPerPage: parsed.messagesPerPage,
      blockRemoteImages: parsed.blockRemoteImages ? 1 : 0,
      transitionsEnabled: parsed.transitionsEnabled ? 1 : 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        signature: parsed.signature,
        theme: parsed.theme,
        messagesPerPage: parsed.messagesPerPage,
        blockRemoteImages: parsed.blockRemoteImages ? 1 : 0,
        transitionsEnabled: parsed.transitionsEnabled ? 1 : 0,
        updatedAt: new Date(),
      },
    });

  return {
    signature: parsed.signature,
    theme: parsed.theme,
    messagesPerPage: parsed.messagesPerPage,
    blockRemoteImages: parsed.blockRemoteImages,
    transitionsEnabled: parsed.transitionsEnabled,
  };
}
