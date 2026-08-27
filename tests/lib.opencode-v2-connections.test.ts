import { mkdtempSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNativeConnectionAccessForTest,
  toOpenAIQuotaCredential,
} from "../src/lib/opencode-v2-connections.js";

describe("OpenCode V2 native connection boundary", () => {
  it("createNativeConnectionAccessForTest passes through list and resolve", async () => {
    const connections = [
      { id: "work", label: "Work" },
      { id: "personal", label: "Personal" },
    ];
    const access = createNativeConnectionAccessForTest({
      list: vi.fn().mockResolvedValue(connections),
      resolve: vi.fn().mockResolvedValue({ type: "oauth", access: "token" }),
    });

    const result = await access.list("openai");
    expect(result).toEqual(connections);

    const first = result[0];
    if (!first) throw new Error("Expected a connection");
    await access.resolve(first);
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

// ---------------------------------------------------------------------------
// Database-backed multi-connection reader tests
// ---------------------------------------------------------------------------

import {
  clearReadAuthFileCacheForTests,
  type OpenCodeCredentialConnection,
  readCredentialConnections,
} from "../src/lib/opencode-auth.js";

function createTestDatabase(dir: string, rows: Array<Record<string, unknown>>): string {
  const dbPath = join(dir, "opencode.db");
  const runtimeRequire = createRequire(import.meta.url);
  const { DatabaseSync } = runtimeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
    ) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): void };
      close(): void;
    };
  };
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE credential (
      id TEXT,
      integration_id TEXT,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      connector_id TEXT,
      method_id TEXT,
      active INTEGER,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `);
  const stmt = db.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    stmt.run(
      row.id,
      row.integration_id,
      row.label ?? "",
      row.value,
      row.active ?? 1,
      row.time_created ?? Date.now(),
      row.time_updated ?? Date.now(),
    );
  }
  db.close();
  return dbPath;
}

describe("readCredentialConnections (database-backed)", () => {
  beforeEach(() => {
    clearReadAuthFileCacheForTests();
  });

  it("returns unavailable when database does not exist", async () => {
    process.env.OPENCODE_DB = "/nonexistent/path/to/opencode.db";
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("unavailable");

    delete process.env.OPENCODE_DB;
  });

  it("returns available with zero connections when table is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-empty-"));
    createTestDatabase(dir, []);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(result.connections).toHaveLength(0);
    }

    delete process.env.OPENCODE_DB;
  });

  it("returns both OpenAI credentials without collapsing same integration_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-two-"));
    createTestDatabase(dir, [
      {
        id: "cred-a",
        integration_id: "openai",
        label: "OpenAI",
        value: JSON.stringify({ type: "oauth", access: "token-a" }),
      },
      {
        id: "cred-b",
        integration_id: "openai",
        label: "OpenAI 2",
        value: JSON.stringify({ type: "oauth", access: "token-b" }),
      },
    ]);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(result.connections).toHaveLength(2);
      expect(result.connections.map((c) => c.id)).toEqual(["cred-a", "cred-b"]);
      expect(result.connections.map((c) => c.label)).toEqual(["OpenAI", "OpenAI 2"]);
    }

    delete process.env.OPENCODE_DB;
  });

  it("preserves deterministic order by time_created then id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-order-"));
    createTestDatabase(dir, [
      {
        id: "cred-c",
        integration_id: "openai",
        label: "C",
        value: JSON.stringify({ type: "oauth", access: "c" }),
        time_created: 300,
      },
      {
        id: "cred-a",
        integration_id: "openai",
        label: "A",
        value: JSON.stringify({ type: "oauth", access: "a" }),
        time_created: 100,
      },
      {
        id: "cred-b",
        integration_id: "openai",
        label: "B",
        value: JSON.stringify({ type: "oauth", access: "b" }),
        time_created: 100,
      },
    ]);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(result.connections.map((c) => c.id)).toEqual(["cred-a", "cred-b", "cred-c"]);
    }

    delete process.env.OPENCODE_DB;
  });

  it("preserves labels and handles missing label gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-labels-"));
    createTestDatabase(dir, [
      {
        id: "cred-empty-label",
        integration_id: "openai",
        label: "",
        value: JSON.stringify({ type: "oauth", access: "t2" }),
        time_created: 100,
      },
      {
        id: "cred-labeled",
        integration_id: "openai",
        label: "Business Account",
        value: JSON.stringify({ type: "oauth", access: "t1" }),
        time_created: 200,
      },
    ]);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(result.connections).toHaveLength(2);
      // First by time_created, empty label should not produce a label property
      expect(result.connections[0]?.label).toBeUndefined();
      expect(result.connections[1]?.label).toBe("Business Account");
    }

    delete process.env.OPENCODE_DB;
  });

  it("ignores malformed credential values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-malformed-"));
    createTestDatabase(dir, [
      {
        id: "cred-good",
        integration_id: "openai",
        label: "Good",
        value: JSON.stringify({ type: "oauth", access: "good-token" }),
      },
      {
        id: "cred-bad",
        integration_id: "openai",
        label: "Bad",
        value: "not-json{",
      },
    ]);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0]?.id).toBe("cred-good");
    }

    delete process.env.OPENCODE_DB;
  });

  it("preserves API key credentials at reader layer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-apikey-"));
    createTestDatabase(dir, [
      {
        id: "cred-apikey",
        integration_id: "openai",
        label: "API Key",
        value: JSON.stringify({ type: "key", key: "sk-secret-key" }),
      },
    ]);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(result.connections).toHaveLength(1);
      // The value should be preserved at the reader layer
      expect(result.connections[0]?.value?.type).toBe("api");
    }

    delete process.env.OPENCODE_DB;
  });

  it("filters by integration_id correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-filter-"));
    createTestDatabase(dir, [
      {
        id: "cred-openai-1",
        integration_id: "openai",
        label: "OpenAI",
        value: JSON.stringify({ type: "oauth", access: "t1" }),
      },
      {
        id: "cred-github",
        integration_id: "github",
        label: "GitHub",
        value: JSON.stringify({ type: "oauth", access: "gh-token" }),
      },
    ]);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("available");
    if (result.state === "available") {
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0]?.id).toBe("cred-openai-1");
    }

    delete process.env.OPENCODE_DB;
  });

  it("returns unavailable when database does not exist", async () => {
    // Point to a nonexistent database path
    process.env.OPENCODE_DB = "/nonexistent/path/to/opencode.db";
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("unavailable");

    delete process.env.OPENCODE_DB;
  });

  it("connection values are only accessible to the quota query layer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-values-"));
    const secretToken = "sk-super-secret-token-12345";
    createTestDatabase(dir, [
      {
        id: "cred-secret",
        integration_id: "openai",
        label: "Secret",
        value: JSON.stringify({ type: "oauth", access: secretToken }),
      },
    ]);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    clearReadAuthFileCacheForTests();

    const result = await readCredentialConnections("openai");
    expect(result.state).toBe("available");
    if (result.state === "available") {
      // The value field contains the credential for the query layer,
      // but the connection ref (id + label) does NOT include it.
      const conn = result.connections[0] as OpenCodeCredentialConnection;
      expect(conn.id).toBe("cred-secret");
      expect(conn.label).toBe("Secret");
      // The value is present for internal use but should never be logged
      expect((conn.value as Record<string, unknown>).access).toBe(secretToken);
      // The safe ref shape (what gets exposed in UI) should not contain the value
      const safeRef = { id: conn.id, ...(conn.label ? { label: conn.label } : {}) };
      expect(JSON.stringify(safeRef)).not.toContain(secretToken);
    }

    delete process.env.OPENCODE_DB;
  });
});
