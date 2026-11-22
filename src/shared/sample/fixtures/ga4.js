/** Google Analytics: a connected property with organic-search overview, opportunities and reports. */
import GA4 from "./data/ga4.json" with { type: "json" };
import { daysAgo, rebaseDates } from "./brand.js";

let cache = null;
const data = () => (cache ??= rebaseDates(GA4));

const REPORTS = {
  landing_pages: "landing-pages", page_performance: "page-performance", key_events: "key-events",
  traffic_acquisition: "traffic-acquisition", audience_breakdown: "audience",
};

export const status = () => data()["status-connected"];
export const overview = () => data().overview;
export const opportunities = () => data().opportunities;
export const health = () => data().health;
export const properties = () => data().properties;
export const report = (kind) => (REPORTS[kind] ? data()[REPORTS[kind]] : undefined);
export const accounts = () => ({ accounts: [{ grantId: "f0000000-0000-4000-8000-0000000000a1", email: "priya@brightwave.io", status: "active", linkedAt: daysAgo(60), workspaces: 1 }] });
