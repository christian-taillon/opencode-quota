/**
 * OpenCode credential database reader
 *
 * Shared helper to read credentials from OpenCode's SQLite database.
 * Providers should prefer this to duplicating database/path parsing.
 */

import { existsSync } from "fs";
import { createRequire } from "module";
import { isAbsolute, join, resolve } from "path";

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import {
  getOpencodeRuntimeDirCandidates,
  getOpencodeRuntimeDirs,
} from "./opencode-runtime-paths.js";

import type { AuthData } from "./types.js";

const DEFAULT_AUTH_CACHE_MAX_AGE_MS = 5_000;
const runtimeRequire = createRequire(import.meta.url);

type CredentialDatabase = {
  close(): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
};

type CredentialDatabaseConstructor = new (
  path: string,
  options?: Record<string, unknown>,
) => CredentialDatabase;

type AuthCacheEntry = {
  timestamp: number;
  value: AuthData | null;
  inFlight?: Promise<AuthData | null>;
};

let authCache: AuthCacheEntry | null = null;

// ---------------------------------------------------------------------------
// Native multi-connection reader
// ---------------------------------------------------------------------------

/**
 * One OpenCode credential row with its parsed value.
 *
 * `value` contains the credential material (access tokens, keys, metadata).
 * It must never be logged, stringified, or exposed outside the quota query
 * layer.
 */
export type OpenCodeCredentialConnection = {
  readonly id: string;
  readonly integrationID: string;
  readonly label?: string;
  readonly value: Record<string, unknown>;
};

export type OpenCodeCredentialConnectionRead =
  | { state: "available"; connections: readonly OpenCodeCredentialConnection[] }
  | { state: "unavailable" };

type ConnectionCacheEntry = {
  timestamp: number;
  value: OpenCodeCredentialConnectionRead;
  inFlight?: Promise<OpenCodeCredentialConnectionRead>;
};

const connectionCache = new Map<string, ConnectionCacheEntry>();

/**
 * Get candidate legacy auth.json paths for Cursor OAuth compatibility.
 * Some OpenCode installations use Linux-style paths even on macOS, so we
 * check multiple locations.
 */
export function getAuthPaths(): string[] {
  // Generate legacy candidates from OpenCode runtime dir semantics (xdg-basedir)
  // plus platform fallbacks for alternate installs.
  const { dataDirs } = getOpencodeRuntimeDirCandidates();
  return dataDirs.map((d) => join(d, "auth.json"));
}

/** Returns the primary legacy auth.json path used for Cursor OAuth compatibility. */
export function getAuthPath(): string {
  return join(getOpencodeRuntimeDirs().dataDir, "auth.json");
}

/**
 * Get candidate OpenCode credential database paths in priority order.
 *
 * `OPENCODE_DB` overrides the normal runtime data-directory candidates.
 */
export function getCredentialDatabasePaths(): string[] {
  const { dataDirs } = getOpencodeRuntimeDirCandidates();
  return getCredentialDatabasePathsForDataDirs(dataDirs);
}

/** Returns OpenCode's primary credential database path for display/logging. */
export function getCredentialDatabasePath(): string {
  const paths = getCredentialDatabasePaths();
  if (paths[0]) return paths[0];
  return process.env.OPENCODE_DB?.trim() === ":memory:"
    ? ":memory:"
    : join(getOpencodeRuntimeDirs().dataDir, "opencode.db");
}

export async function readAuthFile(): Promise<AuthData | null> {
  return readCredentialDatabases(getCredentialDatabasePaths());
}

function readCredentialDatabases(paths: string[]): AuthData | null {
  for (const path of paths) {
    const auth = readCredentialDatabase(path);
    if (auth) return auth;
  }

  return null;
}

function getCredentialDatabasePathsForDataDirs(dataDirs: string[]): string[] {
  const override = process.env.OPENCODE_DB?.trim();
  if (override) {
    if (override === ":memory:") return [];
    return [
      isAbsolute(override)
        ? override
        : resolve(dataDirs[0] ?? getOpencodeRuntimeDirs().dataDir, override),
    ];
  }
  return dataDirs.map((dataDir) => join(dataDir, "opencode.db"));
}

