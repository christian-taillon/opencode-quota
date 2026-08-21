import { createHash } from "crypto";
import { readdir, readFile, rm, stat } from "fs/promises";
import { join } from "path";
import { accountingUnitsEqual, isCanonicalAccountingDecimal } from "./accounting-format.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { sanitizeQuotaProviderResult, sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type {
  AccountingPercentageBasis,
  AccountingQuantity,
  AccountingSemantic,
  AccountingUnit,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "./entries.js";
import { cloneQuotaToastEntry } from "./entries.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getQuotaProviderDisplayLabel, isLiveLocalUsageProviderId } from "./provider-metadata.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import {
  QUOTA_PROVIDERS_AGGREGATE_ID,
  selectEligibleQuotaProviderDefinitions,
} from "./quota-providers.js";
import { updateQuotaTelemetrySnapshot } from "./quota-telemetry.js";
import { getPackageVersion } from "./version.js";

const QUOTA_PROVIDER_CACHE_VERSION = 2 as const;
const QUOTA_PROVIDER_CACHE_PACKAGE_VERSION_FALLBACK = "unknown";
const QUOTA_PROVIDER_CACHE_DIRNAME = "quota-provider-state";
const QUOTA_PROVIDER_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const QUOTA_PROVIDER_CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type PersistedQuotaProviderCacheEntry = {
  version: typeof QUOTA_PROVIDER_CACHE_VERSION;
  packageVersion: string;
  key: string;
  providerId: string;
  timestamp: number;
  result: QuotaProviderResult;
};

const inMemoryCache = new Map<string, PersistedQuotaProviderCacheEntry>();
const inFlightByKey = new Map<string, Promise<QuotaProviderResult>>();
let lastPruneAtMs = 0;

export function cloneQuotaProviderResult(result: QuotaProviderResult): QuotaProviderResult {
  return {
    attempted: result.attempted,
    entries: result.entries.map(cloneQuotaToastEntry),
    errors: result.errors.map((error) => ({ ...error })),
    ...(result.diagnostics
      ? {
          diagnostics: result.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            modelIds: diagnostic.modelIds ? [...diagnostic.modelIds] : null,
            checkedPaths: [...diagnostic.checkedPaths],
            authPaths: [...diagnostic.authPaths],
          })),
        }
      : {}),
    ...(result.statusDetails
      ? { statusDetails: result.statusDetails.map((detail) => ({ ...detail })) }
      : {}),
    ...(result.rawDetails
      ? { rawDetails: result.rawDetails.map((detail) => ({ ...detail })) }
      : {}),
    ...(result.presentation ? { presentation: { ...result.presentation } } : {}),
  };
}

export function buildQuotaProviderStateCacheKey(
  providerId: string,
  ctx: QuotaProviderContext,
  options: { runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[] } = {},
): string {
  const providerSchemaIdentity = providerId === "openai" ? "|labelSchema=plan-v1" : "";
  const googleModels = ctx.config.googleModels.join(",");
  const cursorPlan = ctx.config.cursorPlan;
  const cursorIncludedApiUsd = ctx.config.cursorIncludedApiUsd ?? "";
  const cursorBillingCycleStartDay = ctx.config.cursorBillingCycleStartDay ?? "";
  const opencodeGoWindows = ctx.config.opencodeGoWindows?.join(",") ?? "";
  const onlyCurrentModel = ctx.config.onlyCurrentModel ? "yes" : "no";
  const currentModel = ctx.config.currentModel ?? "";
  const currentProviderID = ctx.config.currentProviderID ?? "";
  const anthropicBinaryPath = ctx.config.anthropicBinaryPath ?? "";
  const isAggregateCache =
    providerId === QUOTA_PROVIDERS_AGGREGATE_ID ||
    providerId.startsWith(`${QUOTA_PROVIDERS_AGGREGATE_ID}:`);
  const relevantQuotaProviders = isAggregateCache
    ? (ctx.config.quotaProviders ?? [])
    : (ctx.config.quotaProviders ?? []).filter((definition) => definition.id === providerId);
  const quotaProvidersIdentity =
    relevantQuotaProviders.length > 0
      ? `|quotaProviders=${JSON.stringify(["quota-providers-cache-v1", relevantQuotaProviders])}`
      : "";
  const runtimeEligibleIdentity = isAggregateCache
    ? `|runtimeEligibleQuotaProviders=${JSON.stringify([
        "quota-providers-runtime-eligible-v1",
        options.runtimeEligibleQuotaProviders ?? [],
      ])}`
    : "";

  return `${providerId}${providerSchemaIdentity}${quotaProvidersIdentity}${runtimeEligibleIdentity}|anthropicBinaryPath=${anthropicBinaryPath}|googleModels=${googleModels}|cursorPlan=${cursorPlan}|cursorIncludedApiUsd=${cursorIncludedApiUsd}|cursorBillingCycleStartDay=${cursorBillingCycleStartDay}|opencodeGoWindows=${opencodeGoWindows}|onlyCurrentModel=${onlyCurrentModel}|currentModel=${currentModel}|currentProviderID=${currentProviderID}`;
}

