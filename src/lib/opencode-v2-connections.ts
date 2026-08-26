import type { IntegrationHooks, PluginContext } from "@opencode-ai/plugin/v2/promise";

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type { OpenAIQuotaCredential } from "./openai.js";

type NativeConnectionInfo = Parameters<IntegrationHooks["connection"]["resolve"]>[0];
type NativeCredentialValue = Awaited<ReturnType<IntegrationHooks["connection"]["resolve"]>>;

export type NativeConnectionRef = {
  readonly id: string;
  readonly label?: string;
};

export interface NativeConnectionAccess {
  list(integrationID: string): Promise<readonly NativeConnectionRef[]>;
  resolve(connection: NativeConnectionRef): Promise<unknown>;
}

type V2IntegrationClient = {
  v2: {
    integration: {
      get(input: { integrationID: string }): Promise<unknown>;
    };
  };
};

type NativeConnectionResolverContext = Pick<PluginContext, "integration">;

let registeredResolver:
  | ((connection: NativeConnectionInfo) => Promise<NativeCredentialValue | undefined>)
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getV2IntegrationClient(client: unknown): V2IntegrationClient {
  if (!isRecord(client) || !isRecord(client.v2) || !isRecord(client.v2.integration)) {
    throw new Error("OpenCode V2 integration API unavailable");
  }

  const get = client.v2.integration.get;
  if (typeof get !== "function") {
    throw new Error("OpenCode V2 integration API unavailable");
  }

  return client as unknown as V2IntegrationClient;
}

function isCredentialConnection(
  value: unknown,
): value is Extract<NativeConnectionInfo, { type: "credential" }> {
  return (
    isRecord(value) &&
    value.type === "credential" &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

function sanitizeConnectionLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = sanitizeSingleLineDisplayText(value).slice(0, 80);
  return label || undefined;
}

function getIntegrationConnections(response: unknown): readonly unknown[] {
  if (
    !isRecord(response) ||
    !isRecord(response.data) ||
    !Array.isArray(response.data.connections)
  ) {
    throw new Error("Invalid OpenCode V2 integration response");
  }
  return response.data.connections;
}

export function createNativeConnectionAccess(params: {
  client: unknown;
  resolve: (connection: NativeConnectionInfo) => Promise<NativeCredentialValue | undefined>;
}): NativeConnectionAccess {
  const rawConnections = new WeakMap<NativeConnectionRef, NativeConnectionInfo>();

  return {
    async list(integrationID: string): Promise<readonly NativeConnectionRef[]> {
      const client = getV2IntegrationClient(params.client);
      const response = await client.v2.integration.get({ integrationID });
      const connections: NativeConnectionRef[] = [];

      for (const value of getIntegrationConnections(response)) {
        if (!isCredentialConnection(value)) continue;

        const label = sanitizeConnectionLabel(value.label);
        const ref: NativeConnectionRef = {
          id: value.id,
          ...(label ? { label } : {}),
        };
        rawConnections.set(ref, value);
        connections.push(ref);
      }

      return connections;
    },

    async resolve(connection: NativeConnectionRef): Promise<unknown> {
      const raw = rawConnections.get(connection);
      if (!raw) throw new Error("Unknown OpenCode V2 native connection");
      return params.resolve(raw);
    },
  };
}

export function createNativeConnectionAccessFromPluginContext(
  client: unknown,
  context: NativeConnectionResolverContext,
): NativeConnectionAccess {
  return createNativeConnectionAccess({
    client,
    resolve: (connection) => context.integration.connection.resolve(connection),
  });
}

export function isNativeConnectionResolverContext(
  value: unknown,
): value is NativeConnectionResolverContext {
  if (!isRecord(value) || !isRecord(value.integration) || !isRecord(value.integration.connection)) {
    return false;
  }
  return typeof value.integration.connection.resolve === "function";
}

export function registerNativeConnectionResolver(
  context: NativeConnectionResolverContext,
): () => void {
  const resolver = (connection: NativeConnectionInfo) =>
    context.integration.connection.resolve(connection);
  const previous = registeredResolver;
  registeredResolver = resolver;

  return () => {
    if (registeredResolver === resolver) registeredResolver = previous;
  };
}

export function createRegisteredNativeConnectionAccess(
  client: unknown,
): NativeConnectionAccess | undefined {
  if (!registeredResolver) return undefined;

  return createNativeConnectionAccess({
    client,
    resolve: (connection) => {
      const resolver = registeredResolver;
      if (!resolver) throw new Error("OpenCode V2 connection resolver unavailable");
      return resolver(connection);
    },
  });
}

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
