import { describe, expect, it } from "vitest";

import type { QuotaToastEntry } from "../src/lib/entries.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const balanceAccounting = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function balanceEntry(
  currency: "USD" | "CNY",
  component: "total_balance" | "granted_balance" | "topped_up_balance",
  prominence: "primary" | "supplementary",
  decimal: string,
): QuotaToastEntry {
  return {
    kind: "quantity",
    accounting: balanceAccounting,
    name: `deepseek-${currency.toLowerCase()}-${component}`,
    group: "DeepSeek",
    semantic: { metric: { kind: "component", component }, prominence },
    quantity: { decimal, unit: { kind: "currency", code: currency } },
  };
}

function availabilityEntry(value: boolean): QuotaToastEntry {
  return {
    kind: "boolean",
    accounting: { ...balanceAccounting, resultType: "status" },
    name: "deepseek-availability",
    group: "DeepSeek",
    semantic: {
      metric: { kind: "named", name: "Availability" },
      prominence: "primary",
    },
    value,
  };
}

function renderSurfaces(data: QuotaRenderData, accountingDetail: "summary" | "detailed") {
  return {
    command: formatQuotaCommand({
      ...data,
      generatedAtMs: 0,
      accountingDetail,
      percentDisplayMode: "remaining",
    }),
    toast: formatQuotaRows({
      version: "test",
      style: "allWindows",
      layout: { maxWidth: 64, narrowAt: 44, tinyAt: 32 },
      entries: data.entries,
      errors: data.errors,
      accountingDetail,
      percentDisplayMode: "remaining",
    }),
    sidebar: buildSidebarQuotaPanelLines({
      data,
      config: {
        formatStyle: "allWindows",
        percentDisplayMode: "remaining",
        accountingDetail,
      },
    }).join("\n"),
    compact: buildCompactQuotaStatusLine({
      data,
      accountingDetail,
      percentDisplayMode: "remaining",
      maxWidth: 240,
    }),
  };
}

describe("DeepSeek structured four-surface formatting", () => {
  it("keeps USD and CNY totals separate and hides supplementary components in summary", () => {
    const outputs = renderSurfaces(
      {
        entries: [
          balanceEntry("USD", "total_balance", "primary", "12.340000000000000001"),
          balanceEntry("CNY", "total_balance", "primary", "88.25"),
        ],
        errors: [],
      },
      "summary",
    );

    for (const output of Object.values(outputs)) {
      expect(output).toContain("DeepSeek");
      expect(output).toContain("USD 12.34");
      expect(output).toContain("CNY 88.25");
      expect(output).not.toContain("Granted balance");
      expect(output).not.toContain("Topped-up balance");
      expect(output).not.toContain("$");
      expect(output).not.toContain("¥");
    }
  });

  it("shows granted and topped-up components in detailed output", () => {
    const outputs = renderSurfaces(
      {
        entries: [
          balanceEntry("USD", "total_balance", "primary", "12.34"),
          balanceEntry("USD", "granted_balance", "supplementary", "2"),
          balanceEntry("USD", "topped_up_balance", "supplementary", "10.34"),
        ],
        errors: [],
      },
      "detailed",
    );

    for (const output of Object.values(outputs).slice(0, 3)) {
      expect(output).toContain("Granted balance");
      expect(output).toContain("USD 2.00");
      expect(output).toContain("Topped-up balance");
      expect(output).toContain("USD 10.34");
    }
    expect(outputs.toast.split("\n").every((line) => line.length <= 64)).toBe(true);
    expect(outputs.sidebar.split("\n").every((line) => line.length <= 36)).toBe(true);
  });

  it.each([
    [true, "Available"],
    [false, "Low balance"],
  ])("renders the boolean availability fallback as %s", (value, text) => {
    const outputs = renderSurfaces({ entries: [availabilityEntry(value)], errors: [] }, "summary");

    for (const output of Object.values(outputs)) {
      expect(output).toContain("Availability");
      expect(output).toContain(text);
      expect(output).not.toContain("Balance: 0");
    }
  });
});
