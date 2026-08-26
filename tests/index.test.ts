import { describe, expect, it, vi } from "vitest";

const pluginMocks = vi.hoisted(() => ({
  server: {
    id: "@slkiser/opencode-quota",
    setup: vi.fn(),
  },
}));

vi.mock("../src/v2-plugin.js", () => ({ default: pluginMocks.server }));

describe("package entrypoint", () => {
  it("exports the V2 server plugin entrypoint", async () => {
    const mod = await import("../src/index.js");

    expect(mod.default).toBe(pluginMocks.server);
  });
});
