import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import businessIndividualLimitUsage from "./fixtures/openai/business-individual-limit.sanitized.json";
import businessTeamMonthlyUsage from "./fixtures/openai/business-team-monthly.sanitized.json";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
  queryOpenAIQuotaForCredential,
  resolveOpenAIOAuth,
} from "../src/lib/openai.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function mockOpenAIUsageResponse(usage: unknown): void {
  mocks.readAuthFileCached.mockResolvedValueOnce({
    openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => usage })) as any);
}

describe("openai auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns none when no supported native OpenCode auth entry exists", () => {
    expect(resolveOpenAIOAuth({})).toEqual({ state: "none" });
  });

  it("prefers openai before legacy compatibility keys", () => {
    expect(
      resolveOpenAIOAuth({
        codex: { type: "oauth", access: "codex-token" },
        openai: { type: "oauth", access: "openai-token" },
        chatgpt: { type: "oauth", access: "chatgpt-token" },
        opencode: { type: "oauth", access: "opencode-token" },
      }),
    ).toMatchObject({
      state: "configured",
      sourceKey: "openai",
      accessToken: "openai-token",
    });
  });

  it("parses the OpenAI account user id from the OAuth JWT", () => {
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_account_user_id: "user-1",
      },
    });

    expect(resolveOpenAIOAuth({ openai: { type: "oauth", access: accessToken } })).toMatchObject({
      state: "configured",
      accountId: "account-1",
      accountUserId: "user-1",
    });
  });

  it("adds an explicit ChatGPT account id header for per-credential queries", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_after_seconds: 60,
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as any);

    await expect(
      queryOpenAIQuotaForCredential({
        accessToken: "explicit-access-token",
        accountId: "account-explicit",
        expiresAt: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({ success: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer explicit-access-token",
          "ChatGPT-Account-Id": "account-explicit",
        }),
      }),
    );
  });

  it("derives the account id and email for a per-credential query", async () => {
    const accessToken = fakeJwt({
      "https://api.openai.com/profile": { email: "account@example.test" },
      "https://api.openai.com/auth": { chatgpt_account_id: "account-derived" },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_after_seconds: 60,
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as any);

    const result = await queryOpenAIQuotaForCredential({
      accessToken,
      expiresAt: Date.now() + 60_000,
    });

    expect(result).toMatchObject({ success: true, email: "account@example.test" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "ChatGPT-Account-Id": "account-derived" }),
      }),
    );
  });

  it("does not request quota for an expired per-credential token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    await expect(
      queryOpenAIQuotaForCredential({
        accessToken: "expired-access-token",
        expiresAt: Date.now(),
      }),
    ).resolves.toEqual({ success: false, error: "Token expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the existing quota parsing behind per-credential queries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(businessIndividualLimitUsage), { status: 200 }),
      ) as any,
    );

    const result = await queryOpenAIQuotaForCredential({
      accessToken: "per-credential-token",
      expiresAt: Date.now() + 60_000,
    });

    expect(result).toMatchObject({
      success: true,
      label: "OpenAI (Business)",
      windows: {
        monthly: {
          percentRemaining: 100,
          resetTimeIso: new Date(1_785_542_400_000).toISOString(),
        },
      },
    });
  });

  it("redacts the access token from API errors", async () => {
    const accessToken = "api-error-secret-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`provider echoed ${accessToken}`, { status: 401 })) as any,
    );

    const result = await queryOpenAIQuotaForCredential({ accessToken });

    expect(result).toEqual({
      success: false,
      error: "OpenAI API error 401: provider echoed [redacted]",
    });
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  it("redacts the access token from thrown network errors", async () => {
    const accessToken = "network-error-secret-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`request failed for ${accessToken}`);
      }) as any,
    );

    const result = await queryOpenAIQuotaForCredential({ accessToken });

    expect(result).toEqual({
      success: false,
      error: "request failed for [redacted]",
    });
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  it("returns null when quota is not configured", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({});

    await expect(queryOpenAIQuota()).resolves.toBeNull();
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
    });
  });

  it("returns token expired error when expires is in the past", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "tok", expires: Date.now() - 1 },
    });

    const out = await queryOpenAIQuota();
    expect(out && !out.success ? out.error : "").toContain("Token expired");
  });

  it("reads auth from chatgpt when codex and openai are absent", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      chatgpt: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
                secondary_window: null,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(80);
  });

  it("reads auth from opencode when higher-priority keys are unusable", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      codex: { type: "oauth", access: "   " },
      openai: { type: "api", access: "ignored" },
      chatgpt: { type: "oauth", access: "   " },
      opencode: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "free",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 50,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
                secondary_window: null,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(50);
  });

  it("uses cached auth reads for hasOpenAIOAuthCached", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "cached-token" },
    });

    await expect(hasOpenAIOAuthCached()).resolves.toBe(true);
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
    });
  });

  it("classifies the sanitized Business window as monthly without inventing absent windows", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(businessTeamMonthlyUsage), { status: 200 }),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.label : "").toBe("OpenAI (Business)");
    expect(out && out.success ? out.windows : {}).toEqual({
      monthly: {
        percentRemaining: 67,
        resetTimeIso: new Date(1_786_262_548_000).toISOString(),
      },
    });
  });

  it("parses the sanitized Business individual spend limit as monthly quota", async () => {
    mockOpenAIUsageResponse(businessIndividualLimitUsage);

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.label : "").toBe("OpenAI (Business)");
    expect(out && out.success ? out.windows : {}).toEqual({
      monthly: {
        percentRemaining: 100,
        resetTimeIso: new Date(1_785_542_400_000).toISOString(),
      },
    });
  });

  it("falls back to individual-limit reset_after_seconds when reset_at is absent", async () => {
    mockOpenAIUsageResponse({
      ...businessIndividualLimitUsage,
      spend_control: {
        individual_limit: {
          remaining_percent: 80,
          reset_after_seconds: 60,
        },
      },
    });

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.windows.monthly : undefined).toEqual({
      percentRemaining: 80,
      resetTimeIso: "2026-01-01T00:01:00.000Z",
    });
  });

  it.each([
    { name: "zero", value: 0, expected: 0 },
    { name: "negative", value: -25, expected: 0 },
    { name: "above 100", value: 140, expected: 100 },
  ])("clamps $name Business individual-limit percentages", async ({ value, expected }) => {
    mockOpenAIUsageResponse({
      ...businessIndividualLimitUsage,
      spend_control: {
        individual_limit: {
          ...businessIndividualLimitUsage.spend_control.individual_limit,
          remaining_percent: value,
        },
      },
    });

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.windows.monthly?.percentRemaining : -1).toBe(expected);
  });

  it.each([
    { name: "missing spend control", spendControl: undefined },
    { name: "missing value", spendControl: { individual_limit: {} } },
    { name: "null value", spendControl: { individual_limit: { remaining_percent: null } } },
    { name: "wrong type", spendControl: { individual_limit: { remaining_percent: "50" } } },
    { name: "NaN", spendControl: { individual_limit: { remaining_percent: Number.NaN } } },
    {
      name: "infinite",
      spendControl: { individual_limit: { remaining_percent: Number.POSITIVE_INFINITY } },
    },
  ])("omits $name while preserving personal, credits, and code-review paths", async ({
    spendControl,
  }) => {
    mockOpenAIUsageResponse({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600,
        },
        secondary_window: null,
      },
      code_review_rate_limit: {
        primary_window: {
          used_percent: 5,
          reset_after_seconds: 60,
        },
      },
      credits: {
        has_credits: true,
        unlimited: false,
        balance: "12.34",
      },
      ...(spendControl === undefined ? {} : { spend_control: spendControl }),
    });

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.windows : {}).toEqual({
      hourly: {
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T01:00:00.000Z",
      },
      codeReview: {
        percentRemaining: 95,
        resetTimeIso: "2026-01-01T00:01:00.000Z",
      },
    });
    expect(out && out.success ? out.credits : undefined).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: "12.34",
    });
  });

  it("keeps an existing Business monthly rate-limit window authoritative", async () => {
    mockOpenAIUsageResponse({
      ...businessTeamMonthlyUsage,
      spend_control: {
        individual_limit: {
          remaining_percent: 5,
          reset_at: 1_800_000_000,
        },
      },
    });

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.label : "").toBe("OpenAI (Business)");
    expect(out && out.success ? out.windows : {}).toEqual({
      monthly: {
        percentRemaining: 67,
        resetTimeIso: new Date(1_786_262_548_000).toISOString(),
      },
    });
  });

  it.each([
    ["business", "OpenAI (Business)"],
    [" TEAM ", "OpenAI (Business)"],
    ["business_trial", "OpenAI (business_trial)"],
    ["team_workspace", "OpenAI (team_workspace)"],
    ["team (role:owner)", "OpenAI (Business)"],
    ["plus", "OpenAI (Plus)"],
    ["pro", "OpenAI (Pro)"],
  ])("derives the plan label for %j", async (planType, expectedLabel) => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: planType,
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3_600,
                },
                secondary_window: null,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.label : "").toBe(expectedLabel);
  });

  it("classifies known windows by duration when their positions are reversed", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 18_000,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(30);
    expect(out && out.success ? out.windows.weekly?.percentRemaining : -1).toBe(90);
  });

  it("omits an unknown duration while preserving a valid sibling", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 3_600,
                  reset_after_seconds: 3_600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      weekly: {
        percentRemaining: 30,
        resetTimeIso: "2026-01-08T00:00:00.000Z",
      },
    });
  });

  it("omits a malformed window while preserving a valid sibling", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "team",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: "33",
                  limit_window_seconds: 2_628_000,
                  reset_after_seconds: 2_585_763,
                },
                secondary_window: {
                  used_percent: 25,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 18_000,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      hourly: {
        percentRemaining: 75,
        resetTimeIso: "2026-01-01T05:00:00.000Z",
      },
    });
  });

  it("collapses equivalent duplicate durations", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
                secondary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      weekly: {
        percentRemaining: 90,
        resetTimeIso: "2026-01-15T00:00:00.000Z",
      },
    });
  });

  it("omits conflicting duplicate durations while preserving an unrelated valid window", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
                secondary_window: {
                  used_percent: 20,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
              },
              code_review_rate_limit: {
                primary_window: {
                  used_percent: 5,
                  reset_after_seconds: 60,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      codeReview: {
        percentRemaining: 95,
        resetTimeIso: "2026-01-01T00:01:00.000Z",
      },
    });
  });

  it("isolates unrepresentable reset dates and falls back when possible", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_at: Number.MAX_VALUE,
                  reset_after_seconds: 3_600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: Number.MAX_VALUE,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      hourly: {
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T01:00:00.000Z",
      },
      weekly: {
        percentRemaining: 30,
        resetTimeIso: undefined,
      },
    });
  });

  it("returns separate hourly and weekly windows", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(90);
    expect(out && out.success ? out.windows.weekly?.percentRemaining : -1).toBe(30);
  });
});
