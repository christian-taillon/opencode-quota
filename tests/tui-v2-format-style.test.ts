import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { resolveQuotaRuntimeContext, collectQuotaRenderData, buildSidebarQuotaPanelLines } =
  vi.hoisted(() => ({
    resolveQuotaRuntimeContext: vi.fn(),
    collectQuotaRenderData: vi.fn(),
    buildSidebarQuotaPanelLines: vi.fn(),
  }));

vi.mock("../src/lib/quota-runtime-context.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-runtime-context.js")>(
    "../src/lib/quota-runtime-context.js",
  );
  return { ...actual, resolveQuotaRuntimeContext };
});

vi.mock("../src/lib/quota-render-data.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-render-data.js")>(
    "../src/lib/quota-render-data.js",
  );
  return { ...actual, collectQuotaRenderData };
});

vi.mock("../src/lib/tui-sidebar-format.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tui-sidebar-format.js")>(
    "../src/lib/tui-sidebar-format.js",
  );
  buildSidebarQuotaPanelLines.mockImplementation(actual.buildSidebarQuotaPanelLines);
  return { ...actual, buildSidebarQuotaPanelLines };
});

import { DEFAULT_CONFIG } from "../src/lib/types.js";
import plugin from "../src/tui-v2.tsx";

function createElement(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) {
  const nextProps = {
    ...(props ?? {}),
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  };
  return typeof type === "function" ? type(nextProps) : { type, props: nextProps };
}

beforeAll(() => {
  (globalThis as { React?: unknown }).React = { createElement };
});

afterAll(() => {
  delete (globalThis as { React?: unknown }).React;
});

const allWindowsEntries = [
  {
    name: "OpenAI (Plus) 5h",
    group: "OpenAI (Plus) · OpenAI",
    label: "5h:",
    percentRemaining: 80,
  },
  {
    name: "OpenAI (Plus) Week",
    group: "OpenAI (Plus) · OpenAI",
    label: "Week:",
    percentRemaining: 70,
  },
  {
    name: "OpenAI (Business) 5h",
    group: "OpenAI (Business) · OpenAI 2",
    label: "5h:",
    percentRemaining: 60,
  },
  {
    name: "OpenAI (Business) Week",
    group: "OpenAI (Business) · OpenAI 2",
    label: "Week:",
    percentRemaining: 50,
  },
] as const;

function makeContext() {
  const handlers = new Map<string, Array<(event: { data?: { sessionID?: string } }) => void>>();
  let sidebarRender: ((props: { sessionID: string }) => unknown) | undefined;
  const context = {
    client: {},
    data: {
      on: vi.fn((event: string, handler: (event: { data?: { sessionID?: string } }) => void) => {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
        return vi.fn();
      }),
    },
    keymap: { layer: vi.fn() },
    ui: {
      slot: vi.fn((claim: any) => {
        if (claim.append === "app") claim.render();
        if (claim.append === "sidebar.content") sidebarRender = claim.render;
        return vi.fn();
      }),
      toast: { show: vi.fn() },
      dialog: { alert: vi.fn(), prompt: vi.fn(), set: vi.fn() },
    },
  };
  return { context, handlers, getSidebarRender: () => sidebarRender };
}

describe("V2 TUI format style selection", () => {
  it("collects sidebar data with its override while keeping toast single-window", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      formatStyle: "singleWindow" as const,
      tuiSidebarPanel: { enabled: true, formatStyle: "allWindows" as const },
    };
    const sidebarData = { entries: [...allWindowsEntries], errors: [], sessionTokens: undefined };
    const toastData = { entries: [allWindowsEntries[0]], errors: [], sessionTokens: undefined };

    resolveQuotaRuntimeContext.mockResolvedValue({
      client: {},
      config,
      configMeta: {},
      providers: [],
      resolveRuntimeProviderIds: vi.fn(),
      session: {},
    });
    collectQuotaRenderData.mockImplementation(async ({ formatStyle }) => ({
      active: [],
      data: formatStyle === "allWindows" ? sidebarData : toastData,
    }));

    const { context, handlers, getSidebarRender } = makeContext();
    plugin.setup(context as any);
    getSidebarRender()!({ sessionID: "sidebar-session" });
    await vi.waitFor(() => expect(buildSidebarQuotaPanelLines).toHaveBeenCalledOnce());

    const sidebarCall = buildSidebarQuotaPanelLines.mock.calls[0]![0];
    expect(collectQuotaRenderData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ formatStyle: "allWindows" }),
    );
    expect(sidebarCall.config).toEqual(expect.objectContaining({ formatStyle: "allWindows" }));
    expect(sidebarCall.data.entries).toHaveLength(4);
    const sidebarText = buildSidebarQuotaPanelLines.mock.results[0]!.value.join("\n");
    expect(sidebarText).toContain("[OpenAI (Plus) · OpenAI]");
    expect(sidebarText).toContain("[OpenAI (Business) · OpenAI 2]");
    expect(sidebarText.match(/\d+%/gu)).toHaveLength(4);

    handlers.get("session.step.ended")![0]!({ data: { sessionID: "toast-session" } });
    await vi.waitFor(() => expect(context.ui.toast.show).toHaveBeenCalledOnce());

    expect(collectQuotaRenderData).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ formatStyle: "singleWindow" }),
    );
    expect(context.ui.toast.show.mock.calls[0]![0].message.match(/\d+%/gu)).toHaveLength(1);
  });
});