function getQuotaProviderCacheDir(): string {
  return join(getOpencodeRuntimeDirs().cacheDir, QUOTA_PROVIDER_CACHE_DIRNAME);
}

export function getQuotaProviderStateCacheFilePath(providerId: string, key: string): string {
  const digest = createHash("sha1").update(key).digest("hex");
  return join(getQuotaProviderCacheDir(), `${providerId}-${digest}.json`);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_NAMED_METRIC_RE = /^[\p{L}\p{N}][\p{L}\p{N} .+&()_-]*$/u;
const SAFE_CUSTOM_SYMBOL_RE = /^[\p{L}\p{N}._-]+$/u;

function isOptionalIsoTimestamp(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      ISO_TIMESTAMP_RE.test(value) &&
      Number.isFinite(Date.parse(value)))
  );
}

function isAccountingMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      "resultType",
      "acquisitionMethod",
      "ownership",
      "authority",
      "sourceId",
      "observedAtIso",
    ]) &&
    isOneOf(value.resultType, [
      "quota",
      "rate_limit",
      "usage",
      "spend",
      "budget",
      "balance",
      "status",
    ]) &&
    isOneOf(value.acquisitionMethod, [
      "remote_api",
      "dashboard_scrape",
      "local_cli",
      "local_runtime_accounting",
      "local_estimation",
    ]) &&
    isOneOf(value.ownership, ["maintained", "user_configured"]) &&
    isOneOf(value.authority, ["provider_reported", "locally_derived"]) &&
    (value.sourceId === undefined || typeof value.sourceId === "string") &&
    isOptionalIsoTimestamp(value.observedAtIso)
  );
}

function isAccountingMetric(value: unknown, safeText: boolean): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "aggregate") return hasOnlyKeys(value, ["kind"]);
  if (value.kind === "window") {
    return (
      hasOnlyKeys(value, ["kind", "window"]) &&
      isOneOf(value.window, [
        "rpm",
        "hour",
        "five_hour",
        "day",
        "week",
        "month",
        "year",
        "mcp",
        "code_review",
      ])
    );
  }
  if (value.kind === "component") {
    return (
      hasOnlyKeys(value, ["kind", "component"]) &&
      isOneOf(value.component, [
        "current_balance",
        "total_balance",
        "cash_balance",
        "gift_balance",
        "granted_balance",
        "topped_up_balance",
        "remaining_credits",
        "auto_reload",
        "auto_reload_amount",
        "auto_reload_trigger",
      ])
    );
  }
  if (value.kind !== "named" || !hasOnlyKeys(value, ["kind", "name"])) return false;
  if (typeof value.name !== "string" || value.name.length > 64) return false;
  return (
    !safeText ||
    (value.name.length > 0 &&
      sanitizeSingleLineDisplayText(value.name) === value.name &&
      SAFE_NAMED_METRIC_RE.test(value.name))
  );
}

function isAccountingSemantic(value: unknown, safeText: boolean): value is AccountingSemantic {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["metric", "prominence"]) &&
    isAccountingMetric(value.metric, safeText) &&
    isOneOf(value.prominence, ["primary", "supplementary"])
  );
}

