/**
 * Verbose quota status formatter for /quota.
 *
 * This is intentionally more verbose than the toast:
 * - Always shows reset countdown when available
 * - Uses one line per limit, grouped under provider headers
 * - Includes session token summary (input/output per model)
 */

import {
  formatAccountingBasisDetails,
  formatAccountingBasisSummary,
  formatAccountingBoolean,
  formatAccountingQuantity,
  getAccountingEntryLabel,
} from "./accounting-format.js";
import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import { isBooleanEntry, isPercentEntry, isQuantityEntry, isValueEntry } from "./entries.js";
import {
  bar,
  formatDisplayedPercentLabel,
  formatLocalCallTimestamp,
  formatTokenCount,
  padLeft,
  padRight,
  resolveDisplayedPercent,
} from "./format-utils.js";
import { groupQuotaEntries } from "./grouped-entry-normalization.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { classifyQuotaWindowText, type QuotaWindowKind } from "./quota-entry-display.js";
import {
  type ReportDocument,
  type ReportSection,
  renderPlainTextReport,
} from "./report-document.js";
import { SESSION_TOKEN_SECTION_HEADING } from "./session-tokens-format.js";
import type { QuotaToastConfig } from "./types.js";

/**
 * Format reset time in compact form (different from toast countdown).
 * Uses seconds/minutes/hours/days format for /quota command.
 */
function formatResetTimeSeconds(diffSeconds: number): string {
  if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) return "now";
  if (diffSeconds < 60) return `${Math.ceil(diffSeconds)}s`;
  if (diffSeconds < 3600) return `${Math.ceil(diffSeconds / 60)}m`;
  if (diffSeconds < 86400) return `${Math.round(diffSeconds / 3600)}h`;
  return `${Math.round(diffSeconds / 86400)}d`;
}

function formatResetsIn(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffSeconds = (t - Date.now()) / 1000;
  return ` | resets in ${formatResetTimeSeconds(diffSeconds)}`;
}

export const QUOTA_COMMAND_BAR_WIDTH = 10;
export const QUOTA_COMMAND_LABEL_WIDTH = 12;

function normalizeMetricText(value?: string): string {
  return value?.trim().replace(/:+$/u, "").trim() ?? "";
}

const COMMAND_WINDOW_LABELS: Readonly<Partial<Record<QuotaWindowKind, string>>> = {
  rpm: "RPM",
  five_hour: "5h",
  hour: "Hour",
  week: "Week",
  day: "Day",
  month: "Month",
  year: "Year",
};

function getCommandWindowLabel(entry: QuotaToastEntry): string | null {
  const kind = classifyQuotaWindowText(normalizeMetricText(entry.label || entry.name));
  return kind ? (COMMAND_WINDOW_LABELS[kind] ?? null) : null;
}

function getCommandMetricLabel(entry: QuotaToastEntry): string {
  if (entry.semantic) return getAccountingEntryLabel(entry);

  const window = getCommandWindowLabel(entry);
  const resultType = entry.accounting?.resultType;

  if (resultType === "balance") return "Balance";
  if (resultType === "status") return "Status";

  const explicit = normalizeMetricText(entry.label);
  const metricLabel = normalizeMetricText(entry.metricLabel);
  const noun =
    resultType === "budget"
      ? "budget"
      : resultType === "usage"
        ? "usage"
        : resultType === "spend"
          ? "spend"
          : resultType === "quota" || resultType === "rate_limit"
            ? "quota"
            : "";

  if (noun) {
    return window ? `${window} ${noun}` : metricLabel || noun[0]!.toUpperCase() + noun.slice(1);
  }
  if (window) return `${window} quota`;

  return explicit || (isValueEntry(entry) ? "Value" : "Quota");
}

function formatCommandDetails(entry: QuotaToastEntry, rightWidth: number): string {
  const right = entry.right?.trim();
  const reset = formatResetsIn(entry.resetTimeIso).replace(/^ \| resets in /u, "reset ");
  if (right && reset) return ` | ${padRight(right, rightWidth)} | ${reset}`;
  if (right) return ` | ${right}`;
  if (reset) return ` | ${reset}`;
  return "";
}

