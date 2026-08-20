import { afterEach, describe, expect, it, vi } from "vitest";

import type { QuotaToastEntry } from "../src/lib/entries.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const quotaAccounting = {
  resultType: "quota" as const,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "locally_derived" as const,
};
const balanceAccounting = {
  resultType: "balance" as const,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "provider_reported" as const,
};
const resetTimeIso = "2099-02-01T00:00:00.000Z";

const positivePass: QuotaToastEntry = {
  accounting: quotaAccounting,
  name: "kilo-gateway-credits",
  group: "Kilo Gateway",
  percentRemaining: 83.33333333333334,
  resetTimeIso,
  semantic: {
    metric: { kind: "component", component: "remaining_credits" },
    prominence: "primary",
  },
  basis: {
    used: {
      quantity: { decimal: "2.5", unit: { kind: "currency", code: "USD" } },
      authority: "provider_reported",
    },
    limit: {
      quantity: { decimal: "15", unit: { kind: "currency", code: "USD" } },
      authority: "locally_derived",
    },
    remaining: {
      quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
      authority: "locally_derived",
    },
  },
};

function quantityEntry(
  accounting: typeof quotaAccounting | typeof balanceAccounting,
  component: "remaining_credits" | "total_balance",
  decimal: string,
  resetTime?: string,
): QuotaToastEntry {
  return {
    kind: "quantity",
    accounting,
    name: `kilo-gateway-${component.replaceAll("_", "-")}`,
    group: "Kilo Gateway",
    semantic: {
      metric: { kind: "component", component },
      prominence: "primary",
    },
    quantity: { decimal, unit: { kind: "currency", code: "USD" } },
    ...(resetTime ? { resetTimeIso: resetTime } : {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

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
      layout: { maxWidth: 64, narrowAt: 44, tinyAt: 32 },
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
      maxWidth: 220,
    }),
  ];
}

describe("Kilo Gateway structured four-surface formatting", () => {
  it("shows one credits percentage with USD remaining basis and no duplicate row", () => {
    const outputs = renderFourSurfaces({ entries: [positivePass], errors: [] });

    for (const output of outputs) {
      expect(output).toContain("Kilo Gateway");
      expect(output).toContain("Credits");
      expect(output).toContain("83%");
      expect(output).toContain("USD");
      expect(output).not.toContain("$");
      expect(output.match(/Credits/gu)).toHaveLength(1);
    }
    expect(outputs[0]).toContain("USD 12.50");
    expect(outputs[0]).toContain("Used: USD 2.50");
    expect(outputs[0]).toContain("Limit: USD 15.00");
    expect(outputs[0]).toContain("Remaining: USD 12.50");
    expect(outputs[1]?.split("\n").every((line) => line.length <= 64)).toBe(true);
    expect(outputs[2]?.split("\n").every((line) => line.length <= 36)).toBe(true);
  });

  it("shows one zero-credit quantity with its reset and no percentage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));

    const outputs = renderFourSurfaces({
      entries: [quantityEntry(quotaAccounting, "remaining_credits", "0", resetTimeIso)],
      errors: [],
    });

    for (const output of outputs) {
      expect(output).toContain("Kilo Gateway");
      expect(output).toContain("Remaining credits");
      expect(output).toContain("USD 0.00");
      expect(output).not.toContain("%");
      expect(output).not.toContain("$");
    }
    for (const output of outputs.slice(0, 3)) {
      expect(output).toMatch(/\b\d+d\b/u);
    }
  });

  it("keeps the Gateway fallback as one total-balance quantity", () => {
    const outputs = renderFourSurfaces({
      entries: [quantityEntry(balanceAccounting, "total_balance", "8.25")],
      errors: [],
    });

    for (const output of outputs) {
      expect(output).toContain("Kilo Gateway");
      expect(output).toContain("Total balance");
      expect(output).toContain("USD 8.25");
      expect(output).not.toContain("%");
      expect(output).not.toContain("$");
      expect(output.toLowerCase()).not.toContain("remaining credits");
      expect(output.toLowerCase()).not.toContain("reset");
    }
  });
});