function isAccountingUnit(value: unknown, safeText: boolean): value is AccountingUnit {
  if (!isRecord(value)) return false;
  if (value.kind === "currency") {
    return (
      hasOnlyKeys(value, ["kind", "code"]) &&
      typeof value.code === "string" &&
      /^[A-Z]{3}$/u.test(value.code)
    );
  }
  if (value.kind === "count") {
    return (
      hasOnlyKeys(value, ["kind", "unit"]) &&
      isOneOf(value.unit, ["request", "token", "credit", "message", "interaction", "unit"])
    );
  }
  if (value.kind !== "custom" || !hasOnlyKeys(value, ["kind", "symbol"])) return false;
  if (typeof value.symbol !== "string" || value.symbol.length > 16) return false;
  return (
    !safeText ||
    (value.symbol.length > 0 &&
      sanitizeSingleLineDisplayText(value.symbol) === value.symbol &&
      SAFE_CUSTOM_SYMBOL_RE.test(value.symbol))
  );
}

function isAccountingQuantity(value: unknown, safeText: boolean): value is AccountingQuantity {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["decimal", "unit"]) &&
    typeof value.decimal === "string" &&
    isCanonicalAccountingDecimal(value.decimal) &&
    isAccountingUnit(value.unit, safeText)
  );
}

function isAccountingBasisFact(value: unknown, safeText: boolean): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["quantity", "authority"]) &&
    isAccountingQuantity(value.quantity, safeText) &&
    !value.quantity.decimal.startsWith("-") &&
    isOneOf(value.authority, ["provider_reported", "locally_derived", "user_configured"])
  );
}

function isAccountingPercentageBasis(
  value: unknown,
  safeText: boolean,
): value is AccountingPercentageBasis {
  if (!isRecord(value) || !hasOnlyKeys(value, ["used", "limit", "remaining"])) return false;
  const facts = [value.used, value.limit, value.remaining].filter(
    (fact): fact is Record<string, unknown> => fact !== undefined,
  );
  if (facts.length === 0 || !facts.every((fact) => isAccountingBasisFact(fact, safeText))) {
    return false;
  }
  const firstUnit = (facts[0]!.quantity as AccountingQuantity).unit;
  return facts.every((fact) =>
    accountingUnitsEqual((fact.quantity as AccountingQuantity).unit, firstUnit),
  );
}

const COMMON_ENTRY_KEYS = [
  "accounting",
  "kind",
  "name",
  "resetTimeIso",
  "group",
  "label",
  "metricLabel",
  "semantic",
  "right",
  "sortPriority",
] as const;

function hasValidEntryBase(entry: Record<string, unknown>, safeText: boolean): boolean {
  return (
    isAccountingMetadata(entry.accounting) &&
    typeof entry.name === "string" &&
    isOptionalIsoTimestamp(entry.resetTimeIso) &&
    (entry.sortPriority === undefined ||
      (typeof entry.sortPriority === "number" && Number.isFinite(entry.sortPriority))) &&
    ["group", "label", "metricLabel", "right"].every(
      (key) => entry[key] === undefined || typeof entry[key] === "string",
    ) &&
    (entry.semantic === undefined || isAccountingSemantic(entry.semantic, safeText))
  );
}

function isQuotaToastEntry(value: unknown, safeText: boolean): value is QuotaToastEntry {
  if (!isRecord(value) || !hasValidEntryBase(value, safeText)) return false;

  if (value.kind === "value") {
    return hasOnlyKeys(value, [...COMMON_ENTRY_KEYS, "value"]) && typeof value.value === "string";
  }
  if (value.kind === "quantity") {
    return (
      hasOnlyKeys(value, [...COMMON_ENTRY_KEYS, "quantity"]) &&
      isAccountingSemantic(value.semantic, safeText) &&
      isAccountingQuantity(value.quantity, safeText)
    );
  }
  if (value.kind === "boolean") {
    return (
      hasOnlyKeys(value, [...COMMON_ENTRY_KEYS, "value"]) &&
      isAccountingSemantic(value.semantic, safeText) &&
      typeof value.value === "boolean"
    );
  }
  return (
    (value.kind === undefined || value.kind === "percent") &&
    hasOnlyKeys(value, [...COMMON_ENTRY_KEYS, "percentRemaining", "basis"]) &&
    typeof value.percentRemaining === "number" &&
    Number.isFinite(value.percentRemaining) &&
    (value.basis === undefined || isAccountingPercentageBasis(value.basis, safeText))
  );
}