function readCredentialDatabase(path: string): AuthData | null {
  if (!existsSync(path)) return null;

  let database: CredentialDatabase | undefined;
  try {
    database = openCredentialDatabase(path);
    const rows = database
      .prepare(
        "SELECT integration_id, value FROM credential WHERE integration_id IS NOT NULL ORDER BY time_updated DESC, id DESC",
      )
      .all() as Array<{ integration_id?: unknown; value?: unknown }>;
    const auth: Record<string, unknown> = {};

    for (const row of rows) {
      if (
        typeof row.integration_id !== "string" ||
        typeof row.value !== "string" ||
        row.integration_id in auth
      )
        continue;
      const value = parseCredentialValue(row.value);
      if (value) auth[row.integration_id] = value;
    }

    return Object.keys(auth).length > 0 ? (auth as AuthData) : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function openCredentialDatabase(path: string): CredentialDatabase {
  if ("Bun" in globalThis) {
    const { Database } = runtimeRequire("bun:sqlite") as {
      Database: CredentialDatabaseConstructor;
    };
    return new Database(path, { readonly: true });
  }

  const { DatabaseSync } = runtimeRequire("node:sqlite") as {
    DatabaseSync: CredentialDatabaseConstructor;
  };
  return new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
}

function parseCredentialValue(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const credential = parsed as Record<string, unknown>;
    const metadata = credential.metadata;
    const authEntry = {
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      ...credential,
    };
    if (authEntry.type === "key" && typeof authEntry.key === "string") {
      authEntry.type = "api";
    }
    return authEntry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multi-connection database reader (native OpenCode V2)
// ---------------------------------------------------------------------------

function getCredentialColumnNames(database: CredentialDatabase): Set<string> {
  const rows = database.prepare("PRAGMA table_info(credential)").all() as Array<{
    name?: unknown;
  }>;
  return new Set(
    rows.map((row) => row.name).filter((name): name is string => typeof name === "string"),
  );
}

function readCredentialConnectionsFromDatabase(
  path: string,
  integrationID: string,
): OpenCodeCredentialConnectionRead {
  if (!existsSync(path)) return { state: "unavailable" };

  let database: CredentialDatabase | undefined;
  try {
    database = openCredentialDatabase(path);
    const columns = getCredentialColumnNames(database);

    if (!columns.has("id") || !columns.has("integration_id") || !columns.has("value")) {
      return { state: "unavailable" };
    }

    const labelExpression = columns.has("label") ? "label" : "NULL AS label";
    const orderBy = columns.has("time_created")
      ? "time_created ASC, id ASC"
      : columns.has("time_updated")
        ? "time_updated ASC, id ASC"
        : "id ASC";

    const rows = database
      .prepare(
        `SELECT id, integration_id, ${labelExpression}, value FROM credential WHERE integration_id = ? ORDER BY ${orderBy}`,
      )
      .all(integrationID) as Array<{
      id?: unknown;
      integration_id?: unknown;
      label?: unknown;
      value?: unknown;
    }>;

    const connections: OpenCodeCredentialConnection[] = [];

    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.integration_id !== "string" ||
        typeof row.value !== "string"
      ) {
        continue;
      }

      const value = parseCredentialValue(row.value);
      if (!value) continue;

      const labelValue =
        typeof row.label === "string" ? sanitizeSingleLineDisplayText(row.label).trim() : "";

      connections.push({
        id: row.id,
        integrationID: row.integration_id,
        ...(labelValue ? { label: labelValue.slice(0, 80) } : {}),
        value,
      });
    }

    return { state: "available", connections };
  } catch {
    return { state: "unavailable" };
  } finally {
    database?.close();
  }
}

function readCredentialConnectionsFromDatabases(
  paths: string[],
  integrationID: string,
): OpenCodeCredentialConnectionRead {
  for (const path of paths) {
    const result = readCredentialConnectionsFromDatabase(path, integrationID);
    if (result.state === "available") return result;
  }
  return { state: "unavailable" };
}

/**
 * Read all OpenCode native credential connections for a given integration ID.
 *
 * Unlike {@link readAuthFile} which collapses to one credential per
 * integration, this returns every matching row so multi-account quota can
 * query each connection independently.
 *
 * The database is opened read-only. Credential values are never logged.
 */
export async function readCredentialConnections(
  integrationID: string,
): Promise<OpenCodeCredentialConnectionRead> {
  return readCredentialConnectionsFromDatabases(getCredentialDatabasePaths(), integrationID);
}

/**
 * Cached multi-connection reader for frequently triggered code paths (e.g.
 * sidebar refresh). Uses the same 5-second max age as the legacy auth cache.
 */
export async function readCredentialConnectionsCached(
  integrationID: string,
  params?: { maxAgeMs?: number },
): Promise<OpenCodeCredentialConnectionRead> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_AUTH_CACHE_MAX_AGE_MS);
  const now = Date.now();
  const cacheKey = integrationID;

  const existing = connectionCache.get(cacheKey);
  if (existing && now - existing.timestamp <= maxAgeMs) {
    return existing.value;
  }

  if (existing?.inFlight) {
    return existing.inFlight;
  }

  const inFlight = (async () => {
    const value = await readCredentialConnections(integrationID);
    connectionCache.set(cacheKey, { timestamp: Date.now(), value });
    return value;
  })();

  connectionCache.set(cacheKey, {
    timestamp: existing?.timestamp ?? 0,
    value: existing?.value ?? { state: "unavailable" },
    inFlight,
  });

  try {
    return await inFlight;
  } finally {
    const entry = connectionCache.get(cacheKey);
    if (entry?.inFlight === inFlight) {
      entry.inFlight = undefined;
    }
  }
}

/**
 * Cached auth reader for frequently triggered code paths (e.g. per-question hooks).
 * This avoids repeated filesystem reads while keeping auth updates visible quickly.
 */
export async function readAuthFileCached(params?: { maxAgeMs?: number }): Promise<AuthData | null> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_AUTH_CACHE_MAX_AGE_MS);
  const now = Date.now();

  if (authCache && now - authCache.timestamp <= maxAgeMs) {
    return authCache.value;
  }

  if (authCache?.inFlight) {
    return authCache.inFlight;
  }

  const inFlight = (async () => {
    const value = await readAuthFile();
    authCache = { timestamp: Date.now(), value };
    return value;
  })();

  authCache = {
    timestamp: authCache?.timestamp ?? 0,
    value: authCache?.value ?? null,
    inFlight,
  };

  try {
    return await inFlight;
  } finally {
    if (authCache?.inFlight === inFlight) {
      authCache.inFlight = undefined;
    }
  }
}

/** Test helper to clear cached auth state between test cases. */
export function clearReadAuthFileCacheForTests(): void {
  authCache = null;
  connectionCache.clear();
}
