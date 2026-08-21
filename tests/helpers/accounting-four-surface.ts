import { formatQuotaRows } from "../../src/lib/format.js";
import { formatQuotaCommand } from "../../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../../src/lib/quota-render-data.js";
import { buildCompactQuotaStatusLine } from "../../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../../src/lib/tui-sidebar-format.js";
import type { QuotaToastConfig } from "../../src/lib/types.js";

export function renderAccountingFourSurfaces(params: {
  data: QuotaRenderData;
  accountingDetail: QuotaToastConfig["accountingDetail"];
  toastMaxWidth: number;
  toastNarrowAt: number;
  compactMaxWidth: number;
}): {
  command: string;
  toast: string;
  sidebar: string;
  compact: string;
} {
  const { data, accountingDetail, toastMaxWidth, toastNarrowAt, compactMaxWidth } = params;

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
      layout: { maxWidth: toastMaxWidth, narrowAt: toastNarrowAt, tinyAt: 32 },
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
      maxWidth: compactMaxWidth,
    }),
  };
}