function isQuotaToastError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const error = value;
  return (
    hasOnlyKeys(error, ["label", "message", "kind"]) &&
    typeof error.label === "string" &&
    typeof error.message === "string" &&
    (error.kind === undefined || error.kind === "intentional-filter")
  );
}

function isQuotaProviderDiagnostic(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const diagnostic = value;
  return (
    hasOnlyKeys(diagnostic, [
      "sourceId",
      "providerId",
      "mode",
      "format",
      "modelIds",
      "apiKeyEnv",
      "selected",
      "attempted",
      "credentialSource",
      "outcome",
      "httpStatus",
      "entryCount",
      "checkedPaths",
      "authPaths",
      "statePath",
      "stateHealth",
      "stateVersion",
      "stateLastUpdatedAt",
    ]) &&
    typeof diagnostic.sourceId === "string" &&
    typeof diagnostic.providerId === "string" &&
    isOneOf(diagnostic.mode, ["remote-api", "local-estimate"]) &&
    (diagnostic.format === undefined ||
      isOneOf(diagnostic.format, ["quota-v1", "openrouter-key-v1", "json-v1"])) &&
    (diagnostic.mode === "remote-api"
      ? diagnostic.format !== undefined
      : diagnostic.format === undefined) &&
    (diagnostic.modelIds === null ||
      (isDenseArray(diagnostic.modelIds) &&
        diagnostic.modelIds.every((modelId) => typeof modelId === "string"))) &&
    (diagnostic.apiKeyEnv === null || typeof diagnostic.apiKeyEnv === "string") &&
    diagnostic.selected === true &&
    typeof diagnostic.attempted === "boolean" &&
    (diagnostic.credentialSource === null ||
      isOneOf(diagnostic.credentialSource, [
        "explicit_env",
        "global_opencode_json",
        "global_opencode_jsonc",
        "auth_json",
      ])) &&
    isOneOf(diagnostic.outcome, [
      "missing_credential",
      "success",
      "http_error",
      "redirect_error",
      "timeout",
      "body_too_large",
      "invalid_content_type",
      "invalid_json",
      "invalid_response",
      "network_error",
      "local_state_error",
    ]) &&
    (diagnostic.httpStatus === undefined ||
      (typeof diagnostic.httpStatus === "number" &&
        Number.isInteger(diagnostic.httpStatus) &&
        diagnostic.httpStatus >= 100 &&
        diagnostic.httpStatus <= 599)) &&
    typeof diagnostic.entryCount === "number" &&
    Number.isInteger(diagnostic.entryCount) &&
    diagnostic.entryCount >= 0 &&
    isDenseArray(diagnostic.checkedPaths) &&
    diagnostic.checkedPaths.every((path) => typeof path === "string") &&
    isDenseArray(diagnostic.authPaths) &&
    diagnostic.authPaths.every((path) => typeof path === "string") &&
    (diagnostic.statePath === undefined || typeof diagnostic.statePath === "string") &&
    (diagnostic.stateHealth === undefined ||
      isOneOf(diagnostic.stateHealth, ["missing", "healthy", "malformed", "version_mismatch"])) &&
    (diagnostic.stateVersion === undefined ||
      diagnostic.stateVersion === null ||
      (typeof diagnostic.stateVersion === "number" &&
        Number.isInteger(diagnostic.stateVersion) &&
        diagnostic.stateVersion >= 0)) &&
    (diagnostic.stateLastUpdatedAt === undefined ||
      diagnostic.stateLastUpdatedAt === null ||
      (typeof diagnostic.stateLastUpdatedAt === "number" &&
        Number.isFinite(diagnostic.stateLastUpdatedAt)))
  );
}

function isQuotaProviderStatusDetail(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const detail = value;
  return (
    hasOnlyKeys(detail, ["key", "value"]) &&
    typeof detail.key === "string" &&
    typeof detail.value === "string"
  );
}

function isQuotaProviderPresentation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const presentation = value;
  return (
    hasOnlyKeys(presentation, [
      "singleWindowDisplayName",
      "singleWindowShowRight",
      "redundantQuotaFamily",
      "classicStrategy",
    ]) &&
    (presentation.singleWindowDisplayName === undefined ||
      typeof presentation.singleWindowDisplayName === "string") &&
    (presentation.singleWindowShowRight === undefined ||
      typeof presentation.singleWindowShowRight === "boolean") &&
    (presentation.redundantQuotaFamily === undefined ||
      typeof presentation.redundantQuotaFamily === "string") &&
    (presentation.classicStrategy === undefined || presentation.classicStrategy === "preserve")
  );
}

