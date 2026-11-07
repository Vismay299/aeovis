// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/ga4.ts
//   src/shared/google-link.ts
//   src/client/features/integrations/googleAuthErrorCopy.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const GA4_DATA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export const GA4_OAUTH_SCOPES = [
  "openid",
  "email",
  GA4_DATA_SCOPE,
] as const;

export const GA4_REPORT_KINDS = [
  "landing_pages",
  "page_performance",
  "key_events",
  "traffic_acquisition",
  "ecommerce_performance",
  "site_search",
  "audience_breakdown",
] as const;

export type Ga4ReportKind = (typeof GA4_REPORT_KINDS)[number];

export const GA4_RANGE_PRESETS = [
  "last_7_days",
  "last_28_days",
  "last_90_days",
] as const;

export type Ga4RangePreset = (typeof GA4_RANGE_PRESETS)[number];

export const GA4_LINK_ERROR_PARAM = "ga4_error";

export const GA4_RETURN_PATHS = [
  "/portal/settings/integrations",
  "/portal/analytics",
  "/onboarding",
] as const;

export type Ga4ReturnPath = (typeof GA4_RETURN_PATHS)[number];

export type Ga4LinkErrorCode =
  | "state_mismatch"
  | "access_denied"
  | "scope_not_granted"
  | "owner_required"
  | "missing_code"
  | "oauth_code_verification_failed"
  | "connection_save_failed"
  | "oauth_failed"
  | string;

export const GA4_REPORT_KIND_LABELS: Record<Ga4ReportKind, string> = {
  landing_pages: "Landing pages",
  page_performance: "Pages",
  key_events: "Key events",
  traffic_acquisition: "Traffic acquisition",
  ecommerce_performance: "E-commerce",
  site_search: "Site search",
  audience_breakdown: "Audience",
};

export const GA4_ACQUISITION_BREAKDOWNS = [
  "channel_group",
  "source_medium",
  "campaign",
] as const;

export type Ga4AcquisitionBreakdown = (typeof GA4_ACQUISITION_BREAKDOWNS)[number];

export const GA4_ECOMMERCE_BREAKDOWNS = ["items", "landing_pages"] as const;

export type Ga4EcommerceBreakdown = (typeof GA4_ECOMMERCE_BREAKDOWNS)[number];

export const GA4_AUDIENCE_BREAKDOWNS = [
  "device",
  "country",
  "user_type",
] as const;

export type Ga4AudienceBreakdown = (typeof GA4_AUDIENCE_BREAKDOWNS)[number];

export const GA4_HEALTH_ISSUE_LABELS: Record<string, string> = {
  no_web_stream: "This property has no web data stream, so it isn't collecting website data.",
  enhanced_measurement_disabled: "Enhanced measurement is off for every web stream, so scrolls, outbound clicks and site search aren't tracked.",
  site_search_measurement_disabled: "Site search tracking is off.",
  no_key_events_configured: "No key events are configured, so conversions can't be measured. Mark your important events as key events in Google Analytics.",
};

export function ga4AuthErrorCopy(code: string): { title: string; description: string } {
  switch (code) {
    case "state_mismatch":
      return {
        title: "Google Analytics connection didn't finish",
        description:
          "The attempt expired or was interrupted. Try again in a single browser tab and finish the Google steps within 10 minutes.",
      };
    case "access_denied":
      return {
        title: "Google Analytics connection was cancelled",
        description:
          "Google's permission screen was closed or declined. Try again whenever you're ready.",
      };
    case "scope_not_granted":
      return {
        title: "Google Analytics connection is missing a permission",
        description:
          "Perceev didn't get access to your Analytics data because a box on Google's permission screen wasn't ticked. Try again and tick every box.",
      };
    case "owner_required":
      return {
        title: "Only the workspace owner can connect Google Analytics",
        description: "Ask the owner to connect it.",
      };
    case "connection_save_failed":
      return {
        title: "Google Analytics connection didn't finish",
        description: "We couldn't save the connection. Please try again.",
      };
    default:
      return {
        title: "Google Analytics connection didn't finish",
        description: "Something went wrong while talking to Google. Please try again.",
      };
  }
}
