import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openOpenCodeSqliteReadOnly } from "../src/lib/opencode-sqlite.js";
import { tokenBucketsFromMessage } from "../src/lib/token-buckets.js";

const runtimePaths = vi.hoisted(() => ({ dataDirs: [] as string[] }));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({ dataDirs: runtimePaths.dataDirs }),
}));

async function importNodeSqlite(): Promise<typeof import("node:sqlite") | null> {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

describe("opencode sqlite adapter", () => {
  it("reads an OpenCode SQLite database through node:sqlite on Node runtimes", async () => {
    const sqlite = await importNodeSqlite();

    if (!sqlite) {
      console.warn(
        "Skipping node:sqlite adapter coverage because this Node runtime does not provide node:sqlite.",
      );
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "opencode-sqlite-"));
    const dbPath = join(dir, "opencode.db");

    try {
      const writer = new sqlite.DatabaseSync(dbPath);
      writer.exec(`
        CREATE TABLE usage (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          tokens INTEGER NOT NULL
        );
        INSERT INTO usage (provider, tokens) VALUES ('copilot', 42), ('qwen', 7);
      `);
      writer.close();

      const conn = await openOpenCodeSqliteReadOnly(dbPath);

      try {
        expect(
          conn.get<{ provider: string; tokens: number }>(
            "SELECT provider, tokens FROM usage WHERE id = ?",
            [1],
          ),
        ).toEqual({
          provider: "copilot",
          tokens: 42,
        });
        expect(
          conn.all<{ provider: string }>(
            "SELECT provider FROM usage WHERE tokens >= ? ORDER BY id",
            [7],
          ),
        ).toEqual([{ provider: "copilot" }, { provider: "qwen" }]);
      } finally {
        conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads authoritative completed assistant rows by completion time", async () => {
    const sqlite = await importNodeSqlite();

    if (!sqlite) {
      console.warn(
        "Skipping completed accounting integration coverage because this Node runtime does not provide node:sqlite.",
      );
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "opencode-accounting-"));
    const dbPath = join(dir, "opencode.db");
    const cutoff = Date.parse("2026-07-16T00:00:00.000Z");

    try {
      runtimePaths.dataDirs = [dir];
      const writer = new sqlite.DatabaseSync(dbPath);
      writer.exec(`
        CREATE TABLE "message" (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      const insert = writer.prepare(
        `INSERT INTO "message" (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      );
      const add = (
        id: string,
        role: "assistant" | "user",
        created: number,
        completed?: number,
      ): void => {
        insert.run(
          id,
          "ses_accounting",
          created,
          completed ?? created,
          JSON.stringify({
            role,
            providerID: "qwen-code",
            modelID: "qwen-plus",
            time: completed === undefined ? { created } : { created, completed },
          }),
        );
      };

      add("normal-response", "assistant", cutoff + 100, cutoff + 200);
      add("unfinished-response", "assistant", cutoff + 300);
      add("before-tool", "assistant", cutoff + 400, cutoff + 500);
      add("after-tool", "assistant", cutoff + 600, cutoff + 700);
      add("cross-cutoff", "assistant", cutoff - 60_000, cutoff + 50);
      add("user-row", "user", cutoff + 800, cutoff + 900);
      add("after-window", "assistant", cutoff + 1_100, cutoff + 1_200);
      writer.close();

      const { iterCompletedAssistantMessages } = await import("../src/lib/opencode-storage.js");
      const messages = await iterCompletedAssistantMessages({
        completedSinceMs: cutoff,
        completedUntilMs: cutoff + 1_000,
      });

      expect(messages.map((message) => message.id)).toEqual([
        "cross-cutoff",
        "normal-response",
        "before-tool",
        "after-tool",
      ]);
      expect(messages.every((message) => typeof message.time?.completed === "number")).toBe(true);
    } finally {
      runtimePaths.dataDirs = [];
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads usage through scalar JSON projection and preserves filters and token types", async () => {
    const sqlite = await importNodeSqlite();

    if (!sqlite) {
      console.warn(
        "Skipping projected usage integration coverage because this Node runtime does not provide node:sqlite.",
      );
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "opencode-projected-usage-"));
    const dbPath = join(dir, "opencode.db");
    const largeIrrelevantPayload = "x".repeat(128 * 1024);
    const extremeIntegerLiteral = "9007199254740993";
    const expectedExtremeNumber = JSON.parse(extremeIntegerLiteral) as number;

    try {
      runtimePaths.dataDirs = [dir];
      const writer = new sqlite.DatabaseSync(dbPath);
      writer.exec(`
        CREATE TABLE "message" (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      const insert = writer.prepare(
        `INSERT INTO "message" (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      );
      const add = (id: string, sessionID: string, created: number, data: string): void => {
        insert.run(id, sessionID, created, created, data);
      };

      add(
        "before-window",
        "ses_one",
        10,
        JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          tokens: { input: 999 },
        }),
      );
      add(
        "assistant-a",
        "ses_one",
        20,
        JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          tokens: {
            input: 11,
            output: "12",
            reasoning: null,
            cache: { read: 0, write: 7 },
          },
          time: { completed: 25 },
        }),
      );
      add("malformed", "ses_one", 30, "{not-json");
      add(
        "extreme-integer",
        "ses_one",
        35,
        `{"role":"assistant","providerID":${extremeIntegerLiteral},"modelID":${extremeIntegerLiteral},"tokens":{"input":${extremeIntegerLiteral}},"time":{"completed":${extremeIntegerLiteral}}}`,
      );
      add(
        "non-string-role-extreme",
        "ses_one",
        36,
        `{"role":${extremeIntegerLiteral},"tokens":{"input":${extremeIntegerLiteral}}}`,
      );
      add(
        "user-with-large-content",
        "ses_one",
        40,
        JSON.stringify({ role: "user", content: largeIrrelevantPayload }),
      );
      add(
        "assistant-b",
        "ses_two",
        50,
        JSON.stringify({
          role: "ASSISTANT",
          providerID: "openai",
          modelID: "gpt-5",
          tokens: {
            input: "13",
            output: 0,
            reasoning: 5,
            cache: { read: null, write: 0 },
          },
        }),
      );
      add(
        "assistant-missing-fields",
        "ses_one",
        55,
        JSON.stringify({ role: "assistant", providerID: null }),
      );
      add(
        "after-window",
        "ses_one",
        70,
        JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          tokens: { input: 1000 },
        }),
      );
      writer.close();

      const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
      const messages = await iterAssistantMessages({ sinceMs: 20, untilMs: 60 });

      expect(messages.map((message) => message.id)).toEqual([
        "assistant-a",
        "extreme-integer",
        "assistant-b",
        "assistant-missing-fields",
      ]);
      expect(messages[0]).toMatchObject({
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        time: { created: 20, completed: 25 },
      });
      const firstMessage = messages[0];
      const extremeMessage = messages[1];
      const secondMessage = messages[2];
      const thirdMessage = messages[3];
      if (!firstMessage || !extremeMessage || !secondMessage || !thirdMessage) {
        throw new Error("Expected four projected assistant messages");
      }
      expect(tokenBucketsFromMessage(firstMessage)).toEqual({
        input: 11,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 7,
      });
      expect(extremeMessage).toMatchObject({
        providerID: undefined,
        modelID: undefined,
        time: { completed: expectedExtremeNumber },
      });
      expect(tokenBucketsFromMessage(extremeMessage)).toEqual({
        input: expectedExtremeNumber,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
      });
      expect(tokenBucketsFromMessage(secondMessage)).toEqual({
        input: 0,
        output: 0,
        reasoning: 5,
        cache_read: 0,
        cache_write: 0,
      });
      expect(thirdMessage).toMatchObject({
        role: "assistant",
        providerID: undefined,
        modelID: undefined,
      });
      expect(tokenBucketsFromMessage(thirdMessage)).toEqual({
        input: 0,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
      });
    } finally {
      runtimePaths.dataDirs = [];
      await rm(dir, { recursive: true, force: true });
    }
  });
});