function isQuotaProviderResult(value: unknown, safeText: boolean): value is QuotaProviderResult {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      "attempted",
      "entries",
      "errors",
      "diagnostics",
      "statusDetails",
      "rawDetails",
      "presentation",
    ]) &&
    typeof value.attempted === "boolean" &&
    isDenseArray(value.entries) &&
    value.entries.every((entry) => isQuotaToastEntry(entry, safeText)) &&
    isDenseArray(value.errors) &&
    value.errors.every(isQuotaToastError) &&
    (value.diagnostics === undefined ||
      (isDenseArray(value.diagnostics) && value.diagnostics.every(isQuotaProviderDiagnostic))) &&
    (value.statusDetails === undefined ||
      (isDenseArray(value.statusDetails) &&
        value.statusDetails.every(isQuotaProviderStatusDetail))) &&
    (value.rawDetails === undefined ||
      (isDenseArray(value.rawDetails) && value.rawDetails.every(isQuotaProviderStatusDetail))) &&
    (value.presentation === undefined || isQuotaProviderPresentation(value.presentation))
  );
}

function normalizeQuotaProviderResult(value: unknown): QuotaProviderResult | null {
  if (!isQuotaProviderResult(value, false)) return null;
  const sanitized = sanitizeQuotaProviderResult(value);
  return isQuotaProviderResult(sanitized, true) ? cloneQuotaProviderResult(sanitized) : null;
}

async function getQuotaProviderCachePackageVersion(): Promise<string> {
  return (await getPackageVersion()) ?? QUOTA_PROVIDER_CACHE_PACKAGE_VERSION_FALLBACK;
}

function isPersistedQuotaProviderCacheEnvelope(
  value: unknown,
  key: string,
  providerId: string,
  packageVersion: string,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["version", "packageVersion", "key", "providerId", "timestamp", "result"]) &&
    value.version === QUOTA_PROVIDER_CACHE_VERSION &&
    value.packageVersion === packageVersion &&
    value.key === key &&
    value.providerId === providerId &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp)
  );
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // best-effort cleanup
  }
}

async function maybePrunePersistedQuotaProviderCache(now: number): Promise<void> {
  if (now - lastPruneAtMs < QUOTA_PROVIDER_CACHE_PRUNE_INTERVAL_MS) {
    return;
  }

  lastPruneAtMs = now;
  const cacheDir = getQuotaProviderCacheDir();

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }

        const path = join(cacheDir, entry.name);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs > QUOTA_PROVIDER_CACHE_RETENTION_MS) {
            await safeRm(path);
          }
        } catch {
          // ignore unreadable files during best-effort pruning
        }
      }),
    );
  } catch {
    // missing/unreadable cache dir is non-fatal
  }
}

async function readPersistedQuotaProviderCacheEntry(params: {
  key: string;
  providerId: string;
  packageVersion: string;
  ttlMs: number;
  now: number;
  ignoreExpiry?: boolean;
}): Promise<PersistedQuotaProviderCacheEntry | null> {
  if (params.ttlMs <= 0 && !params.ignoreExpiry) {
    return null;
  }

  const path = getQuotaProviderStateCacheFilePath(params.providerId, params.key);

  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isPersistedQuotaProviderCacheEnvelope(
        parsed,
        params.key,
        params.providerId,
        params.packageVersion,
      )
    ) {
      await safeRm(path);
      return null;
    }

    const normalizedResult = normalizeQuotaProviderResult(parsed.result);
    if (!normalizedResult) {
      await safeRm(path);
      return null;
    }
    const timestamp = parsed.timestamp as number;
    if (!params.ignoreExpiry && params.now - timestamp >= params.ttlMs) {
      return null;
    }

    return {
      version: QUOTA_PROVIDER_CACHE_VERSION,
      packageVersion: params.packageVersion,
      key: params.key,
      providerId: params.providerId,
      timestamp,
      result: normalizedResult,
    };
  } catch {
    return null;
  }
}

