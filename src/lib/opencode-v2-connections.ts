/**
 * OpenCode V2 native credential connection access.
 *
 * The TUI reads OpenCode's SQLite credential database directly to enumerate
 * and resolve native connections. This avoids any server→TUI module-global
 * bridge: the TUI and server plugins are separate runtimes that do not share
 * module state.
 *
 * The database is always opened read-only. Credential values are never logged.
 */

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type { OpenAIQuotaCredential } from "./openai.js";
import {
  type OpenCodeCredentialConnection,
  readCredentialConnectionsCached,
} from "./opencode-auth.js";

export type NativeConnectionRef = {
  readonly id: string;
  readonly label?: string;
};

export interface NativeConnectionAccess {
  list(integrationID: string): Promise<readonly NativeConnectionRef[]>;
  resolve(connection: NativeConnectionRef): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Database-backed connection access (used by TUI runtime)
// ---------------------------------------------------------------------------

/**
 * Create a {@link NativeConnectionAccess} backed by OpenCode's SQLite
 * credential database. Both `list` and `resolve` read from the same
 * database query (cached for the sidebar refresh interval).
 */
export function createNativeConnectionAccess(): NativeConnectionAccess {
  const connectionMap = new Map<string, OpenCodeCredentialConnection>();

  return {
    async list(integrationID: string): Promise<readonly NativeConnectionRef[]> {
      const result = await readCredentialConnectionsCached(integrationID);
      if (result.state !== "available") return [];

      connectionMap.clear();
      const refs: NativeConnectionRef[] = [];

      for (const connection of result.connections) {
        connectionMap.set(connection.id, connection);
        const label =
          typeof connection.label === "string"
            ? sanitizeSingleLineDisplayText(connection.label).slice(0, 80)
            : undefined;
        refs.push({
          id: connection.id,
          ...(label ? { label } : {}),
        });
      }

      return refs;
    },

    async resolve(connection: NativeConnectionRef): Promise<unknown> {
      const raw = connectionMap.get(connection.id);
      if (!raw) throw new Error("Unknown OpenCode V2 native connection");
      return raw.value;
    },
  };
}

// ---------------------------------------------------------------------------
// Test helper: create a connection access with a custom resolve function.
// Used by unit tests that mock credential resolution.
// ---------------------------------------------------------------------------

export function createNativeConnectionAccessForTest(params: {
  list: (integrationID: string) => Promise<readonly NativeConnectionRef[]>;
  resolve: (connection: NativeConnectionRef) => Promise<unknown>;
}): NativeConnectionAccess {
  return {
    list: params.list,
    resolve: params.resolve,
  };
}

// ---------------------------------------------------------------------------
// Credential conversion (moved here from the original module; used by the
// OpenAI provider to convert raw credential values to quota query input).
// ---------------------------------------------------------------------------

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.metadata) ? value.metadata : undefined;
}

function readMetadataString(
  credential: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const direct = credential[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const nested = metadata?.[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return undefined;
}

export function toOpenAIQuotaCredential(value: unknown): OpenAIQuotaCredential | null {
  if (!isRecord(value) || value.type !== "oauth") return null;

  const accessToken = typeof value.access === "string" ? value.access.trim() : "";
  if (!accessToken) return null;

  const metadata = metadataRecord(value);
  const expiresAt =
    typeof value.expires === "number" && Number.isFinite(value.expires) ? value.expires : undefined;
  const accountId = readMetadataString(value, metadata, ["accountId", "chatgpt_account_id"]);
  const accountUserId = readMetadataString(value, metadata, [
    "accountUserId",
    "chatgpt_account_user_id",
  ]);
  const email = readMetadataString(value, metadata, ["email"]);

  return {
    accessToken,
    ...(accountId ? { accountId } : {}),
    ...(accountUserId ? { accountUserId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(email ? { email } : {}),
  };
}
