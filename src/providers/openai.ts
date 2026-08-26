/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
  queryOpenAIQuotaForCredential,
  resolveOpenAIOAuth,
} from "../lib/openai.js";
import { readAuthFileCached } from "../lib/opencode-auth.js";
import {
  type NativeConnectionRef,
  toOpenAIQuotaCredential,
} from "../lib/opencode-v2-connections.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

type OpenAISuccess = Extract<
  Awaited<ReturnType<typeof queryOpenAIQuotaForCredential>>,
  { success: true }
>;

type NativeOpenAIObservation = {
  connection: NativeConnectionRef;
  result?: Awaited<ReturnType<typeof queryOpenAIQuotaForCredential>>;
  resolutionError?: boolean;
};

function displayConnectionLabel(connection: NativeConnectionRef): string | undefined {
  const label = sanitizeDisplayText(connection.label ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return label || undefined;
}

function nativeConnectionGroup(
  connection: NativeConnectionRef,
  planLabel: string,
  counts: Map<string, number>,
): string {
  const safePlanLabel = sanitizeDisplayText(planLabel).replace(/\s+/gu, " ").trim() || "OpenAI";
  const label = displayConnectionLabel(connection);
  const base = label ? `${safePlanLabel} · ${label}` : safePlanLabel;
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  return count === 1 ? base : `${base} #${count}`;
}

function nativeConnectionErrorLabel(connection: NativeConnectionRef): string {
  const label = displayConnectionLabel(connection);
  return label ? `OpenAI · ${label}` : "OpenAI";
}

function entriesForNativeResult(
  result: OpenAISuccess,
  connection: NativeConnectionRef,
  group: string,
): ReturnType<typeof groupedPercentWindowEntries> {
  return groupedPercentWindowEntries({
    group,
    accounting: {
      resultType: "rate_limit",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      sourceId: `openai:${connection.id}`,
    },
    windows: [
      { window: result.windows.hourly, suffix: "5h", label: "5h:" },
      { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
      { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
      { window: result.windows.codeReview, suffix: "Code Review", label: "Code Review:" },
    ],
  });
}

function nativeStatusDetails(values: {
  connectionCount: number;
  usableConnectionCount: number;
  successfulConnectionCount: number;
  failedConnectionCount: number;
}): ReturnType<typeof statusDetailsFromRecord> {
  return statusDetailsFromRecord({
    auth_configured: values.connectionCount > 0 ? "true" : "false",
    auth_source: "native_v2_connections",
    connection_count: String(values.connectionCount),
    usable_connection_count: String(values.usableConnectionCount),
    successful_connection_count: String(values.successfulConnectionCount),
    failed_connection_count: String(values.failedConnectionCount),
  });
}

async function fetchNativeOpenAIQuota(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
  const nativeConnections = ctx.nativeConnections;
  if (!nativeConnections) return attemptedResult([]);
  let connections: readonly NativeConnectionRef[];
  try {
    connections = [...(await nativeConnections.list("openai"))].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  } catch {
    return withStatusDetails(
      attemptedResult(
        [],
        [
          {
            label: "OpenAI",
            message: "Failed to enumerate native OpenAI connections",
            retryable: true,
          },
        ],
      ),
      nativeStatusDetails({
        connectionCount: 0,
        usableConnectionCount: 0,
        successfulConnectionCount: 0,
        failedConnectionCount: 1,
      }),
    );
  }

  const observations: NativeOpenAIObservation[] = [];
  let usableConnectionCount = 0;
  let successfulConnectionCount = 0;
  let failedConnectionCount = 0;

  for (const connection of connections) {
    try {
      const resolved = await nativeConnections.resolve(connection);
      const credential = toOpenAIQuotaCredential(resolved);
      if (!credential) {
        observations.push({ connection });
        continue;
      }

      usableConnectionCount += 1;
      const result = await queryOpenAIQuotaForCredential(credential, {
        requestTimeoutMs: ctx.config?.requestTimeoutMs,
      });
      if (result.success) successfulConnectionCount += 1;
      else failedConnectionCount += 1;
      observations.push({ connection, result });
    } catch {
      failedConnectionCount += 1;
      observations.push({ connection, resolutionError: true });
    }
  }

  const groupCounts = new Map<string, number>();
  const entries = [] as ReturnType<typeof groupedPercentWindowEntries>;
  const errors: QuotaProviderResult["errors"] = [];

  for (const observation of observations) {
    const { connection, result } = observation;
    if (observation.resolutionError) {
      errors.push({
        label: nativeConnectionErrorLabel(connection),
        message: "Failed to resolve native OpenAI credential",
        retryable: true,
      });
      continue;
    }
    if (!result) continue;

    if (!result.success) {
      errors.push({
        label: nativeConnectionErrorLabel(connection),
        message: sanitizeDisplayText(result.error),
        ...(result.retryable === true ? { retryable: true } : {}),
      });
      continue;
    }

    const group = nativeConnectionGroup(connection, result.label, groupCounts);
    entries.push(...entriesForNativeResult(result, connection, group));
  }

  return withStatusDetails(
    attemptedResult(entries, errors),
    nativeStatusDetails({
      connectionCount: connections.length,
      usableConnectionCount,
      successfulConnectionCount,
      failedConnectionCount,
    }),
  );
}

export const openaiProvider: QuotaProvider = {
  id: "openai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    if (ctx.nativeConnections) return true;

    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "openai",
      fallbackOnError: true,
    });

    if (availableByProviderId) {
      return true;
    }

    return hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    if (ctx.nativeConnections) return fetchNativeOpenAIQuota(ctx);

    const auth = resolveOpenAIOAuth(await readAuthFileCached({ maxAgeMs: 5_000 }));
    const result = await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: "OpenAI",
      onSuccess: (result) =>
        attemptedResult(
          groupedPercentWindowEntries({
            group: result.label,
            accounting: {
              resultType: "rate_limit",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
            },
            windows: [
              { window: result.windows.hourly, suffix: "5h", label: "5h:" },
              { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
              { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
              { window: result.windows.codeReview, suffix: "Code Review", label: "Code Review:" },
            ],
          }),
          [],
          {
            singleWindowDisplayName: result.label,
          },
        ),
    });
    const configured = auth.state === "configured";
    const expiresAt = configured ? auth.expiresAt : undefined;
    return withStatusDetails(
      providerResult,
      statusDetailsFromRecord({
        auth_configured: configured ? "true" : "false",
        auth_source: configured ? auth.sourceKey : "(none)",
        token_status: !configured
          ? "(none)"
          : expiresAt && expiresAt < Date.now()
            ? "expired"
            : "valid",
        token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : "(none)",
        account_email: configured && auth.email ? sanitizeDisplayText(auth.email) : "(none)",
        account_id: configured && auth.accountId ? sanitizeDisplayText(auth.accountId) : "(none)",
      }),
    );
  },
};
