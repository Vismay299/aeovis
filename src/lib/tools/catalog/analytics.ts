import {
  getGoogleAnalyticsAudienceBreakdownTool,
  getGoogleAnalyticsEcommercePerformanceTool,
  getGoogleAnalyticsKeyEventsTool,
  getGoogleAnalyticsMeasurementHealthTool,
  getGoogleAnalyticsOrganicLandingPagesTool,
  getGoogleAnalyticsOrganicOverviewTool,
  getGoogleAnalyticsPagePerformanceTool,
  getGoogleAnalyticsSiteSearchTool,
  getGoogleAnalyticsTrafficAcquisitionTool,
  getSearchOpportunitiesTool,
} from "../../ga4/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import { readAnnotations } from "./quote.ts";

const reportExample = {
  status: "ok",
  rows: [],
  rowCount: 0,
  request: { startDate: "2026-10-01", endDate: "2026-10-28" },
};

const definitions = [
  { def: getGoogleAnalyticsOrganicOverviewTool, report: "Organic overview", output: { status: "ok" } },
  { def: getGoogleAnalyticsOrganicLandingPagesTool, report: "Organic landing pages", output: reportExample },
  { def: getGoogleAnalyticsPagePerformanceTool, report: "Page performance", output: reportExample },
  { def: getGoogleAnalyticsKeyEventsTool, report: "Key events", output: reportExample },
  { def: getGoogleAnalyticsTrafficAcquisitionTool, report: "Traffic acquisition", output: reportExample },
  { def: getGoogleAnalyticsEcommercePerformanceTool, report: "Ecommerce performance", output: reportExample },
  { def: getGoogleAnalyticsSiteSearchTool, report: "Site search", output: reportExample },
  { def: getGoogleAnalyticsAudienceBreakdownTool, report: "Audience breakdown", output: reportExample },
  { def: getGoogleAnalyticsMeasurementHealthTool, report: "Measurement health", output: { status: "ok" } },
  { def: getSearchOpportunitiesTool, report: "Search opportunities", output: reportExample },
];

export const registrations: ToolRegistration[] = definitions.map(({ def, report, output }) =>
  defineRegistration({
    def: def as never,
    area: "analytics",
    feature: "ga4",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (value: any) => {
      const rows = value?.rows?.length ?? 0;
      const start = value?.request?.startDate ?? "the selected period";
      const end = value?.request?.endDate ?? "today";
      return report + ": " + rows + " rows for " + start + " to " + end + ".";
    },
    link: () => ({ path: "/portal/analytics", label: "Analytics" }),
    example: { input: {}, output },
  }),
);