function getCommandValue(entry: QuotaToastEntry): string | null {
  if (isValueEntry(entry)) return entry.value;
  if (isQuantityEntry(entry)) return formatAccountingQuantity(entry.quantity);
  if (isBooleanEntry(entry)) return formatAccountingBoolean(entry.value, entry.semantic);
  return null;
}

function getCommandBasisLines(
  entry: QuotaToastEntry,
  accountingDetail: QuotaToastConfig["accountingDetail"],
  percentDisplayMode: QuotaToastConfig["percentDisplayMode"],
): string[] {
  if (!isPercentEntry(entry) || !entry.basis) return [];
  const details =
    accountingDetail === "detailed"
      ? formatAccountingBasisDetails(entry.basis)
      : [formatAccountingBasisSummary(entry.basis, percentDisplayMode)].filter(
          (detail): detail is string => Boolean(detail),
        );
  return details.map((detail) => `    ${detail}`);
}

function buildQuotaCommandDocument(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  generatedAtMs?: number;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  accountingDetail?: QuotaToastConfig["accountingDetail"];
}): ReportDocument {
  const groups = groupQuotaEntries(params.entries, "quota");

  const sections: ReportSection[] = groups.map((group, index) => {
    const lines: string[] = [];
    const rightWidth = Math.max(0, ...group.entries.map((row) => row.right?.trim().length ?? 0));
    const labelWidth = Math.max(
      QUOTA_COMMAND_LABEL_WIDTH,
      ...group.entries
        .filter((row) => Boolean(row.semantic))
        .map((row) => getCommandMetricLabel(row).length),
    );
    for (const row of group.entries) {
      const label = padRight(getCommandMetricLabel(row), labelWidth);
      const details = formatCommandDetails(row, rightWidth);

      const value = getCommandValue(row);
      if (value !== null) {
        lines.push(`  ${label}  ${value}${details}`);
        continue;
      }

      if (!isPercentEntry(row)) continue;
      const pctLabel = formatDisplayedPercentLabel(row.percentRemaining, params.percentDisplayMode);
      const displayedPercent = resolveDisplayedPercent(
        row.percentRemaining,
        params.percentDisplayMode,
      );
      lines.push(
        `  ${label}  ${bar(displayedPercent, QUOTA_COMMAND_BAR_WIDTH)}  ${padLeft(pctLabel, Math.max(9, pctLabel.length))}${details}`,
      );
      lines.push(
        ...getCommandBasisLines(
          row,
          params.accountingDetail ?? "summary",
          params.percentDisplayMode ?? "remaining",
        ),
      );
    }
    return {
      id: `group-${index}`,
      title: `→ ${formatGroupedHeader(group.group)}`,
      blocks: [{ kind: "lines", lines }],
    };
  });

  if (params.sessionTokens && params.sessionTokens.models.length > 0) {
    sections.push({
      id: "session-tokens",
      title: SESSION_TOKEN_SECTION_HEADING,
      blocks: [
        {
          kind: "lines",
          lines: params.sessionTokens.models.map((model) => {
            const metrics = [`${formatTokenCount(model.input)} in`];
            if ((model.cachedInput ?? 0) > 0) {
              metrics.push(`${formatTokenCount(model.cachedInput ?? 0)} cached`);
            }
            metrics.push(`${formatTokenCount(model.output)} out`);
            return `  ${model.modelID}: ${metrics.join(" | ")}`;
          }),
        },
      ],
    });
  }

  if (params.errors.length > 0) {
    sections.push({
      id: "errors",
      title: "Partial failures",
      blocks: [
        {
          kind: "lines",
          lines: params.errors.map((err) => `  ${err.label}: ${err.message}`),
        },
      ],
    });
  }

  return {
    sections: [
      {
        id: "heading",
        blocks: [
          {
            kind: "lines",
            lines: [`Quota (/quota) ${formatLocalCallTimestamp(params.generatedAtMs)}`],
          },
        ],
      },
      ...sections,
    ],
  };
}

export function formatQuotaCommand(params: {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  generatedAtMs?: number;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  accountingDetail?: QuotaToastConfig["accountingDetail"];
}): string {
  return renderPlainTextReport(buildQuotaCommandDocument(params));
}
