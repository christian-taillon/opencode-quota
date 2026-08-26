import { describe, expect, it, vi } from "vitest";

import {
  createNativeConnectionAccess,
  toOpenAIQuotaCredential,
} from "../src/lib/opencode-v2-connections.js";

describe("OpenCode V2 native connection boundary", () => {
  it("enumerates credential connections while ignoring environment connections", async () => {
    const resolve = vi.fn().mockResolvedValue({ type: "oauth", access: "test-token" });
    const client = {
      v2: {
        integration: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: "openai",
              connections: [
                { type: "credential", id: "work", label: "  Work\n" },
                { type: "env", name: "OPENAI_API_KEY" },
                { type: "credential", id: "personal", label: "Personal" },
              ],
            },
          }),
        },
      },
    };

    const access = createNativeConnectionAccess({ client, resolve });
    const connections = await access.list("openai");

    expect(connections).toEqual([
      { id: "work", label: "Work" },
      { id: "personal", label: "Personal" },
    ]);
    expect(client.v2.integration.get).toHaveBeenCalledWith({ integrationID: "openai" });

    const first = connections[0];
    if (!first) throw new Error("Expected a native connection");
    await access.resolve(first);
    expect(resolve).toHaveBeenCalledWith({ type: "credential", id: "work", label: "  Work\n" });
  });

  it("does not expose the raw native connection through the public reference", async () => {
    const client = {
      v2: {
        integration: {
          get: vi.fn().mockResolvedValue({
            data: { connections: [{ type: "credential", id: "work", label: "Work" }] },
          }),
        },
      },
    };
    const access = createNativeConnectionAccess({
      client,
      resolve: vi.fn().mockResolvedValue(undefined),
    });

    const [connection] = await access.list("openai");

    expect(connection).toEqual({ id: "work", label: "Work" });
    expect(connection).not.toHaveProperty("raw");
  });

  it("converts only OAuth credentials and keeps safe metadata fields", () => {
    expect(
      toOpenAIQuotaCredential({
        type: "oauth",
        access: " access-token ",
        refresh: "refresh-secret",
        expires: 123,
        metadata: {
          chatgpt_account_id: "account-1",
          chatgpt_account_user_id: "user-1",
          email: "person@example.test",
        },
      }),
    ).toEqual({
      accessToken: "access-token",
      accountId: "account-1",
      accountUserId: "user-1",
      email: "person@example.test",
      expiresAt: 123,
    });
    expect(toOpenAIQuotaCredential({ type: "key", key: "api-key-secret" })).toBeNull();
    expect(toOpenAIQuotaCredential({ type: "oauth", access: "   " })).toBeNull();
  });
});
