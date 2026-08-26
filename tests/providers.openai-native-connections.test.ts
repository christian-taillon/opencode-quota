import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOpenAIOAuthCached: vi.fn(),
  queryOpenAIQuota: vi.fn(),
  queryOpenAIQuotaForCredential: vi.fn(),
  resolveOpenAIOAuth: vi.fn(),
}));

vi.mock("../src/lib/openai.js", () => ({
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  hasOpenAIOAuthCached: mocks.hasOpenAIOAuthCached,
  queryOpenAIQuota: mocks.queryOpenAIQuota,
  queryOpenAIQuotaForCredential: mocks.queryOpenAIQuotaForCredential,
  resolveOpenAIOAuth: mocks.resolveOpenAIOAuth,
}));

import type {
  NativeConnectionAccess,
  NativeConnectionRef,
} from "../src/lib/opencode-v2-connections.js";
import { openaiProvider } from "../src/providers/openai.js";

function quotaResult(label = "OpenAI (Plus)", percentRemaining = 80) {
  return {
    success: true as const,
    label,
    windows: {
      hourly: { percentRemaining, resetTimeIso: "2026-01-01T00:00:00.000Z" },
      weekly: { percentRemaining: percentRemaining - 10 },
    },
  };
}

function nativeContext(
  connections: readonly NativeConnectionRef[],
  values: Readonly<Record<string, unknown>>,
): {
  context: Parameters<typeof openaiProvider.fetch>[0];
  list: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn().mockResolvedValue(connections);
  const resolve = vi.fn(async (connection: NativeConnectionRef) => values[connection.id]);
  const access: NativeConnectionAccess = { list, resolve };
  return {
    context: {
      nativeConnections: access,
      config: { requestTimeoutMs: 12_000 },
    } as unknown as Parameters<typeof openaiProvider.fetch>[0],
    list,
    resolve,
  };
}

