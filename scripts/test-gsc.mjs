#!/usr/bin/env node
/**
 * Smoke-test the Google Search Console integration.
 *
 * Usage:
 *   npm run test:gsc                    # list accessible properties
 *   npm run test:gsc -- example.com     # pull top queries for a site
 *
 * Requires GSC_SERVICE_ACCOUNT_KEY in .env.local (raw JSON or base64) and the
 * service-account email added as a Restricted user on the property.
 */

import {
  getGscServiceAccount,
  listGscSites,
  fetchSearchQueriesForUrl,
} from "../src/shared/engines/gsc.js";

const target = process.argv[2];

const account = getGscServiceAccount();
if (!account) {
  console.error("✗ GSC_SERVICE_ACCOUNT_KEY is not set (or not valid JSON/base64).");
  console.error("  Add it to .env.local, then re-run: npm run test:gsc");
  process.exit(1);
}
console.log(`✓ Service account loaded: ${account.client_email}`);
console.log(`  (Add this email as a Restricted user in Search Console → Settings → Users)\n`);

try {
  const sites = await listGscSites();
  if (sites.length === 0) {
    console.log("No accessible properties yet — the service account email hasn't been added to any Search Console property.");
    process.exit(0);
  }
  console.log(`Accessible properties (${sites.length}):`);
  for (const s of sites) console.log(`  - ${s.siteUrl}  [${s.permissionLevel}]`);
} catch (err) {
  console.error(`✗ Could not list properties: ${err.message}`);
  process.exit(1);
}

if (!target) {
  console.log("\nPass a site to pull queries, e.g.: npm run test:gsc -- example.com");
  process.exit(0);
}

console.log(`\nPulling top queries for "${target}" (last 90 days)...`);
try {
  const { siteUrl, rows } = await fetchSearchQueriesForUrl(target, { days: 90, rowLimit: 5000 });
  console.log(`✓ Resolved property: ${siteUrl} — ${rows.length} queries returned\n`);

  const top = [...rows].sort((a, b) => b.impressions - a.impressions).slice(0, 20);
  console.log("Top 20 by impressions:");
  console.log("  impressions  clicks  pos    query");
  for (const r of top) {
    console.log(
      `  ${String(r.impressions).padStart(11)}  ${String(r.clicks).padStart(6)}  ${r.position.toFixed(1).padStart(5)}  ${r.query}`
    );
  }
} catch (err) {
  console.error(`✗ Query pull failed: ${err.message}`);
  process.exit(1);
}
