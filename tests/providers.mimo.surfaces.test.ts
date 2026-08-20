import { describe, expect, it } from "vitest";
import type { QuotaToastEntry } from "../src/lib/entries.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const quotaAccounting = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const balanceAccounting = { ...quotaAccounting, resultType: "balance" } as const;
const group = "Xiaomi MiMo: Standard [standard_monthly]";

const monthlyQuota: QuotaToastEntry = {
  accounting: quotaAccounting,
  name: `${group} Monthly`,
  group,
  percentRemaining: 75,
  semantic: {
    metric: { kind: "window", window: "month" },
    prominence: "primary",
  },
  basis: {
    used: {
      quantity: { decimal: "25", unit: { kind: "count", unit: "token" } },
      authority: "provider_reported",
    },
    limit: {
      quantity: { decimal: "100", unit: { kind: "count", unit: "token" } },
      authority: "provider_reported",
    },
  },
};

function balanceEntry(
  component: "total_balance" | "cash_balance" | "gift_balance",
  prominence: "primary" | "supplementary",
  decimal: string,
  currency: string | null = "USD",
): QuotaToastEntry {
  return {
    kind: "quantity",
    accounting: balanceAccounting,
    name: `xiaomi-mimo-${component}`,
    group,
    semantic: { metric: { kind: "component", component }, prominence },
    quantity: {
      decimal,
      unit: currency ? { kind: "currency", code: currency } : { kind: "count", unit: "credit" },
    },
  };
}

function renderFourSurfaces(data: QuotaRenderData): string[] {
  return [
    formatQuotaCommand({
      ...data,
      generatedAtMs: 0,
      accountingDetail: "detailed",
      percentDisplayMode: "remaining",
    }),
    formatQuotaRows({
      version: "test",
      style: "allWindows",
      layout: { maxWidth: 72, narrowAt: 48, tinyAt: 32 },
      entries: data.entries,
      errors: data.errors,
      accountingDetail: "detailed",
      percentDisplayMode: "remaining",
    }),
    buildSidebarQuotaPanelLines({
      data,
      config: {
        formatStyle: "allWindows",
        percentDisplayMode: "remaining",
        accountingDetail: "detailed",
      },
    }).join("\n"),
    buildCompactQuotaStatusLine({
      data,
      accountingDetail: "detailed",
      percentDisplayMode: "remaining",
      maxWidth: 240,
    }),
  ];
}

describe("Xiaomi MiMo structured four-surface formatting", () => {
  it("shows plan identity, monthly token quota, and separate balance components", () => {
    const outputs = renderFourSurfaces({
      entries: [
        monthlyQuota,
        balanceEntry("total_balance", "primary", "50"),
        balanceEntry("cash_balance", "supplementary", "30"),
        balanceEntry("gift_balance", "supplementary", "20"),
      ],
      errors: [],
    });

    for (const output of outputs) {
      expect(output).toContain("Xiaomi MiMo");
      expect(output).toContain("Standard");
      expect(output).toContain("Monthly quota");
      expect(output).toContain("75%");
      expect(output).toContain("Total balance");
      expect(output).toContain("USD 50.00");
      expect(output).toContain("Cash balance");
      expect(output).not.toContain("$");
    }
    for (const output of outputs.slice(0, 3)) {
      expect(output).toContain("Gift balance");
    }
    expect(outputs[0]).toContain(group);
    expect(outputs[0]).toContain("Used: 25 tokens");
    expect(outputs[0]).toContain("Limit: 100 tokens");
    expect(outputs[1]?.split("\n").every((line) => line.length <= 72)).toBe(true);
    expect(outputs[2]?.split("\n").every((line) => line.length <= 36)).toBe(true);
  });

  it("renders missing-currency balances as credit counts", () => {
    const outputs = renderFourSurfaces({
      entries: [balanceEntry("total_balance", "primary", "12.5", null)],
      errors: [],
    });

    for (const output of outputs) {
      expect(output).toContain("Total balance");
      expect(output).toContain("12.5 credits");
      expect(output).not.toContain("USD");
      expect(output).not.toContain("$");
    }
  });
});
