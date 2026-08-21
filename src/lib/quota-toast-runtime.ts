import type { LoadConfigMeta } from "./config.js";
import { formatQuotaRows } from "./format.js";
import { resolveQuotaFormatStyle } from "./quota-format-style.js";
import { collectQuotaRenderData, type QuotaStatusLiveProbe } from "./quota-render-data.js";
import {
  createQuotaRuntimeRequestContext,
  type QuotaRuntimeContext,
} from "./quota-runtime-context.js";
import type { SessionTokenError } from "./quota-status.js";
import type { QuotaToastConfig } from "./types.js";

export type DeferredQuotaRefreshReason =
  | "config_load_failed"
  | "no_available_providers"
  | "provider_fetch_failed"
  | "no_reportable_data";

export type QuotaToastCollectionResult = {
  message: string | null;
  cacheRenderedMessage: boolean;
  retryable: boolean;
  retryReason?: DeferredQuotaRefreshReason;
  hasQuotaRows: boolean;
  detectedProviderIds: string[];
  freshProviderResults: QuotaStatusLiveProbe[];
  sessionTokenError?: SessionTokenError;
  shouldReconcileDetectedProviders: boolean;
};

export function formatQuotaToastDebugInfo(params: {
  trigger: string;
  reason: string;
  config: QuotaToastConfig;
  configMeta: Pick<LoadConfigMeta, "source" | "paths">;
  currentModel?: string;
  availability?: Array<{ id: string; ok: boolean }>;
}): string {
  const availability = params.availability
    ? params.availability.map((item) => `${item.id}=${item.ok ? "ok" : "no"}`).join(" ")
    : "unknown";

  const providers =
    params.config.enabledProviders === "auto"
      ? "(auto)"
      : params.config.enabledProviders.length > 0
        ? params.config.enabledProviders.join(",")
        : "(none)";

  const modelPart = params.currentModel ? ` model=${params.currentModel}` : "";
  const paths = params.configMeta.paths.length > 0 ? params.configMeta.paths.join(" | ") : "(none)";

  return [
    "Quota Toast Debug (opencode-quota)",
    `trigger=${params.trigger} reason=${params.reason}`,
    `configSource=${params.configMeta.source} paths=${paths}`,
    `enabled=${params.config.enabled} providers=${providers}${modelPart}`,
    `available=${availability}`,
  ].join("\n");
}

function isProviderFetchFailureOnly(errors: Array<{ message: string }>): boolean {
  return (
    errors.length > 0 && errors.every((error) => error.message === "Failed to read quota data")
  );
}

