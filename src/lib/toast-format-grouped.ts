/**
 * Grouped toast formatter.
 *
 * Renders quota entries grouped by provider/account with compact bars.
 * Designed to feel like a status dashboard while still respecting OpenCode toast width.
 */

import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import { isPercentEntry, isValueEntry } from "./entries.js";
import {
  bar,
  DISPLAYED_PERCENT_LABEL_WIDTH,
  formatDisplayedPercentLabel,
  formatResetCountdown,
  isResetTimeDecimals,
  padLeft,
  padRight,
  resolveDisplayedPercent,
} from "./format-utils.js";
import { normalizeGroupedQuotaEntries } from "./grouped-entry-normalization.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { classifyQuotaWindowText, type QuotaWindowKind } from "./quota-entry-display.js";
import { renderSessionTokensLines } from "./session-tokens-format.js";
import type { QuotaToastConfig } from "./types.js";

function normalizeLabelText(value?: string): string {
  return value?.trim().replace(/:+$/u, "").trim() ?? "";
}

const GROUPED_WINDOW_LABELS: Readonly<Record<QuotaWindowKind, string>> = {
  rpm: "RPM",
  five_hour: "Five-hour",
  hour: "Hourly",
  week: "Weekly",
  day: "Daily",
  month: "Monthly",
  year: "Yearly",
  mcp: "MCP",
  code_review: "Code Review",
};

function extractWindowLabel(text: string): string | null {
  const kind = classifyQuotaWindowText(text);
  return kind ? GROUPED_WINDOW_LABELS[kind] : null;
}

function resolveGroupedRowLabel(entry: QuotaToastEntry): string {
  const rawLabel = normalizeLabelText(entry.label);
  const fromLabel = extractWindowLabel(rawLabel);
  if (fromLabel) return fromLabel;
  if (rawLabel) return rawLabel;

  const metricLabel = normalizeLabelText(entry.metricLabel);
  const fromMetricLabel = extractWindowLabel(metricLabel);
  if (fromMetricLabel) return fromMetricLabel;
  if (metricLabel) return metricLabel;

  const fromName = extractWindowLabel(entry.name);
  if (fromName) return fromName;

  return normalizeLabelText(entry.group) || "Quota window";
}