describe("openai provider native V2 connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOpenAIOAuth.mockReturnValue({ state: "none" });
  });

  it("handles zero native connections without using legacy auth", async () => {
    const native = nativeContext([], {});

    const result = await openaiProvider.fetch(native.context);

    expect(native.list).toHaveBeenCalledWith("openai");
    expect(mocks.queryOpenAIQuotaForCredential).not.toHaveBeenCalled();
    expect(mocks.queryOpenAIQuota).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: true, entries: [], errors: [] });
    expect(result.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_source", value: "native_v2_connections" },
        { key: "connection_count", value: "0" },
      ]),
    );
  });

  it("queries one native OAuth connection and uses its stable source id", async () => {
    const connection = { id: "work", label: "Work" };
    const native = nativeContext([connection], {
      work: { type: "oauth", access: "work-token", expires: Date.now() + 60_000 },
    });
    mocks.queryOpenAIQuotaForCredential.mockResolvedValueOnce(quotaResult("OpenAI (Business)"));

    const result = await openaiProvider.fetch(native.context);

    expect(mocks.queryOpenAIQuotaForCredential).toHaveBeenCalledWith(
      { accessToken: "work-token", expiresAt: expect.any(Number) },
      { requestTimeoutMs: 12_000 },
    );
    expect(result.entries.map((entry) => entry.group)).toEqual([
      "OpenAI (Business) · Work",
      "OpenAI (Business) · Work",
    ]);
    expect(result.entries.every((entry) => entry.accounting.sourceId === "openai:work")).toBe(true);
  });

  it("queries two native accounts independently even when their plans match", async () => {
    const connections = [
      { id: "personal", label: "Personal" },
      { id: "work", label: "Work" },
    ];
    const native = nativeContext(connections, {
      personal: { type: "oauth", access: "personal-token" },
      work: { type: "oauth", access: "work-token" },
    });
    mocks.queryOpenAIQuotaForCredential
      .mockResolvedValueOnce(quotaResult())
      .mockResolvedValueOnce(quotaResult());

    const result = await openaiProvider.fetch(native.context);

    expect(mocks.queryOpenAIQuotaForCredential).toHaveBeenCalledTimes(2);
    expect(result.entries.map((entry) => entry.group)).toEqual([
      "OpenAI (Plus) · Personal",
      "OpenAI (Plus) · Personal",
      "OpenAI (Plus) · Work",
      "OpenAI (Plus) · Work",
    ]);
    expect(result.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "openai:personal",
      "openai:personal",
      "openai:work",
      "openai:work",
    ]);
  });

  it("numbers three missing-label accounts in stable connection-id order", async () => {
    const connections = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const native = nativeContext(connections, {
      a: { type: "oauth", access: "a-token" },
      b: { type: "oauth", access: "b-token" },
      c: { type: "oauth", access: "c-token" },
    });
    mocks.queryOpenAIQuotaForCredential
      .mockResolvedValueOnce(quotaResult())
      .mockResolvedValueOnce(quotaResult())
      .mockResolvedValueOnce(quotaResult());

    const result = await openaiProvider.fetch(native.context);

    expect(result.entries.map((entry) => entry.group)).toEqual([
      "OpenAI (Plus)",
      "OpenAI (Plus)",
      "OpenAI (Plus) #2",
      "OpenAI (Plus) #2",
      "OpenAI (Plus) #3",
      "OpenAI (Plus) #3",
    ]);
    expect(result.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "openai:a",
      "openai:a",
      "openai:b",
      "openai:b",
      "openai:c",
      "openai:c",
    ]);
  });

  it("numbers duplicate native labels without collapsing them", async () => {
    const connections = [
      { id: "first", label: "Personal" },
      { id: "second", label: "Personal" },
    ];
    const native = nativeContext(connections, {
      first: { type: "oauth", access: "first-token" },
      second: { type: "oauth", access: "second-token" },
    });
    mocks.queryOpenAIQuotaForCredential
      .mockResolvedValueOnce(quotaResult())
      .mockResolvedValueOnce(quotaResult());

    const result = await openaiProvider.fetch(native.context);

    expect(result.entries.map((entry) => entry.group)).toEqual([
      "OpenAI (Plus) · Personal",
      "OpenAI (Plus) · Personal",
      "OpenAI (Plus) · Personal #2",
      "OpenAI (Plus) · Personal #2",
    ]);
  });

  it("keeps a good account when another account is expired", async () => {
    const native = nativeContext(
      [
        { id: "good", label: "Good" },
        { id: "expired", label: "Expired" },
      ],
      {
        good: { type: "oauth", access: "good-token" },
        expired: { type: "oauth", access: "expired-token" },
      },
    );
    mocks.queryOpenAIQuotaForCredential
      .mockResolvedValueOnce({ success: false, error: "Token expired" })
      .mockResolvedValueOnce(quotaResult());

    const result = await openaiProvider.fetch(native.context);

    expect(result.entries).toHaveLength(2);
    expect(result.errors).toEqual([{ label: "OpenAI · Expired", message: "Token expired" }]);
    expect(result.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "usable_connection_count", value: "2" },
        { key: "successful_connection_count", value: "1" },
        { key: "failed_connection_count", value: "1" },
      ]),
    );
  });

  it("keeps a good account when another account returns an API error", async () => {
    const native = nativeContext(
      [
        { id: "good", label: "Good" },
        { id: "failed", label: "Failed" },
      ],
      {
        good: { type: "oauth", access: "good-token" },
        failed: { type: "oauth", access: "failed-token" },
      },
    );
    mocks.queryOpenAIQuotaForCredential
      .mockResolvedValueOnce({ success: false, error: "OpenAI API error 401: [redacted]" })
      .mockResolvedValueOnce(quotaResult());

    const result = await openaiProvider.fetch(native.context);

    expect(result.entries).toHaveLength(2);
    expect(result.errors).toEqual([
      { label: "OpenAI · Failed", message: "OpenAI API error 401: [redacted]" },
    ]);
  });

  it("ignores key credentials and never sends them to the quota query", async () => {
    const native = nativeContext([{ id: "key" }], {
      key: { type: "key", key: "subscription-key-secret" },
    });

    const result = await openaiProvider.fetch(native.context);

    expect(mocks.queryOpenAIQuotaForCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("subscription-key-secret");
    expect(result.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "connection_count", value: "1" },
        { key: "usable_connection_count", value: "0" },
      ]),
    );
  });

  it("does not invoke legacy single-auth quota when native enumeration succeeds", async () => {
    const native = nativeContext([{ id: "native" }], {
      native: { type: "oauth", access: "native-token" },
    });
    mocks.queryOpenAIQuotaForCredential.mockResolvedValueOnce(quotaResult());

    await openaiProvider.fetch(native.context);

    expect(mocks.queryOpenAIQuota).not.toHaveBeenCalled();
    expect(mocks.resolveOpenAIOAuth).not.toHaveBeenCalled();
  });

  it("surfaces native enumeration errors instead of falling back to legacy auth", async () => {
    const list = vi.fn().mockRejectedValue(new Error("native enumeration failed"));
    const resolve = vi.fn();
    const result = await openaiProvider.fetch({
      nativeConnections: { list, resolve },
      config: {},
    } as unknown as Parameters<typeof openaiProvider.fetch>[0]);

    expect(result).toMatchObject({
      attempted: true,
      entries: [],
      errors: [
        {
          label: "OpenAI",
          message: "Failed to enumerate native OpenAI connections",
        },
      ],
    });
    expect(mocks.queryOpenAIQuota).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("native enumeration failed");
  });
});
