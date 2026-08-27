import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
}));

const sqliteMocks = vi.hoisted(() => ({
  openOpenCodeSqliteReadOnly: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs")>();
  return {
    ...mod,
    existsSync: fsMocks.existsSync,
  };
});

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/tmp/opencode"],
    configDirs: ["/tmp/opencode"],
    cacheDirs: ["/tmp/opencode"],
    stateDirs: ["/tmp/opencode"],
  }),
}));

vi.mock("../src/lib/path-pick.js", () => ({
  pickFirstExistingPath: vi.fn(() => "/tmp/opencode.db"),
}));

vi.mock("../src/lib/opencode-sqlite.js", () => ({
  openOpenCodeSqliteReadOnly: sqliteMocks.openOpenCodeSqliteReadOnly,
}));

describe("opencode storage multi-session reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fsMocks.existsSync.mockReturnValue(true);
  });

  it("queries completed assistant work by completion time across creation cutoffs", async () => {
    const completedSinceMs = Date.parse("2026-07-16T00:00:00.000Z");
    const completedUntilMs = Date.parse("2026-07-16T12:00:00.000Z");
    const conn = {
      get: vi.fn(() => ({ r: "assistant" })),
      all: vi.fn((sql: string, params?: unknown[]) => {
        expect(sql).toContain("json_extract(data, '$.time.completed')");
        expect(sql).toContain("ORDER BY CAST(json_extract(data, '$.time.completed') AS REAL)");
        expect(sql).not.toContain("time_created >=");
        expect(params).toEqual([completedSinceMs, completedUntilMs]);
        return [
          {
            id: "cross-cutoff",
            session_id: "ses_one",
            time_created: completedSinceMs - 60_000,
            data: JSON.stringify({
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-5",
              time: { completed: completedSinceMs + 1 },
            }),
          },
          {
            id: "unfinished",
            session_id: "ses_two",
            time_created: completedSinceMs + 1,
            data: JSON.stringify({
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-5",
              time: {},
            }),
          },
        ];
      }),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { iterCompletedAssistantMessages } = await import("../src/lib/opencode-storage.js");
    const messages = await iterCompletedAssistantMessages({
      completedSinceMs,
      completedUntilMs,
    });

    expect(messages.map((message) => message.id)).toEqual(["cross-cutoff"]);
    expect(messages[0]?.time?.completed).toBe(completedSinceMs + 1);
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("uses a guarded scalar projection instead of materializing message data", async () => {
    const conn = {
      get: vi.fn(() => ({ r: "assistant" })),
      all: vi.fn((sql: string, params?: unknown[]) => {
        expect(sql).toContain("CASE WHEN json_valid(data)");
        expect(sql).toContain("json_extract(data, '$.role')");
        expect(sql).toContain("json_extract(data, '$.tokens.cache.read')");
        expect(sql).not.toContain("time_updated, data FROM");
        expect(params).toEqual([100, 200]);
        return [
          {
            id: "assistant-row",
            session_id: "ses_one",
            time_created: 150,
            time_updated: 160,
            role: "assistant",
            provider_id: "openai",
            model_id: "gpt-5",
            time_completed: 175,
            tokens_input: 10,
            tokens_output: 5,
            tokens_reasoning: null,
            tokens_cache_read: 0,
            tokens_cache_write: 2,
          },
          {
            id: "user-row",
            session_id: "ses_one",
            time_created: 160,
            time_updated: 161,
            role: "user",
            provider_id: null,
            model_id: null,
            time_completed: null,
            tokens_input: null,
            tokens_output: null,
            tokens_reasoning: null,
            tokens_cache_read: null,
            tokens_cache_write: null,
          },
        ];
      }),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    const messages = await iterAssistantMessages({ sinceMs: 100, untilMs: 200 });

    expect(messages.map((message) => message.id)).toEqual(["assistant-row"]);
    expect(messages[0]).toMatchObject({
      providerID: "openai",
      modelID: "gpt-5",
      tokens: {
        input: 10,
        output: 5,
        reasoning: null,
        cache: { read: 0, write: 2 },
      },
    });
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("fails closed instead of selecting full message data without JSON functions", async () => {
    const conn = {
      get: vi.fn(() => null),
      all: vi.fn(),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");

    await expect(iterAssistantMessages({})).rejects.toThrow(
      "OpenCode SQLite JSON functions are unavailable",
    );
    expect(conn.all).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("fails closed for database stats instead of scanning raw message data", async () => {
    const conn = {
      get: vi.fn((sql: string) => (sql.includes("count(*)") ? { c: 3 } : null)),
      all: vi.fn(),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { getOpenCodeDbStats } = await import("../src/lib/opencode-storage.js");

    await expect(getOpenCodeDbStats()).rejects.toThrow(
      "OpenCode SQLite JSON functions are unavailable; refusing to scan raw message payloads.",
    );
    expect(conn.all).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("chunks large session queries below the SQLite bind limit and preserves message order", async () => {
    const conn = {
      all: vi.fn((_: string, params?: unknown[]) => {
        const sessionParams = (params ?? []).filter(
          (value): value is string => typeof value === "string" && value.startsWith("ses_"),
        );

        expect(params?.length ?? 0).toBeLessThanOrEqual(900);

        if (sessionParams.includes("ses_999")) {
          return [
            {
              id: "msg-second-batch",
              session_id: "ses_999",
              time_created: 10,
              role: "assistant",
            },
          ];
        }

        return [
          {
            id: "msg-first-batch",
            session_id: "ses_000",
            time_created: 20,
            role: "assistant",
          },
        ];
      }),
      get: vi.fn(() => ({ r: "assistant" })),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { iterAssistantMessagesForSessions } = await import("../src/lib/opencode-storage.js");
    const sessionIDs = Array.from(
      { length: 1000 },
      (_, index) => `ses_${String(index).padStart(3, "0")}`,
    );

    const messages = await iterAssistantMessagesForSessions({
      sessionIDs,
      sinceMs: 100,
      untilMs: 200,
    });

    expect(sqliteMocks.openOpenCodeSqliteReadOnly).toHaveBeenCalledWith("/tmp/opencode.db");
    expect(conn.all).toHaveBeenCalledTimes(2);
    expect(messages.map((message) => message.id)).toEqual(["msg-second-batch", "msg-first-batch"]);
    expect(conn.close).toHaveBeenCalledTimes(1);
  });
});