export function formatQuotaRowsGrouped(params: {
  layout?: {
    maxWidth: number;
    narrowAt: number;
    tinyAt: number;
  };
  entries?: QuotaToastEntry[];
  errors?: QuotaToastError[];
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  resetTimeDecimals?: number;
  sessionTokens?: SessionTokensData;
}): string {
  const layout = params.layout ?? { maxWidth: 50, narrowAt: 42, tinyAt: 32 };
  const maxWidth = layout.maxWidth;
  const isTiny = maxWidth <= layout.tinyAt;
  const isNarrow = !isTiny && maxWidth <= layout.narrowAt;

  const separator = "  ";
  const percentCol = Math.max(
    DISPLAYED_PERCENT_LABEL_WIDTH,
    ...(params.entries ?? [])
      .filter(isPercentEntry)
      .map(
        (entry) =>
          formatDisplayedPercentLabel(entry.percentRemaining, params.percentDisplayMode).length,
      ),
  );
  const barValueCol = percentCol;
  const barWidth = Math.max(10, maxWidth - separator.length - barValueCol);
  const timeCol = isTiny ? 6 : isNarrow ? 7 : 7;

  const lines: string[] = [];

  // Group entries in stable order.
  const groupOrder: string[] = [];
  const groups = new Map<string, QuotaToastEntry[]>();
  for (const entry of normalizeGroupedQuotaEntries(params.entries ?? [], "toast")) {
    const list = groups.get(entry.group);
    if (list) list.push(entry);
    else {
      groupOrder.push(entry.group);
      groups.set(entry.group, [entry]);
    }
  }

  for (let gi = 0; gi < groupOrder.length; gi++) {
    const g = groupOrder[gi]!;
    const list = groups.get(g) ?? [];
    if (gi > 0) lines.push("");

    lines.push(formatGroupedHeader(g).slice(0, maxWidth));

    for (const entry of list) {
      const right = entry.right ? entry.right.trim() : "";

      if (isValueEntry(entry)) {
        const label = entry.label?.trim() || entry.name;
        const timeStr = formatResetCountdown(entry.resetTimeIso, {
          compactRounded: true,
          decimals: params.resetTimeDecimals,
        });
        const value = entry.value.trim();

        if (isTiny) {
          // Tiny: "label  time  value"
          const timeWidth = isResetTimeDecimals(params.resetTimeDecimals)
            ? Math.max(timeCol, timeStr.length)
            : timeCol;
          const valueCol = Math.min(value.length, Math.max(6, percentCol + 2));
          const tinyNameCol = Math.max(
            1,
            maxWidth - separator.length - timeWidth - separator.length - valueCol,
          );
          const leftText = right ? `${label} ${right}` : label;
          const line = [
            padRight(leftText, tinyNameCol),
            padLeft(timeStr, timeWidth),
            padLeft(value, valueCol),
          ].join(separator);
          lines.push(line.slice(0, maxWidth));
          continue;
        }

        // Non-tiny: single line (no bar)
        const timeWidth = Math.max(timeStr.length, timeCol);
        const valueWidth = Math.max(value.length, 6);
        const leftMax = Math.max(
          1,
          barWidth - separator.length - valueWidth - separator.length - timeWidth,
        );
        const leftText = right ? `${label} ${right}` : label;
        lines.push(
          (
            padRight(leftText, leftMax) +
            separator +
            padLeft(value, valueWidth) +
            separator +
            padLeft(timeStr, timeWidth)
          ).slice(0, maxWidth),
        );
        continue;
      }
      if (!isPercentEntry(entry)) continue;

      const label = resolveGroupedRowLabel(entry);

      // A "value row" has no explicit label and carries a `right` summary to be
      // shown instead of a name. When present, the `right` is justified to the
      // edges of line 1 (left + right) and no reset countdown is shown.
      const isValueRow =
        !entry.label?.trim() && !entry.metricLabel?.trim() && !!entry.right?.trim();
      const displayedPercent = resolveDisplayedPercent(
        entry.percentRemaining,
        params.percentDisplayMode,
      );
      const percentLabel = formatDisplayedPercentLabel(
        entry.percentRemaining,
        params.percentDisplayMode,
      );

      // Percent entries
      // Show reset countdown whenever quota is not fully available.
      // (i.e., any usage at all, or depleted)
      const timeStr =
        entry.percentRemaining < 100
          ? formatResetCountdown(entry.resetTimeIso, {
              compactRounded: true,
              decimals: params.resetTimeDecimals,
            })
          : "";

      if (isTiny) {
        // Tiny: single line with name/time/percent (or just the right summary)
        const timeWidth = isResetTimeDecimals(params.resetTimeDecimals)
          ? Math.max(timeCol, timeStr.length)
          : timeCol;
        const visibleBarSuffix = percentLabel.slice(0, barValueCol);
        if (isValueRow) {
          const tinyNameCol = Math.max(
            1,
            maxWidth - separator.length - timeWidth - separator.length - barValueCol,
          );
          const line = [
            padRight(entry.right!.trim(), tinyNameCol),
            padLeft(timeStr, timeWidth),
            padLeft(visibleBarSuffix, barValueCol),
          ].join(separator);
          lines.push(line.slice(0, maxWidth));
          continue;
        }
        const tinyNameCol = Math.max(
          1,
          maxWidth - separator.length - timeWidth - separator.length - barValueCol,
        );
        const line = [
          padRight(label, tinyNameCol),
          padLeft(timeStr, timeWidth),
          padLeft(visibleBarSuffix, barValueCol),
        ].join(separator);
        lines.push(line.slice(0, maxWidth));
        continue;
      }

      if (isValueRow) {
        // Line 1: right summary. Two segments -> justified to the edges;
        // a single segment -> right-aligned. No name, no reset.
        const text = entry.right!.trim();
        const parts = text.split(/\s{2,}/u).filter(Boolean);
        if (parts.length >= 2) {
          const left = parts[0] ?? "";
          const rightText = parts.slice(1).join("  ");
          const sep = "  ";
          const leftWidth = Math.max(1, maxWidth - sep.length - rightText.length);
          lines.push((padRight(left, leftWidth) + sep + rightText).slice(0, maxWidth));
        } else {
          lines.push(padLeft(text, maxWidth));
        }
      } else {
        // Line 1: label + time at end
        const timeWidth = Math.max(timeStr.length, timeCol);
        const leftMax = Math.max(1, maxWidth - separator.length - timeWidth);
        lines.push(
          (padRight(label, leftMax) + separator + padLeft(timeStr, timeWidth)).slice(0, maxWidth),
        );
      }

      // Line 2: bar + percent
      const barCell = bar(displayedPercent, barWidth);
      const suffixCell = padLeft(percentLabel.slice(0, barValueCol), barValueCol);
      lines.push([barCell, suffixCell].join(separator));
    }
  }

  for (const err of params.errors ?? []) {
    if (lines.length > 0) lines.push("");
    lines.push(`${err.label}: ${err.message}`);
  }

  // Add session token summary (if data available and non-empty)
  const tokenLines = renderSessionTokensLines(params.sessionTokens, { maxWidth });
  if (tokenLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...tokenLines);
  }

  return lines.join("\n");
}