async function writePersistedQuotaProviderCacheEntry(
  entry: PersistedQuotaProviderCacheEntry,
): Promise<void> {
  try {
    await writeJsonAtomic(getQuotaProviderStateCacheFilePath(entry.providerId, entry.key), entry, {
      trailingNewline: true,
    });
  } catch {
    // persistence failures should not break quota fetches
  }
}

async function fetchValidatedProviderResult(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderResult> {
  const fetched = await provider.fetch(ctx);
  const normalized = normalizeQuotaProviderResult(fetched);
  if (normalized) return normalized;

  return {
    attempted: true,
    entries: [],
    errors: [
      {
        label: getQuotaProviderDisplayLabel(provider.id),
        message: "Invalid normalized provider result",
      },
    ],
  };
}

async function resolveRuntimeEligibleQuotaProviders(
  providerId: string,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderDefinition[] | null | undefined> {
  if (providerId !== QUOTA_PROVIDERS_AGGREGATE_ID) {
    return undefined;
  }

  try {
    const response = await ctx.client.config.providers();
    const availableProviderIds = new Set(
      (response.data?.providers ?? []).map((provider) => provider.id),
    );
    return selectEligibleQuotaProviderDefinitions({
      definitions: ctx.config.quotaProviders ?? [],
      availableProviderIds,
      onlyCurrentModel: ctx.config.onlyCurrentModel,
      currentModel: ctx.config.currentModel,
      currentProviderID: ctx.config.currentProviderID,
    });
  } catch {
    return null;
  }
}

function publishQuotaTelemetry(params: {
  ctx: QuotaProviderContext;
  providerId: string;
  snapshotId: string;
  result: QuotaProviderResult;
  cacheTimestamp?: number;
}): void {
  if (!params.ctx.config.telemetryToken) return;
  const uncachedSnapshotId = `uncached:${params.providerId}`;
  updateQuotaTelemetrySnapshot({
    token: params.ctx.config.telemetryToken,
    snapshotId: params.snapshotId,
    ...(params.snapshotId !== uncachedSnapshotId
      ? { supersededSnapshotIds: [uncachedSnapshotId] }
      : {}),
    providerId: params.providerId,
    result: params.result,
    ...(params.cacheTimestamp !== undefined ? { cacheTimestamp: params.cacheTimestamp } : {}),
  });
}

export async function fetchQuotaProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
  bypassCache?: boolean;
}): Promise<QuotaProviderResult> {
  const { provider, ctx, ttlMs, bypassCache = false } = params;

  if (bypassCache) {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: `uncached:${provider.id}`,
      result: snapshot,
    });
    return snapshot;
  }

  if (isLiveLocalUsageProviderId(provider.id)) {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: `uncached:${provider.id}`,
      result: snapshot,
    });
    return snapshot;
  }

  const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
    provider.id,
    ctx,
  );
  if (runtimeEligibleQuotaProviders === null) {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: `uncached:${provider.id}`,
      result: snapshot,
    });
    return snapshot;
  }
  const forceAggregateRefresh =
    provider.id === QUOTA_PROVIDERS_AGGREGATE_ID &&
    runtimeEligibleQuotaProviders?.some((definition) => definition.mode === "local-estimate") ===
      true;
  const key = buildQuotaProviderStateCacheKey(provider.id, ctx, {
    runtimeEligibleQuotaProviders,
  });
  const now = Date.now();
  const packageVersion = await getQuotaProviderCachePackageVersion();
  await maybePrunePersistedQuotaProviderCache(now);

  const inMemory = forceAggregateRefresh ? undefined : inMemoryCache.get(key);
  if (
    inMemory &&
    inMemory.packageVersion === packageVersion &&
    ttlMs > 0 &&
    now - inMemory.timestamp < ttlMs
  ) {
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: inMemory.result,
      cacheTimestamp: inMemory.timestamp,
    });
    return cloneQuotaProviderResult(inMemory.result);
  }

  const inFlight = inFlightByKey.get(key);
  if (inFlight) {
    const snapshot = await inFlight;
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: snapshot,
      cacheTimestamp: inMemoryCache.get(key)?.timestamp,
    });
    return cloneQuotaProviderResult(snapshot);
  }

  const persisted = forceAggregateRefresh
    ? null
    : await readPersistedQuotaProviderCacheEntry({
        key,
        providerId: provider.id,
        packageVersion,
        ttlMs,
        now,
      });
  if (persisted) {
    inMemoryCache.set(key, {
      ...persisted,
      result: cloneQuotaProviderResult(persisted.result),
    });
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: persisted.result,
      cacheTimestamp: persisted.timestamp,
    });
    return cloneQuotaProviderResult(persisted.result);
  }

  // Another caller may have installed the shared promise while this caller awaited disk I/O.
  const inFlightAfterDiskRead = inFlightByKey.get(key);
  if (inFlightAfterDiskRead) {
    const snapshot = await inFlightAfterDiskRead;
    publishQuotaTelemetry({
      ctx,
      providerId: provider.id,
      snapshotId: key,
      result: snapshot,
      cacheTimestamp: inMemoryCache.get(key)?.timestamp,
    });
    return cloneQuotaProviderResult(snapshot);
  }

  const fetchPromise = (async () => {
    const snapshot = await fetchValidatedProviderResult(provider, ctx);

    if (!snapshot.attempted || snapshot.entries.length === 0) {
      inMemoryCache.delete(key);
      await safeRm(getQuotaProviderStateCacheFilePath(provider.id, key));
      return snapshot;
    }

    const entry: PersistedQuotaProviderCacheEntry = {
      version: QUOTA_PROVIDER_CACHE_VERSION,
      packageVersion,
      key,
      providerId: provider.id,
      timestamp: Date.now(),
      result: cloneQuotaProviderResult(snapshot),
    };

    inMemoryCache.set(key, {
      ...entry,
      result: cloneQuotaProviderResult(entry.result),
    });
    await writePersistedQuotaProviderCacheEntry(entry);
    return snapshot;
  })().finally(() => {
    inFlightByKey.delete(key);
  });

  inFlightByKey.set(key, fetchPromise);
  const snapshot = await fetchPromise;
  publishQuotaTelemetry({
    ctx,
    providerId: provider.id,
    snapshotId: key,
    result: snapshot,
    cacheTimestamp: inMemoryCache.get(key)?.timestamp,
  });
  return cloneQuotaProviderResult(snapshot);
}