export async function collectQuotaToastMessage(params: {
  trigger: string;
  runtime: QuotaRuntimeContext;
  bypassProviderCache?: boolean;
}): Promise<QuotaToastCollectionResult> {
  const runtimeConfig = params.runtime.config;
  const quotaResult = await collectQuotaRenderData({
    client: params.runtime.client,
    resolveRuntimeProviderIds: params.runtime.resolveRuntimeProviderIds,
    config: runtimeConfig,
    configMeta: params.runtime.configMeta,
    request: createQuotaRuntimeRequestContext(params.runtime),
    surfaceExplicitProviderIssues: true,
    formatStyle: resolveQuotaFormatStyle(runtimeConfig.formatStyle),
    bypassProviderCache: params.bypassProviderCache,
    providers: params.runtime.providers,
  });
  const {
    selection,
    availability,
    active,
    providerResults,
    attemptedAny,
    hasExplicitProviderIssues,
    data,
  } = quotaResult;
  const detectedProviderIds = active.map((provider) => provider.id);
  const collectionMetadata = {
    detectedProviderIds,
    freshProviderResults: providerResults,
    sessionTokenError: quotaResult.sessionTokenError,
    shouldReconcileDetectedProviders: selection?.isAutoMode === true,
  };

  const currentModel = selection?.currentModel;
  const errors = data?.errors ?? [];
  const hasProviderQuotaRows = Boolean(data?.entries.length);
  const hasQuotaRows = Boolean(hasProviderQuotaRows || data?.sessionTokens);
  const providerFetchFailureOnly = attemptedAny && isProviderFetchFailureOnly(errors);
  const retryableAvailabilityFailure =
    active.length === 0 && availability.some((item) => !item.ok && item.error === true);

  if (active.length === 0 && !(hasExplicitProviderIssues && errors.length > 0)) {
    const message = runtimeConfig.debug
      ? formatQuotaToastDebugInfo({
          trigger: params.trigger,
          reason: "no enabled providers available",
          config: runtimeConfig,
          configMeta: params.runtime.configMeta,
          currentModel,
          availability: availability.map((item) => ({
            id: item.provider.id,
            ok: item.ok,
          })),
        })
      : null;
    const retryableNoProviders = selection?.isAutoMode === true || retryableAvailabilityFailure;
    return {
      message,
      cacheRenderedMessage: false,
      retryable: retryableNoProviders,
      retryReason: retryableNoProviders ? "no_available_providers" : undefined,
      hasQuotaRows: false,
      ...collectionMetadata,
    };
  }

  if (hasQuotaRows) {
    const formatted = formatQuotaRows({
      version: "1.0.0",
      layout: runtimeConfig.layout,
      entries: data?.entries ?? [],
      errors: data?.errors ?? [],
      style: resolveQuotaFormatStyle(runtimeConfig.formatStyle),
      percentDisplayMode: runtimeConfig.percentDisplayMode,
      accountingDetail: runtimeConfig.accountingDetail,
      resetTimeDecimals: runtimeConfig.resetTimeDecimals,
      sessionTokens: data?.sessionTokens,
    });

    const retryableMaskedProviderFailure = !hasProviderQuotaRows && providerFetchFailureOnly;

    if (!runtimeConfig.debug) {
      return {
        message: formatted,
        cacheRenderedMessage: true,
        retryable: retryableMaskedProviderFailure,
        retryReason: retryableMaskedProviderFailure ? "provider_fetch_failed" : undefined,
        hasQuotaRows: true,
        ...collectionMetadata,
      };
    }

    const debugFooter = `\n\n[debug] src=${params.runtime.configMeta.source} providers=${runtimeConfig.enabledProviders === "auto" ? "(auto)" : runtimeConfig.enabledProviders.join(",") || "(none)"} avail=${availability
      .map((item) => `${item.provider.id}:${item.ok ? "ok" : "no"}`)
      .join(" ")}`;

    return {
      message: formatted + debugFooter,
      cacheRenderedMessage: false,
      retryable: retryableMaskedProviderFailure,
      retryReason: retryableMaskedProviderFailure ? "provider_fetch_failed" : undefined,
      hasQuotaRows: true,
      ...collectionMetadata,
    };
  }

  if (
    (runtimeConfig.showOnBothFail && attemptedAny && errors.length > 0) ||
    hasExplicitProviderIssues
  ) {
    const errorLines = errors.map((error) => `${error.label}: ${error.message}`).join("\n");
    const retryableFetchFailure = !hasExplicitProviderIssues && providerFetchFailureOnly;
    const retryableFailure = retryableFetchFailure || retryableAvailabilityFailure;
    const retryReason: DeferredQuotaRefreshReason | undefined = retryableFetchFailure
      ? "provider_fetch_failed"
      : retryableAvailabilityFailure
        ? "no_available_providers"
        : undefined;
    const message = !runtimeConfig.debug
      ? errorLines || "Quota unavailable"
      : (errorLines || "Quota unavailable") +
        "\n\n" +
        formatQuotaToastDebugInfo({
          trigger: params.trigger,
          reason: hasExplicitProviderIssues
            ? "providers missing/unavailable"
            : "all providers failed",
          config: runtimeConfig,
          configMeta: params.runtime.configMeta,
          currentModel,
          availability: availability.map((item) => ({
            id: item.provider.id,
            ok: item.ok,
          })),
        });
    return {
      message,
      cacheRenderedMessage: false,
      retryable: retryableFailure,
      retryReason,
      hasQuotaRows: false,
      ...collectionMetadata,
    };
  }

  const retryableNoData =
    providerFetchFailureOnly ||
    (selection?.isAutoMode === true && active.length > 0 && errors.length === 0);
  return {
    message: runtimeConfig.debug
      ? formatQuotaToastDebugInfo({
          trigger: params.trigger,
          reason: "no entries",
          config: runtimeConfig,
          configMeta: params.runtime.configMeta,
          currentModel,
          availability: availability.map((item) => ({
            id: item.provider.id,
            ok: item.ok,
          })),
        })
      : null,
    cacheRenderedMessage: false,
    retryable: retryableNoData,
    retryReason: providerFetchFailureOnly
      ? "provider_fetch_failed"
      : retryableNoData
        ? "no_reportable_data"
        : undefined,
    hasQuotaRows: false,
    ...collectionMetadata,
  };
}