export type CachedProviderRead =
  | { hit: true; result: QuotaProviderResult; timestamp: number }
  | { hit: false };

export async function readCachedProviderResult(params: {
  provider: QuotaProvider;
  ctx: QuotaProviderContext;
  ttlMs: number;
}): Promise<CachedProviderRead> {
  const runtimeEligibleQuotaProviders = await resolveRuntimeEligibleQuotaProviders(
    params.provider.id,
    params.ctx,
  );
  if (runtimeEligibleQuotaProviders === null) {
    return { hit: false };
  }
  const key = buildQuotaProviderStateCacheKey(params.provider.id, params.ctx, {
    runtimeEligibleQuotaProviders,
  });
  const now = Date.now();

  // Check in-memory cache first.
  const inMemory = inMemoryCache.get(key);
  if (inMemory) {
    publishQuotaTelemetry({
      ctx: params.ctx,
      providerId: params.provider.id,
      snapshotId: key,
      result: inMemory.result,
      cacheTimestamp: inMemory.timestamp,
    });
    return {
      hit: true,
      result: cloneQuotaProviderResult(inMemory.result),
      timestamp: inMemory.timestamp,
    };
  }

  // Fall back to disk cache with no expiry guard.
  const packageVersion = await getQuotaProviderCachePackageVersion();
  const persisted = await readPersistedQuotaProviderCacheEntry({
    key,
    providerId: params.provider.id,
    packageVersion,
    ttlMs: params.ttlMs,
    now,
    ignoreExpiry: true,
  });

  if (persisted) {
    // Populate in-memory cache for subsequent reads.
    inMemoryCache.set(key, {
      ...persisted,
      result: cloneQuotaProviderResult(persisted.result),
    });
    publishQuotaTelemetry({
      ctx: params.ctx,
      providerId: params.provider.id,
      snapshotId: key,
      result: persisted.result,
      cacheTimestamp: persisted.timestamp,
    });
    return {
      hit: true,
      result: cloneQuotaProviderResult(persisted.result),
      timestamp: persisted.timestamp,
    };
  }

  return { hit: false };
}

export function __resetQuotaStateForTests(): void {
  inMemoryCache.clear();
  inFlightByKey.clear();
  lastPruneAtMs = 0;
}
